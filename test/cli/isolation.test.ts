// Stores of different agents on one machine stay apart: init derives a prefix from the folder name, every --json reply names
// store and prefix, and a store found in a parent directory (a nested agent folder without its own store) is always called out.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { derivePrefix } from '../../src/core/index.ts';
import { callTool } from '../../src/mcp/tools.ts';
import { cleanupTemp, cli, readStore, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

// A folder `name` inside a fresh temp directory.
function folder(name: string, parent = tempDir()): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('prefix from the folder name', () => {
  it.each([
    ['laneboard', 'LANEBOARD'],
    ['my-web-app', 'MYWEBAPP'],
    ['agent-2', 'AGENT2'],
    ['2024_report', 'REPORT'],
    ['orchestrator-1', 'ORCHESTRA1'],
    ['orchestrator-12', 'ORCHESTR12'],
    ['claudeassistant_miniabyl', 'CLAUDEASSI'],
    ['x', 'X'],
    ['проект', undefined],
    ['123', undefined],
  ])('%s -> %s', (name, want) => {
    expect(derivePrefix(name)).toBe(want);
  });

  it('init without --name and --prefix: the name is the folder name, the prefix comes from it; --dir takes the store directory or its project', async () => {
    const env = { HOME: tempDir() };
    const cwd = folder('my-web-app');
    const r = JSON.parse((await cli(['init', '--description', 'test board', '--json'], { cwd, env })).stdout);
    expect(r).toMatchObject({ ok: true, store: path.join(cwd, '.laneboard'), prefix: 'MYWEBAPP', data: { config: { prefix: 'MYWEBAPP', name: 'my-web-app', description: 'test board' } }, warnings: [] });
    const other = tempDir();
    expect(JSON.parse((await cli(['init', '--description', 'test board', '--dir', path.join(other, 'stores', 'api'), '--json'], { cwd, env })).stdout).prefix).toBe('API');
    expect(JSON.parse((await cli(['init', '--description', 'test board', '--dir', path.join(folder('agent-2'), '.laneboard'), '--json'], { cwd, env })).stdout).prefix).toBe('AGENT2');
  });

  it('--name gives the board its name and the prefix is derived from the name, not the folder', async () => {
    const r = JSON.parse((await cli(['init', '--name', 'Billing API', '--description', 'billing service of the shop', '--json'], { cwd: folder('svc-1'), env: { HOME: tempDir() } })).stdout);
    expect(r).toMatchObject({ prefix: 'BILLINGAPI', data: { config: { name: 'Billing API', description: 'billing service of the shop' } } });
  });

  it('a name without latin letters falls back to LB and says how to pick one', async () => {
    const r = JSON.parse((await cli(['init', '--description', 'test board', '--json'], { cwd: folder('проект'), env: { HOME: tempDir() } })).stdout);
    expect(r.prefix).toBe('LB');
    expect(r.warnings).toEqual(['no prefix could be derived from the name "проект", so ids use LB; pick one with laneboard init --prefix <PREFIX>']);
  });
});

describe('nested agent folders', () => {
  // parent/ has its own store (PARENT); parent/agent-2/ has its own (AGENT2, derived); parent/third/ has none but is a project
  // of its own (its CLAUDE.md); parent/src/deep/ is a plain subfolder of parent's project.
  async function nested(): Promise<{ parent: string; child: string; third: string; deep: string }> {
    const parent = folder('parent');
    const child = folder('agent-2', parent);
    const third = folder('third', parent);
    fs.writeFileSync(path.join(third, 'CLAUDE.md'), 'Agent B instructions.\n');
    const deep = folder(path.join('src', 'deep'), parent);
    expect((await cli(['init', '--description', 'test board', '--prefix', 'PARENT'], { cwd: parent })).code).toBe(0);
    expect((await cli(['init', '--description', 'test board'], { cwd: child })).code).toBe(0);
    return { parent, child, third, deep };
  }

  it('an agent in the child folder writes only to its own store, without a warning', async () => {
    const { parent, child } = await nested();
    const r = await cli(['create', 'child work', '--status', 'todo', '--as', 'dev', '--json'], { cwd: child });
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, store: path.join(child, '.laneboard'), prefix: 'AGENT2', data: { id: 'AGENT2-1' }, warnings: [] });
    const human = await cli(['comment', 'AGENT2-1', 'step', '--as', 'dev'], { cwd: child });
    expect(human.stderr).toBe('');
    expect(readStore(path.join(child, '.laneboard'), 'active').tasks.map((t) => t.id)).toEqual(['AGENT2-1']);
    expect(readStore(path.join(parent, '.laneboard'), 'active').tasks).toEqual([]);
    const prime = JSON.parse((await cli(['prime', '--as', 'dev', '--json'], { cwd: child })).stdout);
    expect(prime).toMatchObject({ store: path.join(child, '.laneboard'), prefix: 'AGENT2', data: { store_warning: null }, warnings: [] });
  });

  it('an agent in a separate project folder without its own store is warned that the parent store is used: --json, human stderr, prime, MCP', async () => {
    const { parent, third } = await nested();
    const store = path.join(parent, '.laneboard');
    const warning =
      `using store ${store} (prefix PARENT) found in a parent directory, but ${third} looks like a separate project (it has CLAUDE.md); ` +
      'unless this folder is part of that project, find its own board with laneboard boards --json (pin it: export LANEBOARD_DIR=<its path>), ' +
      'or create one: laneboard init --name <name> --description "<whose project, what work>"';
    const json = JSON.parse((await cli(['create', 'stray', '--status', 'todo', '--as', 'dev', '--json'], { cwd: third })).stdout);
    expect(json).toMatchObject({ ok: true, store, prefix: 'PARENT', data: { id: 'PARENT-1' } });
    expect(json.warnings).toEqual([warning]);
    const human = await cli(['list'], { cwd: third });
    expect(human.code).toBe(0);
    expect(human.stderr).toBe(`warning: ${warning}\n`);
    // prime prints it in its text (a SessionStart hook shows only stdout) and does not repeat it on stderr.
    const prime = await cli(['prime', '--as', 'dev'], { cwd: third });
    expect(prime.stdout).toContain(`\nStore: ${store} (prefix PARENT) - parent: test board\nwarning: ${warning}\n`);
    expect(prime.stderr).toBe('');
    expect(JSON.parse((await cli(['prime', '--as', 'dev', '--json'], { cwd: third })).stdout)).toMatchObject({ warnings: [warning], data: { store_warning: warning } });
    const hook = await cli(['prime', '--hook'], { cwd: third, env: { LANEBOARD_AGENT: 'dev' } });
    expect(hook.stdout).toContain(`warning: ${warning}`);
    const mcp = await callTool('task_list', {}, { cwd: third, env: {} });
    expect(mcp.content[1]?.text).toBe(JSON.stringify({ store, prefix: 'PARENT', warnings: [warning] }));
  });

  it('a plain subfolder of the same project (no project marker in between) uses the store without a warning', async () => {
    const { parent, deep } = await nested();
    const r = JSON.parse((await cli(['create', 'deep work', '--status', 'todo', '--as', 'dev', '--json'], { cwd: deep })).stdout);
    expect(r).toMatchObject({ ok: true, store: path.join(parent, '.laneboard'), prefix: 'PARENT', warnings: [] });
    expect((await cli(['list'], { cwd: deep })).stderr).toBe('');
  });

  it('a pinned store (LANEBOARD_DIR, as setup writes it, or --dir) is explicit: no warning', async () => {
    const { parent, third } = await nested();
    const store = path.join(parent, '.laneboard');
    for (const run of [
      () => cli(['list', '--json'], { cwd: third, env: { LANEBOARD_DIR: store } }),
      () => cli(['list', '--json', '--dir', store], { cwd: third }),
    ]) {
      expect(JSON.parse((await run()).stdout)).toMatchObject({ ok: true, store, prefix: 'PARENT', warnings: [] });
    }
  });

  it('error envelopes name the store and prefix too', async () => {
    const { child } = await nested();
    const r = JSON.parse((await cli(['get', 'AGENT2-9', '--json'], { cwd: child })).stdout);
    expect(r).toMatchObject({ ok: false, store: path.join(child, '.laneboard'), prefix: 'AGENT2', error: { code: 'TASK_NOT_FOUND' } });
  });
});
