// LB-22: `laneboard config --statuses a,b,c` changes the board's statuses after init (ADR-0001 §33): add and reorder freely, a status
// that active tasks are in is not dropped (the fix lists them and runs), archived tasks keep a dropped status, a new final status warns;
// and the prefix of a board is checked at every registration (review S5c MINOR: a copied project folder, a board without permission).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/core/config.ts';
import { acquireLock } from '../../src/core/lock.ts';
import { contentSha } from '../../src/core/store.ts';
import { cleanupTemp, cli, readStore, tempDir, writeRaw } from '../helpers.ts';
import type { CliRun } from '../helpers.ts';

afterAll(cleanupTemp);

// Split a printed `laneboard ...` fix into argv the way a shell would.
function shellArgv(fix: string): string[] {
  expect(fix.startsWith('laneboard ')).toBe(true);
  const out = execFileSync('sh', ['-c', `printf '%s\\0' ${fix.slice('laneboard '.length)}`], { encoding: 'utf8' });
  return out.split('\0').slice(0, -1);
}

// A machine: one temp HOME and a folder for projects; `run` is the CLI in a project folder.
function machine(): { home: string; projects: string; project(name: string): string; run(cwd: string, argv: string[]): Promise<CliRun> } {
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
    run: (cwd, argv) => cli(argv, { cwd, env: { HOME: home } }),
  };
}

// The --json document of a run, with its exit code.
async function doc(r: Promise<CliRun>): Promise<{ code: number } & ReturnType<typeof JSON.parse>> {
  const out = await r;
  return { code: out.code, ...JSON.parse(out.stdout) };
}

// Prefixes in the machine registry, in order.
function registered(home: string): string[] {
  const file = path.join(home, '.laneboard', 'boards.json');
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { boards: Array<{ prefix: string }> }).boards.map((b) => b.prefix);
}

// A board `web` (prefix WEB) with tasks WEB-1 (todo), WEB-2 and WEB-3 (review), WEB-4 (done).
async function board(): Promise<{ m: ReturnType<typeof machine>; p: string; store: string; run(argv: string[]): Promise<CliRun> }> {
  const m = machine();
  const p = m.project('web');
  const run = (argv: string[]): Promise<CliRun> => m.run(p, argv);
  expect((await run(['init', '--description', 'web shop'])).code).toBe(0);
  for (const [title, status] of [
    ['one', 'todo'],
    ['two', 'review'],
    ['three', 'review'],
    ['four', 'done'],
  ] as const) {
    expect((await run(['create', title, '--status', status, '--as', 'dev'])).code).toBe(0);
  }
  return { m, p, store: path.join(p, '.laneboard'), run };
}

