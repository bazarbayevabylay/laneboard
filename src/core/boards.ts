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
import { shellQuote } from './shell.ts';
import { canonicalPath, readStoreFile, samePath, STORE_DIR_NAME } from './store.ts';
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

// What a registered path holds: a store ('live'), nothing any more ('missing': the path or a part of it is gone), or something that
// cannot be checked ('unreadable': no permission on the folder, an I/O error). An unreadable board is read like a live one, so it is
// reported with its problem and fix instead of as missing (existsSync says false on EACCES too; review S5b MINOR 1).
export function storeState(dir: string): 'live' | 'missing' | 'unreadable' {
  try {
    fs.statSync(configPath(dir));
    return 'live';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
  }
}

// Errors of a registry folder that cannot be written at all: a read-only HOME, a harness sandbox (Codex workspace-write), a read-only disk.
const UNWRITABLE = new Set(['EACCES', 'EPERM', 'EROFS']);

// The errno code of an error that means the registry folder cannot be written, else undefined.
function unwritableCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && UNWRITABLE.has(code) ? code : undefined;
}

export interface RegistryOptions extends LockOptions {
  // Given: a registry folder that cannot be made or locked (UNWRITABLE) does not fail the command (newcomer F3): `fn` runs on the
  // entries that can be read, without the registry lock, nothing is saved, and this gets the warning that says so.
  onUnwritable?: (warning: string) => void;
}

// The warning of a board left out of an unwritable registry (`code`: why the folder `dir` cannot be written).
function unregisteredWarning(dir: string, code: string): string {
  return (
    `this board is not in the machine registry (${dir} cannot be written: ${code}), so laneboard boards does not list it and its prefix was checked only against the boards listed there; ` +
    'once that folder is writable, laneboard config --name <name> in the project adds it'
  );
}

// Change the registry under its own lock: `fn` gets the entries and returns the new list (or throws to change nothing). A folder that
// cannot be made or locked fails the command, unless `opts.onUnwritable` takes the warning (RegistryOptions).
export async function updateRegistry<T>(
  home: string,
  opts: RegistryOptions,
  fn: (entries: BoardEntry[]) => Promise<{ entries: BoardEntry[]; result: T }> | { entries: BoardEntry[]; result: T },
): Promise<T> {
  const dir = registryDir(home);
  // Set once `fn` runs under the lock: from then on every error is the command's own, never the registry folder's.
  let entered = false;
  try {
    ensureDir(dir);
    return await withLock({ dir }, opts, async (lock) => {
      entered = true;
      const { entries, result } = await fn(readRegistry(home));
      lock.assertHeld();
      writeFileAtomic(registryFile(home), `${JSON.stringify({ schema: REGISTRY_SCHEMA, boards: entries }, null, 2)}\n`, 0o644);
      return result;
    });
  } catch (err) {
    const code = unwritableCode(err);
    if (entered || code === undefined || opts.onUnwritable === undefined) throw err;
    const { result } = await fn(readableEntries(home));
    opts.onUnwritable(unregisteredWarning(dir, code));
    return result;
  }
}

// Registry entries for a command that cannot write the registry: none when the file cannot be read either (a broken file still fails).
function readableEntries(home: string): BoardEntry[] {
  try {
    return readRegistry(home);
  } catch (err) {
    // No permission to read it either: no board is known, as without a registry.
    if (unwritableCode(err) !== undefined) return [];
    throw err;
  }
}

// Entries with `entry` added, or the entry of the same path replaced (registered_at kept).
export function upsertEntry(entries: BoardEntry[], entry: BoardEntry): BoardEntry[] {
  const old = entries.find((e) => e.path === entry.path);
  if (!old) return [...entries, entry];
  return entries.map((e) => (e.path === entry.path ? { ...e, ...entry, registered_at: old.registered_at } : e));
}

