// Store discovery and lock-free reading of store files (parse, validate, checksum, duplicate view).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeIssue, schemaVersion } from './config.ts';
import { LaneboardError } from './errors.ts';
import { STORE_SCHEMA, STORE_VERSION, StoreFile } from './schema.ts';
import type { FileKind, StoreFileT, TaskT } from './schema.ts';

export const STORE_DIR_NAME = '.laneboard';

// How a store was found: --dir, LANEBOARD_DIR, in the current directory, in a parent of it (walk-up), or --board (read-only).
export type StoreSource = 'dir' | 'env' | 'cwd' | 'parent' | 'board';

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

// Is `dir` the machine's board registry (`~/.laneboard` holds boards.json and no config.json), not a store?
function isRegistryDir(dir: string): boolean {
  return !fs.existsSync(path.join(dir, 'config.json')) && fs.existsSync(path.join(dir, 'boards.json'));
}

export interface DiscoveryInput {
  // Value of --dir, if given.
  dir?: string;
  // Value of LANEBOARD_DIR, if set.
  envDir?: string;
  cwd: string;
}

// Is `p` an existing directory?
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    // Missing or unreadable path counts as "no directory here".
    return false;
  }
}

// Find the store: --dir, then LANEBOARD_DIR, then walk up from cwd to `/` (first match wins).
export function resolveStore(input: DiscoveryInput): StoreRef {
  const explicit = input.dir ?? input.envDir;
  if (explicit !== undefined && explicit !== '') {
    const source = input.dir !== undefined ? '--dir' : 'LANEBOARD_DIR';
    const dir = path.resolve(input.cwd, explicit);
    if (!isDir(dir)) {
      throw new LaneboardError('STORE_NOT_FOUND', `${source} points to ${dir}, which is not a directory`, {
        fix: `fix ${source} (laneboard boards --json lists this machine's boards with their paths); if this project has no board yet: laneboard init --dir ${dir} --name <name> --description "<whose project, what work>"`,
      });
    }
    return { dir, found: input.dir !== undefined ? 'dir' : 'env' };
  }
  const start = path.resolve(input.cwd);
  let current = start;
  for (;;) {
    const candidate = path.join(current, STORE_DIR_NAME);
    if (isDir(candidate) && !isRegistryDir(candidate)) return { dir: candidate, found: current === start ? 'cwd' : 'parent' };
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new LaneboardError('STORE_NOT_FOUND', `no ${STORE_DIR_NAME} directory in ${path.resolve(input.cwd)} or any parent`);
}

// First project marker between cwd (included) and the folder that holds the store (excluded), as a path relative to cwd.
export function separateProjectMarker(storeDir: string, cwd: string): string | undefined {
  const owner = path.dirname(storeDir);
  const start = path.resolve(cwd);
  for (let current = start; current !== owner && path.dirname(current) !== current; current = path.dirname(current)) {
    const marker = PROJECT_MARKERS.find((m) => fs.existsSync(path.join(current, m)));
    if (marker) return path.relative(start, path.join(current, marker));
  }
  return undefined;
}

// Warning for a store found in a parent directory that looks like another project's (a project marker lies between):
// a nested agent folder would otherwise write silently into it. A plain subfolder of the same project gets none.
export function parentStoreWarning(ref: StoreRef, cwd: string, prefix: string | null): string | undefined {
  if (ref.found !== 'parent') return undefined;
  const marker = separateProjectMarker(ref.dir, cwd);
  if (marker === undefined) return undefined;
  return (
    `using store ${ref.dir}${prefix ? ` (prefix ${prefix})` : ''} found in a parent directory, but ${path.resolve(cwd)} looks like a separate project (it has ${marker}); ` +
    `unless this folder is part of that project, find its own board with laneboard boards --json (pin it: export LANEBOARD_DIR=<its path>), or create one: laneboard init --name <name> --description "<whose project, what work>"`
  );
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

// Validate parsed JSON as a store file of `kind`; throws STORE_INVALID or STORE_TOO_NEW.
export function validateStoreJson(json: unknown, kind: FileKind, label: string): { data: StoreFileT; version: number } {
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
  return { data, version };
}

// Read one store file fresh from disk; checksum mismatch (hand edit) becomes a warning.
export function readStoreFile(storeDir: string, kind: FileKind, warnings: string[]): LoadedFile {
  const file = storeFilePath(storeDir, kind);
  const label = `${kind}.json`;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new LaneboardError('STORE_INVALID', `${label} is missing in ${storeDir}`);
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new LaneboardError('STORE_INVALID', `${label} is not valid JSON: ${(err as Error).message}`);
  }
  const { data, version } = validateStoreJson(json, kind, label);
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
