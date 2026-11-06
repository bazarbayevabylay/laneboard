// Op: attach a file to a task or remove an attachment (task_attach).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../config.ts';
import { LaneboardError } from '../errors.ts';
import { ensureDir, NOT_WRITTEN_FIX, removeFile, writeFileAtomic } from '../fsio.ts';
import { ATTACHMENT_NAME_RE } from '../schema.ts';
import type { ConfigT } from '../schema.ts';
import { transact } from '../transact.ts';
import { actorSourceOf, addEvent, IdInput, normalizeId, parseInput, requireActiveTask, requireActor, toTaskView, touch, txOptions } from './common.ts';
import type { OpContext, OpResult, TaskView } from './common.ts';
import { missingTask } from './links.ts';

export const AttachInput = z.strictObject({
  id: IdInput,
  // Absolute path of the file to attach.
  path: z.string().min(1).optional(),
  // Stored name; defaults to the source file name.
  name: z.string().min(1).optional(),
  // Name of the attachment to remove.
  remove: z.string().min(1).optional(),
});
export type AttachInputT = z.infer<typeof AttachInput>;

const MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
};

// MIME type by file extension (application/octet-stream when unknown).
export function mimeFor(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return Object.hasOwn(MIME, ext) ? (MIME[ext] ?? 'application/octet-stream') : 'application/octet-stream';
}

