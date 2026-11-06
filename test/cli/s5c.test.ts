// S5c DoD through the CLI (ADR §30): links to tasks of other boards, get with linked_tasks, an id of another board with a fix that
// reaches it; every new error's fix runs (K4). Review S5b MINOR 2 (only passing errno codes say "run it again") and MINOR 4
// (list --all-boards outside every board).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { unreadableStoreFile } from '../../src/core/config.ts';
import { createTask, registerStore } from '../../src/core/index.ts';
import { as, cleanupTemp, cli, newStore, readStore, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

// Split a printed `laneboard ...` fix into argv the way a shell would (as test/cli/lb18.test.ts).
function shellArgv(fix: string): string[] {
  expect(fix.startsWith('laneboard ')).toBe(true);
  const out = execFileSync('sh', ['-c', `printf '%s\\0' ${fix.slice('laneboard '.length)}`], { encoding: 'utf8' });
  return out.split('\0').slice(0, -1);
}

// Two registered boards in a fresh HOME: LB (the current one, with LB-1) and WEB (with WEB-1 in todo), both todo..done.
async function machine(): Promise<{ home: string; lb: TestStore; web: TestStore }> {
  const home = tempDir();
  const lb = await newStore();
  const web = await newStore({ prefix: 'WEB' });
  await registerStore(home, lb.dir);
  await registerStore(home, web.dir);
  await createTask(as(lb, 'a'), { title: 'LB one', status: 'todo' });
  await createTask(as(web, 'a'), { title: 'Web login page', status: 'todo' });
  return { home, lb, web };
}

// Run the CLI on board LB with HOME set; the parsed JSON envelope with the exit code.
async function lbJson(m: { home: string; lb: TestStore }, argv: string[]): Promise<{ code: number; doc: { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; fix: string; allowed?: string[] } } }> {
  const r = await cli([...argv, '--json'], { cwd: m.lb.root, env: { HOME: m.home } });
  return { code: r.code, doc: JSON.parse(r.stdout) };
}

