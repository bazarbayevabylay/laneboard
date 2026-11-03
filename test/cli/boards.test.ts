// Boards for people and for agents that are unsure where to write (S2c): the machine registry (~/.laneboard/boards.json in a temp
// HOME), board names and descriptions, free prefixes, `view` (kanban, filters, colors, --watch) and read-only `--board`.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { age } from '../../src/cli/board-view.ts';
import { runCli } from '../../src/cli/run.ts';
import { createTask, resolveBoard, transact } from '../../src/core/index.ts';
import { callTool } from '../../src/mcp/tools.ts';
import { cleanupTemp, cli, readStore, rejectsWith, tempDir } from '../helpers.ts';
import type { CliRun } from '../helpers.ts';

afterAll(cleanupTemp);

// A machine: one temp HOME and a folder for projects; `run` is the CLI in a project folder.
function machine(): { home: string; projects: string; project(name: string): string; run(cwd: string, argv: string[], env?: Record<string, string>): Promise<CliRun> } {
  const home = tempDir();
  const projects = tempDir();
  return {
    home,
    projects,
    project: (name) => {
      const dir = path.join(projects, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    run: (cwd, argv, env = {}) => cli(argv, { cwd, env: { HOME: home, ...env } }),
  };
}

// --json data of a successful run.
// (Parsed JSON, typed as JSON.parse returns it.)
async function data(r: Promise<CliRun>): Promise<ReturnType<typeof JSON.parse>> {
  const out = await r;
  expect(out.code, out.stdout + out.stderr).toBe(0);
  return JSON.parse(out.stdout).data;
}

describe('board registry', () => {
  it('init and setup add boards; boards lists prefix, name, description, path, counts, last change; a moved board is missing', async () => {
    const m = machine();
    const shop = m.project('shop');
    const api = m.project('api');
    await data(m.run(shop, ['init', '--name', 'Shop', '--description', 'ACME shop frontend: checkout work', '--json']));
    // A board made without HOME (not registered) joins the registry when setup pins the project to it.
    expect((await cli(['init', '--description', 'ACME API: orders service'], { cwd: api })).code).toBe(0);
    await data(m.run(api, ['setup', 'gemini', '--json']));
    await m.run(shop, ['create', 'Fix cart', '--status', 'todo', '--as', 'dev']);
    const listed = await data(m.run(m.projects, ['boards', '--json']));
    expect(listed.registry).toBe(path.join(m.home, '.laneboard', 'boards.json'));
    expect(listed.boards).toMatchObject([
      { path: path.join(shop, '.laneboard'), name: 'Shop', prefix: 'SHOP', description: 'ACME shop frontend: checkout work', missing: false, total: 1, counts: [{ status: 'todo', count: 1 }, { status: 'in_progress', count: 0 }, { status: 'review', count: 0 }, { status: 'done', count: 0 }] },
      { path: path.join(api, '.laneboard'), name: 'api', prefix: 'API', description: 'ACME API: orders service', missing: false, total: 0 },
    ]);
    expect(listed.boards[0].updated_at).toMatch(/^\d{4}-/);
    fs.renameSync(api, path.join(m.projects, 'api-moved'));
    const after = await data(m.run(m.projects, ['boards', '--json']));
    expect(after.boards[1]).toMatchObject({ path: path.join(api, '.laneboard'), missing: true, total: 0 });
    expect((await m.run(m.projects, ['boards'])).stdout).toContain('missing (no store at this path)');
  });

  it('two agents with different descriptions each find their own board in `boards --json` by description and path', async () => {
    const m = machine();
    const orch = m.project('orch');
    const agentB = m.project(path.join('orch', 'agent-b'));
    await data(m.run(orch, ['init', '--name', 'orchestrator', '--description', 'Orchestrator: plans and reviews the release', '--json']));
    fs.writeFileSync(path.join(agentB, 'CLAUDE.md'), 'You are agent B.\n');
    // Agent B starts in its folder: the store found above is another project's, so it is warned and looks at the registry.
    const stray = JSON.parse((await m.run(agentB, ['list', '--json'])).stdout);
    expect(stray.warnings[0]).toContain('looks like a separate project (it has CLAUDE.md)');
    let boards = (await data(m.run(agentB, ['boards', '--json']))).boards as Array<{ path: string; description: string; prefix: string }>;
    expect(boards.find((b) => b.description.startsWith('Agent B'))).toBeUndefined();
    // No board of its own: it creates one with a name and a description (rule 12), then finds it next time.
    await data(m.run(agentB, ['init', '--name', 'agent-b', '--description', 'Agent B: writes the billing docs', '--json']));
    boards = (await data(m.run(orch, ['boards', '--json']))).boards;
    const mine = (desc: string, cwd: string) => boards.find((b) => b.description.includes(desc) && b.path === path.join(cwd, '.laneboard'));
    expect(mine('Orchestrator', orch)).toMatchObject({ prefix: 'ORCHESTRAT' });
    expect(mine('Agent B', agentB)).toMatchObject({ prefix: 'AGENTB' });
    const r = JSON.parse((await m.run(agentB, ['create', 'Billing docs', '--status', 'todo', '--as', 'b', '--json'])).stdout);
    expect(r).toMatchObject({ ok: true, prefix: 'AGENTB', warnings: [] });
  });

  it('a prefix another live board uses is refused with a free one in the fix; a missing board frees its prefix', async () => {
    const m = machine();
    const first = m.project(path.join('a', 'claims-portal-north'));
    const second = m.project(path.join('b', 'claims-portal-south'));
    await data(m.run(first, ['init', '--description', 'first portal', '--json']));
    const taken = await m.run(second, ['init', '--description', 'second portal', '--json']);
    expect(taken.code).toBe(2);
    const err = JSON.parse(taken.stdout).error;
    expect(err).toMatchObject({ code: 'INVALID_VALUE', fix: "laneboard init --description 'second portal' --json --prefix CLAIMSPOR2", details: { taken: ['CLAIMSPORT'] } });
    expect(fs.existsSync(path.join(second, '.laneboard'))).toBe(false);
    // The fix runs as printed (minus --json) and the explicit prefix that is taken is refused the same way.
    expect((await m.run(second, ['init', '--description', 'second portal', '--prefix', 'CLAIMSPORT'])).stderr).toContain('fix: laneboard init --description \'second portal\' --prefix CLAIMSPOR2');
    await data(m.run(second, ['init', '--description', 'second portal', '--prefix', 'CLAIMSPOR2', '--json']));
    fs.rmSync(path.join(first, '.laneboard'), { recursive: true, force: true });
    const third = m.project('claims-portal-x');
    expect(JSON.parse((await m.run(third, ['init', '--description', 'third', '--json'])).stdout).prefix).toBe('CLAIMSPORT');
  });

  it('init needs a description and refuses a folder inside an existing store', async () => {
    const m = machine();
    const p = m.project('proj');
    const none = JSON.parse((await m.run(p, ['init', '--json'])).stdout);
    expect(none.error).toMatchObject({ code: 'USAGE', message: '--description is required', fix: 'laneboard init --json --description "<one line: whose project and what work>"' });
    await data(m.run(p, ['init', '--description', 'proj board', '--json']));
    const inside = JSON.parse((await m.run(path.join(p, '.laneboard'), ['init', '--description', 'nested', '--json'])).stdout);
    expect(inside.error).toMatchObject({ code: 'STORE_EXISTS' });
    expect(inside.error.message).toContain(`is inside the store ${path.join(p, '.laneboard')}`);
    expect(JSON.parse((await m.run(p, ['init', '--name', 'x'.repeat(61), '--description', 'd', '--json'])).stdout).error.code).toBe('INVALID_VALUE');
  });

  it('config shows and changes the name and description; the registry follows; the prefix stays', async () => {
    const m = machine();
    const p = m.project('web');
    await data(m.run(p, ['init', '--description', 'old text', '--json']));
    expect(await data(m.run(p, ['config', '--json']))).toEqual({ name: 'web', description: 'old text', prefix: 'WEB', changed: false });
    expect(await data(m.run(p, ['config', '--name', 'Web shop', '--description', 'ACME web shop: checkout', '--json']))).toEqual({ name: 'Web shop', description: 'ACME web shop: checkout', prefix: 'WEB', changed: true });
    expect((await data(m.run(p, ['boards', '--json']))).boards).toMatchObject([{ name: 'Web shop', description: 'ACME web shop: checkout', prefix: 'WEB' }]);
    expect((await m.run(p, ['prime', '--as', 'dev'])).stdout).toContain('(prefix WEB) - Web shop: ACME web shop: checkout');
  });

  it('the registry folder ~/.laneboard is never taken for a store by the walk up from a folder under HOME', async () => {
    const m = machine();
    await data(m.run(m.project('p'), ['init', '--description', 'p', '--json']));
    const underHome = path.join(m.home, 'work');
    fs.mkdirSync(underHome);
    const r = JSON.parse((await m.run(underHome, ['list', '--json'])).stdout);
    expect(r.error.code).toBe('STORE_NOT_FOUND');
  });

  it('an empty ~/.laneboard (a first init that failed inside the registry lock) is still the registry, not a broken store', async () => {
    const m = machine();
    const old = m.project('old');
    // A store made without HOME, then a first registered init into it: STORE_EXISTS inside the registry lock leaves ~/.laneboard empty.
    expect((await cli(['init', '--description', 'old'], { cwd: old, env: { HOME: '' } })).code).toBe(0);
    expect(JSON.parse((await m.run(old, ['init', '--description', 'again', '--json'])).stdout).error.code).toBe('STORE_EXISTS');
    expect(fs.readdirSync(path.join(m.home, '.laneboard'))).toEqual([]);
    const fresh = path.join(m.home, 'code', 'fresh');
    fs.mkdirSync(fresh, { recursive: true });
    const r = JSON.parse((await m.run(fresh, ['list', '--json'])).stdout);
    expect(r).toMatchObject({ ok: false, store: null, error: { code: 'STORE_NOT_FOUND' } });
    expect((await m.run(fresh, ['prime', '--hook'])).stdout).toMatch(/^laneboard: no board found \(no \.laneboard directory in /);
    const mcp = await callTool('task_list', {}, { cwd: fresh, env: { HOME: m.home } });
    expect(JSON.parse(mcp.content[0]?.text ?? '{}').code).toBe('STORE_NOT_FOUND');
  });

  it('init in HOME is refused at once: ~/.laneboard is the registry (it would wait on its own lock); nothing is created', async () => {
    const m = machine();
    const started = Date.now();
    const r = JSON.parse((await m.run(m.home, ['init', '--description', 'home', '--json'])).stdout);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.error).toMatchObject({ code: 'STORE_EXISTS', message: `${path.join(m.home, '.laneboard')} is this machine's board registry (laneboard boards), so no board can be created there` });
    expect(r.error.fix).toBe(`create the board in the project's own folder: mkdir -p ${path.join(m.home, '<project>')} && cd ${path.join(m.home, '<project>')} && laneboard init --name <name> --description "<whose project, what work>"`);
    expect(fs.existsSync(path.join(m.home, '.laneboard'))).toBe(false);
  });
});

describe('--board opens another board read-only', () => {
  // Two boards: mine (MINE) and theirs (THEIRS) with one task.
  async function two(): Promise<{ m: ReturnType<typeof machine>; mine: string; theirs: string }> {
    const m = machine();
    const mine = m.project('mine');
    const theirs = m.project('theirs');
    await data(m.run(mine, ['init', '--description', 'my board', '--json']));
    await data(m.run(theirs, ['init', '--description', 'their board', '--json']));
    await m.run(theirs, ['create', 'Their task', '--status', 'todo', '--as', 'them']);
    return { m, mine, theirs };
  }

  it('view, list, get and events read it by prefix, name or path', async () => {
    const { m, mine, theirs } = await two();
    for (const board of ['THEIRS', 'theirs', 'Theirs', path.join(theirs, '.laneboard'), '../theirs']) {
      const r = JSON.parse((await m.run(mine, ['list', '--board', board, '--json'])).stdout);
      expect(r, board).toMatchObject({ ok: true, store: path.join(theirs, '.laneboard'), prefix: 'THEIRS', data: { total: 1 } });
    }
    expect((await m.run(mine, ['view', '--board', 'THEIRS'], { COLUMNS: '90' })).stdout).toContain('THEIRS-1 Their task');
    expect((await data(m.run(mine, ['get', 'THEIRS-1', '--board', 'THEIRS', '--json']))).title).toBe('Their task');
    expect((await data(m.run(mine, ['events', '--board', 'THEIRS', '--json']))).total).toBe(1);
    const unknown = JSON.parse((await m.run(mine, ['view', '--board', 'NOPE', '--json'])).stdout);
    expect(unknown.error).toMatchObject({ code: 'STORE_NOT_FOUND', allowed: ['MINE', 'THEIRS'] });
  });

  it('every write through --board is refused (STORE_READ_ONLY) and their store stays byte for byte the same', async () => {
    const { m, mine, theirs } = await two();
    const file = path.join(theirs, '.laneboard', 'active.json');
    const before = fs.readFileSync(file, 'utf8');
    for (const argv of [
      ['create', 'x', '--status', 'todo', '--as', 'me'],
      ['update', 'THEIRS-1', '--title', 'mine now', '--as', 'me'],
      ['claim', 'THEIRS-1', '--as', 'me'],
      ['comment', 'THEIRS-1', 'hi', '--as', 'me'],
      ['archive', 'THEIRS-1', '--as', 'me'],
      ['delete', 'THEIRS-1', '--confirm', 'THEIRS-1', '--as', 'me'],
      ['config', '--name', 'hijacked'],
      ['doctor', '--fix'],
    ]) {
      const r = await m.run(mine, [...argv, '--board', 'THEIRS', '--json']);
      expect(r.code, argv.join(' ')).toBe(6);
      expect(JSON.parse(r.stdout).error.code, argv.join(' ')).toBe('STORE_READ_ONLY');
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(readStore(path.join(mine, '.laneboard'), 'active').tasks).toEqual([]);
  });

  it('core refuses a write to a read-only store too (a facade that forgets the check still cannot write)', async () => {
    const { m, theirs } = await two();
    const ref = resolveBoard(m.home, 'THEIRS', m.projects);
    expect(ref).toEqual({ dir: path.join(theirs, '.laneboard'), found: 'board', readOnly: true });
    await rejectsWith(createTask({ store: ref, actor: 'me' }, { title: 'x', status: 'todo' }), 'STORE_READ_ONLY');
    await rejectsWith(transact(ref, { files: ['active'] }, () => undefined), 'STORE_READ_ONLY');
  });
});

// Run `laneboard view` in-process like a terminal (or not), with an abort signal for --watch.
async function viewRun(cwd: string, argv: string[], io: { isTTY?: boolean; env?: Record<string, string>; signal?: AbortSignal; onOutput?: (all: string) => void; pollMs?: number; noEvents?: boolean }): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const code = await runCli({
    argv: ['view', ...argv],
    env: io.env ?? {},
    cwd,
    readStdin: () => '',
    stdout: (t) => {
      stdout += t;
      io.onOutput?.(stdout);
    },
    stderr: (t) => {
      stderr += t;
    },
    columns: 100,
    isTTY: io.isTTY,
    signal: io.signal,
    watchPollMs: io.pollMs,
    watchNoEvents: io.noEvents,
  });
  return { code, stdout, stderr };
}

describe('view', () => {
  it('colors only on a terminal without NO_COLOR', async () => {
    const m = machine();
    const p = m.project('c');
    await data(m.run(p, ['init', '--description', 'colors', '--json']));
    await m.run(p, ['create', 'Paint', '--status', 'todo', '--as', 'a']);
    const ESC = '\u001b[';
    expect((await viewRun(p, [], { isTTY: true })).stdout).toContain(`${ESC}36mC-1 ${ESC}0m`);
    expect((await viewRun(p, [], { isTTY: true, env: { NO_COLOR: '1' } })).stdout).not.toContain(ESC);
    expect((await viewRun(p, [], { isTTY: false })).stdout).not.toContain(ESC);
  });

  it('time in status is short: <1m, minutes, hours up to 48, then days', () => {
    const now = new Date('2026-11-04T12:00:00.000Z');
    const ago = (ms: number): string => age(new Date(now.getTime() - ms).toISOString(), now);
    expect([ago(59_000), ago(60_000), ago(59 * 60_000), ago(3_600_000), ago(47 * 3_600_000), ago(48 * 3_600_000), ago(-5000)]).toEqual(['<1m', '1m', '59m', '1h', '47h', '2d', '<1m']);
  });

  it('a card shows how long the task has been in its status', async () => {
    const m = machine();
    const p = m.project('t');
    await data(m.run(p, ['init', '--description', 'times', '--json']));
    await m.run(p, ['create', 'Old one', '--status', 'todo', '--as', 'a']);
    const file = path.join(p, '.laneboard', 'active.json');
    const store = readStore(path.join(p, '.laneboard'), 'active');
    const task = store.tasks[0] as unknown as { created_at: string };
    task.created_at = new Date(Date.now() - 3 * 86_400_000 - 1000).toISOString();
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, JSON.stringify(store));
    expect((await viewRun(p, [], {})).stdout).toContain('3d · unassigned');
  });

  for (const mode of ['fs.watch', 'poll'] as const) {
    it(`--watch redraws after a write from another process (${mode}) and ends with exit 0 on Ctrl+C`, async () => {
      const m = machine();
      const p = m.project('w');
      await data(m.run(p, ['init', '--description', 'watch', '--json']));
      const stop = new AbortController();
      let frames = 0;
      const seen = new Promise<void>((resolve) => {
        const onOutput = (all: string): void => {
          frames = all.split('watching for changes').length - 1;
          if (all.includes('W-1 Arrives later')) resolve();
        };
        void viewRun(p, ['--watch'], { signal: stop.signal, onOutput, pollMs: mode === 'poll' ? 50 : 60_000, noEvents: mode === 'poll' }).then((r) => {
          result = r;
        });
      });
      let result: CliRun | undefined;
      await new Promise((r) => setTimeout(r, 150));
      await createTask({ store: { dir: path.join(p, '.laneboard') }, actor: 'a' }, { title: 'Arrives later', status: 'todo' });
      await seen;
      expect(frames).toBeGreaterThanOrEqual(2);
      stop.abort();
      await new Promise((r) => setTimeout(r, 50));
      expect(result?.code).toBe(0);
    });
  }

  it('--watch with --json is a usage error', async () => {
    const m = machine();
    const p = m.project('j');
    await data(m.run(p, ['init', '--description', 'json', '--json']));
    expect((await m.run(p, ['view', '--watch', '--json'])).code).toBe(2);
  });
});
