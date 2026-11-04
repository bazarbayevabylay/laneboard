// Attachment files of the web board (ADR-0001 §31, S5w2): GET /api/tasks/:id/attachments/:name under the same Host and token rules,
// the token as ?token=; inline only for png/jpeg/gif/webp, everything else a sandboxed, never-sniffed octet-stream download;
// the file is picked by the task's metadata and read only from attachments/<id>/ (no traversal, no planted links).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { archiveTasks, attachFile, createTask, STALE_AFTER_MS, WAITING_OWNER_LABEL } from '../../src/core/index.ts';
import { attachmentHeaders, attachmentPath, attachmentReply, openAttachment } from '../../src/board/server/attachments.ts';
import { inlineImageType } from '../../src/board/server/attachment-types.ts';
import { notBuiltText, startBoardServer } from '../../src/board/server/http.ts';
import { hasDotSegment } from '../../src/board/server/security.ts';
import type { BoardServer } from '../../src/board/server/http.ts';
import { attachmentHref, MIN_REFRESH_MS, REFRESH_MS, refreshInterval } from '../../src/board/ui/query.ts';
import { attentionCounts, isResult, WAITING_OWNER_LABEL as UI_WAITING_OWNER_LABEL } from '../../src/board/ui/format.ts';
import { as, cleanupTemp, newStore, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

const running: BoardServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
});

// A 1×1 PNG (the bytes are only compared, never decoded here).
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const FILES: Record<string, string | Buffer> = {
  'shot.png': PNG,
  'photo.JPEG': PNG,
  'page.html': '<script>fetch("/api/boards")</script>',
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  'gate.log': 'gate 0\n',
};

