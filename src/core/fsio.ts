// The only module that writes store files (W1): atomic tmp+rename writes, cleanup, directory setup.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LaneboardError } from './errors.ts';

// Tmp files look like `<target>.<pid>.<random>.tmp` and live directly in the store directory.
const TMP_RE = /\.\d+\.[a-f0-9]+\.tmp$/;

export interface AtomicWriteOptions {
  // Directory for the tmp file; must be on the same filesystem as the target. Defaults to the target's directory.
  tmpDir?: string;
  // Called after the tmp file is complete and before it replaces the target (fault injection in tests).
  beforeRename?: () => void;
}

// Fsync a directory so a completed rename survives a power loss.
function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Fix of a write the disk did not take in full (the cause is almost always a full disk or a file size limit).
export const NOT_WRITTEN_FIX = 'free disk space, then run the same command again';

// A write that did not reach the disk in full (no space, file size limit, short write): the file was not replaced (W4).
// Not "the store is unchanged": in a two-file commit the first file may already be written (W6 order: a duplicate, never a loss).
function notWritten(file: string, reason: string): LaneboardError {
  return new LaneboardError('INTERNAL', `${file} was not written (${reason}); the file on disk was not replaced`, {
    fix: NOT_WRITTEN_FIX,
  });
}

// Write every byte of `buf`: one writeSync may write fewer bytes (a full disk, ulimit -f) and the next one fails with the cause.
function writeAll(fd: number, buf: Buffer): void {
  let offset = 0;
  while (offset < buf.length) {
    const n = fs.writeSync(fd, buf, offset, buf.length - offset);
    if (n <= 0) throw Object.assign(new Error('write returned 0 bytes'), { code: 'SHORT_WRITE' });
    offset += n;
  }
}

// Atomically replace `target`: write tmp in full -> fsync -> size check -> chmod -> rename -> fsync dir (W4).
// A short write removes the tmp and throws notWritten, so the target (and its .bak) keep their old bytes.
export function writeFileAtomic(target: string, content: string | Buffer, mode: number, opts: AtomicWriteOptions = {}): void {
  const dir = path.dirname(target);
  const tmpDir = opts.tmpDir ?? dir;
  const tmp = path.join(tmpDir, `${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    writeAll(fd, buf);
    fs.fsyncSync(fd);
    const size = fs.fstatSync(fd).size;
    if (size !== buf.length) throw Object.assign(new Error(`${size} of ${buf.length} bytes on disk`), { code: 'SHORT_WRITE' });
  } catch (err) {
    // ENOSPC, EFBIG, EDQUOT, EIO or a short write: drop the partial tmp and name the cause; an error without a code is rethrown as is.
    try {
      fs.closeSync(fd);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === 'string') throw notWritten(target, code);
    throw err;
  }
  fs.closeSync(fd);
  // Permissions follow the user's umask, like any file they create (umask 077 keeps the board private).
  fs.chmodSync(tmp, mode & ~process.umask());
  opts.beforeRename?.();
  fs.renameSync(tmp, target);
  fsyncDir(dir);
  if (tmpDir !== dir) fsyncDir(tmpDir);
}

// Remove orphan tmp files left by crashed writers; call only while holding the store lock (W4).
export function removeOrphanTmp(storeDir: string): string[] {
  const removed: string[] = [];
  for (const name of fs.readdirSync(storeDir)) {
    if (!TMP_RE.test(name)) continue;
    fs.rmSync(path.join(storeDir, name), { force: true });
    removed.push(name);
  }
  return removed;
}

// List orphan tmp files without removing them (doctor report).
export function listOrphanTmp(storeDir: string): string[] {
  return fs.readdirSync(storeDir).filter((name) => TMP_RE.test(name));
}

// Create a directory and its parents if missing.
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

// Remove a file if it exists.
export function removeFile(file: string): void {
  fs.rmSync(file, { force: true });
}

// Remove a directory tree if it exists.
export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Move a file or folder to `target` (same filesystem), creating the target's folder; never replaces an existing target.
export function moveEntry(source: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) throw Object.assign(new Error(`${target} already exists`), { code: 'EEXIST' });
  fs.renameSync(source, target);
}

// Remove an empty directory (a stale lock, a folder emptied by doctor); false when it is gone or not empty.
export function removeEmptyDir(dir: string): boolean {
  try {
    fs.rmdirSync(dir);
    return true;
  } catch (err) {
    // Someone removed it first, or it holds files: leave it.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') return false;
    throw err;
  }
}
