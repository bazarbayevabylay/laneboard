// The single mutation path (W2-W8): lock -> fresh read -> validate -> mutate -> atomic write of touched files.
import { loadConfig } from './config.ts';
import { LaneboardError } from './errors.ts';
import { removeOrphanTmp, writeFileAtomic } from './fsio.ts';
import { acquireLock, LOCK_WAIT_MS } from './lock.ts';
import type { HeldLock } from './lock.ts';
import { STORE_SCHEMA, STORE_VERSION } from './schema.ts';
import type { ConfigT, FileKind, StoreFileT } from './schema.ts';
import { backupPath, contentSha, dedupeFiles, readStoreFile, serializeStoreFile, storeFilePath } from './store.ts';
import type { LoadedFile, StoreRef } from './store.ts';

// Test-only crash points, passed as an argument (never read from the environment, C7).
export type FaultPoint = 'after_tmp_write' | 'between_files';

export interface Faults {
  at: FaultPoint;
}

export interface TransactOptions {
  faults?: Faults;
  lockWaitMs?: number;
  // Sink for warnings (checksum mismatch, repaired duplicates).
  warnings?: string[];
}

// What a mutation callback sees: config, a fixed timestamp and the declared store files.
export interface State {
  readonly config: ConfigT;
  readonly now: string;
  readonly active: StoreFileT;
  readonly archive: StoreFileT;
  // Run after the files are written, still under the lock (e.g. remove an attachment file).
  onCommit(fn: () => void): void;
}

const STORE_FILE_MODE = 0o444;

// Run `fn` while holding the store lock, releasing it on every path.
export async function withLock<T>(store: StoreRef, waitMs: number | undefined, fn: (lock: HeldLock) => Promise<T> | T): Promise<T> {
  const lock = await acquireLock(store.dir, waitMs ?? LOCK_WAIT_MS);
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}

// Throw a simulated crash if the fault point matches.
function maybeFault(faults: Faults | undefined, at: FaultPoint): void {
  if (faults?.at === at) throw new Error(`fault injected: ${at}`);
}

export interface CommitOptions {
  now: string;
  lock: HeldLock;
  faults?: Faults;
  // Rewrite these files even when unchanged (doctor accepting a hand edit).
  force?: ReadonlySet<FileKind>;
}

// Write every changed file; a file that gained tasks is written first, so a crash duplicates a task instead of losing it (W6).
export function commitFiles(storeDir: string, files: LoadedFile[], opts: CommitOptions): FileKind[] {
  const changed = files.filter((f) => opts.force?.has(f.kind) || JSON.stringify(f.data) !== f.beforeJson);
  const gained = (f: LoadedFile): boolean => f.data.tasks.some((t) => !f.beforeIds.has(t.id));
  changed.sort((a, b) => Number(gained(b)) - Number(gained(a)));
  changed.forEach((file, index) => {
    if (opts.lock.isCompromised()) {
      throw new LaneboardError('LOCK_TIMEOUT', 'the store lock was lost before writing (heartbeat missed the stale window); nothing more was written');
    }
    if (index > 0) maybeFault(opts.faults, 'between_files');
    file.data.rev += 1;
    file.data.updated_at = opts.now;
    file.data.content_sha256 = contentSha(file.data.tasks);
    // Previous good version first, the same atomic way (W4).
    writeFileAtomic(backupPath(storeDir, file.kind), file.raw, STORE_FILE_MODE);
    writeFileAtomic(storeFilePath(storeDir, file.kind), serializeStoreFile(file.data), STORE_FILE_MODE, {
      beforeRename: index === 0 ? () => maybeFault(opts.faults, 'after_tmp_write') : undefined,
    });
  });
  return changed.map((f) => f.kind);
}

// Read the declared files under the lock; refuse to write files newer than this version (W10).
function loadForWrite(storeDir: string, kinds: readonly FileKind[], warnings: string[]): LoadedFile[] {
  const files = kinds.map((kind) => readStoreFile(storeDir, kind, warnings));
  for (const file of files) {
    if (file.version > STORE_VERSION) {
      throw new LaneboardError('STORE_TOO_NEW', `${file.kind}.json is ${file.data.schema}; this laneboard writes ${STORE_SCHEMA}`);
    }
  }
  return files;
}

// Expose only the declared files to the callback.
function buildState(config: ConfigT, now: string, files: LoadedFile[], hooks: Array<() => void>): State {
  const pick = (kind: FileKind): StoreFileT => {
    const file = files.find((f) => f.kind === kind);
    if (!file) throw new Error(`transact: ${kind}.json was not declared in files`);
    return file.data;
  };
  return {
    config,
    now,
    get active() {
      return pick('active');
    },
    get archive() {
      return pick('archive');
    },
    onCommit: (fn) => {
      hooks.push(fn);
    },
  };
}

// The only mutation path for CLI, MCP, board and import: every call reads fresh files (W3).
export async function transact<T>(store: StoreRef, spec: { files: readonly FileKind[] }, fn: (s: State) => T, opts: TransactOptions = {}): Promise<T> {
  const warnings = opts.warnings ?? [];
  return withLock(store, opts.lockWaitMs, (lock) => {
    // Orphans can only come from crashed writers, because live writers hold this lock (W4).
    removeOrphanTmp(store.dir);
    const config = loadConfig(store.dir);
    const now = new Date().toISOString();
    const files = loadForWrite(store.dir, spec.files, warnings);
    const active = files.find((f) => f.kind === 'active');
    const archive = files.find((f) => f.kind === 'archive');
    if (active && archive) {
      const repaired = dedupeFiles(active.data, archive.data);
      if (repaired.length) warnings.push(`repaired duplicate ids across active.json and archive.json: ${repaired.join(', ')}`);
    }
    const hooks: Array<() => void> = [];
    const result = fn(buildState(config, now, files, hooks));
    commitFiles(store.dir, files, { now, lock, faults: opts.faults });
    for (const hook of hooks) hook();
    return result;
  });
}

// A consistent read of both files under the lock with the duplicate view applied (W7); writes nothing.
export interface StoreView {
  config: ConfigT;
  active: StoreFileT;
  archive: StoreFileT;
}

// Read config and both files under the lock.
export async function readBoth(store: StoreRef, opts: TransactOptions = {}): Promise<StoreView> {
  const warnings = opts.warnings ?? [];
  return withLock(store, opts.lockWaitMs, () => {
    const config = loadConfig(store.dir);
    const active = readStoreFile(store.dir, 'active', warnings).data;
    const archive = readStoreFile(store.dir, 'archive', warnings).data;
    dedupeFiles(active, archive);
    return { config, active, archive };
  });
}

// Lock-free read of config and active.json only (single-file read, W7).
export function readActive(store: StoreRef, opts: TransactOptions = {}): { config: ConfigT; active: StoreFileT } {
  const warnings = opts.warnings ?? [];
  const config = loadConfig(store.dir);
  const active = readStoreFile(store.dir, 'active', warnings).data;
  return { config, active };
}
