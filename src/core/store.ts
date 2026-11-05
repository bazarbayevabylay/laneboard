// Store discovery and lock-free reading of store files (parse, validate, checksum, duplicate view).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeIssue, schemaVersion, unreadableStoreFile } from './config.ts';
import { LaneboardError } from './errors.ts';
import { isDirectory, linkedWorktree, worktreeAt } from './git.ts';
import { shellQuote } from './shell.ts';
import { STORE_SCHEMA, STORE_VERSION, StoreFile } from './schema.ts';
import type { FileKind, StoreFileT, TaskT } from './schema.ts';

export const STORE_DIR_NAME = '.laneboard';

// How a store was found: --dir, LANEBOARD_DIR, in the current directory, in a parent of it (walk-up), in the main checkout of the
// git worktree holding cwd, or --board (read-only).
export type StoreSource = 'dir' | 'env' | 'cwd' | 'parent' | 'worktree' | 'board';

// A resolved store: absolute path of the `.laneboard` directory (and how discovery found it, when it did).
export interface StoreRef {
  dir: string;
  found?: StoreSource;
  // Opened with --board: another board, readable only (transact refuses every write).
  readOnly?: boolean;
}

// Files and folders that mark a project root of its own (a nested agent folder, a separate repository). package.json is not one:
// packages of a monorepo have it and share the repository's board.
export const PROJECT_MARKERS = ['.git', '.claude', 'CLAUDE.md', 'AGENTS.md', 'GEMINI.md'] as const;

// Is `dir` the machine's board registry, not a store? It has no config.json and is `<home>/.laneboard` (an init that failed
// before its first write can leave that folder empty) or holds boards.json (the registry of another home).
// HOME may reach the same folder through a symlink (macOS /var -> /private/var, NFS homes), so both sides are canonical.
function isRegistryDir(dir: string, home: string | undefined): boolean {
  if (fs.existsSync(path.join(dir, 'config.json'))) return false;
  return (home !== undefined && home !== '' && samePath(dir, path.join(home, STORE_DIR_NAME))) || fs.existsSync(path.join(dir, 'boards.json'));
}

export interface DiscoveryInput {
  // Value of --dir, if given.
  dir?: string;
  // Value of LANEBOARD_DIR, if set.
  envDir?: string;
  cwd: string;
  // HOME, if set: its `.laneboard` is the board registry, never a store found by walking up.
  home?: string;
}

// Find the store: --dir, then LANEBOARD_DIR, then walk up from cwd to `/` (first match wins); in a linked git worktree a store
// inside the worktree comes first, then the main checkout's (see worktreeStore), then one above the worktree.
export function resolveStore(input: DiscoveryInput): StoreRef {
  const explicit = input.dir ?? input.envDir;
  if (explicit !== undefined && explicit !== '') {
    const source = input.dir !== undefined ? '--dir' : 'LANEBOARD_DIR';
    const dir = path.resolve(input.cwd, explicit);
    if (!isDirectory(dir)) {
      throw new LaneboardError('STORE_NOT_FOUND', `${source} points to ${dir}, which is not a directory`, {
        fix: `fix ${source} (laneboard boards --json lists this machine's boards with their paths); if this project has no board yet: laneboard init --dir ${shellQuote(dir)} --name <name> --description "<whose project, what work>", then laneboard prime`,
      });
    }
    return { dir, found: input.dir !== undefined ? 'dir' : 'env' };
  }
  const found = walkUp(input.cwd, input.home);
  const worktree = worktreeStore(input.cwd, found, input.home);
  if (worktree) return worktree;
  if (found) return found;
  throw new LaneboardError('STORE_NOT_FOUND', `no ${STORE_DIR_NAME} directory in ${path.resolve(input.cwd)} or any parent`);
}

// Closest `.laneboard` from cwd up to `/` (the registry folder skipped), or undefined.
function walkUp(cwd: string, home: string | undefined): StoreRef | undefined {
  const start = path.resolve(cwd);
  for (let current = start; ; current = path.dirname(current)) {
    const candidate = path.join(current, STORE_DIR_NAME);
    if (isDirectory(candidate) && !isRegistryDir(candidate, home)) return { dir: candidate, found: current === start ? 'cwd' : 'parent' };
    if (path.dirname(current) === current) return undefined;
  }
}

