// GET /api/tasks/:id/attachments/:name (ADR-0001 §31): one stored attachment file, read-only. The name must be one the task's
// metadata lists; the file comes from attachments/<task id>/ of that store only. Raster images may show inline, everything else
// is a download; the response is sandboxed and never sniffed, so a stored html or svg file cannot run on the board's origin.
import fs from 'node:fs';
import path from 'node:path';
import { getTask, LaneboardError } from '../../core/index.ts';
import type { StoreRef } from '../../core/index.ts';
import { errorReply, storeFor, taskId } from './api.ts';
import type { ApiContext, ApiReply } from './api.ts';
import { inlineImageType } from './attachment-types.ts';

// The route; the token rides in the query here too (an <img> or a download link cannot send a header).
export const ATTACHMENT_ROUTE_RE = /^\/api\/tasks\/([^/]+)\/attachments\/([^/]+)$/;

// A file to send, with every header decided here.
export interface FileReply {
  status: 200;
  headers: Record<string, string>;
  body: Buffer;
}

// Names safe to put into a quoted filename= as they are (the store's attachment names always are; anything else gets no filename).
const PLAIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// Headers of an attachment response: inline only for the listed raster images, else a download as octet-stream.
export function attachmentHeaders(name: string, size: number): Record<string, string> {
  const image = inlineImageType(name);
  const filename = PLAIN_NAME_RE.test(name) ? `; filename="${name}"` : '';
  return {
    'Content-Type': image ?? 'application/octet-stream',
    'Content-Disposition': `${image ? 'inline' : 'attachment'}${filename}`,
    'Content-Length': String(size),
    'X-Content-Type-Options': 'nosniff',
    // Opened on its own (a new tab), the file is a sandboxed document: no script, no same-origin access to the board's API.
    'Content-Security-Policy': 'sandbox',
    'Referrer-Policy': 'no-referrer',
    // The address carries the run's token: nothing is kept in the browser cache.
    'Cache-Control': 'no-store',
  };
}

// No such attachment, or no file for it: a plain-text 404 like any unknown path (the reason is for the server's own tests only).
export interface MissingReply {
  status: 404;
  text: string;
}

// A missing attachment.
function notFound(text: string): MissingReply {
  return { status: 404, text };
}

// The attachment name of the address; a malformed %-escape is bad input (400), like a malformed task id.
function attachmentName(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // URIError: a lone or truncated %, so no attachment can have this name.
    throw new LaneboardError('INVALID_VALUE', `attachment name ${raw} in the address is not valid URL encoding`, { fix: 'open the task again on the board and use its link' });
  }
}

// Path of the attachment file directly inside attachments/<id>/ of the store, or null when the id or the name would lead anywhere else.
export function attachmentPath(store: StoreRef, id: string, name: string): string | null {
  const root = path.join(store.dir, 'attachments');
  const dir = path.join(root, id);
  const file = path.join(dir, name);
  return path.dirname(dir) === root && path.dirname(file) === dir && file.startsWith(dir + path.sep) ? file : null;
}

// Answer one attachment request (the token is already checked): the file, or an error envelope.
export async function attachmentReply(ctx: ApiContext, url: URL): Promise<FileReply | MissingReply | ApiReply> {
  const match = ATTACHMENT_ROUTE_RE.exec(url.pathname);
  let store: StoreRef | null = null;
  try {
    const rawName = attachmentName(match?.[2] ?? '');
    store = await storeFor(ctx, url.searchParams.get('board'));
    const task = (await getTask({ store }, { id: taskId(match?.[1] ?? '') })).data;
    // The name in the address only picks an entry of the task's metadata; the path is built from that entry, never from the address.
    const meta = task.attachments.find((a) => a.name === rawName);
    if (!meta) return notFound(`${task.id} has no attachment ${rawName}`);
    const file = attachmentPath(store, task.id, meta.name);
    if (file === null) return notFound(`${task.id} has no attachment ${rawName}`);
    let body: Buffer;
    try {
      // A link or anything but a plain file (planted by hand) is not served.
      if (!fs.lstatSync(file).isFile()) return notFound(`attachment ${meta.name} of ${task.id} is not a plain file`);
      body = fs.readFileSync(file);
    } catch {
      // ENOENT and friends: the metadata names a file that is gone (removed by hand, or deleted after the read).
      return notFound(`attachment ${meta.name} of ${task.id} has no file in the store any more`);
    }
    return { status: 200, headers: attachmentHeaders(meta.name, body.length), body };
  } catch (err) {
    return errorReply(err, store);
  }
}