describe('config --statuses', () => {
  it('adds and reorders statuses; the last one is final; create, list and prime follow the new list; no registry write needed', async () => {
    const { m, store, run } = await board();
    const registry = fs.readFileSync(path.join(m.home, '.laneboard', 'boards.json'), 'utf8');
    const r = await doc(run(['config', '--statuses', 'backlog, todo,in_progress,review,done', '--json']));
    expect(r).toMatchObject({ code: 0, ok: true, data: { statuses: ['backlog', 'todo', 'in_progress', 'review', 'done'], changed: true }, warnings: [] });
    expect(loadConfig(store).statuses).toEqual(['backlog', 'todo', 'in_progress', 'review', 'done']);
    expect(loadConfig(store).schema).toBe('laneboard/config@1');
    expect(fs.readFileSync(path.join(m.home, '.laneboard', 'boards.json'), 'utf8')).toBe(registry);
    expect((await doc(run(['create', 'later', '--status', 'backlog', '--as', 'dev', '--json']))).data).toMatchObject({ id: 'WEB-5', status: 'backlog' });
    const prime = await doc(run(['prime', '--as', 'dev', '--json']));
    expect(prime.data).toMatchObject({ first_status: 'backlog', final_status: 'done' });
    // The same list again changes nothing; the human output names the list and the final status.
    expect((await doc(run(['config', '--statuses', 'backlog,todo,in_progress,review,done', '--json']))).data.changed).toBe(false);
    expect((await run(['config'])).stdout).toContain('\n  statuses: backlog, todo, in_progress, review, done (final: done)\n');
  });

  it('a status that active tasks are in is not dropped: INVALID_VALUE naming them, nothing written; the fix lists them; after the move it works', async () => {
    const { store, run } = await board();
    const before = fs.readFileSync(path.join(store, 'config.json'), 'utf8');
    const r = await doc(run(['config', '--statuses', 'todo,in_progress,done', '--json']));
    expect(r.code).toBe(2);
    expect(r.error).toMatchObject({
      code: 'INVALID_VALUE',
      message:
        'cannot remove a status that 2 active task(s) are in: review (2: WEB-2, WEB-3); move each of them to a status you keep (laneboard update <ID> --status <status>), ' +
        'then run this command again (a new name for a status: add the new name, move the tasks, then drop the old name)',
      details: { in_use: [{ status: 'review', tasks: ['WEB-2', 'WEB-3'] }] },
      fix: `laneboard list --status review --dir ${store} --json`,
    });
    expect(fs.readFileSync(path.join(store, 'config.json'), 'utf8')).toBe(before);
    // The fix runs (from another folder too: it names the store) and lists exactly the tasks to move.
    const listed = await doc(cli(shellArgv(r.error.fix), { cwd: tempDir(), env: {} }));
    expect(listed.code).toBe(0);
    expect(listed.data.items.map((t: { id: string }) => t.id).sort()).toEqual(['WEB-2', 'WEB-3']);
    // A new name for a status: add it, move the tasks, then drop the old one.
    expect((await run(['config', '--statuses', 'todo,in_progress,qa,review,done'])).code).toBe(0);
    for (const id of ['WEB-2', 'WEB-3']) expect((await run(['update', id, '--status', 'qa', '--as', 'dev'])).code).toBe(0);
    const ok = await doc(run(['config', '--statuses', 'todo,in_progress,qa,done', '--json']));
    expect(ok).toMatchObject({ code: 0, data: { statuses: ['todo', 'in_progress', 'qa', 'done'], changed: true }, warnings: [] });
  });

  it('two dropped statuses in use: both named, the fix lists both', async () => {
    const { store, run } = await board();
    const r = await doc(run(['config', '--statuses', 'in_progress,review', '--json']));
    expect(r.error.message).toContain('cannot remove statuses that 2 active task(s) are in: todo (1: WEB-1); done (1: WEB-4);');
    expect(r.error.fix).toBe(`laneboard list --status todo --status done --dir ${store} --json`);
    const listed = await doc(cli(shellArgv(r.error.fix), { cwd: tempDir(), env: {} }));
    expect(listed.data.items.map((t: { id: string }) => t.id).sort()).toEqual(['WEB-1', 'WEB-4']);
  });

  it('archived tasks keep a dropped status (read as unknown) and do not block; the warning counts them', async () => {
    const { store, run } = await board();
    expect((await run(['update', 'WEB-3', '--status', 'todo', '--as', 'dev'])).code).toBe(0);
    expect((await run(['archive', 'WEB-2', '--as', 'dev'])).code).toBe(0);
    const r = await doc(run(['config', '--statuses', 'todo,in_progress,done', '--json']));
    expect(r).toMatchObject({ code: 0, data: { changed: true } });
    expect(r.warnings).toEqual([
      '1 archived task(s) keep the removed status review: they stay readable as an unknown status, and restore brings them back in it (then laneboard update <ID> --status <status>)',
    ]);
    expect((await doc(run(['get', 'WEB-2', '--json']))).data).toMatchObject({ status: 'review', archived: true });
    expect(loadConfig(store).statuses).toEqual(['todo', 'in_progress', 'done']);
  });

  it('a new final status warns which tasks stop and start counting as closed; open tasks and finish follow the new list', async () => {
    const { run } = await board();
    const r = await doc(run(['config', '--statuses', 'todo,in_progress,done,review', '--json']));
    expect(r).toMatchObject({ code: 0, data: { statuses: ['todo', 'in_progress', 'done', 'review'] } });
    expect(r.warnings).toEqual([
      'the final status changes from done to review: active tasks in done (1) no longer count as closed, those in review (2) do; finish, accepting handed-in tasks and the in-work and stale marks now use review',
    ]);
    const open = await doc(run(['list', '--open', '--json']));
    expect(open.data.items.map((t: { id: string }) => t.id).sort()).toEqual(['WEB-1', 'WEB-4']);
    expect((await doc(run(['finish', 'WEB-1', '--result', 'done', '--no-commit', '--as', 'dev', '--json']))).data).toMatchObject({ status: 'review' });
    // A reorder that keeps the last status says nothing.
    expect((await doc(run(['config', '--statuses', 'in_progress,todo,done,review', '--json']))).warnings).toEqual([]);
  });

  it('a bad or repeated status is INVALID_VALUE and nothing is written', async () => {
    const { store, run } = await board();
    const before = fs.readFileSync(path.join(store, 'config.json'), 'utf8');
    expect((await doc(run(['config', '--statuses', 'todo,in progress,review,done', '--json']))).error).toMatchObject({ code: 'INVALID_VALUE', message: 'status "in progress" must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$' });
    expect((await doc(run(['config', '--statuses', 'todo,review,todo,done', '--json']))).error).toMatchObject({ code: 'INVALID_VALUE', fix: 'list each status once: --statuses todo,review,done' });
    expect((await doc(run(['config', '--statuses', '', '--json']))).error.code).toBe('INVALID_VALUE');
    expect(fs.readFileSync(path.join(store, 'config.json'), 'utf8')).toBe(before);
  });

  it('the change runs under the store lock (the lock of every task write): busy lock -> LOCK_TIMEOUT, config unchanged', async () => {
    const { p, store } = await board();
    const before = fs.readFileSync(path.join(store, 'config.json'), 'utf8');
    const lock = await acquireLock(store);
    try {
      const r = await cli(['config', '--statuses', 'todo,done', '--json'], { cwd: p, env: {}, lockWaitMs: 300 });
      expect(r.code).toBe(5);
      expect(JSON.parse(r.stdout).error.code).toBe('LOCK_TIMEOUT');
    } finally {
      await lock.release();
    }
    expect(fs.readFileSync(path.join(store, 'config.json'), 'utf8')).toBe(before);
  });

  it('the in-use check reads the tasks under the store lock: a task that enters the dropped status while config waits for the lock blocks it (review LB-22 MAJOR 2)', async () => {
    const { p, store } = await board();
    const before = fs.readFileSync(path.join(store, 'config.json'), 'utf8');
    const lockPath = path.join(store, 'lock');
    const lock = await acquireLock(store);
    // config's first attempt at the lock directory (busy: the test holds it) means everything it does before the lock is done.
    let waiting!: () => void;
    const attempted = new Promise<void>((resolve) => (waiting = resolve));
    const mkdir = fs.mkdir;
    const spy = vi.spyOn(fs, 'mkdir').mockImplementation(((dir: fs.PathLike, ...rest: unknown[]) => {
      if (String(dir) === lockPath) waiting();
      return (mkdir as (...a: unknown[]) => void)(dir, ...rest);
    }) as typeof fs.mkdir);
    let run: Promise<CliRun>;
    try {
      run = cli(['config', '--statuses', 'todo,review,done', '--json'], { cwd: p, env: {}, lockWaitMs: 20_000 });
      await attempted;
      // In that window a writer (here: the test, holding the lock like transact) moves WEB-1 into in_progress, the status config drops.
      const active = readStore(store, 'active');
      const tasks = active.tasks.map((t) => (t.id === 'WEB-1' ? { ...t, status: 'in_progress' } : t));
      writeRaw(path.join(store, 'active.json'), `${JSON.stringify({ ...active, tasks, content_sha256: contentSha(tasks) }, null, 2)}\n`);
    } finally {
      spy.mockRestore();
      await lock.release();
    }
    const r = await doc(run);
    expect(r.code).toBe(2);
    expect(r.error).toMatchObject({ code: 'INVALID_VALUE', details: { in_use: [{ status: 'in_progress', tasks: ['WEB-1'] }] } });
    expect(fs.readFileSync(path.join(store, 'config.json'), 'utf8')).toBe(before);
  });
});