// The store of the main checkout for cwd in a linked git worktree (`git worktree add ../wt`, A18): the worktree's `.git` file leads to
// the repository's common git directory and so to the main checkout, whose `<root>/.laneboard` (not committed, so a worktree outside
// the project tree has no copy) is this project's board. Only when walking up found no store inside the worktree itself; a store
// above the worktree (e.g. `<project>/.claude/worktrees/<name>`, or an unrelated folder above `../wt`) gives way to it.
function worktreeStore(cwd: string, near: StoreRef | undefined, home: string | undefined): StoreRef | undefined {
  const tree = linkedWorktree(cwd);
  if (tree?.main === undefined) return undefined;
  if (near !== undefined && isWithin(canonicalPath(near.dir), canonicalPath(tree.root))) return undefined;
  const candidate = path.join(tree.main, STORE_DIR_NAME);
  return isDirectory(candidate) && !isRegistryDir(candidate, home) ? { dir: candidate, found: 'worktree' } : undefined;
}

// `p` absolute with symlinks resolved (macOS /var -> /private/var); for a path that does not exist yet, its nearest existing
// parent is resolved and the missing rest kept as written. Every comparison with HOME, cwd or a store path goes through it.
export function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  let existing = abs;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  return path.join(fs.realpathSync(existing), path.relative(existing, abs));
}

// Do `a` and `b` name the same folder (symlinks resolved)?
export function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

// Is `inner` the folder `outer` or inside it?
function isWithin(inner: string, outer: string): boolean {
  const rel = path.relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// First project marker between cwd (included) and the folder that holds the store (excluded), as a path relative to cwd.
// A git worktree of the store's repository (Claude Code puts them in `<project>/.claude/worktrees/`) is that project, not another one.
export function separateProjectMarker(storeDir: string, cwd: string): string | undefined {
  const owner = canonicalPath(path.dirname(storeDir));
  const start = path.resolve(cwd);
  for (let current = start; canonicalPath(current) !== owner && path.dirname(current) !== current; current = path.dirname(current)) {
    // A linked worktree's main checkout (worktreeAt: the same rule discovery uses).
    const repo = worktreeAt(current)?.main;
    if (repo !== undefined && isWithin(owner, canonicalPath(repo))) return undefined;
    const marker = PROJECT_MARKERS.find((m) => fs.existsSync(path.join(current, m)));
    if (marker) return path.relative(start, path.join(current, marker));
  }
  return undefined;
}

// A store that may be another project's: what made it look so, or undefined. Either LANEBOARD_DIR hides a store of cwd's own
// (`ownStore`: walking up from cwd finds it, wherever the pinned store lies), or the store was found in a parent directory or
// LANEBOARD_DIR names a store whose project folder holds cwd, and a project marker lies between. A pin set for a parent folder
// reaches its subfolders: Claude Code reads the repository root's .claude/settings.local.json in every folder of the repository,
// also when it pins a store outside the repository (setup claude-code --dir ~/boards/<project>/.laneboard).
export interface ForeignStore {
  marker: string;
  ownStore?: string;
}

// Signs that the store in use belongs to another project than cwd (see ForeignStore); undefined when there are none.
export function foreignStore(ref: StoreRef, cwd: string, home?: string): ForeignStore | undefined {
  if (ref.found === 'env') {
    // A store of cwd's own is the clearest sign; a store walking up finds behind a project marker is another project's, not cwd's.
    const near = walkUp(cwd, home);
    if (near !== undefined && !samePath(near.dir, ref.dir) && separateProjectMarker(near.dir, cwd) === undefined) {
      return { marker: path.relative(path.resolve(cwd), near.dir), ownStore: near.dir };
    }
  }
  if (ref.found !== 'parent' && !pinnedAbove(ref, cwd)) return undefined;
  const marker = separateProjectMarker(ref.dir, cwd);
  return marker === undefined ? undefined : { marker };
}

// Does LANEBOARD_DIR name a store whose project folder holds cwd (a pin set for a parent folder)?
function pinnedAbove(ref: StoreRef, cwd: string): boolean {
  const here = canonicalPath(cwd);
  const owner = canonicalPath(path.dirname(ref.dir));
  return ref.found === 'env' && here !== owner && isWithin(here, owner);
}

// Warning for a store that looks like another project's (a project marker lies between, see foreignStore): a nested agent folder
// would otherwise write silently into it. A plain subfolder of the same project gets none.
export function parentStoreWarning(ref: StoreRef, cwd: string, prefix: string | null, home?: string): string | undefined {
  const foreign = foreignStore(ref, cwd, home);
  if (foreign === undefined) return undefined;
  const how = ref.found === 'parent' ? 'found in a parent directory' : pinnedAbove(ref, cwd) ? 'from LANEBOARD_DIR (set for a parent folder)' : 'from LANEBOARD_DIR';
  const own = foreign.ownStore;
  const it = own ? `it has its own store ${own}` : `it has ${foreign.marker}`;
  // A new board goes to the folder of the marker, and by --dir: a bare init would take LANEBOARD_DIR, the store in use.
  const created = path.join(path.dirname(path.resolve(cwd, foreign.marker)), STORE_DIR_NAME);
  const fix = own
    ? `pass --dir ${shellQuote(own)} on every command`
    : `find its own board with laneboard boards --json and pass --dir <its path> on every command, or create one: laneboard init --dir ${shellQuote(created)} --name <name> --description "<whose project, what work>", then pass --dir ${shellQuote(created)} on every command, starting with laneboard prime`;
  return `using store ${ref.dir}${prefix ? ` (prefix ${prefix})` : ''} ${how}, but ${path.resolve(cwd)} looks like a separate project (${it}); unless this folder is part of that project, ${fix}`;
}

// Directory that init creates: --dir, then LANEBOARD_DIR, then `<cwd>/.laneboard` (no walk-up).
export function initTarget(input: DiscoveryInput): string {
  const explicit = input.dir ?? input.envDir;
  if (explicit !== undefined && explicit !== '') return path.resolve(input.cwd, explicit);
  return path.join(path.resolve(input.cwd), STORE_DIR_NAME);
}

// Path of active.json / archive.json.
export function storeFilePath(storeDir: string, kind: FileKind): string {
  return path.join(storeDir, `${kind}.json`);
}

// Path of the `.bak` copy written before each replace.
export function backupPath(storeDir: string, kind: FileKind): string {
  return `${storeFilePath(storeDir, kind)}.bak`;
}

// sha256 of the serialized task array (content_sha256).
export function contentSha(tasks: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(tasks)).digest('hex');
}

