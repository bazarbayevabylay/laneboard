// Machine registry of boards (`~/.laneboard/boards.json`): init and setup add a board, `laneboard boards` lists them,
// `--board <prefix|name|path>` opens one read-only. The store's config.json stays the source of truth; the registry only
// remembers where boards are (a path that no longer holds a store is reported as missing, never deleted silently).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { configPath, loadConfig, storePrefix } from './config.ts';
import { LaneboardError } from './errors.ts';
import { ensureDir, writeFileAtomic } from './fsio.ts';
import { PREFIX_RE } from './schema.ts';
import { canonicalPath, readStoreFile, STORE_DIR_NAME } from './store.ts';
import type { StoreRef } from './store.ts';
import { withLock } from './transact.ts';
import type { LockOptions } from './lock.ts';

export const REGISTRY_SCHEMA = 'laneboard/boards@1';
export const REGISTRY_FILE = 'boards.json';

const Entry = z.looseObject({
  path: z.string().min(1),
  prefix: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  registered_at: z.string(),
});
const Registry = z.looseObject({ schema: z.string(), boards: z.array(Entry) });

export type BoardEntry = z.infer<typeof Entry>;

// Directory of the registry: `<home>/.laneboard` (it holds boards.json, never a store's config.json).
export function registryDir(home: string): string {
  return path.join(home, STORE_DIR_NAME);
}

// Path of boards.json.
export function registryFile(home: string): string {
  return path.join(registryDir(home), REGISTRY_FILE);
}

// Registry entries as on disk; no file yet -> none; a broken file fails with a fix (it is never overwritten blindly).
export function readRegistry(home: string): BoardEntry[] {
  const file = registryFile(home);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new LaneboardError('STORE_INVALID', `${file} is not valid JSON: ${(err as Error).message}`, { fix: `fix the JSON in ${file}, or delete it (laneboard setup <harness> or laneboard config --name <name> in each project adds its board again)` });
  }
  const parsed = Registry.safeParse(json);
  if (!parsed.success) throw new LaneboardError('STORE_INVALID', `${file} is not a laneboard board registry`, { fix: `fix ${file}, or delete it (laneboard setup <harness> or laneboard config --name <name> in each project adds its board again)` });
  return parsed.data.boards;
}

// Does this path hold a store (config.json present)?
export function isLiveBoard(dir: string): boolean {
  return fs.existsSync(configPath(dir));
}

// Change the registry under its own lock: `fn` gets the entries and returns the new list (or throws to change nothing).
export async function updateRegistry<T>(
  home: string,
  opts: LockOptions,
  fn: (entries: BoardEntry[]) => Promise<{ entries: BoardEntry[]; result: T }> | { entries: BoardEntry[]; result: T },
): Promise<T> {
  const dir = registryDir(home);
  ensureDir(dir);
  return withLock({ dir }, opts, async (lock) => {
    const { entries, result } = await fn(readRegistry(home));
    lock.assertHeld();
    writeFileAtomic(registryFile(home), `${JSON.stringify({ schema: REGISTRY_SCHEMA, boards: entries }, null, 2)}\n`, 0o644);
    return result;
  });
}

// Entries with `entry` added, or the entry of the same path replaced (registered_at kept).
export function upsertEntry(entries: BoardEntry[], entry: BoardEntry): BoardEntry[] {
  const old = entries.find((e) => e.path === entry.path);
  if (!old) return [...entries, entry];
  return entries.map((e) => (e.path === entry.path ? { ...e, ...entry, registered_at: old.registered_at } : e));
}

// Add or refresh the board at `dir` from its config (setup, config changes); a missing or broken store is not registered.
export async function registerStore(home: string, dir: string, opts: LockOptions = {}): Promise<boolean> {
  if (!isLiveBoard(dir)) return false;
  const config = loadConfig(dir);
  const entry: BoardEntry = { path: dir, prefix: config.prefix, name: config.name ?? null, description: config.description ?? null, registered_at: new Date().toISOString() };
  await updateRegistry(home, opts, (entries) => ({ entries: upsertEntry(entries, entry), result: undefined }));
  return true;
}

// Prefixes of live boards other than the one at `exceptPath`.
export function takenPrefixes(entries: readonly BoardEntry[], exceptPath: string): Map<string, string> {
  const taken = new Map<string, string>();
  for (const e of entries) {
    if (e.path === exceptPath || !isLiveBoard(e.path)) continue;
    let prefix = e.prefix;
    try {
      prefix = loadConfig(e.path).prefix;
    } catch {
      // A broken config still holds its board's ids: keep the registered prefix.
    }
    taken.set(prefix, e.path);
  }
  return taken;
}

