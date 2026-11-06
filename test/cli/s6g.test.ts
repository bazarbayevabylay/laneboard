// S6g "config after init" (LB-32; audit A25, A26, A28): `config --field <key>:<type>[:<description>]` / `--drop-field <key>` change the
// board's task fields like `--statuses` changes its statuses (ADR-0001 §33): a dropped field or a new type that active tasks' values do
// not fit is INVALID_VALUE with a fix that runs, archived tasks only warn, config stays config@1; a board has at least 2 statuses; a new
// board refuses to attach the usual secret files (credentials, .netrc, .npmrc, ssh keys of every type, *.p12, *.pfx, *.kdbx).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DENY_NAMES, loadConfig } from '../../src/core/config.ts';
import { ERRORS } from '../../src/core/index.ts';
import { acquireLock } from '../../src/core/lock.ts';
import { contentSha } from '../../src/core/store.ts';
import { cleanupTemp, cli, readStore, tempDir, writeRaw } from '../helpers.ts';
import type { CliRun } from '../helpers.ts';

afterAll(cleanupTemp);

// The --json document of a run, with its exit code.
async function doc(r: Promise<CliRun>): Promise<{ code: number } & ReturnType<typeof JSON.parse>> {
  const out = await r;
  return { code: out.code, ...JSON.parse(out.stdout) };
}

// A board `web` (prefix WEB) in the folder `folder`: WEB-1 priority 1, WEB-2 priority 2, WEB-3 without fields, WEB-4 priority 3 (archived).
async function board(folder = 'web'): Promise<{ p: string; store: string; run(argv: string[]): Promise<CliRun> }> {
  const home = tempDir();
  const p = path.join(tempDir(), folder);
  fs.mkdirSync(p);
  const run = (argv: string[]): Promise<CliRun> => cli(argv, { cwd: p, env: { HOME: home } });
  expect((await run(['init', '--name', 'web', '--description', 'web shop'])).code).toBe(0);
  for (const [title, field] of [
    ['one', 'priority=1'],
    ['two', 'priority=2'],
    ['three', undefined],
    ['four', 'priority=3'],
  ] as const) {
    const r = await run(['create', title, '--status', 'todo', '--as', 'dev', ...(field ? ['--field', field] : [])]);
    expect(r.code, r.stderr).toBe(0);
  }
  expect((await run(['archive', 'WEB-4', '--as', 'dev'])).code).toBe(0);
  return { p, store: path.join(p, '.laneboard'), run };
}

