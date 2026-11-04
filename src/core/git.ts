// The commit a folder's git checkout is at, when HEAD last moved and whether tracked files have uncommitted changes, all read from
// the repository files (laneboard never runs git; ADR-0001 §0, §19, §20).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// A full object name: SHA-1 (40 hex) or SHA-256 (64 hex).
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Text of a file, or undefined when it cannot be read.
function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    // No such file (no repository here, a ref that is not loose): the caller tries the next place.
    return undefined;
  }
}

// The checkout holding `cwd`: its folder (`root`) and git directory, the nearest `.git` folder or the folder a `.git` file names
// (worktree, submodule).
function checkout(cwd: string): { root: string; gitDir: string } | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    const stat = fs.statSync(dotGit, { throwIfNoEntry: false });
    if (stat?.isDirectory()) return { root: dir, gitDir: dotGit };
    if (stat?.isFile()) {
      const target = /^gitdir:\s*(.+)$/m.exec(readText(dotGit) ?? '')?.[1]?.trim();
      return target ? { root: dir, gitDir: path.resolve(dir, target) } : undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// The git directory of the repository holding `cwd`.
function gitDir(cwd: string): string | undefined {
  return checkout(cwd)?.gitDir;
}

// The commit HEAD points at for the repository holding `cwd`; undefined outside a repository, before the first commit,
// or for a ref format laneboard does not read (reftable).
export function gitHead(cwd: string): string | undefined {
  const dir = gitDir(cwd);
  if (dir === undefined) return undefined;
  const head = readText(path.join(dir, 'HEAD'))?.trim() ?? '';
  if (SHA_RE.test(head)) return head;
  const ref = /^ref:\s*(refs\/\S+)$/.exec(head)?.[1];
  if (ref === undefined) return undefined;
  // A worktree keeps its HEAD in its own folder and the branches in the main repository (named by `commondir`).
  const common = path.resolve(dir, readText(path.join(dir, 'commondir'))?.trim() || '.');
  for (const base of [dir, common]) {
    const loose = readText(path.join(base, ref))?.trim() ?? '';
    if (SHA_RE.test(loose)) return loose;
  }
  for (const line of (readText(path.join(common, 'packed-refs')) ?? '').split('\n')) {
    const [sha, name] = line.trim().split(' ');
    if (name === ref && sha !== undefined && SHA_RE.test(sha)) return sha;
  }
  return undefined;
}

// When HEAD last moved to `head` (unix seconds): the newest line of the HEAD reflog, if it names `head`; undefined without a reflog
// (core.logAllRefUpdates off) or when it does not match (the check is then skipped).
export function headMovedAt(cwd: string, head: string): number | undefined {
  const dir = gitDir(cwd);
  if (dir === undefined) return undefined;
  const last = (readText(path.join(dir, 'logs', 'HEAD')) ?? '').trimEnd().split('\n').at(-1) ?? '';
  // `<old> <new> <name> <<email>> <unix time> <zone>\t<message>`
  const m = /^\S+ (\S+) .*> (\d+) [+-]\d{4}/.exec(last);
  return m && m[1] === head ? Number(m[2]) : undefined;
}

// One entry of the git index: path, mode, size and modification time as staged, object id, flags.
interface IndexEntry {
  name: string;
  mode: number;
  size: number;
  mtimeSec: number;
  mtimeNsec: number;
  oid: Buffer;
  stage: number;
  // assume-unchanged or skip-worktree: git does not look at the file either.
  ignored: boolean;
  intentToAdd: boolean;
}

// A number of the index version 4 path compression (git varint.c: 7 bits per byte, +1 per continuation).
function readVarint(buf: Buffer, at: number): { value: number; next: number } {
  let c = buf[at] ?? 0;
  let value = c & 127;
  let next = at + 1;
  while (c & 128) {
    c = buf[next] ?? 0;
    next += 1;
    value = ((value + 1) << 7) + (c & 127);
  }
  return { value, next };
}

// Entries of the index file (versions 2-4, git Documentation/gitformat-index); undefined for anything else or a split index.
function readIndex(file: string, oidLength: number): IndexEntry[] | undefined {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    // No index (nothing staged yet in a new repository): nothing to compare.
    return undefined;
  }
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'DIRC') return undefined;
  const version = buf.readUInt32BE(4);
  if (version < 2 || version > 4) return undefined;
  const entries: IndexEntry[] = [];
  let at = 12;
  let previous = '';
  for (let i = buf.readUInt32BE(8); i > 0; i--) {
    // A cut or damaged index: no answer rather than a wrong one.
    if (at + 44 + oidLength > buf.length) return undefined;
    const flags = buf.readUInt16BE(at + 40 + oidLength);
    const hasExtended = version >= 3 && (flags & 0x4000) !== 0;
    const extended = hasExtended ? buf.readUInt16BE(at + 42 + oidLength) : 0;
    const nameAt = at + 42 + oidLength + (hasExtended ? 2 : 0);
    let name: string;
    let end: number;
    if (version === 4) {
      // The path is the previous one minus N characters plus a NUL-terminated suffix; no padding.
      const strip = readVarint(buf, nameAt);
      end = buf.indexOf(0, strip.next);
      if (end < 0) return undefined;
      name = previous.slice(0, previous.length - strip.value) + buf.toString('utf8', strip.next, end);
      end += 1;
    } else {
      const nul = buf.indexOf(0, nameAt);
      if (nul < 0) return undefined;
      name = buf.toString('utf8', nameAt, nul);
      // Entries are padded with NULs to a multiple of 8 bytes.
      end = at + Math.floor((nul - at + 8) / 8) * 8;
    }
    if (end > buf.length) return undefined;
    entries.push({
      name,
      mode: buf.readUInt32BE(at + 24),
      size: buf.readUInt32BE(at + 36),
      mtimeSec: buf.readUInt32BE(at + 8),
      mtimeNsec: buf.readUInt32BE(at + 12),
      oid: buf.subarray(at + 40, at + 40 + oidLength),
      stage: (flags >> 12) & 3,
      ignored: (flags & 0x8000) !== 0 || (extended & 0x4000) !== 0,
      intentToAdd: (extended & 0x2000) !== 0,
    });
    previous = name;
    at = end;
  }
  // A split index keeps most entries in another file ("link" extension): not read, so no answer.
  for (let ext = at; ext + 8 <= buf.length - oidLength; ext += 8 + buf.readUInt32BE(ext + 4)) {
    if (buf.toString('latin1', ext, ext + 4) === 'link') return undefined;
  }
  return entries;
}

