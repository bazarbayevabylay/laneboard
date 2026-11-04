// CLI argv rules: repeated options, text that starts with "-", `--` and `--opt=value`, and fixes that run as printed.
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTemp, cli, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

// A temp directory with a store and task LB-1.
async function seeded(): Promise<{ root: string; run: (argv: string[]) => ReturnType<typeof cli> }> {
  const root = tempDir();
  const run = (argv: string[]): ReturnType<typeof cli> => cli(argv, { cwd: root });
  expect((await run(['init', '--description', 'test board', '--prefix', 'LB'])).code).toBe(0);
  expect((await run(['create', 'Fix login', '--status', 'todo', '--as', 'a'])).code).toBe(0);
  return { root, run };
}

// Run a command and return its JSON error.
async function errorOf(run: (argv: string[]) => ReturnType<typeof cli>, argv: string[]): Promise<{ code: string; message: string; fix: string }> {
  const r = await run([...argv, '--json']);
  expect(r.code, r.stdout).not.toBe(0);
  return JSON.parse(r.stdout).error;
}

// Split a printed `laneboard ...` fix into argv the way a shell would.
function shellArgv(fix: string): string[] {
  expect(fix.startsWith('laneboard ')).toBe(true);
  const out = execFileSync('sh', ['-c', `printf '%s\\0' ${fix.slice('laneboard '.length)}`], { encoding: 'utf8' });
  return out.split('\0').slice(0, -1);
}

describe('repeated options (M3)', () => {
  it.each([
    [['update', 'LB-1', '--status', 'done', '--status', 'todo', '--as', 'a'], '--status is given 2 times ("done", "todo")'],
    [['comment', 'LB-1', 'x', '--as', 'a', '--as', 'b'], '--as is given 2 times ("a", "b")'],
    [['update', 'LB-1', '--title=one', '--title', 'two', '--as', 'a'], '--title is given 2 times ("one", "two")'],
    [['list', '--unassigned', '--unassigned'], '--unassigned is given 2 times'],
  ])('%j -> USAGE', async (argv, message) => {
    const { run } = await seeded();
    const err = await errorOf(run, argv);
    expect(err.code).toBe('USAGE');
    expect(err.message).toContain(message);
    const r = await run(argv);
    expect(r.code).toBe(2);
  });

  it('the fix keeps one occurrence: runnable when the values agree, a named choice when they differ', async () => {
    const { run } = await seeded();
    const same = await errorOf(run, ['comment', 'LB-1', 'x', '--as', 'a', '--as', 'a']);
    expect(same.fix).toBe('laneboard comment LB-1 x --as a --json');
    expect((await run(shellArgv(same.fix))).code).toBe(0);
    const differ = await errorOf(run, ['update', 'LB-1', '--status', 'done', '--status', 'todo', '--as', 'a']);
    expect(differ.fix).toBe('laneboard update LB-1 --status <one of: done, todo> --as a --json');
  });

  it('options that the spec makes repeatable still repeat', async () => {
    const { run } = await seeded();
    const r = await run(['update', 'LB-1', '--add-link', 'pr=https://example.com/1', '--add-link', 'commit=abc123', '--add-label', 'ui', '--add-label', 'auth', '--as', 'a', '--json', '--full']);
    expect(r.code, r.stdout).toBe(0);
    expect(JSON.parse(r.stdout).data.links).toHaveLength(2);
    const c = await run(['create', 'two labels', '--status', 'todo', '--label', 'a', '--label', 'b', '--field', 'priority=1', '--as', 'a', '--json', '--full']);
    expect(c.code, c.stdout).toBe(0);
    expect(JSON.parse(c.stdout).data.labels).toEqual(['a', 'b']);
  });
});

