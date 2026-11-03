// Store lock (W2): proper-lockfile mkdir lock `.laneboard/lock` with mtime heartbeat and stale takeover.
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { LaneboardError } from './errors.ts';

export const LOCK_STALE_MS = 10_000;
export const LOCK_UPDATE_MS = 5_000;
// Longer than the stale window, so a dead holder is always outwaited.
export const LOCK_WAIT_MS = 15_000;

export interface HeldLock {
  release(): Promise<void>;
  // True when the heartbeat failed and another process may have taken the lock over.
  isCompromised(): boolean;
}

// Sleep for a short random time between lock attempts.
function backoff(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 45));
}

// Acquire the store lock, waiting up to `waitMs`; throws LOCK_TIMEOUT when the budget runs out.
export async function acquireLock(storeDir: string, waitMs: number = LOCK_WAIT_MS): Promise<HeldLock> {
  const deadline = Date.now() + waitMs;
  let compromised = false;
  for (;;) {
    try {
      const release = await lockfile.lock(storeDir, {
        lockfilePath: path.join(storeDir, 'lock'),
        realpath: false,
        stale: LOCK_STALE_MS,
        update: LOCK_UPDATE_MS,
        retries: 0,
        onCompromised: () => {
          compromised = true;
        },
      });
      return {
        release: async () => {
          try {
            await release();
          } catch (err) {
            // A compromised lock is already gone; nothing else to release.
            if (!compromised) throw err;
          }
        },
        isCompromised: () => compromised,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ELOCKED') throw err;
      if (Date.now() >= deadline) {
        throw new LaneboardError('LOCK_TIMEOUT', `store is locked by another laneboard process (waited ${(waitMs / 1000).toFixed(1)} s for ${path.join(storeDir, 'lock')})`);
      }
      await backoff();
    }
  }
}
