// The single mutation path (W2-W8): lock -> fresh read -> validate -> mutate -> atomic write of touched files.
import { loadConfig } from './config.ts';
import { LaneboardError, READ_ONLY_BOARD_FIX } from './errors.ts';
import { removeOrphanTmp, writeFileAtomic } from './fsio.ts';
import { acquireLock } from './lock.ts';
import type { HeldLock, LockOptions } from './lock.ts';
import { STORE_SCHEMA, STORE_VERSION } from './schema.ts';
import type { ConfigT, FileKind, StoreFileT } from './schema.ts';
import { backupPath, contentSha, dedupeFiles, readStoreFile, serializeStoreFile, storeFilePath } from './store.ts';
import type { LoadedFile, StoreRef } from './store.ts';

// Test-only crash points, passed as an argument (never read from the environment, C7).
export type FaultPoint = 'after_tmp_write' | 'between_files';

export interface Faults {
  at: FaultPoint;
}

export interface TransactOptions extends LockOptions {
  faults?: Faults;
  // Sink for warnings (checksum mismatch, repaired duplicates).
  warnings?: string[];
  // Write every declared file, changed or not, and give each `.bak` the new content instead of the previous one (redact: the
  // removed text must not stay behind in a backup).
  freshBackups?: boolean;
}

// What a mutation callback sees: config, a fixed timestamp and the declared store files.
export interface State {
  readonly config: ConfigT;
  readonly now: string;
  readonly active: StoreFileT;
  readonly archive: StoreFileT;
  // Throw LOCK_LOST before a write of the callback's own (an attachment file) when the lock is too old.
  assertLockHeld(): void;
  // Run after the files are written, still under the lock (e.g. remove an attachment file).
  onCommit(fn: () => void): void;
  // Run when the transaction fails before any store file was replaced and the lock is still ours: undo a write of the callback's own
  // (attach removes the file it stored, so a failed metadata write leaves no file behind). After LOCK_LOST it does not run: another
  // process may own the lock and have written the same path (its file stays; an orphan of ours is left to doctor).
  onRollback(fn: () => void): void;
}

const STORE_FILE_MODE = 0o444;

// Run `fn` while holding the store lock, releasing it on every path.
export async function withLock<T>(store: StoreRef, opts: LockOptions, fn: (lock: HeldLock) => Promise<T> | T): Promise<T> {
  const lock = await acquireLock(store.dir, opts);
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
  // Write each `.bak` from the new content, not from the previous file (redact).
  freshBackups?: boolean;
  // Filled with each file whose replace was attempted (it may be on disk even when the write then throws).
  replacing?: FileKind[];
}

// Write every changed file; a file that gained tasks is written first, so a crash duplicates a task instead of losing it (W6).
export function commitFiles(storeDir: string, files: LoadedFile[], opts: CommitOptions): FileKind[] {
  const changed = files.filter((f) => opts.force?.has(f.kind) || JSON.stringify(f.data) !== f.beforeJson);
  const gained = (f: LoadedFile): boolean => f.data.tasks.some((t) => !f.beforeIds.has(t.id));
  changed.sort((a, b) => Number(gained(b)) - Number(gained(a)));
  changed.forEach((file, index) => {
    // A holder that stalled may have lost the lock to a stale takeover: never write over its new owner (W2).
    opts.lock.assertHeld(index > 0 ? changed.slice(0, index).map((f) => `${f.kind}.json`).join(', ') : undefined);
    if (index > 0) maybeFault(opts.faults, 'between_files');
    file.data.rev += 1;
    file.data.updated_at = opts.now;
    file.data.content_sha256 = contentSha(file.data.tasks);
    const content = serializeStoreFile(file.data);
    // Previous good version first, the same atomic way (W4); redact backs up the new content, so no copy of the old text remains.
    writeFileAtomic(backupPath(storeDir, file.kind), opts.freshBackups ? content : file.raw, STORE_FILE_MODE);
    writeFileAtomic(storeFilePath(storeDir, file.kind), content, STORE_FILE_MODE, {
      beforeRename: () => {
        if (index === 0) maybeFault(opts.faults, 'after_tmp_write');
        opts.replacing?.push(file.kind);
      },
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
function buildState(config: ConfigT, now: string, files: LoadedFile[], hooks: { commit: Array<() => void>; rollback: Array<() => void> }, lock: HeldLock): State {
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
      hooks.commit.push(fn);
    },
    onRollback: (fn) => {
      hooks.rollback.push(fn);
    },
    assertLockHeld: () => lock.assertHeld(),
  };
}

// Whether the lock is still ours (within the write deadline, so no stale takeover can have happened, W2).
function stillHeld(lock: HeldLock): boolean {
  try {
    lock.assertHeld();
    return true;
  } catch {
    // LOCK_LOST: past the deadline another process may hold the lock now; the caller then leaves everything as it is.
    return false;
  }
}

// Run the rollback hooks newest first; one that fails does not stop the others or replace the error being reported.
function runRollbacks(rollbacks: ReadonlyArray<() => void>): void {
  for (const undo of [...rollbacks].reverse()) {
    try {
      undo();
    } catch {
      // The caller rethrows the original error; a file the undo could not remove is an orphan, which doctor lists and removes.
    }
  }
}

// The only mutation path for CLI, MCP, board and import: every call reads fresh files (W3).
export async function transact<T>(store: StoreRef, spec: { files: readonly FileKind[] }, fn: (s: State) => T, opts: TransactOptions = {}): Promise<T> {
  // A board opened with --board is someone else's: reading it is fine, writing to it never is.
  if (store.readOnly) {
    throw new LaneboardError('STORE_READ_ONLY', `${store.dir} was opened with --board, which is read-only`, {
      fix: READ_ONLY_BOARD_FIX,
    });
  }
  const warnings = opts.warnings ?? [];
  return withLock(store, opts, (lock) => {
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
    const hooks = { commit: [] as Array<() => void>, rollback: [] as Array<() => void> };
    const replacing: FileKind[] = [];
    let result: T;
    try {
      result = fn(buildState(config, now, files, hooks, lock));
      const force = opts.freshBackups ? new Set(spec.files) : undefined;
      commitFiles(store.dir, files, { now, lock, faults: opts.faults, force, freshBackups: opts.freshBackups, replacing });
    } catch (err) {
      // Undo only while no store file can have been replaced (once one may be, its metadata needs the file) and only while the lock
      // is ours: after a stale takeover the paths the hooks would remove may be the new owner's.
      if (replacing.length === 0 && stillHeld(lock)) runRollbacks(hooks.rollback);
      throw err;
    }
    for (const hook of hooks.commit) hook();
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
  return withLock(store, opts, () => {
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