describe('text that starts with "-" (M4)', () => {
  it.each([
    [['comment', 'LB-1', '- item one', '--as', 'a'], 'laneboard comment LB-1 --as a --json -- \'- item one\''],
    [['comment', 'LB-1', '-1 regression found', '--as', 'a'], 'laneboard comment LB-1 --as a --json -- \'-1 regression found\''],
    [['create', '-x', '--status', 'todo', '--as', 'a'], 'laneboard create --status todo --as a --json -- -x'],
    [['create', 't', '--status', 'todo', '--description', '- a\n- b', '--as', 'a'], "laneboard create t --status todo '--description=- a\n- b' --as a --json"],
    [['update', 'LB-1', '--title', '-x thing', '--as', 'a'], "laneboard update LB-1 '--title=-x thing' --as a --json"],
    [['comment', 'LB-1', '--- section', '--as', 'a'], "laneboard comment LB-1 --as a --json -- '--- section'"],
    [['comment', 'LB-1', '-- note for b', '--as', 'a'], "laneboard comment LB-1 --as a --json -- '-- note for b'"],
    [['create', '--- t', '--status', 'todo', '--as', 'a'], "laneboard create --status todo --as a --json -- '--- t'"],
  ])('%j: the fix is the working command', async (argv, fix) => {
    const { run } = await seeded();
    const err = await errorOf(run, argv);
    expect(err.fix).toBe(fix);
    expect(err.fix).not.toContain('<');
    const r = await run(shellArgv(err.fix));
    expect(r.code, r.stdout).toBe(0);
  });

  it('a missing value is not glued to the next option', async () => {
    const { run } = await seeded();
    const err = await errorOf(run, ['update', 'LB-1', '--status', '--as', 'a']);
    expect(err).toMatchObject({ code: 'USAGE', message: '--status needs a value', fix: 'laneboard update LB-1 --status <value> --as a --json' });
  });

  it('a double-dash typo of an option is still treated as an option', async () => {
    const { run } = await seeded();
    const err = await errorOf(run, ['create', 'x', '--stauts', 'todo', '--as', 'a']);
    expect(err.code).toBe('UNKNOWN_OPTION');
    expect(err.fix).toBe('laneboard create x --status todo --as a --json');
  });

  it('a single-dash typo of an option is still treated as an option', async () => {
    const { run } = await seeded();
    const err = await errorOf(run, ['create', 'x', '-status', 'todo', '--as', 'a']);
    expect(err.code).toBe('UNKNOWN_OPTION');
    expect(err.fix).toBe('laneboard create x --status todo --as a --json');
  });

  it('after --, everything is text: "--json" there does not switch the output to JSON', async () => {
    const { run } = await seeded();
    const r = await run(['comment', 'LB-1', '--as', 'a', '--', '--json']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe('LB-1 commented (rev 2, todo, unassigned)\n');
    const got = JSON.parse((await run(['get', 'LB-1', '--json'])).stdout);
    expect(got.data.events.at(-1).data.text).toBe('--json');
  });
});

describe('fixes name a concrete format, not --help (m3, m4)', () => {
  it.each([
    [['update', 'LB-1', '--field', 'priorty=1', '--as', 'a'], 'laneboard update LB-1 --field priority=1 --as a --json'],
    [['update', 'LB-1', '--field=priorty=1', '--as', 'a'], 'laneboard update LB-1 --field=priority=1 --as a --json'],
    [['update', 'LB-1', '--field', 'priority=high', '--as', 'a'], 'laneboard update LB-1 --field priority=<number> --as a --json'],
    [['update', 'LB-1', '--assignee', 'bad name', '--as', 'a'], 'laneboard update LB-1 --assignee <name like dev-1> --as a --json'],
    [['events', '--since', 'yesterday'], 'laneboard events --since <YYYY-MM-DDTHH:MM:SS.sssZ> --json'],
    [['list', '--limit', 'ten'], 'laneboard list --limit <whole number> --json'],
    [['comment', 'LB-1'], 'laneboard comment <id> (<text> | --file P|-) [--full]'],
  ])('%j', async (argv, fix) => {
    const { run } = await seeded();
    const err = await errorOf(run, argv);
    expect(err.fix).toBe(fix);
    expect(err.fix).not.toContain('--help');
  });

  it('a typo in --field runs as printed', async () => {
    const { run } = await seeded();
    const err = await errorOf(run, ['update', 'LB-1', '--field', 'priorty=1', '--as', 'a']);
    expect((await run(shellArgv(err.fix))).code).toBe(0);
  });
});
