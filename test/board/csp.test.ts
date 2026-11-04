// K7: the web board works under CSP default-src 'self': no inline style or script in the UI sources, no HTML rendering of
// store text, styles only in style.css; the built index.html loads only files. The test builds the UI itself into a temp
// folder (vite build --outDir), so the check runs on a clean checkout before `npm run build` too, and the server serves that build.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBoardServer } from '../../src/board/server/http.ts';
import { cleanupTemp, newStore, REPO, tempDir } from '../helpers.ts';

const UI = path.join(REPO, 'src', 'board', 'ui');
const VITE = path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js');

afterAll(cleanupTemp);

describe('K7: CSS in a file, no inline script or style', () => {
  it('UI sources have no <style>, style bindings, style attributes or v-html', () => {
    const r = spawnSync('grep', ['-rnE', '<style|:style=|v-bind:style|[[:space:]]style=|v-html', UI], { encoding: 'utf8' });
    expect(r.stdout).toBe('');
    expect(r.status).toBe(1);
  });

  it('the grep finds a planted violation (the check is not blind)', () => {
    const r = spawnSync('grep', ['-cE', '<style|:style=|v-bind:style|[[:space:]]style=|v-html'], { input: '<div :style="x"></div>\n<p v-html="t"></p>\n', encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('2');
  });
});

describe('K7: the built UI (vite build into a temp folder)', () => {
  let dist = '';
  beforeAll(() => {
    dist = path.join(tempDir(), 'board');
    const r = spawnSync(process.execPath, [VITE, 'build', '--config', path.join(UI, 'vite.config.ts'), '--outDir', dist, '--emptyOutDir', '--logLevel', 'warn'], { cwd: REPO, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });

  it('index.html: scripts only by src, no <style>, one stylesheet file in assets/', () => {
    const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    const scripts = html.match(/<script[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.filter((s) => !s.includes('src='))).toEqual([]);
    expect(html).not.toMatch(/<style/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(fs.readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.css'))).toHaveLength(1);
  });

  it('the server serves that build: index.html with the token, every file it links with 200', async () => {
    const s = await newStore();
    const server = await startBoardServer({ port: 0, current: { dir: s.dir }, uiDir: dist });
    try {
      expect(server.uiBuilt).toBe(true);
      const get = (p: string): Promise<{ status: number; body: string }> =>
        new Promise((resolve, reject) => {
          http
            .get({ host: '127.0.0.1', port: server.port, path: p, headers: { Host: `127.0.0.1:${server.port}` } }, (res) => {
              let body = '';
              res.on('data', (d: Buffer) => (body += d.toString()));
              res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
            })
            .on('error', reject);
        });
      const index = await get('/');
      expect(index.status).toBe(200);
      expect(index.body).toContain(`<meta name="laneboard-token" content="${server.token}">`);
      const linked = [...index.body.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1] ?? '');
      expect(linked.length).toBeGreaterThanOrEqual(2);
      for (const p of linked) expect((await get(p)).status, p).toBe(200);
    } finally {
      await server.close();
    }
  });
});