// Serialize a store file for disk.
export function serializeStoreFile(data: StoreFileT): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

// Empty store file, as written by init (next_id only in active.json).
export function emptyStoreFile(kind: FileKind, now: string): StoreFileT {
  if (kind === 'active') {
    return { schema: STORE_SCHEMA, kind, rev: 0, next_id: 1, updated_at: now, content_sha256: contentSha([]), tasks: [] };
  }
  return { schema: STORE_SCHEMA, kind, rev: 0, updated_at: now, content_sha256: contentSha([]), tasks: [] };
}

// One store file as read from disk, plus what is needed to detect and order changes.
export interface LoadedFile {
  kind: FileKind;
  data: StoreFileT;
  // Exact bytes on disk (written to `.bak` before the next replace).
  raw: string;
  version: number;
  beforeJson: string;
  beforeIds: Set<string>;
}

export interface StoreReadOptions {
  // Accept an id used twice in the file (doctor reads such a file to renumber the later copy).
  allowDuplicateIds?: boolean;
}

// Ids that appear more than once in one task list, in order of first repeat.
export function repeatedIds(tasks: readonly TaskT[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const t of tasks) {
    if (seen.has(t.id)) repeated.add(t.id);
    seen.add(t.id);
  }
  return [...repeated];
}

// Validate parsed JSON as a store file of `kind`; throws STORE_INVALID or STORE_TOO_NEW.
export function validateStoreJson(json: unknown, kind: FileKind, label: string, opts: StoreReadOptions = {}): { data: StoreFileT; version: number } {
  const version = schemaVersion((json as { schema?: unknown } | null)?.schema);
  const parsed = StoreFile.safeParse(json);
  if (!parsed.success) {
    if (version > STORE_VERSION) {
      throw new LaneboardError('STORE_TOO_NEW', `${label} is ${String((json as { schema: unknown }).schema)}; this laneboard supports ${STORE_SCHEMA}`);
    }
    throw new LaneboardError('STORE_INVALID', describeIssue(parsed.error, label));
  }
  // Keep the parsed JSON itself (not zod output) so unknown properties and key order survive a rewrite (W11).
  const data = json as StoreFileT;
  if (data.kind !== kind) throw new LaneboardError('STORE_INVALID', `${label} kind is "${data.kind}", expected "${kind}"`);
  if (kind === 'active' && data.next_id === undefined) throw new LaneboardError('STORE_INVALID', `${label} next_id is missing`);
  // Two tasks with one id (a git merge of the board, a hand edit): every command would reach only the first one.
  const repeated = opts.allowDuplicateIds ? [] : repeatedIds(data.tasks);
  if (repeated.length) {
    throw new LaneboardError('STORE_INVALID', `duplicate id ${repeated.join(', ')} in ${label}: two tasks have the same id`, {
      fix: 'laneboard doctor --fix (the copy created later gets a new id)',
    });
  }
  return { data, version };
}

