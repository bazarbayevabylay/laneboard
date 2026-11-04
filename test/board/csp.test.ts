// K7: the web board works under CSP default-src 'self': no inline style or script in the UI sources, no HTML rendering of
// store text, styles only in style.css; after `npm run build`, dist/board/index.html loads only files.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from '../helpers.ts';

const UI = path.join(REPO, 'src', 'board', 'ui');
const DIST = path.join(REPO, 'dist', 'board');

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

  it.skipIf(!fs.existsSync(path.join(DIST, 'index.html')))('built index.html: scripts only by src, no <style>, one stylesheet file in assets/', () => {
    const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
    const scripts = html.match(/<script[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.filter((s) => !s.includes('src='))).toEqual([]);
    expect(html).not.toMatch(/<style/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(fs.readdirSync(path.join(DIST, 'assets')).filter((f) => f.endsWith('.css'))).toHaveLength(1);
  });
});
