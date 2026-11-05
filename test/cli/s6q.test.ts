// S6q "small input things": every fix here runs as printed (create --title, labels), number fields take decimal notation only (B-U8),
// the events limit keeps what the hand-in and the result are read from (A16), and prime --hook under a stale pin advises the pin's
// own fix (setup, or init --dir), never the bare init that refuses there (S6k tail).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { commentTask, createTask, finishTask, getTask, labelSuggestion, updateTask } from '../../src/core/index.ts';
import { as, cleanupTemp, cli, newStore, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

// Split a printed `laneboard ...` fix into argv the way a shell would.
function shellArgv(fix: string): string[] {
  expect(fix.startsWith('laneboard ')).toBe(true);
  const out = execFileSync('sh', ['-c', `printf '%s\\0' ${fix.slice('laneboard '.length)}`], { encoding: 'utf8' });
  return out.split('\0').slice(0, -1);
}

// The JSON error of a CLI run that must fail with exit 2.
async function errorOf(s: TestStore, argv: string[]): Promise<{ code: string; message: string; fix: string }> {
  const r = await cli([...argv, '--json'], { cwd: s.root });
  expect(r.code, r.stdout).toBe(2);
  return JSON.parse(r.stdout).error;
}

// Run a printed fix in the store's folder; its JSON envelope (exit 0 expected).
async function runFix(s: TestStore, fix: string): Promise<{ data: Record<string, unknown> }> {
  const argv = shellArgv(fix);
  const r = await cli(argv.includes('--json') ? argv : [...argv, '--json'], { cwd: s.root });
  expect(r.code, `${fix}\n${r.stdout}${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout);
}

describe('create --title (dogfood S6j): the title is an argument; the fix moves it there and adds --status', () => {
  it('--title X: UNKNOWN_OPTION says the title is an argument; the fix has the first status of the board and runs as printed', async () => {
    const s = await newStore({ statuses: ['backlog', 'doing', 'done'] });
    const human = await cli(['create', '--title', 'Fix login', '--as', 'a'], { cwd: s.root });
    expect(human.code).toBe(2);
    expect(human.stderr).toContain('error UNKNOWN_OPTION: unknown option --title for create: the title is an argument, not an option (laneboard create <title> --status S');
    expect(human.stderr).toContain("  fix: laneboard create 'Fix login' --as a --status backlog\n");
    const err = await errorOf(s, ['create', '--title', 'Fix login', '--as', 'a']);
    expect(err.fix).toBe("laneboard create 'Fix login' --as a --json --status backlog");
    expect((await runFix(s, err.fix)).data).toMatchObject({ id: 'LB-1', status: 'backlog' });
  });

  it('--title=X with its own --status and --dir: the status is kept, nothing is added; the fix runs from another folder', async () => {
    const s = await newStore();
    const elsewhere = tempDir();
    const r = await cli(['create', `--title=Fix it`, '--status', 'in_progress', '--dir', s.dir, '--as', 'a', '--json'], { cwd: elsewhere });
    expect(r.code).toBe(2);
    const fix = JSON.parse(r.stdout).error.fix as string;
    expect(fix).toBe(`laneboard create 'Fix it' --status in_progress --dir ${s.dir} --as a --json`);
    const ran = await cli(shellArgv(fix), { cwd: elsewhere });
    expect(JSON.parse(ran.stdout).data).toMatchObject({ id: 'LB-1', status: 'in_progress' });
  });

  it('the --status a fix adds comes from the store --dir names, not from the folder the command runs in', async () => {
    const s = await newStore({ statuses: ['inbox', 'done'] });
    const r = await cli(['create', '--title', 'X', '--dir', s.dir, '--json'], { cwd: tempDir() });
    expect(JSON.parse(r.stdout).error.fix).toBe(`laneboard create X --dir ${s.dir} --json --status inbox`);
  });

  it('--title with no value: the title is a placeholder; a title already given or a value with "-": the usual unknown option', async () => {
    const s = await newStore();
    expect((await errorOf(s, ['create', '--status', 'todo', '--title'])).fix).toBe('laneboard create <title> --status todo --json');
    const taken = await errorOf(s, ['create', 'One', '--title', 'Two', '--status', 'todo']);
    expect(taken).toMatchObject({ code: 'UNKNOWN_OPTION', message: 'unknown option --title for create' });
    expect((await errorOf(s, ['create', '--title=-x', '--status', 'todo'])).message).toBe('unknown option --title for create');
  });

  it('other commands: comment LB-1 --text hi becomes comment LB-1 hi and runs; --id of update goes to the id', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'T', status: 'todo' });
    const comment = await errorOf(s, ['comment', 'LB-1', '--text', 'hi there', '--as', 'a']);
    expect(comment.fix).toBe("laneboard comment LB-1 'hi there' --as a --json");
    await runFix(s, comment.fix);
    expect((await getTask(as(s), { id: 'LB-1' })).data.events.at(-1)?.data.text).toBe('hi there');
    const update = await errorOf(s, ['update', '--id', 'LB-1', '--title', 'New', '--as', 'a']);
    expect(update.fix).toBe('laneboard update LB-1 --title New --as a --json');
    // `--text` before the id would take the id's place: no guess then.
    expect((await errorOf(s, ['comment', '--text', 'hi', '--as', 'a'])).message).toBe('unknown option --text for comment');
  });
});

describe('B-U7: a label fix replaces every label that breaks the format', () => {
  it('create --label zone:api --label zone:db --label ok: both replaced (zone-api, zone-db), ok kept; the fix runs', async () => {
    const s = await newStore();
    const err = await errorOf(s, ['create', 'T', '--status', 'todo', '--label', 'zone:api', '--label', 'zone:db', '--label', 'ok', '--as', 'a']);
    expect(err.code).toBe('INVALID_VALUE');
    expect(err.fix).toBe('laneboard create T --status todo --label zone-api --label zone-db --label ok --as a --json');
    await runFix(s, err.fix);
    expect((await getTask(as(s), { id: 'LB-1' })).data.labels).toEqual(['zone-api', 'zone-db', 'ok']);
  });

  it('update --add-label=UI Bug --remove-label x/y: inline and separate values, both fixed; the fix runs', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'T', status: 'todo', labels: ['x-y'] });
    const err = await errorOf(s, ['update', 'LB-1', '--add-label=UI Bug', '--remove-label', 'x/y', '--as', 'a']);
    expect(err.fix).toBe('laneboard update LB-1 --add-label=ui-bug --remove-label x-y --as a --json');
    await runFix(s, err.fix);
    expect((await getTask(as(s), { id: 'LB-1' })).data.labels).toEqual(['ui-bug']);
  });

  it('a label with nothing to keep gets the placeholder; the text after -- is never touched', async () => {
    const s = await newStore();
    const r = await cli(['create', '--json', '--status', 'todo', '--label', '日本', '--label', 'A:B', '--as', 'a', '--', '--label x'], { cwd: s.root });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error.fix).toBe("laneboard create --json --status todo --label <label like ui-bug> --label a-b --as a -- '--label x'");
  });

  it('labelSuggestion: lowercase, accents dropped, other runs one "-", starts with a letter or digit, at most 40; a valid label is itself', () => {
    expect(labelSuggestion('Zone:API')).toBe('zone-api');
    expect(labelSuggestion('Café bug!!')).toBe('cafe-bug-');
    expect(labelSuggestion('--x')).toBe('x');
    expect(labelSuggestion('a'.repeat(50))).toBe('a'.repeat(40));
    expect(labelSuggestion('ui-')).toBe('ui-');
    expect(labelSuggestion('日本')).toBeUndefined();
  });

  it('the core error carries the suggestion (MCP shows it too)', async () => {
    const s = await newStore();
    const r = await createTask(as(s, 'a'), { title: 'T', status: 'todo', labels: ['zone:api'] }).catch((e: unknown) => e);
    expect(r).toMatchObject({ code: 'INVALID_VALUE', input: { field: 'label', value: 'zone:api', suggestion: 'zone-api' } });
  });

  it('create --help states the label rule and that the title is an argument', async () => {
    const r = await cli(['create', '--help'], { cwd: tempDir() });
    expect(r.stdout).toContain('The title is an argument.');
    expect(r.stdout).toContain('A label: lowercase letters, digits, dot, dash or underscore');
  });
});

describe('B-U8: a number field takes decimal notation only', () => {
  it.each(['0x10', '1e3', 'Infinity', ' 5', '5 ', '+5', '.5', '5.', '0b1', '1_000'])('%s: INVALID_VALUE, nothing written', async (value) => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'T', status: 'todo' });
    expect((await cli(['config', '--field', 'estimate:number:hours', '--as', 'a'], { cwd: s.root })).code).toBe(0);
    const err = await errorOf(s, ['update', 'LB-1', '--field', `estimate=${value}`, '--as', 'a']);
    expect(err).toMatchObject({ code: 'INVALID_VALUE' });
    expect(err.message).toContain('expected a number (e.g. estimate=1)');
    expect((await getTask(as(s), { id: 'LB-1' })).data.fields).toEqual({});
  });

  it.each([
    ['16', 16],
    ['-3', -3],
    ['0.25', 0.25],
    ['007', 7],
  ])('%s is read as %d', async (value, expected) => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'T', status: 'todo' });
    expect((await cli(['config', '--field', 'estimate:number:hours', '--as', 'a'], { cwd: s.root })).code).toBe(0);
    expect((await cli(['update', 'LB-1', '--field', `estimate=${value}`, '--as', 'a'], { cwd: s.root })).code).toBe(0);
    expect((await getTask(as(s), { id: 'LB-1' })).data.fields).toEqual({ estimate: expected });
  });
});

describe('A16: the events limit keeps created, the newest status and assigned, and the newest result', () => {
  // A board whose config keeps `limit` events per task.
  async function limited(limit: number): Promise<TestStore> {
    const s = await newStore({ statuses: ['todo', 'in_progress', 'review', 'done'] });
    const file = path.join(s.dir, 'config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.limits.events_per_task = limit;
    fs.writeFileSync(file, JSON.stringify(config));
    return s;
  }

  it('events_per_task=5, a hand-in and then 10 comments: the acceptance goes through and the result is still there', async () => {
    const s = await limited(5);
    await createTask(as(s, 'orch'), { title: 'T', status: 'todo' });
    await updateTask(as(s, 'orch'), { id: 'LB-1', assignee: 'dev-1', status: 'in_progress' });
    await finishTask(as(s, 'dev-1'), { id: 'LB-1', result: 'done, tests green', status: 'review', no_commit: true });
    for (let i = 0; i < 10; i++) await commentTask(as(s, 'orch'), { id: 'LB-1', text: `note ${i}` });
    const before = (await getTask(as(s), { id: 'LB-1' })).data;
    expect(before.events).toHaveLength(5);
    expect(before.events.map((e) => e.type)).toEqual(['created', 'assigned', 'commented', 'status', 'commented']);
    expect(before.events[2]?.data).toMatchObject({ text: 'done, tests green', result: true });
    expect(before.events[3]?.data).toMatchObject({ to: 'review', handed_in: true });
    expect(before.events[4]?.data.text).toBe('note 9');
    const accepted = await finishTask(as(s, 'orch'), { id: 'LB-1', result: 'accepted' });
    expect(accepted.data.status).toBe('done');
  });

  it('the kept events go too when they alone are over the limit: oldest first, the event just added stays', async () => {
    const s = await limited(1);
    await createTask(as(s, 'a'), { title: 'T', status: 'todo' });
    await commentTask(as(s, 'a'), { id: 'LB-1', text: 'last' });
    const t = (await getTask(as(s), { id: 'LB-1' })).data;
    expect(t.events.map((e) => e.data.text)).toEqual(['last']);
    expect(t.events_dropped).toBe(1);
  });

  it('only the newest status and assigned are kept: older ones go before newer plain comments', async () => {
    const s = await limited(4);
    await createTask(as(s, 'a'), { title: 'T', status: 'todo' });
    await updateTask(as(s, 'a'), { id: 'LB-1', status: 'in_progress' });
    await updateTask(as(s, 'a'), { id: 'LB-1', status: 'review' });
    await commentTask(as(s, 'a'), { id: 'LB-1', text: 'c1' });
    await commentTask(as(s, 'a'), { id: 'LB-1', text: 'c2' });
    const t = (await getTask(as(s), { id: 'LB-1' })).data;
    expect(t.events.map((e) => [e.type, e.data.to ?? e.data.text ?? null])).toEqual([
      ['created', null],
      ['status', 'review'],
      ['commented', 'c1'],
      ['commented', 'c2'],
    ]);
    expect(t.events_dropped).toBe(1);
  });
});

describe('S6k tail: prime --hook under a stale LANEBOARD_DIR pin advises the pin fix, never the bare init', () => {
  it('this folder has a board: the hook line names laneboard setup claude-code and --dir; no "laneboard init"', async () => {
    const s = await newStore();
    const home = tempDir();
    const gone = path.join(tempDir(), 'moved-away', '.laneboard');
    const r = await cli(['prime', '--hook'], { cwd: s.root, env: { HOME: home, LANEBOARD_DIR: gone }, stdin: '{"source":"startup"}' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`laneboard: no board opened (LANEBOARD_DIR points to ${gone}, which is not a directory; this folder's board is`);
    expect(r.stdout).toContain(`If the user wants to track work here with laneboard: laneboard setup claude-code in ${s.root} pins the session to it again`);
    expect(r.stdout).not.toContain('laneboard init');
    // Plain prime names the same fix in its problem line.
    const plain = await cli(['prime'], { cwd: s.root, env: { HOME: home, LANEBOARD_DIR: gone } });
    expect(plain.stdout).toContain(`fix: laneboard setup claude-code in ${s.root}`);
    expect(plain.stdout).not.toContain('laneboard init --name');
  });

  it('no board here either: the hook gives the init --dir of the pinned path; with no pin the plain init line stays', async () => {
    const cwd = tempDir();
    const home = tempDir();
    const gone = path.join(tempDir(), 'nothing', '.laneboard');
    const r = await cli(['prime', '--hook'], { cwd, env: { HOME: home, LANEBOARD_DIR: gone }, stdin: '{"source":"startup"}' });
    expect(r.stdout).toContain(`laneboard init --dir ${gone} --name <name>`);
    expect(r.stdout).toMatch(/^laneboard: no board opened \(/);
    const bare = await cli(['prime', '--hook'], { cwd, env: { HOME: home }, stdin: '{"source":"startup"}' });
    expect(bare.stdout).toMatch(/^laneboard: no board found \(no \.laneboard directory in /);
    expect(bare.stdout).toContain('laneboard init --name <name>');
  });
});
