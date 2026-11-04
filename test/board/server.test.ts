// Web board server (ADR-0001 §31, K6/K8): loopback only, Host and token checks, GET only, assets by listed name, CSP headers,
// read-only API on core ops, SSE after a write from another process, PORT_IN_USE with a runnable fix, `laneboard board` lifecycle.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { archiveTasks, createTask, getTask, listTasks, viewBoard } from '../../src/core/index.ts';
import { startBoardServer } from '../../src/board/server/http.ts';
import type { BoardServer } from '../../src/board/server/http.ts';
import { runCli } from '../../src/cli/run.ts';
import { as, CLI_SOURCE, cleanupTemp, cli, newStore, spawnNode, tempDir } from '../helpers.ts';
import type { CliRun, TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

const running: BoardServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
});

// A built UI stand-in: index.html and one asset of each served type (the real bundle is checked after `npm run build`, K7).
function fakeUi(): string {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><title>t</title><script type="module" src="/assets/app-1.js"></script></head><body></body></html>');
  fs.writeFileSync(path.join(dir, 'assets', 'app-1.js'), 'console.info(1)');
  fs.writeFileSync(path.join(dir, 'assets', 'app-1.css'), 'body{}');
  fs.writeFileSync(path.join(dir, 'assets', 'notes.txt'), 'not served');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside assets');
  return dir;
}

