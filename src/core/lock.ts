// Store lock (W2): proper-lockfile mkdir lock `.laneboard/lock` with mtime heartbeat and stale takeover.
import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { LaneboardError } from './errors.ts';

export const LOCK_STALE_MS = 10_000;
export const LOCK_UPDATE_MS = 5_000;
// Longer than the stale window, so a dead holder is always outwaited.
export const LOCK_WAIT_MS = 15_000;
// Latest moment after the acquire at which a holder may still write: half the stale window,
// so the write itself ends long before another process may take the lock over as stale.
export const LOCK_MAX_HOLD_MS = LOCK_STALE_MS / 2;

export interface LockOptions {
  // Wait budget for a busy lock (default LOCK_WAIT_MS).
  lockWaitMs?: number;
  // Write deadline after the acquire (default LOCK_MAX_HOLD_MS; tests pass a smaller one).
  lockMaxHoldMs?: number;
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

// Acquire the store lock, waiting up to `lockWaitMs`; throws LOCK_TIMEOUT when the budget runs out.
export async function acquireLock(storeDir: string, opts: LockOptions = {}): Promise<HeldLock> {
  const waitMs = opts.lockWaitMs ?? LOCK_WAIT_MS;
  const maxHoldMs = opts.lockMaxHoldMs ?? LOCK_MAX_HOLD_MS;
  const deadline = Date.now() + waitMs;
  const lockPath = path.join(storeDir, 'lock');
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
      if (Date.now() >= deadline) {
        throw new LaneboardError('LOCK_TIMEOUT', `store is locked by another laneboard process (waited ${(waitMs / 1000).toFixed(1)} s for ${lockPath})`);
      }
      await backoff();
    }
  }
}