// Add or refresh the board at `dir` from its config (setup, config changes); a missing or broken store is not registered (`registered`
// false). A prefix another live board uses is refused (checkPrefixFree), so a copied project folder cannot register a second board
// with the same ids; a board registered before that duplicate keeps working and gets a warning naming it. `harness`: the setup that
// asked (its fix undoes that setup on a refused copy).
// A registry folder that cannot be written (EACCES, EPERM, EROFS) is a warning, not a failure (`registered` false).
export async function registerStore(home: string, dir: string, opts: LockOptions & { harness?: string } = {}): Promise<{ registered: boolean; warnings: string[] }> {
  if (!isLiveBoard(dir)) return { registered: false, warnings: [] };
  const config = loadConfig(dir);
  const entry: BoardEntry = { path: dir, prefix: config.prefix, name: config.name ?? null, description: config.description ?? null, registered_at: new Date().toISOString() };
  const unwritable: string[] = [];
  const warnings = await updateRegistry(home, { ...opts, onUnwritable: (w) => unwritable.push(w) }, (entries) => {
    const found = checkPrefixFree(entries, dir, config.prefix, opts.harness);
    return { entries: upsertEntry(entries, entry), result: found };
  });
  return { registered: unwritable.length === 0, warnings: [...warnings, ...unwritable] };
}

// Prefixes of the boards other than the one at `exceptPath` (any spelling of that path) whose path still holds a store or cannot be
// checked: a board without permission on its folder keeps its ids, so its prefix stays taken (storeState; review S5c MINOR).
export function takenPrefixes(entries: readonly BoardEntry[], exceptPath: string): Map<string, string> {
  return new Map(otherBoards(entries, exceptPath).map((b) => [b.prefix, b.path] as const));
}

// INVALID_VALUE for a prefix another live board uses, with a free one as the suggestion (init, config --prefix).
export function prefixTaken(prefix: string, owner: string, taken: ReadonlyMap<string, string>): LaneboardError {
  const free = freePrefix(prefix, taken);
  return new LaneboardError('INVALID_VALUE', `prefix ${prefix} is already used by the board at ${owner}; two boards with one prefix have look-alike ids`, {
    input: { field: 'prefix', value: prefix, suggestion: free },
    details: { taken: [...taken.keys()].sort() },
    fix: `pick a free prefix: --prefix ${free}`,
  });
}

// A live board of the registry other than the one at `dir`, with the prefix its config.json says (else the registered one).
interface Holder {
  path: string;
  prefix: string;
  registered_at: string;
}

// The live boards of `entries` other than the one at `exceptPath` (any spelling of that path), each with its prefix: a board whose
// folder or config cannot be read keeps its registered prefix (storeState; review S5c MINOR).
function otherBoards(entries: readonly BoardEntry[], exceptPath: string): Holder[] {
  const out: Holder[] = [];
  for (const e of entries) {
    if (samePath(e.path, exceptPath) || storeState(e.path) === 'missing') continue;
    let prefix = e.prefix;
    try {
      prefix = loadConfig(e.path).prefix;
    } catch {
      // A broken or unreadable config still holds its board's ids: keep the registered prefix.
    }
    out.push({ path: e.path, prefix, registered_at: e.registered_at });
  }
  return out;
}

// INVALID_VALUE for registering the board at `dir` (setup, config) whose prefix the board at `owner`, registered earlier, uses: a
// copied project folder, or a board made while the other one could not be read. `registeredAt`: when this board itself was
// registered, if it is (a copy an older laneboard registered; its entry stays as it is). A board without tasks gets a free prefix
// (config --prefix; the CLI adds it to the caller's own config command); a board with tasks keeps its prefix (ids carry it): the fix
// undoes the setup that pinned this folder to it (`harness`, else a placeholder), the message names the other ways out.
export function prefixInUse(dir: string, prefix: string, owner: string, taken: ReadonlyMap<string, string>, registeredAt?: string, harness?: string): LaneboardError {
  const warnings: string[] = [];
  const count = readStoreFile(dir, 'active', warnings).data.tasks.length + readStoreFile(dir, 'archive', warnings).data.tasks.length;
  const details = { taken: [...taken.keys()].sort(), owner };
  const state =
    registeredAt === undefined
      ? 'so this board is not registered'
      : `this board is in the registry too (since ${registeredAt}, after that board), so its entry is not updated`;
  const head = `prefix ${prefix} of the board at ${dir} is already used by the board at ${owner}, registered earlier; two boards with one prefix have look-alike ids, ${state}`;
  if (count === 0) {
    const free = freePrefix(prefix, taken);
    return new LaneboardError('INVALID_VALUE', `${head}; give it a free prefix`, {
      details,
      fix: `laneboard config --prefix ${free} --dir ${shellQuote(dir)}`,
      edit: { add: [{ name: 'prefix', value: free }] },
    });
  }
  const h = harness ?? '<harness>';
  const project = shellQuote(path.dirname(owner));
  return new LaneboardError(
    'INVALID_VALUE',
    `${head}; it has ${count} task(s) with ids like ${prefix}-1, so its prefix cannot change. ` +
      `If this folder is a copy of that project, a harness set up here writes to the copy: undo that setup in this folder (the fix), ` +
      `and work on that board from its project (laneboard setup ${h} in ${project}); ` +
      `else move ${shellQuote(dir)} aside and create this project's own board (laneboard init --dir ${shellQuote(dir)} --name <name> --description "<whose project, what work>")`,
    { details, fix: `laneboard setup ${h} --remove --dir ${shellQuote(dir)}` },
  );
}