// Case-insensitive match of a name against a simple glob (`*`, `?`).
export function globMatch(pattern: string, name: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`, 'i').test(name);
}

// Refuse a source whose name, stored name or link target matches config.attachments.deny_names (secrets, keys).
function checkDenied(config: ConfigT, names: Array<{ name: string; what: string }>): void {
  for (const { name, what } of names) {
    const pattern = config.attachments.deny_names.find((p) => globMatch(p, name));
    if (pattern) {
      throw new LaneboardError('INVALID_VALUE', `${what} "${name}" matches attachments.deny_names pattern "${pattern}" and is never attached`, {
        input: { field: 'path', value: name },
        fix: 'attach a file that holds no secrets; deny_names lives in .laneboard/config.json',
      });
    }
  }
}

// Directory holding a task's attachments.
export function attachmentDir(storeDir: string, id: string): string {
  return path.join(storeDir, 'attachments', id);
}

// Input error for an unusable source path.
function badSource(file: string, message: string, fix: string): LaneboardError {
  return new LaneboardError('INVALID_VALUE', message, { input: { field: 'path', value: file }, fix });
}

// Real path of the source (symlinks resolved), so deny_names also sees what a link points to.
function realSource(file: string): string {
  if (!path.isAbsolute(file)) throw badSource(file, `path "${file}" must be absolute`, 'pass an absolute path to the file');
  try {
    return fs.realpathSync(file);
  } catch {
    // Missing path or a dangling link is an input error, not a crash.
    throw badSource(file, `file ${file} does not exist or is not readable`, 'pass the path of an existing, readable file');
  }
}

// Read the whole source through one descriptor, never more than `limit` bytes (a growing file cannot slip past the limit).
function readSource(file: string, real: string, limit: number): Buffer {
  let fd: number;
  try {
    // O_NOFOLLOW: the resolved path must not turn into a link after realpath; O_NONBLOCK: a FIFO must not hang the open.
    fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    // Unreadable (permissions) or swapped for a link: an input error, not a crash.
    throw badSource(file, `file ${file} does not exist or is not readable`, 'pass the path of an existing, readable file');
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw badSource(file, `${file} is not a regular file`, 'attach a regular file; pack a directory into an archive first');
    const tooBig = (size: string): LaneboardError =>
      badSource(file, `${file} is ${size} bytes, over limits.attachment_bytes (${limit})`, `attach a file of at most ${limit} bytes, or raise limits.attachment_bytes in .laneboard/config.json`);
    if (stat.size > limit) throw tooBig(String(stat.size));
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      total += n;
      if (total > limit) throw tooBig(`more than ${limit}`);
      chunks.push(chunk.subarray(0, n));
    }
    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(fd);
  }
}

// SHA-256 hex of bytes (attachment metadata).
function sha256Of(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// Read the stored attachment back: its size and sha256 must equal the metadata about to be recorded, else remove it and fail.
// The copy is read in 64 KiB chunks, so a large attachment is not held in memory a second time (LB-65.6).
function verifyStored(file: string, size: number, sha256: string): void {
  const hash = crypto.createHash('sha256');
  let length = 0;
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      length += n;
      hash.update(chunk.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  if (length === size && hash.digest('hex') === sha256) return;
  // A broken copy must not stay behind under a name the metadata will never describe.
  removeFile(file);
  const reason = length === size ? 'sha256 differs' : `${length} of ${size} bytes`;
  throw new LaneboardError('INTERNAL', `${file} was stored broken (${reason}) and was removed; the task is unchanged`, { fix: NOT_WRITTEN_FIX });
}

// Copy a file into attachments/<id>/<name>, then record metadata in the same transaction; or remove one.
export async function attachFile(ctx: OpContext, input: AttachInputT): Promise<OpResult<TaskView>> {
  const actor = requireActor(ctx.actor);
  const p = parseInput(AttachInput, input);
  if ((p.path === undefined) === (p.remove === undefined)) {
    throw new LaneboardError('USAGE', 'pass either path (to attach) or remove (to detach)', { edit: p.path === undefined ? { args: ['<path>'] } : { drop: [{ name: 'remove' }] } });
  }
  if (p.remove !== undefined && p.name !== undefined) throw new LaneboardError('USAGE', 'name is only used when attaching', { edit: { drop: [{ name: 'name' }] } });
  const warnings: string[] = [];
  const opts = txOptions(ctx, warnings);
  const storeDir = ctx.store.dir;

  if (p.remove !== undefined) {
    const name = p.remove;
    const data = await transact(
      ctx.store,
      { files: ['active', 'archive'] },
      (s) => {
        const id = normalizeId(p.id, s.config.prefix);
        const task = requireActiveTask(s, id, (missing) => missingTask(ctx, missing, s.config.prefix, 'write'));
        const index = task.attachments.findIndex((a) => a.name === name);
        if (index < 0) {
          throw new LaneboardError('ATTACHMENT_NOT_FOUND', `${id} has no attachment "${name}"`, {
            allowed: task.attachments.map((a) => a.name),
            fix: `see attachment names: laneboard get ${id} --json`,
          });
        }
        task.attachments.splice(index, 1);
        touch(task, s.now, actor);
        addEvent(task, s.config, s.now, actor, 'detached', { name }, actorSourceOf(ctx));
        // Metadata goes first; the file is removed after the write, still under the lock.
        s.onCommit(() => removeFile(path.join(attachmentDir(storeDir, id), name)));
        return toTaskView(task, false);
      },
      opts,
    );
    return { data, warnings };
  }

  const source = p.path ?? '';
  const real = realSource(source);
  const name = p.name ?? path.basename(source);
  // Lock-free config read: deny_names and the size limit only change by hand.
  const config = loadConfig(storeDir);
  // Secrets first, so a fix never suggests renaming one (`--name`).
  checkDenied(config, [
    { name, what: 'attachment name' },
    { name: path.basename(source), what: 'file' },
    { name: path.basename(real), what: `link target of ${path.basename(source)}` },
  ]);
  if (!ATTACHMENT_NAME_RE.test(name)) {
    throw new LaneboardError('INVALID_VALUE', `attachment name "${name}" must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`, {
      input: { field: 'name', value: name },
      fix: 'pass --name with letters, digits, dot, dash or underscore',
    });
  }
  // Read before the lock: a slow source (network mount, cloud placeholder) must not stall the lock holder (W2).
  const bytes = readSource(source, real, config.limits.attachment_bytes);
  const data = await transact(
    ctx.store,
    { files: ['active', 'archive'] },
    (s) => {
      const id = normalizeId(p.id, s.config.prefix);
      const task = requireActiveTask(s, id, (missing) => missingTask(ctx, missing, s.config.prefix, 'write'));
      if (task.attachments.some((a) => a.name === name)) {
        throw new LaneboardError('ATTACHMENT_EXISTS', `${id} already has an attachment "${name}"`, {
          fix: `pick another --name, or remove the old one first: laneboard attach ${id} --remove ${name} --json`,
        });
      }
      const dir = attachmentDir(storeDir, id);
      s.assertLockHeld();
      ensureDir(dir);
      const size = bytes.length;
      const sha256 = sha256Of(bytes);
      // File first, metadata second: a crash leaves an orphan file, never metadata without a file; a failed metadata write removes it.
      const file = path.join(dir, name);
      writeFileAtomic(file, bytes, 0o444, { tmpDir: storeDir });
      // The metadata write below may still fail (full disk): then the file goes too, the task stays as it was. After a lost lock the
      // file stays (transact skips the hook): another process may have stored its own file under this name meanwhile.
      s.onRollback(() => removeFile(file));
      // Metadata only for the bytes that are on disk (a short write on a full disk must not be recorded as the source file).
      verifyStored(file, size, sha256);
      const meta = {
        name,
        size,
        sha256,
        mime: mimeFor(name),
        added_by: actor,
        added_at: s.now,
      };
      task.attachments.push(meta);
      touch(task, s.now, actor);
      addEvent(task, s.config, s.now, actor, 'attached', { name, size: meta.size, sha256: meta.sha256 }, actorSourceOf(ctx));
      return toTaskView(task, false);
    },
    opts,
  );
  return { data, warnings };
}