// A store with three tasks (one archived) and a server on a free port.
async function served(opts: { home?: string } = {}): Promise<{ s: TestStore; server: BoardServer }> {
  const s = await newStore();
  await createTask(as(s, 'dev-1'), { title: 'Fix login', status: 'todo', assignee: 'dev-1', labels: ['ui'], description: 'cookie <b>expired</b>' });
  await createTask(as(s, 'dev-2'), { title: 'Add search', status: 'in_progress', assignee: 'dev-2', labels: ['api'] });
  await createTask(as(s, 'dev-2'), { title: 'Old thing', status: 'done' });
  await archiveTasks(as(s, 'dev-2'), { ids: ['LB-3'] });
  const server = await startBoardServer({ port: 0, home: opts.home, current: { dir: s.dir }, uiDir: fakeUi(), stream: { pollMs: 200 } });
  running.push(server);
  return { s, server };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

// A raw HTTP request (node:http, so the Host header and the path go out exactly as given).
function request(server: BoardServer, pathName: string, opts: { method?: string; host?: string; token?: string | null } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: opts.host ?? `127.0.0.1:${server.port}` };
    if (opts.token !== null) headers['X-Laneboard-Token'] = opts.token ?? server.token;
    const req = http.request({ host: '127.0.0.1', port: server.port, path: pathName, method: opts.method ?? 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// The envelope of an API reply.
async function api(server: BoardServer, pathName: string): Promise<{ status: number; doc: ReturnType<typeof JSON.parse> }> {
  const r = await request(server, pathName);
  return { status: r.status, doc: JSON.parse(r.body) };
}

// SHA-256 of every file of a store: the server must leave them byte for byte.
function storeHash(dir: string): string {
  const h = crypto.createHash('sha256');
  for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) h.update(f).update(fs.readFileSync(p));
  }
  return h.digest('hex');
}

describe('board server: protection (K8)', () => {
  it('listens on 127.0.0.1 only', async () => {
    const { server } = await served();
    const address = server.server.address();
    expect(typeof address === 'object' && address?.address).toBe('127.0.0.1');
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
  });

  it('a foreign Host is refused with 403 on every path (DNS rebinding); localhost:<port> is accepted', async () => {
    const { server } = await served();
    for (const p of ['/', '/api/boards', '/assets/app-1.js']) {
      expect((await request(server, p, { host: 'evil.example' })).status, p).toBe(403);
      expect((await request(server, p, { host: `evil.example:${server.port}` })).status, p).toBe(403);
      expect((await request(server, p, { host: `127.0.0.1:${server.port + 1}` })).status, p).toBe(403);
    }
    expect((await request(server, '/', { host: `localhost:${server.port}` })).status).toBe(200);
  });

  it('/api without the token, or with a wrong one, is 403; the event stream takes it only as ?token=', async () => {
    const { server } = await served();
    expect((await request(server, '/api/boards', { token: null })).status).toBe(403);
    expect((await request(server, '/api/boards', { token: 'x'.repeat(64) })).status).toBe(403);
    expect((await request(server, '/api/board', { token: server.token.slice(1) })).status).toBe(403);
    expect((await request(server, '/api/events', { token: null })).status).toBe(403);
    expect((await request(server, `/api/events?token=${'0'.repeat(64)}`, { token: null })).status).toBe(403);
    expect((await request(server, '/api/boards')).status).toBe(200);
  });

  it('POST, PATCH, PUT and DELETE are 405 with Allow: GET (the board is read-only)', async () => {
    const { s, server } = await served();
    const before = storeHash(s.dir);
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      for (const p of ['/', '/api/tasks/LB-1', '/api/tasks']) {
        const r = await request(server, p, { method });
        expect(r.status, `${method} ${p}`).toBe(405);
        expect(r.headers.allow).toBe('GET');
      }
    }
    expect(storeHash(s.dir)).toBe(before);
  });

  it('assets: only listed js/css files by name; traversal and other files are 404', async () => {
    const { server } = await served();
    const js = await request(server, '/assets/app-1.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect((await request(server, '/assets/app-1.css')).headers['content-type']).toBe('text/css; charset=utf-8');
    for (const p of ['/assets/../package.json', '/assets/%2e%2e/secret.txt', '/assets/..%2fsecret.txt', '/assets/notes.txt', '/secret.txt', '/index.html', '/assets/', '/assets/missing.js']) {
      expect((await request(server, p)).status, p).toBe(404);
    }
  });

  it('every response carries CSP, nosniff and no-referrer; / and /api are no-store; no CORS headers', async () => {
    const { server } = await served();
    for (const [p, opts] of [['/', {}], ['/api/boards', {}], ['/assets/app-1.js', {}], ['/nope', {}], ['/api/boards', { token: null }], ['/', { method: 'POST' }]] as const) {
      const r = await request(server, p, opts);
      expect(r.headers['content-security-policy'], p).toBe("default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      expect(r.headers['x-content-type-options'], p).toBe('nosniff');
      expect(r.headers['referrer-policy'], p).toBe('no-referrer');
      expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control-')), p).toEqual([]);
    }
    expect((await request(server, '/')).headers['cache-control']).toBe('no-store');
    expect((await request(server, '/api/boards')).headers['cache-control']).toBe('no-store');
  });

  it('index.html carries the run token in a meta tag; every run has its own 256-bit token', async () => {
    const { server } = await served();
    const html = (await request(server, '/')).body;
    expect(html).toContain(`<meta name="laneboard-token" content="${server.token}">`);
    expect(server.token).toMatch(/^[a-f0-9]{64}$/);
    const other = (await served()).server;
    expect(other.token).not.toBe(server.token);
  });
});

describe('board server: read-only API on core ops', () => {
  it('/api/board equals viewBoard with the same filters (core filters, not UI code) plus the filter choices', async () => {
    const { s, server } = await served();
    for (const q of [{}, { assignee: 'dev-1' }, { labels: ['api'] }, { text: 'SEARCH' }, { assignee: 'dev-1', labels: ['api'] }]) {
      const query = new URLSearchParams();
      if ('assignee' in q && q.assignee) query.set('assignee', q.assignee);
      for (const l of 'labels' in q ? (q.labels ?? []) : []) query.append('label', l);
      if ('text' in q && q.text) query.set('text', q.text);
      const { status, doc } = await api(server, `/api/board?${query}`);
      expect(status).toBe(200);
      const expected = (await viewBoard({ store: { dir: s.dir } }, q)).data;
      const { assignees, labels, ...view } = doc.data;
      expect(view, JSON.stringify(q)).toEqual(expected);
      expect(assignees).toEqual(['dev-1', 'dev-2']);
      expect(labels).toEqual(['api', 'ui']);
    }
  });

  it('envelope like the CLI: ok, store, prefix, data, warnings', async () => {
    const { s, server } = await served();
    const { doc } = await api(server, '/api/tasks/LB-1');
    expect(Object.keys(doc)).toEqual(['ok', 'store', 'prefix', 'data', 'warnings']);
    expect(doc).toMatchObject({ ok: true, store: s.dir, prefix: 'LB' });
    expect(doc.data).toEqual((await getTask({ store: s.store }, { id: 'LB-1' })).data);
  });

  it('/api/tasks searches the archive and pages the final status; errors carry the registry status and the core message', async () => {
    const { s, server } = await served();
    const archived = await api(server, '/api/tasks?scope=archive&text=old');
    expect(archived.doc.data).toEqual((await listTasks({ store: s.store }, { scope: 'archive', text: 'old' })).data);
    expect(archived.doc.data.items.map((i: { id: string }) => i.id)).toEqual(['LB-3']);
    expect((await api(server, '/api/tasks/LB-3')).doc.data.archived).toBe(true);
    const missing = await api(server, '/api/tasks/LB-99');
    expect(missing.status).toBe(404);
    expect(missing.doc).toMatchObject({ ok: false, prefix: 'LB', error: { code: 'TASK_NOT_FOUND' } });
    expect((await api(server, '/api/tasks?status=nope')).status).toBe(400);
    expect((await api(server, '/api/tasks?limit=abc')).doc.error.code).toBe('INVALID_VALUE');
    const board = await api(server, '/api/board?board=NOPE');
    expect(board.status).toBe(400);
    expect(board.doc.error).toMatchObject({ code: 'INVALID_VALUE', allowed: ['LB'] });
    expect((await request(server, '/api/unknown')).status).toBe(404);
  });

  it('serving every route leaves the store byte for byte the same', async () => {
    const { s, server } = await served();
    const before = storeHash(s.dir);
    for (const p of ['/', '/api/boards', '/api/board', '/api/board?text=x', '/api/tasks?scope=all', '/api/tasks/LB-1', '/api/tasks/LB-3', '/api/tasks/LB-99']) await request(server, p);
    expect(storeHash(s.dir)).toBe(before);
  });

  it('tabs: the started board first, then the registry boards; a moved board is a missing tab, never readable', async () => {
    const home = tempDir();
    const projects = tempDir();
    const mk = async (name: string): Promise<string> => {
      const dir = path.join(projects, name);
      fs.mkdirSync(dir);
      expect((await cli(['init', '--name', name, '--description', `${name} board`], { cwd: dir, env: { HOME: home } })).code).toBe(0);
      return dir;
    };
    const shop = await mk('shop');
    const api2 = await mk('api');
    const gone = await mk('gone');
    await cli(['create', 'Cart', '--status', 'todo', '--as', 'a'], { cwd: api2, env: { HOME: home } });
    await cli(['create', 'Shipped', '--status', 'done', '--as', 'a'], { cwd: api2, env: { HOME: home } });
    fs.renameSync(gone, path.join(projects, 'gone-moved'));
    const server = await startBoardServer({ port: 0, home, current: { dir: path.join(api2, '.laneboard') }, uiDir: fakeUi() });
    running.push(server);
    const tabs = (await api(server, '/api/boards')).doc.data.boards;
    expect(tabs.map((t: { key: string; current: boolean; missing: boolean; active: number }) => [t.key, t.current, t.missing, t.active])).toEqual([
      ['API', true, false, 1],
      ['SHOP', false, false, 0],
      ['GONE', false, true, 0],
    ]);
    expect((await api(server, '/api/board?board=SHOP')).doc.store).toBe(path.join(shop, '.laneboard'));
    expect((await api(server, '/api/board?board=GONE')).status).toBe(400);
    // Without HOME: the started board only.
    const alone = await startBoardServer({ port: 0, current: { dir: path.join(api2, '.laneboard') }, uiDir: fakeUi() });
    running.push(alone);
    expect((await api(alone, '/api/boards')).doc.data.boards.map((t: { key: string }) => t.key)).toEqual(['API']);
  });

  it('a broken registry keeps the started board and names the problem instead of failing', async () => {
    const home = tempDir();
    const s = await newStore();
    fs.mkdirSync(path.join(home, '.laneboard'));
    fs.writeFileSync(path.join(home, '.laneboard', 'boards.json'), '{ broken');
    const server = await startBoardServer({ port: 0, home, current: { dir: s.dir }, uiDir: fakeUi() });
    running.push(server);
    const { status, doc } = await api(server, '/api/boards');
    expect(status).toBe(200);
    expect(doc.data.boards.map((t: { key: string }) => t.key)).toEqual(['LB']);
    expect(doc.data.registry_problem).toContain('boards.json is not valid JSON');
    expect((await api(server, '/api/board')).status).toBe(200);
  });
});

// Read SSE events from /api/events until `until` returns true or the time is up.
function readEvents(server: BoardServer, until: (text: string) => boolean, ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    const req = http.get({ host: '127.0.0.1', port: server.port, path: `/api/events?token=${server.token}`, headers: { Host: `127.0.0.1:${server.port}` } }, (res) => {
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
      res.on('data', (d: Buffer) => {
        text += d.toString();
        if (until(text)) {
          req.destroy();
          resolve(text);
        }
      });
    });
    req.on('error', (err) => (until(text) ? resolve(text) : reject(err)));
    setTimeout(() => {
      req.destroy();
      resolve(text);
    }, ms);
  });
}

