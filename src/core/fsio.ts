// The only module that writes store files (W1): atomic tmp+rename writes, cleanup, directory setup.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

// Atomically replace `target`: write tmp -> fsync -> chmod -> rename -> fsync dir (W4).
export function writeFileAtomic(target: string, content: string | Buffer, mode: number, opts: AtomicWriteOptions = {}): void {
  const dir = path.dirname(target);
  const tmpDir = opts.tmpDir ?? dir;
  const tmp = path.join(tmpDir, `${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, mode);
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

// Move a file aside under a new name in the same directory (keeps a broken store file for inspection).
export function moveAside(file: string, newName: string): string {
  const dest = path.join(path.dirname(file), newName);
  fs.renameSync(file, dest);
  fsyncDir(path.dirname(file));
  return dest;
}
