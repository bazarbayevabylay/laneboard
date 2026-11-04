// The real CLI process: spec smoke (init, create LB-1, wrong status -> exit 2 with allowed), discovery, stdout/stderr split.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTemp, CLI_SOURCE, spawnNode, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

describe('laneboard process', () => {
  it('spec smoke: init (prefix from the folder name), create -> WA-1, update with an unknown status -> exit 2 listing allowed', async () => {
    const cwd = path.join(tempDir(), 'web-app');
    fs.mkdirSync(cwd);
    expect((await spawnNode([CLI_SOURCE, 'init', '--description', 'test board'], { cwd })).code).toBe(0);
    const created = await spawnNode([CLI_SOURCE, 'create', 'x', '--status', 'todo', '--as', 'a', '--json'], { cwd });
    expect(created.code).toBe(0);
    expect(created.stdout).toContain('"id":"WA-1"');
    expect(created.stdout).toContain('"prefix":"WA"');
    expect(created.stderr).toBe('');
    const bad = await spawnNode([CLI_SOURCE, 'update', 'WA-1', '--status', 'doing', '--as', 'a'], { cwd });
    expect(bad.code).toBe(2);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toContain('allowed: todo, in_progress, review, done');
  });

  it('finds the store from a subdirectory, via LANEBOARD_DIR, and via --dir; takes the actor from LANEBOARD_AGENT', async () => {
    const root = tempDir();
    await spawnNode([CLI_SOURCE, 'init', '--description', 'test board', '--prefix', 'LB'], { cwd: root });
    const sub = path.join(root, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    const store = path.join(root, '.laneboard');
    const fromSub = await spawnNode([CLI_SOURCE, 'create', 'one', '--status', 'todo', '--json', '--full'], { cwd: sub, env: { LANEBOARD_AGENT: 'env-agent' } });
    expect(JSON.parse(fromSub.stdout)).toMatchObject({ ok: true, store, data: { id: 'LB-1', created_by: 'env-agent' } });
    const elsewhere = tempDir();
    const viaEnv = await spawnNode([CLI_SOURCE, 'get', 'LB-1', '--json'], { cwd: elsewhere, env: { LANEBOARD_DIR: store } });
    expect(JSON.parse(viaEnv.stdout).data.title).toBe('one');
    const viaFlag = await spawnNode([CLI_SOURCE, 'get', 'LB-1', '--json', '--dir', store], { cwd: elsewhere, env: { LANEBOARD_DIR: '/nonexistent' } });
    expect(JSON.parse(viaFlag.stdout).ok).toBe(true);
    const missing = await spawnNode([CLI_SOURCE, 'list', '--json'], { cwd: elsewhere });
    expect(missing.code).toBe(6);
    expect(JSON.parse(missing.stdout).error.code).toBe('STORE_NOT_FOUND');
  });

  it('reads a description from stdin with --description-file -', async () => {
    const cwd = tempDir();
    await spawnNode([CLI_SOURCE, 'init', '--description', 'test board', '--prefix', 'LB'], { cwd });
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [CLI_SOURCE, 'create', 'piped', '--status', 'todo', '--description-file', '-', '--as', 'a', '--json', '--full'], { cwd });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stdin.end('from stdin\n');
    const code = await new Promise((resolve) => child.on('exit', resolve));
    expect(code).toBe(0);
    expect(JSON.parse(out).data.description).toBe('from stdin\n');
  });
});
