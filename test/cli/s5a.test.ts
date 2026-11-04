// S5a (ADR §25-§27) through the CLI: --parent / --no-parent / list --parent, --append-description(-file), the result mark in get;
// every new error's fix runs (K4, as test/cli/lb18.test.ts). Also review LB-19 MINOR 1: an unreadable store file is a store error.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTemp, cli, newStore } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

// Split a printed `laneboard ...` fix into argv the way a shell would.
function shellArgv(fix: string): string[] {
  expect(fix.startsWith('laneboard ')).toBe(true);
  const out = execFileSync('sh', ['-c', `printf '%s\\0' ${fix.slice('laneboard '.length)}`], { encoding: 'utf8' });
  return out.split('\0').slice(0, -1);
}

// Run a CLI command with --json; the parsed envelope and the exit code.
async function json(s: TestStore, argv: string[]): Promise<{ code: number; doc: any }> {
  const r = await cli([...argv, '--json'], { cwd: s.root });
  return { code: r.code, doc: JSON.parse(r.stdout) };
}

// A store with LB-1 "Parent" and its subtask LB-2 "Child", made by the CLI.
async function withChild(): Promise<TestStore> {
  const s = await newStore();
  expect((await json(s, ['create', 'Parent', '--status', 'todo', '--as', 'a'])).code).toBe(0);
  const child = await json(s, ['create', 'Child', '--status', 'todo', '--parent', 'LB-1', '--as', 'a']);
  expect(child.doc).toMatchObject({ ok: true, data: { id: 'LB-2' } });
  return s;
}