// Is the file at `file` different from its index entry? The stat data first (as git does), the content's object id when it differs.
function entryChanged(file: string, e: IndexEntry): boolean {
  try {
    return statOrContentChanged(file, e);
  } catch {
    // The path cannot be read (a folder became a file, no permission): git cannot show it as committed either.
    return true;
  }
}

// entryChanged without the guard for unreadable paths.
function statOrContentChanged(file: string, e: IndexEntry): boolean {
  const st = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (st === undefined) return true;
  const type = e.mode & 0o170000;
  const link = type === 0o120000;
  if (link ? !st.isSymbolicLink() : !st.isFile()) return true;
  // Size 0 in the index may be git's mark for a "racily clean" entry (written in the same second as the index): then only the
  // content tells.
  const size = Number(st.size % 0x100000000n);
  if (size !== e.size && e.size !== 0) return true;
  // The executable bit is part of the content git commits.
  if (!link && ((e.mode & 0o100) !== 0) !== ((Number(st.mode) & 0o100) !== 0)) return true;
  const sec = Number((st.mtimeNs / 1000000000n) % 0x100000000n);
  const nsec = Number(st.mtimeNs % 1000000000n);
  // A git built without nanoseconds stores 0 there.
  if (size === e.size && sec === e.mtimeSec && (e.mtimeNsec === 0 || nsec === e.mtimeNsec)) return false;
  const content = link ? Buffer.from(fs.readlinkSync(file, { encoding: 'buffer' })) : fs.readFileSync(file);
  const hash = crypto.createHash(e.oid.length === 20 ? 'sha1' : 'sha256');
  hash.update(`blob ${content.length}\0`);
  hash.update(content);
  return !hash.digest().equals(e.oid);
}

// Do tracked files of the checkout holding `cwd` differ from the index (changed, deleted, unmerged, added with intent-to-add)?
// `head` gives the object id length (SHA-1 or SHA-256). Changes that are staged but not committed are not seen (that needs the
// commit's tree); undefined when the index cannot be read. Files under clean or text filters (LFS, autocrlf) may count as changed.
export function hasUncommittedChanges(cwd: string, head: string): boolean | undefined {
  const co = checkout(cwd);
  if (co === undefined) return undefined;
  const entries = readIndex(path.join(co.gitDir, 'index'), head.length / 2);
  if (entries === undefined) return undefined;
  for (const e of entries) {
    if (e.stage !== 0 || e.intentToAdd) return true;
    // Submodules and the directories of a sparse index have no file of their own to compare.
    const type = e.mode & 0o170000;
    if (e.ignored || type === 0o160000 || type === 0o040000) continue;
    if (entryChanged(path.join(co.root, e.name), e)) return true;
  }
  return false;
}