// A store whose LB-1 has every file of FILES attached, LB-2 one archived attachment, and a server on a free port.
async function served(): Promise<{ s: TestStore; server: BoardServer }> {
  const s = await newStore();
  await createTask(as(s, 'dev-1'), { title: 'With files', status: 'todo' });
  await createTask(as(s, 'dev-1'), { title: 'Archived with a file', status: 'done' });
  const src = tempDir();
  for (const [name, body] of Object.entries(FILES)) {
    fs.writeFileSync(path.join(src, name), body);
    await attachFile(as(s, 'dev-1'), { id: 'LB-1', path: path.join(src, name) });
  }
  await attachFile(as(s, 'dev-1'), { id: 'LB-2', path: path.join(src, 'gate.log') });
  await archiveTasks(as(s, 'dev-1'), { ids: ['LB-2'] });
  const server = await startBoardServer({ port: 0, current: { dir: s.dir }, uiDir: tempDir() });
  running.push(server);
  return { s, server };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

// A raw GET (node:http: the path goes out exactly as written, dot segments and escapes included).
function get(server: BoardServer, pathName: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, path: pathName, headers: { Host: `127.0.0.1:${server.port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

// The address the panel uses for one attachment of the current board.
function fileUrl(server: BoardServer, id: string, name: string, token = server.token): string {
  return attachmentHref(id, name, null, token);
}

describe('attachment files: headers by our own list, never by the stored mime', () => {
  it('a png is inline image/png, nosniff, sandboxed, not cached; the bytes are the stored file', async () => {
    const { server } = await served();
    const r = await get(server, fileUrl(server, 'LB-1', 'shot.png'));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['content-disposition']).toBe('inline; filename="shot.png"');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toBe('sandbox');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.equals(PNG)).toBe(true);
    expect((await get(server, fileUrl(server, 'LB-1', 'photo.JPEG'))).headers['content-type']).toBe('image/jpeg');
  });

  it('.html is a download: attachment, application/octet-stream, nosniff, CSP sandbox (attach stored it as text/html)', async () => {
    const { s, server } = await served();
    const meta = JSON.parse(fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8')).tasks[0].attachments.find((a: { name: string }) => a.name === 'page.html');
    expect(meta.mime).toBe('text/html');
    const r = await get(server, fileUrl(server, 'LB-1', 'page.html'));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-disposition']).toBe('attachment; filename="page.html"');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toBe('sandbox');
    expect(r.body.toString()).toBe(FILES['page.html']);
  });

  it('.svg is never inline (scripts in svg): attachment, octet-stream, sandboxed; .log too', async () => {
    const { server } = await served();
    for (const name of ['logo.svg', 'gate.log']) {
      const r = await get(server, fileUrl(server, 'LB-1', name));
      expect(r.status, name).toBe(200);
      expect(r.headers['content-type'], name).toBe('application/octet-stream');
      expect(r.headers['content-disposition'], name).toBe(`attachment; filename="${name}"`);
      expect(r.headers['content-security-policy'], name).toBe('sandbox');
      expect(r.headers['x-content-type-options'], name).toBe('nosniff');
    }
  });

  it('the inline list is png, jpeg, gif, webp only (any case); the UI previews by the same list', () => {
    for (const name of ['a.png', 'a.PNG', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp']) expect(inlineImageType(name), name).not.toBeNull();
    for (const name of ['a.svg', 'a.html', 'a.htm', 'a.xml', 'a.pdf', 'a.txt', 'png', '.png', 'a.png.html', 'a']) expect(inlineImageType(name), name).toBeNull();
    expect(attachmentHeaders('x.svg', 3)).toMatchObject({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="x.svg"', 'Content-Length': '3' });
    // A name that could break the header gets no filename at all.
    expect(attachmentHeaders('a"b.png', 1)['Content-Disposition']).toBe('inline');
  });

  it('an archived task still serves its files', async () => {
    const { server } = await served();
    const r = await get(server, fileUrl(server, 'LB-2', 'gate.log'));
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('gate 0\n');
  });
});

describe('attachment files: access and paths', () => {
  it('without the token, with a wrong one, or with the token only in the header: 403; a foreign Host: 403', async () => {
    const { server } = await served();
    const bare = `/api/tasks/LB-1/attachments/shot.png`;
    expect((await get(server, bare)).status).toBe(403);
    expect((await get(server, fileUrl(server, 'LB-1', 'shot.png', '0'.repeat(64)))).status).toBe(403);
    expect((await get(server, bare, { 'X-Laneboard-Token': server.token })).status).toBe(403);
    expect((await get(server, fileUrl(server, 'LB-1', 'shot.png'), { Host: 'evil.example' })).status).toBe(403);
  });

  it('traversal with .. (raw, escaped, double-escaped) and names not in the metadata are 404 and never reach a store file', async () => {
    const { s, server } = await served();
    const q = `?token=${server.token}`;
    const config = fs.readFileSync(path.join(s.dir, 'config.json'));
    for (const p of [
      `/api/tasks/LB-1/attachments/..%2F..%2Fconfig.json${q}`,
      `/api/tasks/LB-1/attachments/..%2f..%2factive.json${q}`,
      `/api/tasks/LB-1/attachments/%2e%2e%2f%2e%2e%2fconfig.json${q}`,
      `/api/tasks/LB-1/attachments/..%252F..%252Fconfig.json${q}`,
      `/api/tasks/LB-1/attachments/..${q}`,
      `/api/tasks/LB-1/attachments/../../config.json${q}`,
      `/api/tasks/LB-1/attachments/missing.png${q}`,
      `/api/tasks/LB-2/attachments/shot.png${q}`,
    ]) {
      const r = await get(server, p);
      expect(r.status, p).toBe(404);
      expect(r.body.includes(config), p).toBe(false);
    }
    // A deeper path is no attachment route at all: refused like any /api path without the header token.
    expect((await get(server, `/api/tasks/LB-1/attachments/shot.png/x${q}`)).status).toBe(403);
  });

  it('the path is built from the metadata name and must stay in attachments/<id>/', () => {
    const store = { dir: '/tmp/x/.laneboard' };
    expect(attachmentPath(store, 'LB-1', 'shot.png')).toBe(path.join('/tmp/x/.laneboard', 'attachments', 'LB-1', 'shot.png'));
    for (const name of ['../config.json', '../../active.json', '..', '.', '', '../LB-10/a.png']) expect(attachmentPath(store, 'LB-1', name), name).toBeNull();
    expect(attachmentPath(store, '..', 'config.json')).toBeNull();
  });

  it('a raw path with a . or .. segment (also %2e-escaped) is refused before routing', () => {
    for (const p of ['/api/tasks/LB-1/attachments/..', '/a/../b', '/a/./b', '/a/%2e%2e/b', '/a/%2E./b', '/a/.%2e?x=1', '/..']) expect(hasDotSegment(p), p).toBe(true);
    // A backslash (and its escape) ends a segment too: the URL parser reads `\` as `/` in http URLs.
    for (const p of ['/api/tasks/x\\..\\..\\board', '/a\\.\\b', '/a/b\\..', '/a%5C..%5Cb', '/a%5c%2e%2e%5cb', '/a\\%2E%2e/b']) expect(hasDotSegment(p), p).toBe(true);
    for (const p of ['/', '/api/tasks/LB-1/attachments/a..b', '/api/x?q=/../', '/a/...', '/a/%2e%2e%2fb', '/assets/app-1.js', '/a\\..b', '/a%5C...']) expect(hasDotSegment(p), p).toBe(false);
  });

  it('dot segments behind a backslash never resolve into another route: 404, not the board', async () => {
    const { server } = await served();
    const header = { 'X-Laneboard-Token': server.token };
    // The control: the URL parser does turn the backslashes into this route.
    expect(new URL('http://127.0.0.1/api/tasks/x\\..\\..\\board').pathname).toBe('/api/board');
    for (const p of ['/api/tasks/x\\..\\..\\board', '/api/tasks/x\\%2e%2e\\%2e%2e\\board', '/api/tasks/x%5C..%5C..%5Cboard']) {
      const r = await get(server, p, header);
      expect(r.status, p).toBe(404);
      expect(r.body.toString(), p).not.toContain('"columns"');
    }
    const q = `?token=${server.token}`;
    const r = await get(server, `/api/tasks/LB-1/attachments/gate.log\\..\\..\\..\\boards${q}`);
    expect(r.status).toBe(404);
    expect(r.body.toString()).not.toContain('"ok":true');
  });

  it('a file replaced by a link (planted by hand) is not followed: 404', async () => {
    const { s, server } = await served();
    const file = path.join(s.dir, 'attachments', 'LB-1', 'gate.log');
    fs.rmSync(file, { force: true });
    fs.symlinkSync(path.join(s.dir, 'config.json'), file);
    const r = await get(server, fileUrl(server, 'LB-1', 'gate.log'));
    expect(r.status).toBe(404);
    expect(r.body.toString()).not.toContain('"prefix"');
  });

  it('the task folder replaced by a link out of the store: 404, the outside file is never sent', async () => {
    const { s, server } = await served();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, 'gate.log'), 'SECRET-VIA-DIR-LINK');
    const dir = path.join(s.dir, 'attachments', 'LB-1');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.symlinkSync(outside, dir);
    const r = await get(server, fileUrl(server, 'LB-1', 'gate.log'));
    expect(r.status).toBe(404);
    expect(r.body.toString()).not.toContain('SECRET');
  });

  it('the whole attachments/ folder replaced by a link out of the store: 404, the outside file is never sent', async () => {
    const { s, server } = await served();
    const outside = tempDir();
    fs.mkdirSync(path.join(outside, 'LB-1'));
    fs.writeFileSync(path.join(outside, 'LB-1', 'gate.log'), 'SECRET-VIA-ROOT-LINK');
    const root = path.join(s.dir, 'attachments');
    fs.rmSync(root, { recursive: true, force: true });
    fs.symlinkSync(outside, root);
    const r = await get(server, fileUrl(server, 'LB-1', 'gate.log'));
    expect(r.status).toBe(404);
    expect(r.body.toString()).not.toContain('SECRET');
  });

  it('a store reached through a linked path of its own still serves (only links inside the store are refused)', async () => {
    const { s } = await served();
    const via = path.join(tempDir(), 'store-link');
    fs.symlinkSync(s.dir, via);
    const server = await startBoardServer({ port: 0, current: { dir: via }, uiDir: tempDir() });
    running.push(server);
    const r = await get(server, fileUrl(server, 'LB-1', 'gate.log'));
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('gate 0\n');
  });

  it('a FIFO in place of the file (planted by hand) does not hang the server: 404', async () => {
    const { s, server } = await served();
    const file = path.join(s.dir, 'attachments', 'LB-1', 'gate.log');
    fs.rmSync(file, { force: true });
    execFileSync('mkfifo', [file]);
    const r = await get(server, fileUrl(server, 'LB-1', 'gate.log'));
    expect(r.status).toBe(404);
    expect((await get(server, fileUrl(server, 'LB-1', 'shot.png'))).status).toBe(200);
  });

  it('a file is streamed: every byte of a 3 MiB file, Content-Length from the open descriptor', async () => {
    const { s, server } = await served();
    const big = crypto.randomBytes(3 * 1024 * 1024 + 7);
    const file = path.join(s.dir, 'attachments', 'LB-1', 'gate.log');
    // Stored files are read-only: replace, not overwrite.
    fs.rmSync(file);
    fs.writeFileSync(file, big);
    const r = await get(server, fileUrl(server, 'LB-1', 'gate.log'));
    expect(r.status).toBe(200);
    expect(r.headers['content-length']).toBe(String(big.length));
    expect(r.body.equals(big)).toBe(true);
  });

  it('the bytes come from the descriptor opened at the check: a file swapped after the open is not what is read', async () => {
    const { s } = await served();
    const file = path.join(s.dir, 'attachments', 'LB-1', 'gate.log');
    const opened = await openAttachment({ dir: s.dir }, 'LB-1', 'gate.log');
    if (typeof opened === 'string') throw new Error(opened);
    try {
      fs.rmSync(file);
      fs.symlinkSync(path.join(s.dir, 'config.json'), file);
      expect(opened.size).toBe(7);
      expect((await opened.handle.readFile()).toString()).toBe('gate 0\n');
    } finally {
      await opened.handle.close();
    }
  });

  it('a file over 2 GiB is served (no whole-file read, no false 404): 200 with its size', async () => {
    const { s } = await served();
    const size = 3 * 1024 * 1024 * 1024;
    // Sparse: no disk space is used, and the body is never read here (stored files are read-only: replace, not overwrite).
    const file = path.join(s.dir, 'attachments', 'LB-1', 'gate.log');
    fs.rmSync(file);
    fs.writeFileSync(file, '');
    fs.truncateSync(file, size);
    const reply = await attachmentReply({ current: { dir: s.dir, readOnly: true } }, new URL('http://127.0.0.1/api/tasks/LB-1/attachments/gate.log'));
    expect(reply.status).toBe(200);
    if (!('file' in reply)) throw new Error(JSON.stringify(reply));
    try {
      expect(reply.size).toBe(size);
      expect(reply.headers['Content-Length']).toBe(String(size));
    } finally {
      await reply.file.close();
    }
  });

  it('an unknown task is TASK_NOT_FOUND 404, a malformed %-escape in the name is 400', async () => {
    const { server } = await served();
    const missing = await get(server, fileUrl(server, 'LB-9', 'shot.png'));
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body.toString()).error.code).toBe('TASK_NOT_FOUND');
    expect((await get(server, `/api/tasks/LB-1/attachments/%E0%A4%A${'?token='}${server.token}`)).status).toBe(400);
  });

  it('the panel address: id and name escaped, board and token in the query', () => {
    expect(attachmentHref('LB-1', 'a b.png', null, 't0')).toBe('/api/tasks/LB-1/attachments/a%20b.png?token=t0');
    expect(attachmentHref('WEB-3', 'x.log', 'WEB', 't1')).toBe('/api/tasks/WEB-3/attachments/x.log?board=WEB&token=t1');
  });
});

describe('S5w2 UI logic and texts', () => {
  it('the not-built page also names reinstalling the package', () => {
    expect(notBuiltText('/x/dist/board')).toContain('npm ci && npm run build');
    expect(notBuiltText('/x/dist/board')).toContain('or reinstall laneboard: npm i -g laneboard');
  });

  it('refresh interval: 60 s by default, ?refresh_ms= within 500 ms … 60 s', () => {
    expect(REFRESH_MS).toBe(60_000);
    expect(refreshInterval('')).toBe(60_000);
    expect(refreshInterval('?refresh_ms=1000')).toBe(1000);
    expect(refreshInterval('?refresh_ms=1')).toBe(MIN_REFRESH_MS);
    expect(refreshInterval('?refresh_ms=999999')).toBe(60_000);
    for (const bad of ['?refresh_ms=', '?refresh_ms=abc', '?refresh_ms=-5', '?refresh_ms=1e3']) expect(refreshInterval(bad), bad).toBe(60_000);
  });

  it('attention counters count the core marks of the shown cards; the waiting-owner name is the core one', () => {
    expect(UI_WAITING_OWNER_LABEL).toBe(WAITING_OWNER_LABEL);
    const card = (handed_in: boolean, stale: boolean, labels: string[] = []) => ({ handed_in, stale, labels });
    expect(attentionCounts([card(true, false), card(false, true), card(false, true, ['waiting-owner']), card(false, false, ['x'])])).toEqual({ handedIn: 1, stale: 2, owner: 1 });
    expect(attentionCounts([])).toEqual({ handedIn: 0, stale: 0, owner: 0 });
    expect(STALE_AFTER_MS).toBe(4 * 60 * 60 * 1000);
  });

  it('a Result is a comment with data.result === true only', () => {
    expect(isResult('commented', { text: 'x', result: true })).toBe(true);
    expect(isResult('commented', { text: 'x' })).toBe(false);
    expect(isResult('commented', { text: 'x', result: 'true' })).toBe(false);
    expect(isResult('status', { result: true })).toBe(false);
  });
});