// The prefix check of every registration, not only init. Another live board with `prefix` that was registered earlier than the board
// at `dir` (or `dir` is not registered yet) -> refused (prefixInUse). A board registered under this path before every other board with
// its prefix keeps working: duplicates registered after it (older laneboard versions did not check) only make a warning (ADR §33).
export function checkPrefixFree(entries: readonly BoardEntry[], dir: string, prefix: string, harness?: string): string[] {
  const holders = otherBoards(entries, dir).filter((b) => b.prefix === prefix);
  if (holders.length === 0) return [];
  const own = entries
    .filter((e) => samePath(e.path, dir))
    .map((e) => e.registered_at)
    .sort()[0];
  const earlier = holders.filter((b) => own === undefined || b.registered_at < own).sort((a, b) => (a.registered_at < b.registered_at ? -1 : 1));
  const owner = earlier[0];
  if (owner !== undefined) throw prefixInUse(dir, prefix, owner.path, takenPrefixes(entries, dir), own, harness);
  return holders.map((b) => {
    const head = `prefix ${prefix} is also used by the board at ${b.path}, registered later (a copied project folder?); its ids look like this board's and its changes are refused`;
    const n = taskCount(b.path);
    if (n === 0) return `${head} until it gets a free prefix: laneboard config --prefix ${freePrefix(prefix, takenPrefixes(entries, b.path))} --dir ${shellQuote(b.path)}`;
    const why = n === undefined ? 'its files cannot be read, so it may hold tasks' : `it has ${n} task(s), so its prefix cannot change`;
    return `${head}; ${why}: move ${shellQuote(b.path)} aside, or undo the harness setup there (laneboard setup <harness> --remove in ${shellQuote(path.dirname(b.path))})`;
  });
}

// Active and archived tasks of the store at `dir`; undefined when its files cannot be read (the warning then says less).
function taskCount(dir: string): number | undefined {
  const warnings: string[] = [];
  try {
    return readStoreFile(dir, 'active', warnings).data.tasks.length + readStoreFile(dir, 'archive', warnings).data.tasks.length;
  } catch {
    // An unreadable or broken copy: it may hold tasks, so it is not offered a prefix change.
    return undefined;
  }
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
  if (storeState(e.path) === 'missing') return { ...base, missing: true };
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
// every registry entry holding a store (or one that cannot be checked: its read reports why), each path once (canonicalPath); entries
// without a store come back as `missing`, not thrown.
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
    if (storeState(e.path) !== 'missing') boards.push({ store: { dir: e.path, found: 'board', readOnly: true }, current: false, prefix: e.prefix, name: e.name });
    else missing.push({ path: e.path, prefix: e.prefix, name: e.name, problem: 'missing (no store at this path)' });
  }
  return { boards, missing };
}

