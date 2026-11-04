// Store watcher shared by `view --watch` and the web board's live updates: fs.watch on the store folder (debounced) plus a stat poll
// as the safety net (network drives and some editors miss fs.watch events). Reads only; nothing is written.
import fs from 'node:fs';
import path from 'node:path';

// fs.watch reports one write as several events: react once after they settle.
const DEBOUNCE_MS = 100;
// Fallback poll when fs.watch misses an event: every 2 s.
export const WATCH_POLL_MS = 2000;

// The files whose change is a change of the board (archive.json too: archive and restore move tasks between files).
const WATCHED_FILES = ['active.json', 'archive.json', 'config.json'];

export interface WatchOptions {
  // Stop watching (Ctrl+C, a closed browser connection).
  signal?: AbortSignal;
  // Poll interval (default WATCH_POLL_MS).
  pollMs?: number;
  // false = leave fs.watch out, only the poll notices changes (tests).
  events?: boolean;
}

export interface StoreChange {
  // rev of active.json after the change; null while it cannot be read (being replaced, broken).
  rev: number | null;
}

// What changes when the store is written: size, mtime and inode of its files (an atomic write renames a new inode in).
function signature(storeDir: string): string {
  return WATCHED_FILES.map((f) => {
    try {
      const st = fs.statSync(path.join(storeDir, f));
      return `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      // A file missing for a moment (or for good) is part of the signature too.
      return 'missing';
    }
  }).join('|');
}

// rev of active.json, or null when it cannot be read right now (the watcher reports the change anyway).
function activeRev(storeDir: string): number | null {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(storeDir, 'active.json'), 'utf8')) as { rev?: unknown };
    return typeof json.rev === 'number' ? json.rev : null;
  } catch {
    // Missing or half-written file: the next change brings the rev.
    return null;
  }
}

// Wait until the store changes (fs.watch, with a poll as the safety net) or the signal is aborted; true = changed.
function nextChange(storeDir: string, opts: WatchOptions): Promise<boolean> {
  const { signal } = opts;
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const before = signature(storeDir);
    let timer: NodeJS.Timeout | undefined;
    let watcher: fs.FSWatcher | undefined;
    const done = (changed: boolean): void => {
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      watcher?.close();
      signal?.removeEventListener('abort', onAbort);
      resolve(changed);
    };
    const onAbort = (): void => done(false);
    const check = (): void => {
      if (signature(storeDir) !== before) done(true);
    };
    const poll = setInterval(check, opts.pollMs ?? WATCH_POLL_MS);
    try {
      if (opts.events !== false) {
        watcher = fs.watch(storeDir, () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(check, DEBOUNCE_MS);
        });
        // A watcher that fails later (the directory went away) leaves the poll in charge.
        watcher.on('error', () => watcher?.close());
      }
    } catch {
      // fs.watch is not available here: the poll alone notices changes.
      watcher = undefined;
    }
    signal?.addEventListener('abort', onAbort);
  });
}

// Call onChange after every change of the store until the signal is aborted; the next wait starts after onChange settles.
export async function watchStore(storeDir: string, onChange: (change: StoreChange) => Promise<void> | void, opts: WatchOptions = {}): Promise<void> {
  while (await nextChange(storeDir, opts)) await onChange({ rev: activeRev(storeDir) });
}