describe('board server: live updates (K8)', () => {
  it('a `laneboard comment` from another process reaches the event stream within 2 s', async () => {
    const { s, server } = await served();
    const events = readEvents(server, (t) => t.includes('event: change'), 5000);
    await new Promise((r) => setTimeout(r, 150));
    const started = Date.now();
    const write = await spawnNode([CLI_SOURCE, 'comment', 'LB-1', 'from another process', '--as', 'dev-1', '--dir', s.dir]);
    expect(write.code, write.stderr).toBe(0);
    const text = await events;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(text).toMatch(/^: connected\n\n/);
    const rev = JSON.parse(/event: change\ndata: (.*)\n/.exec(text)?.[1] ?? 'null');
    expect(rev).toEqual({ rev: JSON.parse(fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8')).rev });
  });

  it('the stream pings and ends when the server closes', async () => {
    const s = await newStore();
    const server = await startBoardServer({ port: 0, current: { dir: s.dir }, uiDir: fakeUi(), stream: { pingMs: 50 } });
    const text = readEvents(server, (t) => t.includes(': ping'), 3000);
    expect(await text).toContain(': ping\n\n');
    await server.close();
  });
});

// Run `laneboard board` in-process until its first output, then Ctrl+C.
async function boardRun(cwd: string, argv: string[], env: Record<string, string> = {}): Promise<{ result: CliRun; first: string }> {
  const stop = new AbortController();
  let stdout = '';
  let stderr = '';
  let first = '';
  const done = runCli({
    argv: ['board', ...argv],
    env,
    cwd,
    readStdin: () => '',
    stdout: (t) => {
      stdout += t;
      first ||= t;
      stop.abort();
    },
    stderr: (t) => {
      stderr += t;
    },
    signal: stop.signal,
  });
  const code = await done;
  return { result: { code, stdout, stderr }, first };
}

// Split a printed `laneboard ...` fix into argv the way a shell would.
function shellArgv(fix: string): string[] {
  expect(fix.startsWith('laneboard ')).toBe(true);
  const out = execFileSync('sh', ['-c', `printf '%s\\0' ${fix.slice('laneboard '.length)}`], { encoding: 'utf8' });
  return out.split('\0').slice(0, -1);
}

describe('laneboard board (CLI)', () => {
  it('prints the URL, serves until Ctrl+C and exits 0; --json prints {url, port}', async () => {
    const s = await newStore();
    const human = await boardRun(s.root, ['--port', '0']);
    expect(human.result.code).toBe(0);
    expect(human.first).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\nlaneboard board: read-only/);
    const json = await boardRun(s.root, ['--port', '0', '--json']);
    expect(json.result.code).toBe(0);
    const doc = JSON.parse(json.first);
    expect(doc).toMatchObject({ ok: true, store: s.dir, prefix: 'LB', data: { url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/) } });
    expect(doc.data.url).toBe(`http://127.0.0.1:${doc.data.port}/`);
  });

  it('a busy port is PORT_IN_USE (exit 5) whose fix is the same command with --port 0, and the fix runs', async () => {
    const s = await newStore();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      const r = await cli(['board', '--port', String(port), '--json'], { cwd: s.root });
      expect(r.code).toBe(5);
      const error = JSON.parse(r.stdout).error;
      expect(error.code).toBe('PORT_IN_USE');
      expect(error.fix).toBe('laneboard board --json --port 0');
      const fixed = await boardRun(s.root, shellArgv(error.fix).slice(1));
      expect(fixed.result.code).toBe(0);
      expect(JSON.parse(fixed.first).ok).toBe(true);
    } finally {
      blocker.close();
    }
  });

  it('a malformed --port is INVALID_VALUE with the fix --port 0', async () => {
    const s = await newStore();
    for (const bad of ['abc', '70000', '-1', '1.5']) {
      const r = await cli(['board', `--port=${bad}`, '--json'], { cwd: s.root });
      expect(r.code, bad).toBe(2);
      expect(JSON.parse(r.stdout).error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard board --json --port 0' });
    }
  });

  it('--board opens another board read-only as the first tab', async () => {
    const home = tempDir();
    const mine = tempDir();
    const theirs = tempDir();
    await cli(['init', '--name', 'mine', '--description', 'mine'], { cwd: mine, env: { HOME: home } });
    await cli(['init', '--name', 'theirs', '--description', 'theirs'], { cwd: theirs, env: { HOME: home } });
    const r = await boardRun(mine, ['--port', '0', '--board', 'THEI', '--json'], { HOME: home });
    expect(r.result.code).toBe(0);
    expect(JSON.parse(r.first)).toMatchObject({ ok: true, store: path.join(theirs, '.laneboard'), prefix: 'THEI' });
  });
});