describe('S5a DoD: subtasks', () => {
  it('create --parent, get children, list --parent; human get names parent and children', async () => {
    const s = await withChild();
    expect((await json(s, ['get', 'LB-1'])).doc.data.children[0].id).toBe('LB-2');
    expect((await json(s, ['list', '--parent', 'LB-1'])).doc.data.items.map((i: { id: string }) => i.id)).toEqual(['LB-2']);
    expect((await cli(['get', 'LB-2'], { cwd: s.root })).stdout).toContain('\n  parent: LB-1 Parent [todo]\n');
    expect((await cli(['get', 'LB-1'], { cwd: s.root })).stdout).toContain('\n  children: LB-2 [todo]\n');
  });

  it('a cycle: INVALID_VALUE; the fix is the same command with a placeholder parent, and it runs with a real one', async () => {
    const s = await withChild();
    await json(s, ['create', 'Other', '--status', 'todo', '--as', 'a']);
    const { code, doc } = await json(s, ['update', 'LB-1', '--parent', 'LB-2', '--as', 'a']);
    expect(code).toBe(2);
    expect(doc.error).toMatchObject({ code: 'INVALID_VALUE', message: 'LB-2 cannot be the parent of LB-1: LB-2 is under LB-1 (LB-1 > LB-2)' });
    expect(doc.error.fix).toBe('laneboard update LB-1 --as a --json --parent <id of a task not under LB-1>');
    const r = await cli(shellArgv(doc.error.fix.replace('<id of a task not under LB-1>', 'LB-3')), { cwd: s.root });
    expect(r.code, r.stdout).toBe(0);
    expect(JSON.parse(r.stdout).data).toMatchObject({ id: 'LB-1' });
    expect((await json(s, ['get', 'LB-1'])).doc.data.parent).toBe('LB-3');
  });

  it('a parent on another board: INVALID_VALUE, the fix links it instead (update: --add-link, create: --link)', async () => {
    const s = await withChild();
    const update = await json(s, ['update', 'LB-2', '--parent', 'WEB-3', '--as', 'a']);
    expect(update.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard update LB-2 --as a --json --add-link task=WEB-3' });
    const create = await json(s, ['create', 'x', '--status', 'todo', '--parent', 'WEB-3', '--as', 'a']);
    expect(create.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard create x --status todo --as a --json --link task=WEB-3' });
  });

  it('--parent with --no-parent: USAGE, the fix keeps --parent and runs; --no-parent makes a top-level task', async () => {
    const s = await withChild();
    await json(s, ['create', 'Other', '--status', 'todo', '--as', 'a']);
    const { doc } = await json(s, ['update', 'LB-2', '--parent', 'LB-3', '--no-parent', '--as', 'a']);
    expect(doc.error).toMatchObject({ code: 'USAGE', fix: 'laneboard update LB-2 --parent LB-3 --as a --json' });
    expect((await cli(shellArgv(doc.error.fix), { cwd: s.root })).code).toBe(0);
    const top = await json(s, ['update', 'LB-2', '--no-parent', '--as', 'a', '--full']);
    expect(top.doc.data).toMatchObject({ parent: null, events: expect.arrayContaining([expect.objectContaining({ data: { parent: ['LB-3', null] } })]) });
  });

  it('delete of the parent: the child has no parent and an updated {parent: [LB-1, null]} event', async () => {
    const s = await withChild();
    expect((await json(s, ['delete', 'LB-1', '--confirm', 'LB-1', '--as', 'a'])).code).toBe(0);
    const child = (await json(s, ['get', 'LB-2'])).doc.data;
    expect(child.parent).toBeNull();
    expect(child.events.at(-1)).toMatchObject({ type: 'updated', data: { parent: ['LB-1', null] } });
  });
});

describe('S5a DoD: description append', () => {
  it('twice: old text + blank line + each; event appended, no --expected-rev; human event line says appended', async () => {
    const s = await newStore();
    await json(s, ['create', 'T', '--status', 'todo', '--description', 'old', '--as', 'a']);
    expect((await json(s, ['update', 'LB-1', '--append-description', 'x', '--as', 'a'])).code).toBe(0);
    expect((await json(s, ['update', 'LB-1', '--append-description', 'x', '--as', 'a'])).code).toBe(0);
    const t = (await json(s, ['get', 'LB-1'])).doc.data;
    expect(t.description).toBe('old\n\nx\n\nx');
    expect(t.events.at(-1).data).toEqual({ description: { chars: [6, 9], appended: true } });
    expect((await cli(['get', 'LB-1'], { cwd: s.root })).stdout).toContain('  updated  description=6→9 chars (appended)\n');
    fs.writeFileSync(path.join(s.root, 'more.md'), 'from a file');
    expect((await json(s, ['update', 'LB-1', '--append-description-file', 'more.md', '--as', 'a'])).code).toBe(0);
    expect((await json(s, ['get', 'LB-1'])).doc.data.description).toBe('old\n\nx\n\nx\n\nfrom a file');
  });

  it.each([
    [['--description', 'y', '--append-description', 'z'], 'laneboard update LB-1 --description y --as a --json'],
    [['--description-file', 'more.md', '--append-description', 'z'], 'laneboard update LB-1 --description-file more.md --as a --json'],
    [['--description', 'y', '--append-description-file', 'more.md'], 'laneboard update LB-1 --description y --as a --json'],
    [['--append-description', 'z', '--append-description-file', 'more.md'], 'laneboard update LB-1 --append-description z --as a --json'],
  ])('%j: USAGE, the fix is the own command without the second option, and it runs', async (opts, fix) => {
    const s = await newStore();
    fs.writeFileSync(path.join(s.root, 'more.md'), 'text');
    await json(s, ['create', 'T', '--status', 'todo', '--as', 'a']);
    const { code, doc } = await json(s, ['update', 'LB-1', ...opts, '--as', 'a']);
    expect(code).toBe(2);
    expect(doc.error).toMatchObject({ code: 'USAGE', fix });
    const r = await cli(shellArgv(doc.error.fix), { cwd: s.root });
    expect(r.code, r.stdout).toBe(0);
  });

  it('over 100000 characters: INVALID_VALUE, the fix attaches the text as a file, and it runs', async () => {
    const s = await newStore();
    fs.writeFileSync(path.join(s.root, 'long.md'), 'x'.repeat(99999));
    await json(s, ['create', 'T', '--status', 'todo', '--description-file', 'long.md', '--as', 'a']);
    const { code, doc } = await json(s, ['update', 'LB-1', '--append-description', 'more text', '--as', 'a']);
    expect(code).toBe(2);
    expect(doc.error).toMatchObject({ code: 'INVALID_VALUE', message: 'description would be 100010 characters, over 100000', fix: 'laneboard attach LB-1 <path of a file with the text>' });
    fs.writeFileSync(path.join(s.root, 'more.md'), 'more text');
    const r = await cli([...shellArgv(doc.error.fix.replace('<path of a file with the text>', 'more.md')), '--as', 'a'], { cwd: s.root });
    expect(r.code, r.stdout + r.stderr).toBe(0);
  });
});

describe('S5a DoD: result mark', () => {
  it("finish (the assignee's and an acceptance) marks its comment; comment does not; human get says commented (result)", async () => {
    const s = await newStore();
    await json(s, ['create', 'T', '--status', 'todo', '--assignee', 'dev', '--as', 'dev']);
    await json(s, ['comment', 'LB-1', 'a note', '--as', 'dev']);
    await json(s, ['finish', 'LB-1', '--result', 'ready', '--status', 'review', '--no-commit', '--as', 'dev']);
    await json(s, ['finish', 'LB-1', '--result', 'ok', '--as', 'boss']);
    const comments = (await json(s, ['get', 'LB-1'])).doc.data.events.filter((e: { type: string }) => e.type === 'commented').map((e: { data: unknown }) => e.data);
    expect(comments).toEqual([{ text: 'a note' }, { text: 'ready', result: true }, { text: 'ok', result: true }]);
    const human = (await cli(['get', 'LB-1'], { cwd: s.root })).stdout;
    expect(human).toContain('  dev  commented  a note\n');
    expect(human).toContain('  dev  commented (result)  ready\n');
    expect(human).toContain('  boss  commented (result)  ok\n');
  });
});

// Root reads any file whatever its mode, so the permission cases cannot fail there.
const asRoot = process.getuid?.() === 0;

describe('review LB-19 MINOR 1: a store file that cannot be read is a store error with a fix, not INTERNAL', () => {
  it.skipIf(asRoot)('unreadable config.json: create without --status keeps its USAGE fix; running it gives STORE_INVALID whose chmod fix runs', async () => {
    const s = await newStore();
    const config = path.join(s.dir, 'config.json');
    fs.chmodSync(config, 0o000);
    try {
      const usage = await json(s, ['create', 'Fix', 'login', '--as', 'a']);
      expect(usage.doc.error).toMatchObject({ code: 'USAGE', fix: "laneboard create 'Fix login' --as a --json --status <status>" });
      const store = await json(s, ['create', 'x', '--status', 'todo', '--as', 'a']);
      expect(store.code).toBe(6);
      expect(store.doc.error).toMatchObject({ code: 'STORE_INVALID', message: `config.json cannot be read (EACCES): ${config}`, fix: `chmod u+rw ${config}` });
      execFileSync('sh', ['-c', store.doc.error.fix]);
      expect((await json(s, ['create', 'x', '--status', 'todo', '--as', 'a'])).code).toBe(0);
    } finally {
      fs.chmodSync(config, 0o644);
    }
  });

  it.skipIf(asRoot)('unreadable active.json: list gives STORE_INVALID with the chmod fix', async () => {
    const s = await newStore();
    const active = path.join(s.dir, 'active.json');
    fs.chmodSync(active, 0o000);
    try {
      const { code, doc } = await json(s, ['list']);
      expect(code).toBe(6);
      expect(doc.error).toMatchObject({ code: 'STORE_INVALID', message: `active.json cannot be read (EACCES): ${active}`, fix: `chmod u+rw ${active}` });
    } finally {
      fs.chmodSync(active, 0o644);
    }
  });

  it('a store file that is a directory: STORE_INVALID naming it, not INTERNAL', async () => {
    const s = await newStore();
    fs.rmSync(path.join(s.dir, 'config.json'));
    fs.mkdirSync(path.join(s.dir, 'config.json'));
    const { code, doc } = await json(s, ['list']);
    expect(code).toBe(6);
    expect(doc.error.code).toBe('STORE_INVALID');
    expect(doc.error.message).toMatch(/^config\.json cannot be read \(EISDIR\): /);
  });
});
