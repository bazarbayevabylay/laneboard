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
    ['laneboard', 'LANE'],
    ['my-web-app', 'MWA'],
    ['agent-2', 'AGE2'],
    ['2024_report', 'REPO'],
    ['orchestrator-1', 'ORC1'],
    ['orchestrator-12', 'OR12'],
    ['agent-1234', 'AGEN'],
    ['claudeassistant_miniabyl', 'CM'],
    ['a-b-c-d-e', 'ABCD'],
    ['café', 'CAFE'],
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
    expect(r).toMatchObject({ ok: true, store: path.join(cwd, '.laneboard'), prefix: 'MWA', data: { config: { prefix: 'MWA', name: 'my-web-app', description: 'test board' } }, warnings: [] });
    const other = tempDir();
    expect(JSON.parse((await cli(['init', '--description', 'test board', '--dir', path.join(other, 'stores', 'api'), '--json'], { cwd, env })).stdout).prefix).toBe('API');
    expect(JSON.parse((await cli(['init', '--description', 'test board', '--dir', path.join(folder('agent-2'), '.laneboard'), '--json'], { cwd, env })).stdout).prefix).toBe('AGE2');
  });

  it('--name gives the board its name and the prefix is derived from the name, not the folder', async () => {
    const r = JSON.parse((await cli(['init', '--name', 'Billing API', '--description', 'billing service of the shop', '--json'], { cwd: folder('svc-1'), env: { HOME: tempDir() } })).stdout);
    expect(r).toMatchObject({ prefix: 'BA', data: { config: { name: 'Billing API', description: 'billing service of the shop' } } });
  });

  it('a name without latin letters falls back to LB and says how to pick one', async () => {
    const r = JSON.parse((await cli(['init', '--description', 'test board', '--json'], { cwd: folder('проект'), env: { HOME: tempDir() } })).stdout);
    expect(r.prefix).toBe('LB');
    expect(r.warnings).toEqual(['no prefix could be derived from the name "проект", so ids use LB; pick one with laneboard init --prefix <PREFIX>']);
  });
});

