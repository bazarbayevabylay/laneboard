// Dogfooding fixes (S2f): short derived prefixes and changing the prefix of an empty board, the view order and names, event text
// in `get`, the assignee warning on create, shell-quoted paths in fixes and setup's path comparison through symlinks.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderBoard, shortName } from '../../src/cli/board-view.ts';
import { eventText } from '../../src/cli/format.ts';
import { loadConfig } from '../../src/core/config.ts';
import type { ViewResult } from '../../src/core/index.ts';
import { cleanupTemp, cli, readStore, tempDir } from '../helpers.ts';
import type { CliRun } from '../helpers.ts';

afterAll(cleanupTemp);

// A project folder `name` in a fresh temp dir and the CLI run there with a temp HOME of its own.
function project(name: string): { dir: string; home: string; run(argv: string[], env?: Record<string, string>): Promise<CliRun> } {
  const dir = path.join(tempDir(), name);
  fs.mkdirSync(dir);
  const home = tempDir();
  return { dir, home, run: (argv, env = {}) => cli(argv, { cwd: dir, env: { HOME: home, ...env } }) };
}

// The --json document of a run.
async function doc(r: Promise<CliRun>): Promise<ReturnType<typeof JSON.parse>> {
  return JSON.parse((await r).stdout);
}

describe('prefix', () => {
  it('init derives a short prefix and says how to change it while the board is empty', async () => {
    const p = project('laneboard');
    const r = await p.run(['init', '--description', 'the tool itself']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('prefix LANE;');
    expect(r.stdout).toContain('\nids: LANE-1, LANE-2, ...; another prefix while the board has no task: laneboard config --prefix <PREFIX>\n');
    // A board made by --dir names --dir in that command (quoted: the path has a space).
    const other = path.join(tempDir(), 'my app', '.laneboard');
    const byDir = await cli(['init', '--dir', other, '--description', 'd'], { cwd: p.dir, env: { HOME: p.home } });
    expect(byDir.stdout).toContain(`prefix MA;`);
    expect(byDir.stdout).toContain(`laneboard config --prefix <PREFIX> --dir '${other}'\n`);
    expect(byDir.stdout).toContain(`next: laneboard prime --dir '${other}'`);
  });

  it('config --prefix changes the prefix of a board without tasks; the registry and the next id follow', async () => {
    const p = project('laneboard');
    await p.run(['init', '--description', 'the tool itself']);
    const r = await doc(p.run(['config', '--prefix', 'LB', '--json']));
    expect(r).toMatchObject({ ok: true, prefix: 'LB', data: { prefix: 'LB', changed: true }, warnings: [] });
    expect(loadConfig(path.join(p.dir, '.laneboard')).prefix).toBe('LB');
    expect((await doc(p.run(['boards', '--json']))).data.boards).toMatchObject([{ prefix: 'LB' }]);
    expect((await doc(p.run(['create', 'first', '--status', 'todo', '--as', 'a', '--json']))).data.id).toBe('LB-1');
    // The same prefix again changes nothing, also with a task on the board.
    expect((await doc(p.run(['config', '--prefix', 'LB', '--json']))).data).toMatchObject({ prefix: 'LB', changed: false });
  });

  it('config --prefix is refused once the board has a task, active or archived, and for a bad format', async () => {
    const p = project('web');
    await p.run(['init', '--description', 'web']);
    await p.run(['create', 'first', '--status', 'done', '--as', 'a']);
    const active = await doc(p.run(['config', '--prefix', 'SHOP', '--json']));
    expect(active.error).toMatchObject({ code: 'INVALID_VALUE', message: 'the prefix of a board with tasks never changes: this board has 1 task(s) with ids like WEB-1, so it cannot become SHOP' });
    await p.run(['archive', 'WEB-1', '--as', 'a']);
    expect(readStore(path.join(p.dir, '.laneboard'), 'active').tasks).toEqual([]);
    const archived = await doc(p.run(['config', '--prefix', 'SHOP', '--json']));
    expect(archived.error.code).toBe('INVALID_VALUE');
    expect(loadConfig(path.join(p.dir, '.laneboard')).prefix).toBe('WEB');
    const bad = await doc(project('x').run(['config', '--prefix', 'shop', '--json']));
    expect(bad.error.code).toBe('STORE_NOT_FOUND');
    const lower = await doc(p.run(['config', '--prefix', 'shop', '--json']));
    expect(lower.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard config --prefix SHOP --json' });
  });

  it('config --prefix takes only a prefix no other live board uses (same fix as init)', async () => {
    const p = project('first');
    await p.run(['init', '--description', 'first', '--prefix', 'CP']);
    const second = path.join(tempDir(), 'second');
    fs.mkdirSync(second);
    const run = (argv: string[]): Promise<CliRun> => cli(argv, { cwd: second, env: { HOME: p.home } });
    await run(['init', '--description', 'second']);
    const taken = await doc(run(['config', '--prefix', 'CP', '--json']));
    expect(taken.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard config --prefix CP2 --json', details: { taken: ['CP'] } });
    expect(loadConfig(path.join(second, '.laneboard')).prefix).toBe('SECO');
  });
});

describe('view', () => {
  // A view result with one todo column of the given cards (assignee, age in status 0).
  function board(cards: Array<{ id: string; assignee: string | null }>): ViewResult {
    const now = new Date().toISOString();
    return {
      name: 'b',
      description: null,
      prefix: 'B',
      columns: [{ status: 'todo', known: true, cards: cards.map((c) => ({ id: c.id, title: 'T', assignee: c.assignee, labels: [], status_since: now, rev: 1, last_comment: null, parent: null, children: { total: 0, final: 0 }, updated_at: now, handed_in: false, in_work: false, stale: false })), more: 0 }],
      shown: cards.length,
      total: cards.length,
      final_status: 'done',
      final_shown: 0,
      final_total: 0,
    };
  }

  it('a default name drops its harness and is cut in the user part, so the session part stays; other names are cut from the end', () => {
    expect(shortName('claude-code@abylaybazarbayev:f92f65da', 40)).toBe('abylaybazarbayev:f92f65da');
    expect(shortName('claude-code@abylaybazarbayev:f92f65da', 16)).toBe('abylay…:f92f65da');
    expect(shortName('backend-developer-with-a-long-name', 16)).toBe('backend-develop…');
    expect(shortName('dev@team:abc', 40)).toBe('dev@team:abc');
    const text = renderBoard(board([{ id: 'B-1', assignee: 'claude-code@abylaybazarbayev:f92f65da' }]), { width: 20, color: false, now: new Date(), store: '/s', filters: [] });
    expect(text).toContain('  <1m · ab…:f92f65da\n');
  });

  it('cards in a column are ordered by priority (0 first, none last), then by the latest update', async () => {
    const p = project('v');
    await p.run(['init', '--description', 'v', '--prefix', 'V']);
    const make = async (title: string, priority?: number): Promise<void> => {
      await p.run(['create', title, '--status', 'todo', '--as', 'a', ...(priority === undefined ? [] : ['--field', `priority=${priority}`])]);
      await new Promise((r) => setTimeout(r, 5));
    };
    await make('none-old');
    await make('p2', 2);
    await make('p0', 0);
    await make('none-new');
    await make('p2-new', 2);
    const ids = async (): Promise<string[]> => (await doc(p.run(['view', '--json']))).data.columns[0].cards.map((c: { title: string }) => c.title);
    expect(await ids()).toEqual(['p0', 'p2-new', 'p2', 'none-new', 'none-old']);
    // Without a numeric priority field in config the order is the latest update first.
    const file = path.join(p.dir, '.laneboard', 'config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.fields = { priority: { type: 'string' } };
    fs.writeFileSync(file, JSON.stringify(config));
    expect(await ids()).toEqual(['p2-new', 'none-new', 'p0', 'p2', 'none-old']);
  });
});

describe('get', () => {
  it('shows a comment as its text and other events as short key=value pairs', () => {
    expect(eventText('commented', { text: 'repro attached' })).toBe('repro attached');
    expect(eventText('created', { title: 'Fix login', status: 'todo', assignee: null })).toBe('title="Fix login" status=todo assignee=-');
    expect(eventText('status', { from: 'todo', to: 'in_progress' })).toBe('from=todo to=in_progress');
    expect(eventText('attached', { name: 'notes.txt', size: 11, sha256: 'af94040caa54ae89a0460096007629185ce8d17256b0ba0ed7691ef4500449bf' })).toBe('name=notes.txt size=11 sha256=af94040caa54…');
    expect(eventText('updated', { description: { chars: [0, 21] }, links: [[], [{ kind: 'pr', ref: 'https://example.com/pr/7' }]], 'fields.priority': [null, 0], labels: [['ui'], ['ui', 'auth']] })).toBe(
      'description=0→21 chars links=[]→[pr=https://example.com/pr/7] fields.priority=-→0 labels=[ui]→[ui, auth]',
    );
    expect(eventText('created', { title: 'x'.repeat(80) })).toBe(`title=${'x'.repeat(59)}…`);
  });

  it('a comment of several lines continues under its first line', async () => {
    const p = project('g');
    await p.run(['init', '--description', 'g', '--prefix', 'G']);
    await p.run(['create', 'T', '--status', 'todo', '--as', 'a']);
    await p.run(['comment', 'G-1', 'line one\nline two', '--as', 'a']);
    const out = (await p.run(['get', 'G-1'])).stdout;
    expect(out).toMatch(/ {2}a {2}commented {2}line one\n {6}line two\n?$/);
    expect(out).not.toContain('{"text"');
  });
});

describe('create --assignee', () => {
  it('warns when the assignee is not the writer, with the commands for both cases; silent for yourself or no assignee', async () => {
    const p = project('c');
    await p.run(['init', '--description', 'c', '--prefix', 'C']);
    const env = { CLAUDE_CODE_SESSION_ID: 'f92f65da-1111', USER: 'abylay' };
    const other = await doc(p.run(['create', 'T', '--status', 'todo', '--assignee', 'backend-developer', '--json'], env));
    expect(other.warnings).toEqual([
      'C-1 is assigned to backend-developer, not to you (claude-code@abylay:f92f65da): fine when you create it for someone else, but prime will not list it as yours. ' +
        'If it is your task: laneboard update C-1 --assignee claude-code@abylay:f92f65da --expected-rev 1 --as claude-code@abylay:f92f65da --json; ' +
        'if backend-developer is your name: pass --as backend-developer on every command',
    ]);
    expect((await doc(p.run(['create', 'T', '--status', 'todo', '--assignee', 'dev', '--as', 'dev', '--json']))).warnings).toEqual([]);
    expect((await doc(p.run(['create', 'T', '--status', 'todo', '--as', 'dev', '--json']))).warnings).toEqual([]);
    // The fix runs as printed.
    expect((await doc(p.run(['update', 'C-1', '--assignee', 'claude-code@abylay:f92f65da', '--expected-rev', '1', '--as', 'claude-code@abylay:f92f65da', '--json'], env))).ok).toBe(true);
  });
});

describe('paths in fixes', () => {
  it('are shell-quoted when they hold spaces', async () => {
    const root = path.join(tempDir(), 'my projects');
    fs.mkdirSync(root);
    const missing = path.join(root, 'app', '.laneboard');
    const notFound = await doc(cli(['list', '--json'], { cwd: root, env: { LANEBOARD_DIR: missing } }));
    expect(notFound.error.fix).toContain(`laneboard init --dir '${missing}' --name`);
    const store = path.join(root, '.laneboard');
    await cli(['init', '--description', 'd', '--prefix', 'MP'], { cwd: root, env: {} });
    const exists = await doc(cli(['init', '--description', 'd', '--json'], { cwd: root, env: {} }));
    expect(exists.error.fix).toBe(`use it (laneboard list --dir '${store}'), or pass --dir <another empty directory>`);
    const inside = await doc(cli(['init', '--description', 'd', '--json'], { cwd: store, env: {} }));
    expect(inside.error.fix).toBe(
      `use that board (laneboard prime --dir '${store}'), or create a board for another project in its own folder: laneboard init --dir <project folder>/.laneboard --name <name> --description "<whose project, what work>"`,
    );
  });

  it('a missing config.json names a working way back, not a bare init into the full store', async () => {
    const root = path.join(tempDir(), 'my app');
    fs.mkdirSync(root);
    await cli(['init', '--description', 'd', '--prefix', 'MA'], { cwd: root, env: {} });
    const store = path.join(root, '.laneboard');
    fs.rmSync(path.join(store, 'config.json'));
    const r = await doc(cli(['list', '--json'], { cwd: root, env: {} }));
    expect(r.error).toMatchObject({
      code: 'STORE_INVALID',
      fix: `restore ${path.join(store, 'config.json')} (from git or a copy); or move '${store}' aside and create a new board: laneboard init --dir '${store}' --name <name> --description "<whose project, what work>"`,
    });
  });

  it("rule 12's init by --dir creates this folder's board although LANEBOARD_DIR names another one", async () => {
    const parent = tempDir();
    await cli(['init', '--description', 'parent', '--prefix', 'PAR'], { cwd: parent, env: {} });
    const child = path.join(parent, 'child');
    fs.mkdirSync(child);
    const env = { LANEBOARD_DIR: path.join(parent, '.laneboard') };
    const r = await doc(cli(['init', '--dir', '.laneboard', '--name', 'child', '--description', 'child work', '--json'], { cwd: child, env }));
    expect(r).toMatchObject({ ok: true, store: path.join(child, '.laneboard'), data: { next: `laneboard prime --dir ${path.join(child, '.laneboard')}` } });
  });
});

describe('setup', () => {
  it('LANEBOARD_DIR naming ./.laneboard through a symlink is not reported as a pin from elsewhere', async () => {
    const real = tempDir();
    const link = path.join(tempDir(), 'link');
    fs.symlinkSync(real, link);
    const home = tempDir();
    await cli(['init', '--description', 'p', '--prefix', 'P'], { cwd: real, env: { HOME: home } });
    const r = await doc(cli(['setup', 'gemini', '--dry-run', '--json'], { cwd: real, env: { HOME: home, LANEBOARD_DIR: path.join(link, '.laneboard') } }));
    expect(r.ok).toBe(true);
    expect(r.warnings.filter((w: string) => w.includes('the store pin comes from'))).toEqual([]);
  });
});
