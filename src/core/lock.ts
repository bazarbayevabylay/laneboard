// Store lock (W2): proper-lockfile mkdir lock `.laneboard/lock` with mtime heartbeat and stale takeover.
import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { LaneboardError } from './errors.ts';
import { removeEmptyDir } from './fsio.ts';
import { shellQuote } from './shell.ts';

// proper-lockfile loads signal-exit, which re-raises SIGXFSZ when no one else listens, so a file size limit (ulimit -f) killed the
// process mid-write (exit 153, no reply). With a listener the write fails with EFBIG instead and fsio reports it (S6a, A1).
process.on('SIGXFSZ', () => {});

export const LOCK_STALE_MS = 10_000;
export const LOCK_UPDATE_MS = 5_000;
// Longer than the stale window, so a dead holder is always outwaited.
export const LOCK_WAIT_MS = 15_000;
// Latest moment after the acquire at which a holder may still write: half the stale window,
// so the write itself ends long before another process may take the lock over as stale.
export const LOCK_MAX_HOLD_MS = LOCK_STALE_MS / 2;
// After this long waiting, the caller hears why the command is slow (onLockWait).
export const LOCK_NOTICE_MS = 1_000;
// A lock this far ahead of the clock counts as "from the future". Not 0: proper-lockfile sets a new lock's mtime up to 1 s ahead
// (its precision probe rounds up to the next second), so a fresh live lock is often slightly in the future.
export const LOCK_FUTURE_SLACK_MS = 2_000;

export interface LockOptions {
  // Wait budget for a busy lock (default LOCK_WAIT_MS).
  lockWaitMs?: number;
  // Write deadline after the acquire (default LOCK_MAX_HOLD_MS; tests pass a smaller one).
  lockMaxHoldMs?: number;
  // Told once, after LOCK_NOTICE_MS of waiting, that the command waits for the lock (CLI human mode: a line on stderr).
  onLockWait?: (message: string) => void;
  // Sink for warnings (a stale lock with a time in the future was removed).
  warnings?: string[];
}

export interface HeldLock {
  release(): Promise<void>;
  // Throw LOCK_LOST when the lock is too old to write under; call right before every write.
  // Bodies under the lock are synchronous, so the heartbeat never runs inside them and
  // the time since the acquire is the only reliable signal (a pause, a sleep, a slow disk).
  assertHeld(written?: string): void;
}

// Sleep for a short random time between lock attempts.
function backoff(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 45));
}

// fs for proper-lockfile that can skip removing the lock directory once it may belong to another process.
function lockFs(state: { keepDir: boolean }): typeof fs {
  return {
    ...fs,
    rmdir: ((dir: fs.PathLike, cb: fs.NoParamCallback) => (state.keepDir ? cb(null) : fs.rmdir(dir, cb))) as typeof fs.rmdir,
    rmdirSync: ((dir: fs.PathLike) => (state.keepDir ? undefined : fs.rmdirSync(dir))) as typeof fs.rmdirSync,
  };
}

// What identifies one lock directory: its inode and mtime (a live holder moves the mtime every LOCK_UPDATE_MS).
interface LockStamp {
  ino: number;
  mtimeMs: number;
}