// First free prefix: `prefix` itself, else the same with a number (CLAIMSPORT -> CLAIMSPOR2), at most 10 characters.
export function freePrefix(prefix: string, taken: ReadonlyMap<string, string>): string {
  if (!taken.has(prefix)) return prefix;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${prefix.slice(0, 10 - String(n).length)}${n}`;
    if (PREFIX_RE.test(candidate) && !taken.has(candidate)) return candidate;
  }
  return prefix;
}

export interface BoardInfo {
  path: string;
  name: string | null;
  prefix: string;
  description: string | null;
  // No store at this path any more (moved or deleted): shown, not removed.
  missing: boolean;
  // Why the store cannot be read, when it cannot.
  problem: string | null;
  // Active tasks per status, in config order.
  counts: Array<{ status: string; count: number }>;
  total: number;
  // Last write to active.json or archive.json.
  updated_at: string | null;
}

// One registry entry with what its store says now (lock-free reads, nothing written).
function boardInfo(e: BoardEntry): BoardInfo {
  const base: BoardInfo = { path: e.path, name: e.name, prefix: e.prefix, description: e.description, missing: false, problem: null, counts: [], total: 0, updated_at: null };
  if (!isLiveBoard(e.path)) return { ...base, missing: true };
  try {
    const config = loadConfig(e.path);
    const warnings: string[] = [];
    const active = readStoreFile(e.path, 'active', warnings).data;
    const archive = readStoreFile(e.path, 'archive', warnings).data;
    const counts = new Map<string, number>(config.statuses.map((s) => [s, 0]));
    for (const t of active.tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
    return {
      ...base,
      name: config.name ?? null,
      prefix: config.prefix,
      description: config.description ?? null,
      counts: [...counts].map(([status, count]) => ({ status, count })),
      total: active.tasks.length,
      updated_at: active.updated_at > archive.updated_at ? active.updated_at : archive.updated_at,
    };
  } catch (err) {
    return { ...base, problem: (err as Error).message };
  }
}

export interface BoardsResult {
  registry: string;
  boards: BoardInfo[];
}

// Every registered board with its task counts (CLI `laneboard boards`).
export async function listBoards(home: string): Promise<{ data: BoardsResult; warnings: string[] }> {
  const boards = readRegistry(home).map(boardInfo);
  return { data: { registry: registryFile(home), boards }, warnings: [] };
}

// A board of the machine the all-boards reads open (ADR §29): read-only like --board; `current`: the store the command runs on.
export interface LiveBoard {
  store: StoreRef;
  current: boolean;
  // As registered (the store's config.json is the truth once it is read): what a board that cannot be read is listed by.
  prefix: string;
  name: string | null;
}

// A registry entry whose path holds no store any more: listed with its problem, never read.
export interface MissingBoard {
  path: string;
  prefix: string;
  name: string | null;
  problem: string;
}

// The boards the all-boards reads walk, one after another (ADR §29): the current store first (also when it is not registered), then
// every registry entry holding a store, each path once (canonicalPath); entries without a store come back as `missing`, not thrown.
export function liveBoards(home: string, current?: StoreRef): { boards: LiveBoard[]; missing: MissingBoard[] } {
  const seen = new Set<string>();
  const boards: LiveBoard[] = [];
  const missing: MissingBoard[] = [];
  const entries = readRegistry(home);
  if (current !== undefined) {
    seen.add(canonicalPath(current.dir));
    const entry = entries.find((e) => canonicalPath(e.path) === canonicalPath(current.dir));
    boards.push({ store: { dir: current.dir, found: 'board', readOnly: true }, current: true, prefix: storePrefix(current.dir) ?? entry?.prefix ?? '?', name: entry?.name ?? null });
  }
  for (const e of entries) {
    const key = canonicalPath(e.path);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isLiveBoard(e.path)) boards.push({ store: { dir: e.path, found: 'board', readOnly: true }, current: false, prefix: e.prefix, name: e.name });
    else missing.push({ path: e.path, prefix: e.prefix, name: e.name, problem: 'missing (no store at this path)' });
  }
  return { boards, missing };
}

// Does the value name a path (not a prefix or a name)?
function looksLikePath(value: string): boolean {
  return value.includes('/') || value.startsWith('.') || value.startsWith('~');
}

// Open another board read-only: a path (to a .laneboard directory or a project holding one), else a prefix or name from the registry.
export function resolveBoard(home: string | undefined, value: string, cwd: string): StoreRef {
  if (looksLikePath(value)) {
    const raw = value.startsWith('~') && home ? path.join(home, value.slice(1)) : value;
    const dir = path.resolve(cwd, raw);
    for (const candidate of [dir, path.join(dir, STORE_DIR_NAME)]) {
      if (isLiveBoard(candidate)) return { dir: candidate, found: 'board', readOnly: true };
    }
    throw new LaneboardError('STORE_NOT_FOUND', `--board ${value}: no laneboard store at ${dir}`, { fix: 'laneboard boards lists the boards on this machine; pass one of their prefixes to --board' });
  }
  if (!home) throw new LaneboardError('STORE_NOT_FOUND', `--board ${value}: HOME is not set, so the board registry cannot be read`, { fix: 'pass the board path instead: --board <path to the project or its .laneboard>' });
  const live = readRegistry(home)
    .map(boardInfo)
    .filter((b) => !b.missing);
  const want = value.toLowerCase();
  const byPrefix = live.filter((b) => b.prefix.toLowerCase() === want);
  const hits = byPrefix.length ? byPrefix : live.filter((b) => (b.name ?? '').toLowerCase() === want);
  const first = hits[0];
  if (hits.length === 1 && first) return { dir: first.path, found: 'board', readOnly: true };
  const allowed = live.map((b) => b.prefix);
  if (hits.length > 1) {
    throw new LaneboardError('INVALID_VALUE', `--board ${value} matches ${hits.length} boards`, { allowed: hits.map((b) => b.prefix), fix: 'pass the prefix of one of them (`allowed`), or its path' });
  }
  throw new LaneboardError('STORE_NOT_FOUND', `--board ${value}: no board with this prefix or name in ${registryFile(home)}`, { allowed, fix: 'laneboard boards lists the boards on this machine; pass a prefix from `allowed`' });
}