// Run a printed fix with bash in a fresh folder, `laneboard` being a stub that records each call's argv; the recorded calls.
function fixCalls(fix: string): string[][] {
  const cwd = tempDir();
  const bin = path.join(cwd, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(bin, 'calls');
  fs.writeFileSync(path.join(bin, 'laneboard'), `#!/bin/sh\nprintf '%s\\0' "$@" >> '${calls}'\nprintf '\\n' >> '${calls}'\n`, { mode: 0o755 });
  const r = spawnSync('bash', ['-c', fix], { cwd, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: cwd }, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  if (!fs.existsSync(calls)) return [];
  return fs
    .readFileSync(calls, 'utf8')
    .split('\0\n')
    .filter((line) => line !== '')
    .map((line) => line.split('\0'));
}

// config.json as it is on disk.
function configText(store: string): string {
  return fs.readFileSync(path.join(store, 'config.json'), 'utf8');
}

describe('config --field / --drop-field', () => {
  it('declares a field, changes its description, keeps it on an omitted one, removes it on an empty one; config@1, same again = no change', async () => {
    const { store, run } = await board();
    const r = await doc(run(['config', '--field', 'team:string:owning team: a or b', '--json']));
    expect(r).toMatchObject({ code: 0, data: { changed: true, fields: { priority: { type: 'number', description: '0 = highest' }, team: { type: 'string', description: 'owning team: a or b' } } }, warnings: [] });
    expect(loadConfig(store).schema).toBe('laneboard/config@1');
    expect(Object.keys(loadConfig(store).fields)).toEqual(['priority', 'team']);
    expect((await doc(run(['create', 'five', '--status', 'todo', '--field', 'team=a', '--as', 'dev', '--json']))).data.id).toBe('WEB-5');
    expect((await doc(run(['get', 'WEB-5', '--json']))).data.fields).toEqual({ team: 'a' });
    // The same declaration again: nothing written. Without a description the current one stays; an empty one removes it.
    const before = configText(store);
    expect((await doc(run(['config', '--field', 'team:string', '--json']))).data.changed).toBe(false);
    expect(configText(store)).toBe(before);
    expect((await doc(run(['config', '--field', 'priority:number:', '--json']))).data.fields.priority).toEqual({ type: 'number' });
    // A replaced field keeps its place in config.fields.
    expect(Object.keys(loadConfig(store).fields)).toEqual(['priority', 'team']);
    expect((await run(['config'])).stdout).toContain('\n  fields: priority (number), team (string, owning team: a or b)\n');
  });

  it('dropping a field that active tasks hold: INVALID_VALUE naming them, nothing written; the fix runs and unsets exactly those values; then it is dropped', async () => {
    const { store, run } = await board();
    const before = configText(store);
    const r = await doc(run(['config', '--drop-field', 'priority', '--as', 'owner', '--json']));
    expect(r.code).toBe(2);
    expect(r.error).toMatchObject({
      code: 'INVALID_VALUE',
      message: 'cannot change fields that 2 active task(s) hold: drop priority: 2 hold a value (WEB-1, WEB-2); remove each of those values (laneboard update <ID> --unset-field <key>), then run this command again',
      details: { in_use: [{ field: 'priority', change: 'drop', tasks: ['WEB-1', 'WEB-2'] }] },
      fix: `for id in WEB-1 WEB-2; do laneboard update "$id" --unset-field priority --dir ${store} --as owner; done`,
    });
    expect(configText(store)).toBe(before);
    // The fix runs from any folder (it names the store): each call is a real command.
    const calls = fixCalls(r.error.fix);
    expect(calls).toEqual([
      ['update', 'WEB-1', '--unset-field', 'priority', '--dir', store, '--as', 'owner'],
      ['update', 'WEB-2', '--unset-field', 'priority', '--dir', store, '--as', 'owner'],
    ]);
    for (const argv of calls) expect((await cli(argv, { cwd: tempDir(), env: {} })).code).toBe(0);
    const ok = await doc(run(['config', '--drop-field', 'priority', '--json']));
    expect(ok).toMatchObject({ code: 0, data: { changed: true, fields: {} } });
    // The archived WEB-4 keeps its value: a warning, no block; doctor stays healthy (exit 0).
    expect(ok.warnings).toEqual(['1 archived task(s) keep a value of the removed field priority (WEB-4): restore brings it back, then laneboard update <ID> --unset-field priority']);
    const doctor = await doc(run(['doctor', '--json']));
    expect(doctor).toMatchObject({ code: 0, data: { healthy: true } });
    expect((await doc(run(['create', 'six', '--status', 'todo', '--field', 'priority=1', '--as', 'dev', '--json']))).error.code).toBe('UNKNOWN_FIELD');
  });

  it('the fix names a store whose path has a space, a quote and $ as one argument: the loop unsets the values, then the drop goes through', async () => {
    const { store, run } = await board("My Proj's $x");
    const r = await doc(run(['config', '--drop-field', 'priority', '--as', 'owner', '--json']));
    expect(r.error.fix).toBe(`for id in WEB-1 WEB-2; do laneboard update "$id" --unset-field priority --dir '${store.replaceAll("'", "'\\''")}' --as owner; done`);
    const calls = fixCalls(r.error.fix);
    expect(calls).toEqual([
      ['update', 'WEB-1', '--unset-field', 'priority', '--dir', store, '--as', 'owner'],
      ['update', 'WEB-2', '--unset-field', 'priority', '--dir', store, '--as', 'owner'],
    ]);
    for (const argv of calls) expect((await cli(argv, { cwd: tempDir(), env: {} })).code).toBe(0);
    expect(await doc(run(['config', '--drop-field', 'priority', '--json']))).toMatchObject({ code: 0, data: { changed: true, fields: {} } });
  });

  it('without a known name the fix asks for one (--as <your-name>)', async () => {
    const { run } = await board();
    const r = await doc(run(['config', '--drop-field', 'priority', '--json']));
    expect(r.error.fix).toContain('--unset-field priority --dir ');
    expect(r.error.fix).toContain(' --as <your-name>; done');
  });

  it('a new type that active values do not fit: INVALID_VALUE (change "type"), nothing written; a type every value fits is written; create follows the new type', async () => {
    const { store, run } = await board();
    const before = configText(store);
    const r = await doc(run(['config', '--field', 'priority:string', '--as', 'owner', '--json']));
    expect(r.code).toBe(2);
    expect(r.error.message).toBe(
      'cannot change fields that 2 active task(s) hold: priority to string: 2 hold a value of another type (WEB-1, WEB-2); remove each of those values (laneboard update <ID> --unset-field <key>) ' +
        '(to keep a value, set it in the new type instead: laneboard update <ID> --field priority=<string>), then run this command again',
    );
    expect(r.error.details).toEqual({ in_use: [{ field: 'priority', change: 'type', type: 'string', tasks: ['WEB-1', 'WEB-2'] }] });
    expect(configText(store)).toBe(before);
    // json takes any value: written, the description stays.
    const ok = await doc(run(['config', '--field', 'priority:json', '--json']));
    expect(ok).toMatchObject({ code: 0, data: { fields: { priority: { type: 'json', description: '0 = highest' } } } });
    // number again: WEB-1 and WEB-2 still hold numbers; the archived WEB-4 too, so no warning.
    expect(await doc(run(['config', '--field', 'priority:number', '--json']))).toMatchObject({ code: 0, warnings: [] });
    // Set one value in the new type, unset the other: then the change goes through and create follows it.
    expect((await run(['update', 'WEB-1', '--field', 'priority=high', '--as', 'dev'])).code).toBe(2);
    expect((await run(['update', 'WEB-1', '--unset-field', 'priority', '--as', 'dev'])).code).toBe(0);
    expect((await run(['update', 'WEB-2', '--unset-field', 'priority', '--as', 'dev'])).code).toBe(0);
    const typed = await doc(run(['config', '--field', 'priority:string', '--json']));
    expect(typed.code).toBe(0);
    expect(typed.warnings).toEqual([
      '1 archived task(s) hold priority values that are not string (WEB-4): restore brings them back as they are, then laneboard update <ID> --field priority=<string>',
    ]);
    expect((await run(['create', 'six', '--status', 'todo', '--field', 'priority=high', '--as', 'dev'])).code).toBe(0);
    expect((await doc(run(['get', 'WEB-5', '--json']))).data.fields).toEqual({ priority: 'high' });
    expect((await doc(run(['doctor', '--json']))).data.healthy).toBe(true);
  });

  it('declaring a key that active tasks already hold (set before it was declared) checks their values against the type', async () => {
    const { store, run } = await board();
    const active = readStore(store, 'active');
    const tasks = active.tasks.map((t) => (t.id === 'WEB-3' ? { ...t, fields: { color: 'red' } } : t));
    writeRaw(path.join(store, 'active.json'), `${JSON.stringify({ ...active, tasks, content_sha256: contentSha(tasks) }, null, 2)}\n`);
    expect((await doc(run(['config', '--field', 'color:number', '--json']))).error.details).toEqual({ in_use: [{ field: 'color', change: 'type', type: 'number', tasks: ['WEB-3'] }] });
    expect(await doc(run(['config', '--field', 'color:string', '--json']))).toMatchObject({ code: 0, data: { fields: { color: { type: 'string' } } } });
  });

  it('a type that stays is not checked again: a new description goes through over a hand-edited value of another type, which stays', async () => {
    const { store, run } = await board();
    const active = readStore(store, 'active');
    const tasks = active.tasks.map((t) => (t.id === 'WEB-3' ? { ...t, fields: { priority: 'x' } } : t));
    writeRaw(path.join(store, 'active.json'), `${JSON.stringify({ ...active, tasks, content_sha256: contentSha(tasks) }, null, 2)}\n`);
    const r = await doc(run(['config', '--field', 'priority:number:lower runs first', '--json']));
    expect(r).toMatchObject({ code: 0, data: { changed: true, fields: { priority: { type: 'number', description: 'lower runs first' } } } });
    expect(loadConfig(store).fields.priority).toEqual({ type: 'number', description: 'lower runs first' });
    expect(readStore(store, 'active').tasks.find((t) => t.id === 'WEB-3')?.fields).toEqual({ priority: 'x' });
  });

  it('a dropped field and a retyped one in one command: both named, the fix unsets both', async () => {
    const { store, run } = await board();
    expect((await run(['config', '--field', 'team:string'])).code).toBe(0);
    expect((await run(['update', 'WEB-3', '--field', 'team=a', '--as', 'dev'])).code).toBe(0);
    const r = await doc(run(['config', '--drop-field', 'team', '--field', 'priority:boolean', '--as', 'owner', '--json']));
    expect(r.error.message).toContain('cannot change fields that 3 active task(s) hold: drop team: 1 hold a value (WEB-3); priority to boolean: 2 hold a value of another type (WEB-1, WEB-2);');
    expect(fixCalls(r.error.fix).map((argv) => `${argv[1]} ${argv[3]}`)).toEqual(['WEB-3 team', 'WEB-1 priority', 'WEB-2 priority']);
    expect(Object.keys(loadConfig(store).fields)).toEqual(['priority', 'team']);
  });

  it('bad values are refused before anything is read or written, each with a fix built from the command', async () => {
    const { store, run } = await board();
    const before = configText(store);
    const error = async (argv: string[]): Promise<{ code: string; message: string; fix: string; allowed?: string[] }> => (await doc(run([...argv, '--json']))).error;
    expect(await error(['config', '--field', 'Team:string'])).toMatchObject({ code: 'INVALID_VALUE', message: '--field "Team:string": the key "Team" must match ^[a-z][a-z0-9_]{0,39}$', fix: 'laneboard config --field <key>:<type>[:<description>] --json' });
    expect(await error(['config', '--field', 'team'])).toMatchObject({ code: 'INVALID_VALUE', message: '--field "team": the type must be one of string, number, boolean, string[], json, got none' });
    expect(await error(['config', '--field', 'team:strin:who'])).toMatchObject({ code: 'INVALID_VALUE', allowed: ['string', 'number', 'boolean', 'string[]', 'json'], fix: 'laneboard config --field team:string:who --json' });
    expect((await error(['config', '--field', 'team:string:two\nlines'])).message).toBe('--field "team:string:two\nlines": the description must be one line of at most 500 characters');
    expect((await error(['config', '--field', `team:string:${'x'.repeat(501)}`])).code).toBe('INVALID_VALUE');
    expect((await doc(run(['config', '--field', `team:string:${'x'.repeat(500)}`, '--json']))).code).toBe(0);
    expect((await run(['config', '--drop-field', 'team'])).code).toBe(0);
    expect(await error(['config', '--field', 'team:string', '--field', 'team:number'])).toMatchObject({ code: 'USAGE', message: '--field team is given more than once' });
    expect(await error(['config', '--field', 'team:string', '--drop-field', 'team'])).toMatchObject({ code: 'USAGE', fix: 'laneboard config --field team:string --json' });
    expect(await error(['config', '--drop-field', 'priorty'])).toMatchObject({ code: 'UNKNOWN_FIELD', allowed: ['priority'], fix: 'laneboard config --drop-field priority --json' });
    expect(await error(['config', '--drop-field', 'color'])).toMatchObject({ code: 'UNKNOWN_FIELD', fix: 'laneboard config --drop-field <field from allowed> --json' });
    expect(configText(store)).toBe(before);
  });

  it('the change runs under the store lock: busy lock -> LOCK_TIMEOUT, config unchanged', async () => {
    const { p, store } = await board();
    const before = configText(store);
    const lock = await acquireLock(store);
    try {
      const r = await cli(['config', '--field', 'team:string', '--json'], { cwd: p, env: {}, lockWaitMs: 300 });
      expect(r.code).toBe(5);
      expect(JSON.parse(r.stdout).error.code).toBe('LOCK_TIMEOUT');
    } finally {
      await lock.release();
    }
    expect(configText(store)).toBe(before);
  });

  it('the in-use check reads the tasks under the store lock: a value set while config waits for the lock blocks the drop', async () => {
    const { p, store, run } = await board();
    expect((await run(['update', 'WEB-1', '--unset-field', 'priority', '--as', 'dev'])).code).toBe(0);
    expect((await run(['update', 'WEB-2', '--unset-field', 'priority', '--as', 'dev'])).code).toBe(0);
    const before = configText(store);
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
    let pending: Promise<CliRun>;
    try {
      pending = cli(['config', '--drop-field', 'priority', '--json'], { cwd: p, env: {}, lockWaitMs: 20_000 });
      await attempted;
      // In that window a writer (here: the test, holding the lock like transact) gives WEB-3 a priority.
      const active = readStore(store, 'active');
      const tasks = active.tasks.map((t) => (t.id === 'WEB-3' ? { ...t, fields: { priority: 5 } } : t));
      writeRaw(path.join(store, 'active.json'), `${JSON.stringify({ ...active, tasks, content_sha256: contentSha(tasks) }, null, 2)}\n`);
    } finally {
      spy.mockRestore();
      await lock.release();
    }
    const r = await doc(pending);
    expect(r.code).toBe(2);
    expect(r.error.details).toEqual({ in_use: [{ field: 'priority', change: 'drop', tasks: ['WEB-3'] }] });
    expect(configText(store)).toBe(before);
  });

  it('an agent that meets an undeclared field is sent to the owner, never to config.json (MCP fix and import fix)', async () => {
    expect(ERRORS.UNKNOWN_FIELD.fix).toBe('use a field from `allowed`, or ask the board owner to declare it: laneboard config --field <key>:<type> --json');
    const { p, run } = await board();
    const src = path.join(p, 'tasks');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'a.md'), '---\ntitle: A\nstatus: todo\ncolor: red\n---\nbody\n');
    const r = await doc(run(['import', 'markdown', src, '--status-key', 'status', '--as', 'dev', '--json']));
    expect(r.error.code).toBe('UNKNOWN_FIELD');
    expect(r.error.fix).toContain('ask the board owner to declare it (laneboard config --field <key>:<type>)');
    expect(r.error.fix).not.toContain('config.json');
  });
});