describe('nested agent folders', () => {
  // parent/ has its own store (PARENT); parent/agent-2/ has its own (AGE2, derived); parent/third/ has none but is a project
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
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, store: path.join(child, '.laneboard'), prefix: 'AGE2', data: { id: 'AGE2-1' }, warnings: [] });
    const human = await cli(['comment', 'AGE2-1', 'step', '--as', 'dev'], { cwd: child });
    expect(human.stderr).toBe('');
    expect(readStore(path.join(child, '.laneboard'), 'active').tasks.map((t) => t.id)).toEqual(['AGE2-1']);
    expect(readStore(path.join(parent, '.laneboard'), 'active').tasks).toEqual([]);
    const prime = JSON.parse((await cli(['prime', '--as', 'dev', '--json'], { cwd: child })).stdout);
    expect(prime).toMatchObject({ store: path.join(child, '.laneboard'), prefix: 'AGE2', data: { store_warning: null }, warnings: [] });
  });

  it('an agent in a separate project folder without its own store is warned that the parent store is used: --json, human stderr, prime, MCP', async () => {
    const { parent, third } = await nested();
    const store = path.join(parent, '.laneboard');
    const warning =
      `using store ${store} (prefix PARENT) found in a parent directory, but ${third} looks like a separate project (it has CLAUDE.md); ` +
      'unless this folder is part of that project, find its own board with laneboard boards --json and pass --dir <its path> on every command, ' +
      `or create one: laneboard init --dir ${path.join(third, '.laneboard')} --name <name> --description "<whose project, what work>", ` +
      `then pass --dir ${path.join(third, '.laneboard')} on every command, starting with laneboard prime`;
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
    // Under that warning prime asks for no task in the store in use (as the edit hook): no create or claim command for it.
    expect(prime.stdout).toContain("\nYou have no task in progress. The store above looks like another project's: create your task on this folder's own board (see the warning).\n");
    expect(prime.stdout).not.toMatch(/Create one now|Given a task id|laneboard create "<short title/);
    expect(JSON.parse((await cli(['prime', '--as', 'dev', '--json'], { cwd: third })).stdout)).toMatchObject({ warnings: [warning], data: { store_warning: warning } });
    const hook = await cli(['prime', '--hook'], { cwd: third, env: { LANEBOARD_AGENT: 'dev' } });
    expect(hook.stdout).toContain(`warning: ${warning}`);
    expect(hook.stdout).not.toMatch(/Create one now|Given a task id|laneboard create "<short title/);
    const mcp = await callTool('task_list', {}, { cwd: third, env: {} });
    expect(mcp.content[1]?.text).toBe(JSON.stringify({ store, prefix: 'PARENT', warnings: [warning] }));
  });

  it('a plain subfolder of the same project (no project marker in between) uses the store without a warning', async () => {
    const { parent, deep } = await nested();
    const r = JSON.parse((await cli(['create', 'deep work', '--status', 'todo', '--as', 'dev', '--json'], { cwd: deep })).stdout);
    expect(r).toMatchObject({ ok: true, store: path.join(parent, '.laneboard'), prefix: 'PARENT', warnings: [] });
    expect((await cli(['list'], { cwd: deep })).stderr).toBe('');
  });

  it('--dir is explicit for one command: no warning', async () => {
    const { parent, third } = await nested();
    const store = path.join(parent, '.laneboard');
    expect(JSON.parse((await cli(['list', '--json', '--dir', store], { cwd: third })).stdout)).toMatchObject({ ok: true, store, prefix: 'PARENT', warnings: [] });
  });

  it('LANEBOARD_DIR set for a parent folder (the root local settings file reaches every folder of a repository) warns in a separate project folder', async () => {
    const { parent, child, third, deep } = await nested();
    const store = path.join(parent, '.laneboard');
    const env = { LANEBOARD_DIR: store };
    // A folder with its own store: the warning names it and the --dir to use.
    const own = JSON.parse((await cli(['list', '--json'], { cwd: child, env })).stdout);
    expect(own).toMatchObject({ ok: true, store, prefix: 'PARENT' });
    expect(own.warnings).toEqual([
      `using store ${store} (prefix PARENT) from LANEBOARD_DIR (set for a parent folder), but ${child} looks like a separate project ` +
        `(it has its own store ${path.join(child, '.laneboard')}); unless this folder is part of that project, pass --dir ${path.join(child, '.laneboard')} on every command`,
    ]);
    // A separate project folder without a store: the same advice as for a store found by walking up.
    expect(JSON.parse((await cli(['list', '--json'], { cwd: third, env })).stdout).warnings[0]).toContain('from LANEBOARD_DIR (set for a parent folder), but');
    // The pinned project itself and its plain subfolders stay silent, and so does a pin to a store outside cwd's ancestors.
    for (const cwd of [parent, deep]) expect(JSON.parse((await cli(['list', '--json'], { cwd, env })).stdout).warnings).toEqual([]);
    expect(JSON.parse((await cli(['list', '--json'], { cwd: third, env: { LANEBOARD_DIR: path.join(child, '.laneboard') } })).stdout).warnings).toEqual([]);
    // cwd's own store named through a symlink (HOME=/var/... on macOS, cwd /private/var/...) is the same store: silent.
    const link = path.join(tempDir(), 'link');
    fs.symlinkSync(parent, link);
    expect(JSON.parse((await cli(['list', '--json'], { cwd: child, env: { LANEBOARD_DIR: path.join(link, 'agent-2', '.laneboard') } })).stdout).warnings).toEqual([]);
    const mcp = await callTool('task_list', {}, { cwd: child, env });
    expect(JSON.parse(mcp.content[1]?.text ?? '{}').warnings).toEqual(own.warnings);
  });

  it("LANEBOARD_DIR of a parent folder, separate project without a store: the warning's commands create and use its own board; a bare init says LANEBOARD_DIR is in the way", async () => {
    const { parent, third } = await nested();
    const store = path.join(parent, '.laneboard');
    const own = path.join(third, '.laneboard');
    const env = { LANEBOARD_DIR: store };
    const warning: string = JSON.parse((await cli(['list', '--json'], { cwd: third, env })).stdout).warnings[0];
    expect(warning).toContain(
      `or create one: laneboard init --dir ${own} --name <name> --description "<whose project, what work>", then pass --dir ${own} on every command, starting with laneboard prime`,
    );
    // Rule 12's bare init takes LANEBOARD_DIR, the parent's store: STORE_EXISTS names that and offers this folder's board only.
    const bare = JSON.parse((await cli(['init', '--name', 'third', '--description', 'b work', '--json'], { cwd: third, env })).stdout);
    expect(bare.error).toMatchObject({
      code: 'STORE_EXISTS',
      message: `LANEBOARD_DIR points to ${store}, which already holds a board (LANEBOARD_DIR may be set for a parent folder, e.g. by its .claude/settings.local.json)`,
      fix: `to create the board of ${third}: laneboard init --dir ${own} --name <name> --description "<whose project, what work>", then pass --dir ${own} on every command, starting with laneboard prime`,
    });
    // In the pinned project itself the same init is a plain STORE_EXISTS (offering ./.laneboard again would loop).
    expect(JSON.parse((await cli(['init', '--description', 'again', '--json'], { cwd: parent, env })).stdout).error.message).toBe(`a store already exists at ${store}`);
    // The commands as written (placeholders filled): init, prime, then the create line prime prints, all with --dir.
    const init = JSON.parse((await cli(['init', '--dir', own, '--name', 'third', '--description', 'b work', '--json'], { cwd: third, env })).stdout);
    expect(init).toMatchObject({ ok: true, store: own, prefix: 'THIR', data: { next: `laneboard prime --dir ${own}` } });
    const prime = await cli(['prime', '--dir', own, '--as', 'dev'], { cwd: third, env });
    expect(prime.stdout).toContain(`\n  laneboard create "<short title of your work>" --status todo --assignee dev --as dev --dir ${own} --json\n`);
    expect(prime.stdout).toContain(`Given a task id instead: laneboard claim <ID> --as dev --dir ${own} --json`);
    const made = JSON.parse((await cli(['create', 'b work', '--status', 'todo', '--assignee', 'dev', '--as', 'dev', '--dir', own, '--json'], { cwd: third, env })).stdout);
    expect(made).toMatchObject({ ok: true, store: own, prefix: 'THIR', data: { id: 'THIR-1' }, warnings: [] });
    expect(readStore(store, 'active').tasks).toEqual([]);
  });

  it('a pin to a store outside the repository (setup claude-code --dir ~/boards/...) warns in a nested project with its own store; the edit hook asks for no task there', async () => {
    const pinned = path.join(tempDir(), 'boards', 'orch', '.laneboard');
    const root = folder('orch');
    fs.mkdirSync(path.join(root, '.git'));
    const agentB = folder('agentB', root);
    fs.writeFileSync(path.join(agentB, 'CLAUDE.md'), 'Agent B instructions.\n');
    const sub = folder('src', agentB);
    expect((await cli(['init', '--dir', pinned, '--name', 'orch', '--description', 'o'], { cwd: root })).code).toBe(0);
    expect((await cli(['init', '--name', 'agentb', '--description', 'b'], { cwd: agentB })).code).toBe(0);
    const own = path.join(agentB, '.laneboard');
    const env = { LANEBOARD_DIR: pinned };
    const hook = await cli(['prime', '--edit-hook'], { cwd: agentB, env: { ...env, CLAUDE_CODE_SESSION_ID: 'abcd1234' } });
    const note: string = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext;
    expect(note).toBe(
      `laneboard: the store in use, ${pinned} (prefix ORCH), looks like another project's: ${agentB} has its own store ${own}. ` +
        'Unless this folder is part of that project, its tasks belong on its own board; `laneboard boards --json` lists the boards on this machine with their descriptions.',
    );
    const warning =
      `using store ${pinned} (prefix ORCH) from LANEBOARD_DIR, but ${agentB} looks like a separate project (it has its own store ${own}); ` +
      `unless this folder is part of that project, pass --dir ${own} on every command`;
    expect(JSON.parse((await cli(['create', 'agentB work', '--status', 'todo', '--as', 'b', '--json'], { cwd: agentB, env })).stdout).warnings).toEqual([warning]);
    // A plain subfolder of agentB: the same own store, found by walking up.
    expect(JSON.parse((await cli(['list', '--json'], { cwd: sub, env })).stdout).warnings[0]).toContain(`(it has its own store ${own})`);
    const mcp = await callTool('task_list', {}, { cwd: agentB, env });
    expect(JSON.parse(mcp.content[1]?.text ?? '{}').warnings).toEqual([warning]);
    // The pinned project's root has no store of its own: silent.
    expect(JSON.parse((await cli(['list', '--json'], { cwd: root, env })).stdout).warnings).toEqual([]);
  });

  it('error envelopes name the store and prefix too', async () => {
    const { child } = await nested();
    const r = JSON.parse((await cli(['get', 'AGE2-9', '--json'], { cwd: child })).stdout);
    expect(r).toMatchObject({ ok: false, store: path.join(child, '.laneboard'), prefix: 'AGE2', error: { code: 'TASK_NOT_FOUND' } });
  });
});