// A line git writes into a file with a merge conflict.
const CONFLICT_MARKER_RE = /^(<{7}|>{7})( |$)/m;

// Not-JSON error for a store file: a merge conflict gets its own fix (the restore is the last resort, it drops the merge).
function notJson(file: string, label: string, raw: string, err: Error): LaneboardError {
  if (CONFLICT_MARKER_RE.test(raw)) {
    return new LaneboardError('STORE_INVALID', `${label} has git merge conflict markers (<<<<<<< ... >>>>>>>): ${file}`, {
      fix: `resolve the merge conflict in ${shellQuote(file)} (keep the tasks of both sides, then laneboard doctor --fix gives a repeated id a new one), or take one side: git checkout --ours ${shellQuote(file)}; last resort, the previous version: laneboard doctor --restore-backup`,
    });
  }
  return new LaneboardError('STORE_INVALID', `${label} is not valid JSON: ${err.message}`);
}

// Read one store file fresh from disk; checksum mismatch (hand edit) becomes a warning.
export function readStoreFile(storeDir: string, kind: FileKind, warnings: string[], opts: StoreReadOptions = {}): LoadedFile {
  const file = storeFilePath(storeDir, kind);
  const label = `${kind}.json`;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new LaneboardError('STORE_INVALID', `${label} is missing in ${storeDir}`);
    throw unreadableStoreFile(file, label, err);
  }
  return parseStoreFile(raw, file, kind, label, warnings, opts);
}

// A store file from its text (`file` and `label` name it in errors): doctor builds the restored file from the .bak's text this way.
export function parseStoreFile(raw: string, file: string, kind: FileKind, label: string, warnings: string[], opts: StoreReadOptions = {}): LoadedFile {
  let json: unknown;
  try {
    // An editor may save a byte order mark (Windows Notepad); JSON.parse refuses it, the content is fine.
    json = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err) {
    throw notJson(file, label, raw, err as Error);
  }
  const { data, version } = validateStoreJson(json, kind, label, opts);
  if (contentSha(data.tasks) !== data.content_sha256) {
    warnings.push(`${label} content_sha256 mismatch: the file was edited by hand; check it with laneboard doctor`);
  }
  const beforeJson = JSON.stringify(data);
  return { kind, data, raw, version, beforeJson, beforeIds: new Set(data.tasks.map((t) => t.id)) };
}

// Resolve ids present in both files: higher task rev wins, tie goes to active (W6). Returns repaired ids.
export function dedupeFiles(active: StoreFileT, archive: StoreFileT): string[] {
  const archived = new Map(archive.tasks.map((t) => [t.id, t] as const));
  const dropActive = new Set<string>();
  const dropArchive = new Set<string>();
  for (const task of active.tasks) {
    const other = archived.get(task.id);
    if (!other) continue;
    if (other.rev > task.rev) dropActive.add(task.id);
    else dropArchive.add(task.id);
  }
  if (dropActive.size) active.tasks = active.tasks.filter((t) => !dropActive.has(t.id));
  if (dropArchive.size) archive.tasks = archive.tasks.filter((t) => !dropArchive.has(t.id));
  return [...dropActive, ...dropArchive].sort();
}

// Numeric part of a task id (`LB-12` -> 12).
export function idNumber(id: string): number {
  return Number(id.slice(id.lastIndexOf('-') + 1));
}

// Highest numeric id across the given task lists, 0 when empty.
export function maxIdNumber(...lists: TaskT[][]): number {
  let max = 0;
  for (const list of lists) for (const t of list) max = Math.max(max, idNumber(t.id));
  return max;
}