describe('prefix checked at every registration (review S5c MINOR)', () => {
  it('a copied project folder without tasks: config --name is refused, nothing written; the fix gives it a free prefix and runs', async () => {
    const m = machine();
    const web = m.project('web');
    expect((await m.run(web, ['init', '--description', 'web shop'])).code).toBe(0);
    const copy = path.join(m.projects, 'web2');
    fs.cpSync(web, copy, { recursive: true });
    const store = path.join(copy, '.laneboard');
    const before = fs.readFileSync(path.join(store, 'config.json'), 'utf8');
    const r = await doc(m.run(copy, ['config', '--name', 'web2', '--json']));
    expect(r.code).toBe(2);
    expect(r.error).toMatchObject({
      code: 'INVALID_VALUE',
      message: `prefix WEB of the board at ${store} is already used by the board at ${path.join(web, '.laneboard')}, registered earlier; two boards with one prefix have look-alike ids, so this board is not registered; give it a free prefix`,
      fix: 'laneboard config --name web2 --json --prefix WEB2',
      details: { taken: ['WEB'], owner: path.join(web, '.laneboard') },
    });
    expect(fs.readFileSync(path.join(store, 'config.json'), 'utf8')).toBe(before);
    expect(registered(m.home)).toEqual(['WEB']);
    const fixed = await doc(m.run(copy, shellArgv(r.error.fix)));
    expect(fixed).toMatchObject({ code: 0, data: { name: 'web2', prefix: 'WEB2', changed: true } });
    expect(registered(m.home)).toEqual(['WEB', 'WEB2']);
  });

  it('a copied project folder with tasks: setup writes its files but does not register it; the warning names the other board, its fix undoes the setup', async () => {
    const m = machine();
    const web = m.project('web');
    expect((await m.run(web, ['init', '--description', 'web shop'])).code).toBe(0);
    expect((await m.run(web, ['create', 'one', '--status', 'todo', '--as', 'dev'])).code).toBe(0);
    const copy = path.join(m.projects, 'web2');
    fs.cpSync(web, copy, { recursive: true });
    const r = await doc(m.run(copy, ['setup', 'gemini', '--json']));
    expect(r.code).toBe(0);
    const owner = path.join(web, '.laneboard');
    const store = path.join(copy, '.laneboard');
    const fix = `laneboard setup gemini --remove --dir ${store}`;
    expect(r.warnings).toContain(
      `the board was not added to the machine registry (laneboard boards): prefix WEB of the board at ${store} is already used by the board at ${owner}, registered earlier; ` +
        'two boards with one prefix have look-alike ids, so this board is not registered; it has 1 task(s) with ids like WEB-1, so its prefix cannot change. ' +
        'If this folder is a copy of that project, a harness set up here writes to the copy: undo that setup in this folder (the fix), ' +
        `and work on that board from its project (laneboard setup gemini in ${web}); else move ${store} aside and create this project's own board ` +
        `(laneboard init --dir ${store} --name <name> --description "<whose project, what work>"); fix: ${fix}`,
    );
    expect(registered(m.home)).toEqual(['WEB']);
    expect(fs.existsSync(path.join(copy, 'GEMINI.md'))).toBe(true);
    // The fix runs in the copy and takes its harness files away; setup in the original project pins the original board.
    const undone = await doc(m.run(copy, shellArgv(fix).concat('--json')));
    expect(undone).toMatchObject({ code: 0, data: { mode: 'remove' } });
    expect(fs.existsSync(path.join(copy, 'GEMINI.md'))).toBe(false);
    expect(fs.existsSync(path.join(copy, '.gemini', 'settings.json'))).toBe(false);
    expect(await doc(m.run(web, ['setup', 'gemini', '--json']))).toMatchObject({ code: 0, warnings: [] });
    // The same through config: refused, the config of the copy is unchanged; without a harness at hand the fix has a placeholder.
    const c = await doc(m.run(copy, ['config', '--description', 'copy', '--json']));
    expect(c.error).toMatchObject({ code: 'INVALID_VALUE', fix: `laneboard setup <harness> --remove --dir ${store}` });
    expect(loadConfig(store).description).toBe('web shop');
  });

  it('a duplicate already in the registry (an older laneboard registered the copy) does not lock the original board; the copy stays refused (review LB-22 MAJOR 1)', async () => {
    const m = machine();
    const web = m.project('web');
    expect((await m.run(web, ['init', '--description', 'web shop'])).code).toBe(0);
    expect((await m.run(web, ['create', 'one', '--status', 'todo', '--as', 'dev'])).code).toBe(0);
    const owner = path.join(web, '.laneboard');
    const copyProject = path.join(m.projects, 'web2');
    fs.cpSync(web, copyProject, { recursive: true });
    const copy = path.join(copyProject, '.laneboard');
    // What setup of 0.3.1 / a1f02eb wrote in the copy: a second WEB entry, registered after the original.
    const file = path.join(m.home, '.laneboard', 'boards.json');
    const reg = JSON.parse(fs.readFileSync(file, 'utf8')) as { boards: Array<{ registered_at: string }> };
    const later = new Date(Date.parse(reg.boards[0]?.registered_at ?? '') + 60_000).toISOString();
    reg.boards.push({ path: copy, prefix: 'WEB', name: 'web', description: 'web shop', registered_at: later } as never);
    fs.writeFileSync(file, JSON.stringify(reg, null, 2));
    expect(registered(m.home)).toEqual(['WEB', 'WEB']);
    const warning =
      `prefix WEB is also used by the board at ${copy}, registered later (a copied project folder?); its ids look like this board's and its changes are refused; ` +
      `it has 1 task(s), so its prefix cannot change: move ${copy} aside, or undo the harness setup there (laneboard setup <harness> --remove in ${copyProject})`;
    // The original (registered first under its path) changes its name and description; the warning names the copy.
    const r = await doc(m.run(web, ['config', '--description', 'web shop v2', '--name', 'shop', '--json']));
    expect(r).toMatchObject({ code: 0, data: { name: 'shop', description: 'web shop v2', changed: true }, warnings: [warning] });
    const entries = (JSON.parse(fs.readFileSync(file, 'utf8')) as { boards: Array<{ path: string; name: string | null; description: string | null }> }).boards;
    expect(entries.find((e) => e.path === owner)).toMatchObject({ name: 'shop', description: 'web shop v2' });
    expect(entries.find((e) => e.path === copy)).toMatchObject({ name: 'web', description: 'web shop' });
    // Its own prefix given again is not a prefix taken by another board either.
    expect(await doc(m.run(web, ['config', '--prefix', 'WEB', '--json']))).toMatchObject({ code: 0, data: { prefix: 'WEB', changed: false }, warnings: [warning] });
    // setup on the original: registered, the same warning, no "not added".
    expect(await doc(m.run(web, ['setup', 'gemini', '--json']))).toMatchObject({ code: 0, warnings: [warning] });
    // The copy, registered later, is still refused, and the message says it is in the registry.
    const c = await doc(m.run(copyProject, ['config', '--description', 'copy', '--json']));
    expect(c.code).toBe(2);
    expect(c.error).toMatchObject({
      code: 'INVALID_VALUE',
      message: expect.stringContaining(
        `prefix WEB of the board at ${copy} is already used by the board at ${owner}, registered earlier; two boards with one prefix have look-alike ids, this board is in the registry too (since ${later}, after that board), so its entry is not updated; it has 1 task(s)`,
      ),
      details: { owner },
    });
    expect(loadConfig(copy).description).toBe('web shop');
  });

  it('a duplicate without tasks registered later: the warning on the original gives it a free prefix, and that fix runs', async () => {
    const m = machine();
    const web = m.project('web');
    expect((await m.run(web, ['init', '--description', 'web shop'])).code).toBe(0);
    const copyProject = path.join(m.projects, 'web2');
    fs.cpSync(web, copyProject, { recursive: true });
    const copy = path.join(copyProject, '.laneboard');
    const file = path.join(m.home, '.laneboard', 'boards.json');
    const reg = JSON.parse(fs.readFileSync(file, 'utf8')) as { boards: Array<{ registered_at: string }> };
    reg.boards.push({ path: copy, prefix: 'WEB', name: 'web', description: 'web shop', registered_at: new Date(Date.now() + 60_000).toISOString() } as never);
    fs.writeFileSync(file, JSON.stringify(reg, null, 2));
    const r = await doc(m.run(web, ['config', '--description', 'web shop v2', '--json']));
    expect(r.code).toBe(0);
    const fix = `laneboard config --prefix WEB2 --dir ${copy}`;
    expect(r.warnings).toEqual([`prefix WEB is also used by the board at ${copy}, registered later (a copied project folder?); its ids look like this board's and its changes are refused until it gets a free prefix: ${fix}`]);
    expect(await doc(cli(shellArgv(fix).concat('--json'), { cwd: tempDir(), env: { HOME: m.home } }))).toMatchObject({ code: 0, data: { prefix: 'WEB2' } });
    expect(registered(m.home)).toEqual(['WEB', 'WEB2']);
    expect((await doc(m.run(web, ['config', '--description', 'web shop v3', '--json']))).warnings).toEqual([]);
  });

  it('init does not take the prefix of a board whose folder it cannot read (EACCES is not missing)', async () => {
    const m = machine();
    const web = m.project('web');
    expect((await m.run(web, ['init', '--description', 'web shop'])).code).toBe(0);
    const other = m.project('other');
    const store = path.join(web, '.laneboard');
    fs.chmodSync(store, 0o000);
    try {
      const r = await doc(m.run(other, ['init', '--prefix', 'WEB', '--description', 'other', '--json']));
      expect(r.code).toBe(2);
      expect(r.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard init --prefix WEB2 --description other --json', details: { taken: ['WEB'] } });
    } finally {
      fs.chmodSync(store, 0o755);
    }
    expect(fs.existsSync(path.join(other, '.laneboard', 'config.json'))).toBe(false);
    expect(registered(m.home)).toEqual(['WEB']);
  });

  it('the same board under another spelling of its path is not a second board', async () => {
    const m = machine();
    const web = m.project('web');
    expect((await m.run(web, ['init', '--description', 'web shop'])).code).toBe(0);
    const link = path.join(tempDir(), 'link');
    fs.symlinkSync(web, link);
    const r = await doc(cli(['config', '--description', 'via a symlink', '--dir', path.join(link, '.laneboard'), '--json'], { cwd: link, env: { HOME: m.home } }));
    expect(r).toMatchObject({ code: 0, data: { description: 'via a symlink', changed: true } });
  });
});
