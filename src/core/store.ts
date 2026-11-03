// Store discovery and lock-free reading of store files (parse, validate, checksum, duplicate view).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeIssue, schemaVersion } from './config.ts';
import { LaneboardError } from './errors.ts';
import { STORE_SCHEMA, STORE_VERSION, StoreFile } from './schema.ts';
import type { FileKind, StoreFileT, TaskT } from './schema.ts';

export const STORE_DIR_NAME = '.laneboard';

// How a store was found: --dir, LANEBOARD_DIR, in the current directory, or in a parent of it (walk-up).
export type StoreSource = 'dir' | 'env' | 'cwd' | 'parent';

// A resolved store: absolute path of the `.laneboard` directory (and how discovery found it, when it did).
export interface StoreRef {
  dir: string;
  found?: StoreSource;
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
        fix: `laneboard init --dir ${dir}, or fix ${source}`,
      });
    }
    return { dir, found: input.dir !== undefined ? 'dir' : 'env' };
  }
  const start = path.resolve(input.cwd);
  let current = start;
  for (;;) {
    const candidate = path.join(current, STORE_DIR_NAME);
    if (isDir(candidate)) return { dir: candidate, found: current === start ? 'cwd' : 'parent' };
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new LaneboardError('STORE_NOT_FOUND', `no ${STORE_DIR_NAME} directory in ${path.resolve(input.cwd)} or any parent`);
}

// Warning for a store found in a parent directory: another project's store (a nested agent directory) would be used silently otherwise.
export function parentStoreWarning(ref: StoreRef, cwd: string, prefix: string | null): string | undefined {
  if (ref.found !== 'parent') return undefined;
  return (
    `using store ${ref.dir}${prefix ? ` (prefix ${prefix})` : ''} found in a parent directory, not in ${path.resolve(cwd)}; ` +
    `fine if it is this project's store, otherwise stop and ask the user (pin the right one: export LANEBOARD_DIR=<abs>/.laneboard)`
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