// The board of this machine whose prefix is `prefix` (its config.json, else as registered), other than `current`, and the prefixes
// of all those boards (`allowed` of an error): task links and ids of another board find their board here (ADR §30).
export function boardByPrefix(home: string, prefix: string, current?: StoreRef): { board: LiveBoard | undefined; prefixes: string[] } {
  const others = liveBoards(home, current)
    .boards.filter((b) => !b.current)
    .map((b) => ({ ...b, prefix: storePrefix(b.store.dir) ?? b.prefix }));
  return { board: others.find((b) => b.prefix === prefix), prefixes: [...new Set(others.map((b) => b.prefix))] };
}

export interface ForgetResult {
  registry: string;
  // The entries dropped: their path held no store.
  forgotten: Array<{ path: string; prefix: string; name: string | null }>;
}

// Registry entries that `value` names: a path (the store folder or the project holding it, any spelling), else a prefix, else a name
// (both ignoring case, like --board).
function entriesNamed(entries: readonly BoardEntry[], value: string, home: string, cwd: string): BoardEntry[] {
  if (looksLikePath(value)) {
    const dir = path.resolve(cwd, value.startsWith('~') ? path.join(home, value.slice(1)) : value);
    return entries.filter((e) => e.path === dir || samePath(e.path, dir) || samePath(e.path, path.join(dir, STORE_DIR_NAME)));
  }
  const want = value.toLowerCase();
  const byPrefix = entries.filter((e) => e.prefix.toLowerCase() === want);
  return byPrefix.length ? byPrefix : entries.filter((e) => (e.name ?? '').toLowerCase() === want);
}

// `laneboard boards --forget <prefix|name|path>` (LB-26): drop the registry entries `value` names whose path holds no store any more (a
// moved or deleted board), under the registry lock. An entry whose path still holds a store (or cannot be checked) is never dropped:
// with no entry left to drop that is INVALID_VALUE, else a warning per kept entry.
export async function forgetBoard(home: string, value: string, cwd: string, opts: LockOptions = {}): Promise<{ data: ForgetResult; warnings: string[] }> {
  const notFound = (entries: readonly BoardEntry[]): LaneboardError =>
    new LaneboardError('STORE_NOT_FOUND', `--forget ${value}: no board with this prefix, name or path in ${registryFile(home)}`, {
      allowed: [...new Set(entries.map((e) => e.prefix))],
      fix: 'laneboard boards lists the boards on this machine; pass the prefix or the path of one shown as missing',
    });
  // Nothing registered: fail before the registry folder is made for the lock.
  if (readRegistry(home).length === 0) throw notFound([]);
  // A registry folder that cannot be written (read-only HOME, a sandbox): the entry cannot be dropped, said plainly, not INTERNAL.
  const unwritable = (): never => {
    throw new LaneboardError('STORE_READ_ONLY', `--forget ${value}: the machine registry ${registryDir(home)} cannot be written, so nothing was forgotten`, {
      fix: `make ${shellQuote(registryDir(home))} writable, then run laneboard boards --forget ${shellQuote(value)} again`,
    });
  };
  return updateRegistry(home, { ...opts, onUnwritable: unwritable }, (entries) => {
    const named = entriesNamed(entries, value, home, cwd);
    if (named.length === 0) throw notFound(entries);
    const gone = named.filter((e) => storeState(e.path) === 'missing');
    const live = named.filter((e) => !gone.includes(e));
    const first = live[0];
    if (gone.length === 0 && first !== undefined) {
      throw new LaneboardError('INVALID_VALUE', `--forget ${value}: the board at ${first.path} still holds a store; forget drops only entries whose path holds none (a moved or deleted board)`, {
        details: { path: first.path, prefix: first.prefix },
        // Never a fix that moves or deletes the store: an agent may run a fix blindly (ADR-0001 rule 13), and this board holds tasks.
        fix: 'nothing to do: a live board stays listed; laneboard boards shows the entries marked missing, the only ones --forget drops',
      });
    }
    const forgotten = gone.map((e) => ({ path: e.path, prefix: e.prefix, name: e.name }));
    const warnings = live.map((e) => `kept ${e.path} (${e.prefix}): it still holds a store, and forget drops only entries without one`);
    return { entries: entries.filter((e) => !gone.includes(e)), result: { data: { registry: registryFile(home), forgotten }, warnings } };
  });
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