describe('S5c DoD: links to tasks of other boards', () => {
  it('create --link task=WEB-1 with board WEB live: ok; get shows linked_tasks and the human link line', async () => {
    const m = await machine();
    const created = await lbJson(m, ['create', 'd', '--status', 'todo', '--link', 'task=WEB-1', '--as', 'a']);
    expect(created.code, JSON.stringify(created.doc)).toBe(0);
    expect(created.doc.ok).toBe(true);
    const got = await lbJson(m, ['get', 'LB-2']);
    expect((got.doc.data?.linked_tasks as unknown[])[0]).toMatchObject({ ref: 'WEB-1', board: 'WEB', found: true, status: 'todo', final: false });
    const human = await cli(['get', 'LB-2'], { cwd: m.lb.root, env: { HOME: m.home } });
    expect(human.stdout).toContain('  links: task=WEB-1 (WEB todo: Web login page)');
  });

  it('task=WEB-99: TASK_NOT_FOUND, its fix (a search on board WEB) runs', async () => {
    const m = await machine();
    const r = await lbJson(m, ['create', 'd', '--status', 'todo', '--link', 'task=WEB-99', '--as', 'a']);
    expect(r.code).toBe(3);
    expect(r.doc.error).toMatchObject({ code: 'TASK_NOT_FOUND', message: `link task=WEB-99: no such task on board WEB (${m.web.dir})` });
    expect(r.doc.error?.fix).toBe('laneboard list --board WEB --scope all --text "<words from the title>" --json');
    const fix = await cli(shellArgv(r.doc.error?.fix ?? ''), { cwd: m.lb.root, env: { HOME: m.home } });
    expect(fix.code, fix.stderr).toBe(0);
  });

  it('task=NOPE-1: INVALID_VALUE with the prefixes of the live boards as allowed; its fix (laneboard boards) runs', async () => {
    const m = await machine();
    const r = await lbJson(m, ['update', 'LB-1', '--add-link', 'task=NOPE-1', '--as', 'a']);
    expect(r.code).toBe(2);
    expect(r.doc.error).toEqual({ code: 'INVALID_VALUE', message: 'link task=NOPE-1: no live board with prefix NOPE on this machine', fix: 'laneboard boards --json', allowed: ['WEB'] });
    expect((await cli(shellArgv('laneboard boards'), { cwd: m.lb.root, env: { HOME: m.home } })).code).toBe(0);
  });

  it('no HOME: USAGE, the fix sets HOME before the same command and runs', async () => {
    const m = await machine();
    const r = await cli(['update', 'LB-1', '--add-link', 'task=WEB-1', '--as', 'a', '--json'], { cwd: m.lb.root });
    expect(r.code).toBe(2);
    const fix = JSON.parse(r.stdout).error.fix as string;
    expect(fix).toBe('HOME=<your home directory> laneboard update LB-1 --add-link task=WEB-1 --as a --json');
    const run = await cli(shellArgv(fix.slice(fix.indexOf('laneboard '))), { cwd: m.lb.root, env: { HOME: m.home } });
    expect(run.code, run.stdout).toBe(0);
  });

  it('S5a: a parent on another board gets a fix that links it instead, and now that fix runs (create and update)', async () => {
    const m = await machine();
    const upd = await lbJson(m, ['update', 'LB-1', '--parent', 'WEB-1', '--as', 'a']);
    expect(upd.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard update LB-1 --as a --json --add-link task=WEB-1' });
    const runUpd = await cli(shellArgv(upd.doc.error?.fix ?? ''), { cwd: m.lb.root, env: { HOME: m.home } });
    expect(runUpd.code, runUpd.stdout).toBe(0);
    const crt = await lbJson(m, ['create', 'x', '--status', 'todo', '--parent', 'WEB-1', '--as', 'a']);
    const runCrt = await cli(shellArgv(crt.doc.error?.fix ?? ''), { cwd: m.lb.root, env: { HOME: m.home } });
    expect(runCrt.code, runCrt.stdout).toBe(0);
    expect(readStore(m.lb.dir, 'active').tasks.map((t) => t.links)).toEqual([[{ kind: 'task', ref: 'WEB-1' }], [{ kind: 'task', ref: 'WEB-1' }]]);
  });
});

describe('S5c DoD: an id of another board on this board', () => {
  it('get WEB-1 from board LB: TASK_NOT_FOUND naming board WEB; the fix is the same command with --board WEB and it runs', async () => {
    const m = await machine();
    const r = await lbJson(m, ['get', 'WEB-1']);
    expect(r.code).toBe(3);
    expect(r.doc.error).toMatchObject({ code: 'TASK_NOT_FOUND', message: `WEB-1 is on board WEB (${m.web.dir}), not on this board (LB)`, fix: 'laneboard get WEB-1 --json --board WEB' });
    const run = await cli(shellArgv(r.doc.error?.fix ?? ''), { cwd: m.lb.root, env: { HOME: m.home } });
    expect(run.code, run.stdout).toBe(0);
    expect(JSON.parse(run.stdout).data.title).toBe('Web login page');
    // The same for the other reads: events --task, and list --parent (review S5b NIT: no empty list without a hint).
    for (const argv of [
      ['events', '--task', 'WEB-1'],
      ['list', '--parent', 'WEB-1'],
    ]) {
      const e = await lbJson(m, argv);
      expect(e.doc.error?.code).toBe('TASK_NOT_FOUND');
      expect(e.doc.error?.fix).toBe(`laneboard ${argv.join(' ')} --json --board WEB`);
      expect((await cli(shellArgv(e.doc.error?.fix ?? ''), { cwd: m.lb.root, env: { HOME: m.home } })).code).toBe(0);
    }
  });

  it('comment WEB-1 "x" from board LB: the fix is the same command with --dir <the WEB store>; it runs and the comment lands on WEB', async () => {
    const m = await machine();
    const r = await lbJson(m, ['comment', 'WEB-1', 'x', '--as', 'a']);
    expect(r.code).toBe(3);
    expect(r.doc.error?.fix).toBe(`laneboard comment WEB-1 x --as a --json --dir ${m.web.dir}`);
    const run = await cli(shellArgv(r.doc.error?.fix ?? ''), { cwd: m.lb.root, env: { HOME: m.home } });
    expect(run.code, run.stdout).toBe(0);
    expect(readStore(m.web.dir, 'active').tasks[0]?.rev).toBe(2);
    // A --dir already given is replaced, not repeated.
    const pinned = await lbJson(m, ['comment', 'WEB-1', 'y', '--as', 'a', '--dir', m.lb.dir]);
    expect(pinned.doc.error?.fix).toBe(`laneboard comment WEB-1 y --as a --json --dir ${m.web.dir}`);
  });
});

describe('review S5b MINOR 2: only a passing errno code says "run it again"', () => {
  it('ELOOP, ENXIO, EINVAL, a code-less error: STORE_INVALID without "not damaged", fix restores the file', () => {
    for (const code of ['ELOOP', 'ENXIO', 'EINVAL', 'ERR_FS_FILE_TOO_LARGE', undefined]) {
      const err = unreadableStoreFile('/p/.laneboard/active.json', 'active.json', { code });
      expect(err.code).toBe('STORE_INVALID');
      expect(err.message).toBe(`active.json cannot be read (${code ?? 'UNKNOWN'}): /p/.laneboard/active.json`);
      expect(err.fix).toBe('restore /p/.laneboard/active.json as a readable file (from git or a copy), then check the store: laneboard doctor');
      expect(err.edit).toBeUndefined();
    }
  });

  it('a symlink loop in place of active.json (the review probe): exit 6, STORE_INVALID, the restore fix, not "run the same command"', async () => {
    const s = await newStore();
    const file = path.join(s.dir, 'active.json');
    fs.renameSync(file, path.join(s.dir, 'active.json.bak'));
    fs.symlinkSync('active.json', file);
    const r = await cli(['list', '--json'], { cwd: s.root });
    expect(r.code).toBe(6);
    const err = JSON.parse(r.stdout).error;
    expect(err).toMatchObject({ code: 'STORE_INVALID', message: `active.json cannot be read (ELOOP): ${file}` });
    expect(err.fix).toMatch(/^restore /);
  });
});

describe('review S5b MINOR 4: list --all-boards outside every board', () => {
  it('runs in a folder without a board (where prime --all-boards points to it); a plain list or a --dir that names nothing still fails', async () => {
    const m = await machine();
    const outside = tempDir();
    const r = await cli(['list', '--all-boards', '--open', '--json'], { cwd: outside, env: { HOME: m.home } });
    expect(r.code, r.stdout).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.store).toBeNull();
    expect(doc.data.items.map((t: { id: string }) => t.id).sort()).toEqual(['LB-1', 'WEB-1']);
    expect(doc.data.boards.map((b: { prefix: string }) => b.prefix)).toEqual(['LB', 'WEB']);
    // The command prime --all-boards prints in its overview header runs there as printed.
    const prime = await cli(['prime', '--hook', '--all-boards'], { cwd: outside, env: { HOME: m.home } });
    const hint = /all: (laneboard list --all-boards --open --json)\)/.exec(prime.stdout)?.[1] ?? '';
    expect((await cli(shellArgv(hint), { cwd: outside, env: { HOME: m.home } })).code).toBe(0);
    expect((await cli(['list', '--json'], { cwd: outside, env: { HOME: m.home } })).code).toBe(6);
    expect((await cli(['list', '--all-boards', '--json', '--dir', path.join(outside, 'nope')], { cwd: outside, env: { HOME: m.home } })).code).toBe(6);
    // Without HOME there: the usual USAGE with HOME set by the fix.
    const noHome = await cli(['list', '--all-boards', '--json'], { cwd: outside });
    expect(JSON.parse(noHome.stdout).error.fix).toBe('HOME=<your home directory> laneboard list --all-boards --json');
  });
});