describe('at least 2 statuses (A26)', () => {
  it('init and config refuse one status, also written twice (the count is checked before the duplicates); two are fine', async () => {
    const root = tempDir();
    const r = await doc(cli(['init', '--statuses', 'done', '--description', 'x', '--json'], { cwd: root, env: {} }));
    expect(r.error).toMatchObject({ code: 'INVALID_VALUE', message: 'a board needs at least 2 different statuses, got done: the first for new tasks, the last one final', fix: 'list a status to start in before the final one: --statuses todo,done' });
    expect(fs.existsSync(path.join(root, '.laneboard'))).toBe(false);
    const { store, run } = await board();
    const before = configText(store);
    expect((await doc(run(['config', '--statuses', 'todo', '--json']))).error.message).toBe('a board needs at least 2 different statuses, got todo: the first for new tasks, the last one final');
    expect((await doc(run(['config', '--statuses', 'todo', '--json']))).error.fix).toBe('list a status to start in before the final one: --statuses todo,done');
    expect((await doc(run(['config', '--statuses', 'done,done', '--json']))).error.message).toContain('at least 2 different statuses, got done,done');
    expect(configText(store)).toBe(before);
    expect((await doc(run(['config', '--statuses', 'todo,done', '--json']))).data.statuses).toEqual(['todo', 'done']);
  });
});

describe('deny_names of a new board (A28)', () => {
  it('init writes the patterns; the usual secret files are refused, other files with similar names are attached', async () => {
    const { p, store, run } = await board();
    expect(loadConfig(store).attachments.deny_names).toEqual([...DEFAULT_DENY_NAMES]);
    const dir = path.join(p, 'files');
    fs.mkdirSync(dir);
    const attach = async (name: string): Promise<{ code: number; message?: string }> => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, 'x');
      const r = await doc(run(['attach', 'WEB-1', file, '--as', 'dev', '--json']));
      return { code: r.code, message: r.error?.message };
    };
    for (const name of ['credentials', 'aws-credentials.json', '.git-credentials', '.netrc', '.npmrc', 'id_ecdsa', 'id_ecdsa_sk', 'id_dsa', 'id_xmss', 'id_ed25519_sk', 'server.p12', 'cert.PFX', 'vault.kdbx', 'id_rsa', '.env.local']) {
      const r = await attach(name);
      expect(r.code, name).toBe(2);
      expect(r.message, name).toContain('matches attachments.deny_names pattern');
    }
    for (const name of ['id_mapping.csv', 'notes.txt', 'netrc.md', 'p12.txt']) expect((await attach(name)).code, name).toBe(0);
  });
});
