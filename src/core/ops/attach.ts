// Op: attach a file to a task or remove an attachment (task_attach).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { LaneboardError } from '../errors.ts';
import { ensureDir, removeFile, writeFileAtomic } from '../fsio.ts';
import { ATTACHMENT_NAME_RE } from '../schema.ts';
import type { ConfigT } from '../schema.ts';
import { transact } from '../transact.ts';
import { addEvent, IdInput, normalizeId, parseInput, requireActiveTask, requireActor, toTaskView, touch } from './common.ts';
import type { OpContext, OpResult, TaskView } from './common.ts';

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

// Refuse names matching config.attachments.deny_names (secrets, keys).
function checkDenied(config: ConfigT, names: string[]): void {
  for (const name of names) {
    const pattern = config.attachments.deny_names.find((p) => globMatch(p, name));
    if (pattern) {
      throw new LaneboardError('INVALID_VALUE', `"${name}" matches attachments.deny_names pattern "${pattern}" and is never attached`, {
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

// Read the source file outside the lock; size is checked before reading.
function readSource(file: string, limit: number): Buffer {
  if (!path.isAbsolute(file)) throw new LaneboardError('INVALID_VALUE', `path "${file}" must be absolute`, { input: { field: 'path', value: file } });
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    // Missing or unreadable source is an input error, not a crash.
    throw new LaneboardError('INVALID_VALUE', `file ${file} does not exist or is not readable`, { input: { field: 'path', value: file } });
  }
  if (!stat.isFile()) throw new LaneboardError('INVALID_VALUE', `${file} is not a regular file`, { input: { field: 'path', value: file } });
  if (stat.size > limit) {
    throw new LaneboardError('INVALID_VALUE', `${file} is ${stat.size} bytes, over limits.attachment_bytes (${limit})`, { input: { field: 'path', value: file } });
  }
  return fs.readFileSync(file);
}

// Copy a file into attachments/<id>/<name>, then record metadata in the same transaction; or remove one.
export async function attachFile(ctx: OpContext, input: AttachInputT): Promise<OpResult<TaskView>> {
  const actor = requireActor(ctx.actor);
  const p = parseInput(AttachInput, input);
  if ((p.path === undefined) === (p.remove === undefined)) throw new LaneboardError('USAGE', 'pass either path (to attach) or remove (to detach)');
  if (p.remove !== undefined && p.name !== undefined) throw new LaneboardError('USAGE', 'name is only used when attaching');
  const warnings: string[] = [];
  const opts = { faults: ctx.faults, lockWaitMs: ctx.lockWaitMs, warnings };
  const storeDir = ctx.store.dir;

  if (p.remove !== undefined) {
    const name = p.remove;
    const data = await transact(
      ctx.store,
      { files: ['active', 'archive'] },
      (s) => {
        const id = normalizeId(p.id, s.config.prefix);
        const task = requireActiveTask(s, id);
        const index = task.attachments.findIndex((a) => a.name === name);
        if (index < 0) {
          throw new LaneboardError('ATTACHMENT_NOT_FOUND', `${id} has no attachment "${name}"`, {
            allowed: task.attachments.map((a) => a.name),
            fix: `see attachment names: laneboard get ${id}`,
          });
        }
        task.attachments.splice(index, 1);
        touch(task, s.now, actor);
        addEvent(task, s.config, s.now, actor, 'detached', { name });
        // Metadata goes first; the file is removed after the write, still under the lock.
        s.onCommit(() => removeFile(path.join(attachmentDir(storeDir, id), name)));
        return toTaskView(task, false);
      },
      opts,
    );
    return { data, warnings };
  }

  const source = p.path ?? '';
  const name = p.name ?? path.basename(source);
  if (!ATTACHMENT_NAME_RE.test(name)) {
    throw new LaneboardError('INVALID_VALUE', `attachment name "${name}" must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`, {
      input: { field: 'name', value: name },
      fix: 'pass --name with letters, digits, dot, dash or underscore',
    });
  }
  const data = await transact(
    ctx.store,
    { files: ['active', 'archive'] },
    (s) => {
      const id = normalizeId(p.id, s.config.prefix);
      checkDenied(s.config, [name, path.basename(source)]);
      const task = requireActiveTask(s, id);
      if (task.attachments.some((a) => a.name === name)) {
        throw new LaneboardError('ATTACHMENT_EXISTS', `${id} already has an attachment "${name}"`, {
          fix: `pick another --name, or remove the old one first: laneboard attach ${id} --remove ${name}`,
        });
      }
      const bytes = readSource(source, s.config.limits.attachment_bytes);
      const dir = attachmentDir(storeDir, id);
      ensureDir(dir);
      // File first, metadata second: a crash leaves an orphan file, never metadata without a file.
      writeFileAtomic(path.join(dir, name), bytes, 0o444, { tmpDir: storeDir });
      const meta = {
        name,
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        mime: mimeFor(name),
        added_by: actor,
        added_at: s.now,
      };
      task.attachments.push(meta);
      touch(task, s.now, actor);
      addEvent(task, s.config, s.now, actor, 'attached', { name, size: meta.size, sha256: meta.sha256 });
      return toTaskView(task, false);
    },
    opts,
  );
  return { data, warnings };
}