// Stamp of the lock directory, undefined when it is gone.
function lockStamp(lockPath: string): LockStamp | undefined {
  try {
    const st = fs.statSync(lockPath);
    return { ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {
    // Released between the failed attempt and this look: nothing to describe.
    return undefined;
  }
}

// A lock whose mtime lies in the future (the clock went back, another host's clock) never looks stale to proper-lockfile until the
// clock catches up. Watched here: unchanged for LOCK_STALE_MS of our own waiting, its holder is dead (a live one moves the mtime
// every LOCK_UPDATE_MS), so it is removed like any stale lock.
interface FutureWatch {
  stamp: LockStamp;
  since: number;
}

// Is the lock's mtime ahead of the clock by more than proper-lockfile's own rounding?
function isFuture(stamp: LockStamp, now: number): boolean {
  return stamp.mtimeMs > now + LOCK_FUTURE_SLACK_MS;
}

// Track a lock seen with a future mtime; true once it stayed unchanged for the whole stale window.
function futureLockIsStale(watch: { current?: FutureWatch }, stamp: LockStamp | undefined, now: number): boolean {
  const same = stamp !== undefined && watch.current !== undefined && watch.current.stamp.ino === stamp.ino && watch.current.stamp.mtimeMs === stamp.mtimeMs;
  if (!same) {
    watch.current = stamp !== undefined && isFuture(stamp, now) ? { stamp, since: now } : undefined;
    return false;
  }
  return now - (watch.current as FutureWatch).since >= LOCK_STALE_MS;
}

// Remove a stale lock directory, but only if it is still the one that was watched (a new holder's lock has another stamp).
function removeStaleLock(lockPath: string, watched: LockStamp): boolean {
  const now = lockStamp(lockPath);
  if (now === undefined || now.ino !== watched.ino || now.mtimeMs !== watched.mtimeMs) return false;
  return removeEmptyDir(lockPath);
}

// How the lock looks right now, for messages: "last touched <time>" or "its time <time> is in the future".
function describeLock(stamp: LockStamp | undefined): string {
  if (stamp === undefined) return '';
  const at = new Date(stamp.mtimeMs).toISOString();
  return isFuture(stamp, Date.now()) ? `; its time ${at} is in the future (the clock was changed)` : `; the lock was last touched at ${at}`;
}

// LOCK_TIMEOUT naming the lock, its time and, for a lock from the future, how to remove it.
function lockTimeout(lockPath: string, waitMs: number): LaneboardError {
  const stamp = lockStamp(lockPath);
  const message = `store is locked by another laneboard process (waited ${(waitMs / 1000).toFixed(1)} s for ${lockPath}${describeLock(stamp)})`;
  if (stamp !== undefined && isFuture(stamp, Date.now())) {
    return new LaneboardError('LOCK_TIMEOUT', message, { fix: `if no laneboard command is running on this board: rmdir ${shellQuote(lockPath)}, then run the same command again` });
  }
  return new LaneboardError('LOCK_TIMEOUT', message);
}

// Acquire the store lock, waiting up to `lockWaitMs`; throws LOCK_TIMEOUT when the budget runs out.
export async function acquireLock(storeDir: string, opts: LockOptions = {}): Promise<HeldLock> {
  const waitMs = opts.lockWaitMs ?? LOCK_WAIT_MS;
  const maxHoldMs = opts.lockMaxHoldMs ?? LOCK_MAX_HOLD_MS;
  const started = Date.now();
  const deadline = started + waitMs;
  const lockPath = path.join(storeDir, 'lock');
  const watch: { current?: FutureWatch } = {};
  let noticed = false;
  let compromised = false;
  for (;;) {
    const state = { keepDir: false };
    try {
      const release = await lockfile.lock(storeDir, {
        lockfilePath: lockPath,
        realpath: false,
        stale: LOCK_STALE_MS,
        update: LOCK_UPDATE_MS,
        retries: 0,
        fs: lockFs(state),
        onCompromised: () => {
          compromised = true;
        },
      });
      const acquiredAt = Date.now();
      return {
        release: async () => {
          // Held past the stale window without a heartbeat: the directory may be another process's lock now.
          // Leave it; if it is still ours, it is stale and the next writer takes it over at once.
          if (Date.now() - acquiredAt >= LOCK_STALE_MS) state.keepDir = true;
          try {
            await release();
          } catch (err) {
            // A compromised lock is already gone; nothing else to release.
            if (!compromised) throw err;
          }
        },
        assertHeld: (written) => {
          if (Date.now() - acquiredAt < maxHoldMs) return;
          const done = written ? `only ${written} was written (the next command repairs the half-done move)` : 'nothing was written';
          throw new LaneboardError(
            'LOCK_LOST',
            `held the store lock past the ${maxHoldMs / 1000} s write deadline (process paused or too slow); another laneboard process may own the lock now, so ${done}`,
          );
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ELOCKED') throw err;
      const now = Date.now();
      const stamp = lockStamp(lockPath);
      if (futureLockIsStale(watch, stamp, now) && removeStaleLock(lockPath, (watch.current as FutureWatch).stamp)) {
        opts.warnings?.push(`removed a stale store lock ${lockPath} whose time ${new Date((watch.current as FutureWatch).stamp.mtimeMs).toISOString()} was in the future (the clock was changed)`);
        watch.current = undefined;
        continue;
      }
      if (now >= deadline) throw lockTimeout(lockPath, waitMs);
      if (!noticed && now - started >= LOCK_NOTICE_MS && opts.onLockWait) {
        noticed = true;
        opts.onLockWait(
          `waiting for the store lock ${lockPath}: another laneboard process holds it, or one that stopped left it (taken over after ${LOCK_STALE_MS / 1000} s)${describeLock(stamp)}; giving up after ${(waitMs / 1000).toFixed(0)} s`,
        );
      }
      await backoff();
    }
  }
}
