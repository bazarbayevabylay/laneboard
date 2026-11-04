// LB-22: `laneboard config --statuses a,b,c` changes the board's statuses after init (ADR-0001 §33): add and reorder freely, a status
// that active tasks are in is not dropped (the fix lists them and runs), archived tasks keep a dropped status, a new final status warns;
// and the prefix of a board is checked at every registration (review S5c MINOR: a copied project folder, a board without permission).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.ts';
import { acquireLock } from '../../src/core/lock.ts';
import { cleanupTemp, cli, tempDir } from '../helpers.ts';
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
      message: `prefix WEB of the board at ${store} is already used by the board at ${path.join(web, '.laneboard')}; two boards with one prefix have look-alike ids, so this board is not registered; give it a free prefix`,
      fix: 'laneboard config --name web2 --json --prefix WEB2',
      details: { taken: ['WEB'], owner: path.join(web, '.laneboard') },
    });
    expect(fs.readFileSync(path.join(store, 'config.json'), 'utf8')).toBe(before);
    expect(registered(m.home)).toEqual(['WEB']);
    const fixed = await doc(m.run(copy, shellArgv(r.error.fix)));
    expect(fixed).toMatchObject({ code: 0, data: { name: 'web2', prefix: 'WEB2', changed: true } });
    expect(registered(m.home)).toEqual(['WEB', 'WEB2']);
  });

  it('a copied project folder with tasks: setup writes its files but does not register it; the warning names the other board', async () => {
    const m = machine();
    const web = m.project('web');
    expect((await m.run(web, ['init', '--description', 'web shop'])).code).toBe(0);
    expect((await m.run(web, ['create', 'one', '--status', 'todo', '--as', 'dev'])).code).toBe(0);
    const copy = path.join(m.projects, 'web2');
    fs.cpSync(web, copy, { recursive: true });
    const r = await doc(m.run(copy, ['setup', 'gemini', '--json']));
    expect(r.code).toBe(0);
    const owner = path.join(web, '.laneboard');
    expect(r.warnings).toContain(
      `the board was not added to the machine registry (laneboard boards): prefix WEB of the board at ${path.join(copy, '.laneboard')} is already used by the board at ${owner}; ` +
        'two boards with one prefix have look-alike ids, so this board is not registered; it has 1 task(s) with ids like WEB-1, so its prefix cannot change; ' +
        `fix: if this board is a copy of that one, use that board: laneboard prime --dir ${owner}; else move ${path.join(copy, '.laneboard')} aside and create this project's own board: ` +
        `laneboard init --dir ${path.join(copy, '.laneboard')} --name <name> --description "<whose project, what work>"`,
    );
    expect(registered(m.home)).toEqual(['WEB']);
    expect((await m.run(copy, ['prime', '--dir', owner])).code).toBe(0);
    // The same through config: refused, the config of the copy is unchanged.
    expect((await doc(m.run(copy, ['config', '--description', 'copy', '--json']))).error.code).toBe('INVALID_VALUE');
    expect(loadConfig(path.join(copy, '.laneboard')).description).toBe('web shop');
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
