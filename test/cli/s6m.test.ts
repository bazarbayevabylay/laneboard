// S6m: roles in the rules and prime (UX A-U4, B-U3 check, B-U6; P1 (6), P2). On a board with checks prime names them and who makes
// them, lists the tasks waiting for the agent's check and the checker's comment under a returned task; create_by refuses create,
// subtasks, MCP task_create and import of anybody else; create and import right into a later check or the final status follow the
// author rule of update (S6j tail). A board without the keys answers as before (the invariant script compares whole outputs).
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, describe, expect, it } from 'vitest';
import { agentRules } from '../../src/core/index.ts';
import { PRIME_MAX_CHARS, RULES_MAX_CHARS, SHORT_RULES_MAX_CHARS, shortRules } from '../../src/cli/format.ts';
import { mcpRules } from '../../src/mcp/tools.ts';
import { cleanupTemp, cli, CLI_SOURCE, newStore } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

const FLOW = ['backlog', 'ready', 'dev', 'code_review', 'qa', 'done'];

// Run the CLI with --json in `s` as `actor`; the exit code and the parsed envelope.
async function run(s: TestStore, actor: string, argv: string[]): Promise<{ code: number; doc: Record<string, any> }> {
  const r = await cli([...argv, '--as', actor, '--json'], { cwd: s.root });
  return { code: r.code, doc: JSON.parse(r.stdout) };
}

// prime as `actor` in human text.
async function primeText(s: TestStore, actor: string): Promise<string> {
  const r = await cli(['prime', '--as', actor], { cwd: s.root });
  expect(r.code).toBe(0);
  return r.stdout;
}

// Ids of the active tasks.
async function ids(s: TestStore): Promise<string[]> {
  const r = await run(s, 'orch', ['list', '--scope', 'all']);
  return (r.doc.data.items as Array<{ id: string }>).map((t) => t.id).sort();
}

// Persona B's board: checks code_review then qa by rev and orch (`by`), creators `creators` (none: no create_by); API-1 in dev held by dev-a.
async function board(opts: { by?: string[]; creators?: string[]; checks?: boolean } = {}): Promise<TestStore> {
  const s = await newStore({ prefix: 'API', statuses: FLOW });
  const by = opts.by ?? ['rev', 'orch'];
  const keys = [
    ...(opts.checks === false ? [] : ['--review-statuses', 'code_review,qa', ...(by.length ? ['--reviewers', by.join(',')] : [])]),
    ...(opts.creators ? ['--creators', opts.creators.join(',')] : []),
  ];
  if (keys.length) expect((await run(s, 'orch', ['config', ...keys])).code).toBe(0);
  expect((await run(s, 'orch', ['create', 'Add endpoint', '--status', 'ready'])).code).toBe(0);
  expect((await run(s, 'dev-a', ['claim', 'API-1', '--status', 'dev'])).code).toBe(0);
  return s;
}

describe('rules 1 and 7 (A-U4, P1/P2) within the budgets', () => {
  it('rule 1 says prime tells how or whom to ask; rule 7: a checker passes on or accepts, never its own work; budgets hold', () => {
    const rules = agentRules();
    const line = (n: number): string => rules.split('\n').find((l) => l.startsWith(`${n}. `)) ?? '';
    expect(line(1)).toContain('claim your task or create one (`laneboard prime` says how, or whom to ask)');
    expect(line(7)).toContain("A checker's `finish` accepts a task handed in with `finish` or passes it to the next check (prime lists them), never its own work.");
    expect(rules.length).toBeLessThanOrEqual(RULES_MAX_CHARS);
    expect(shortRules(rules).length).toBeLessThanOrEqual(SHORT_RULES_MAX_CHARS);
    expect(mcpRules().length).toBeLessThanOrEqual(4096);
  });
});

describe('P2: create_by (config --creators)', () => {
  it('a non-creator create is INVALID_VALUE (exit 2) and writes nothing; the fix asks on its own task; the creator creates', async () => {
    const s = await board({ creators: ['orch'] });
    const before = await ids(s);
    const r = await run(s, 'dev-a', ['create', 'Extra', '--status', 'ready']);
    expect(r.code).toBe(2);
    expect(r.doc.error).toMatchObject({ code: 'INVALID_VALUE', details: { create_by: ['orch'] } });
    expect(r.doc.error.message).toContain('only orch create tasks (config create_by), and you write as dev-a');
    expect(r.doc.error.fix).toBe('laneboard comment API-1 "<task you need, for orch to create>" --as dev-a');
    expect(await ids(s)).toEqual(before);
    expect((await run(s, 'orch', ['create', 'Extra', '--status', 'ready'])).code).toBe(0);
  });

  it('without a task of its own the fix says to report to whoever started it; a subtask asks on the parent', async () => {
    const s = await board({ creators: ['orch'] });
    const r = await run(s, 'dev-b', ['create', 'Extra', '--status', 'ready']);
    expect(r.code).toBe(2);
    expect(r.doc.error.fix).toBe('report the task you need to whoever started you (orch create tasks here), then wait for its id: laneboard claim <ID> --as dev-b');
    const sub = await run(s, 'dev-b', ['create', 'Sub', '--status', 'ready', '--parent', 'API-1']);
    expect(sub.code).toBe(2);
    expect(sub.doc.error.fix).toBe('laneboard comment API-1 "<task you need, for orch to create>" --as dev-b');
  });

  it('import of a non-creator is refused, the dry run too; the creator imports', async () => {
    const s = await board({ creators: ['orch'] });
    fs.writeFileSync(path.join(s.root, 'TODO.md'), '# T\n- [ ] one\n- [ ] two\n');
    for (const dry of [true, false]) {
      const r = await run(s, 'dev-a', ['import', 'checklist', 'TODO.md', '--status', 'ready', ...(dry ? ['--dry-run'] : [])]);
      expect(r.code, `dry ${dry}`).toBe(2);
      expect(r.doc.error.message).toContain('only orch create tasks');
    }
    expect(await ids(s)).toEqual(['API-1']);
    expect((await run(s, 'orch', ['import', 'checklist', 'TODO.md', '--status', 'ready'])).doc.data.created).toHaveLength(2);
  });

  it('prime of a non-creator prints no create command but whom to ask; a creator gets the create command', async () => {
    const s = await board({ creators: ['orch'], checks: false });
    const dev = await primeText(s, 'dev-b');
    expect(dev).not.toContain('laneboard create "<short title');
    expect(dev).toContain('Only orch create tasks on this board: ask whoever started you for a task id (never create it under another name), then: laneboard claim <ID> --status ready --as dev-b --json');
    expect(dev).toContain('Only orch create tasks here (not you).');
    const orch = await primeText(s, 'orch');
    expect(orch).toContain('laneboard create "<short title of your work>" --status backlog --assignee orch --as orch --json');
    expect(orch).toContain('Only orch create tasks here.');
    const json = (await run(s, 'dev-b', ['prime'])).doc.data;
    expect(json.roles).toMatchObject({ checks: [], checkers: [], creators: ['orch'], can_create: false, work_status: null, feedback: [] });
    // No checks: nobody returns work, so no comment of another name under an own task.
    expect((await run(s, 'rev', ['comment', 'API-1', 'Needs a test'])).code).toBe(0);
    expect(await primeText(s, 'dev-a')).not.toContain('last comment by');
    expect((await run(s, 'dev-a', ['prime'])).doc.data.roles.feedback).toEqual([]);
  });

  it('MCP task_create of a non-creator gets the same refusal; task_prime carries the roles', async () => {
    const s = await board({ creators: ['orch'] });
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI_SOURCE, 'mcp', '--as', 'dev-a'], cwd: s.root, env: { PATH: process.env.PATH ?? '' }, stderr: 'pipe' });
    const client = new Client({ name: 's6m', version: '0.0.0' });
    await client.connect(transport);
    try {
      const r = await client.callTool({ name: 'task_create', arguments: { title: 'Extra', status: 'ready' } });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard comment API-1 "<task you need, for orch to create>" --as dev-a' });
      const prime = await client.callTool({ name: 'task_prime', arguments: {} });
      expect((prime.structuredContent as Record<string, any>).roles).toMatchObject({ checks: ['code_review', 'qa'], creators: ['orch'], can_create: false, work_status: 'dev' });
    } finally {
      await client.close();
    }
    expect(await ids(s)).toEqual(['API-1']);
  });
});

describe('S6j tail: create and import right past the checks follow the author rule of update', () => {
  it('create into the final status or a later check by its assignee: INVALID_VALUE, the command rebuilt with the work status', async () => {
    const s = await board();
    for (const status of ['done', 'qa']) {
      const r = await cli(['create', 'Mine', '--status', status, '--assignee', 'dev-a', '--as', 'dev-a'], { cwd: s.root });
      expect(r.code, status).toBe(2);
      expect(r.stderr).toContain(`on this board ${status} is set by a check (code_review -> qa -> done): the author of the work hands it in to code_review with finish`);
      expect(r.stderr).toContain('fix: laneboard create Mine --status dev --assignee dev-a --as dev-a');
    }
    // S6w I1: the first check too (a task enters a check only handed in with finish, else no checker sees it); nothing was written.
    const first = await cli(['create', 'Review me', '--status', 'code_review', '--assignee', 'dev-a', '--as', 'dev-a'], { cwd: s.root });
    expect(first.code).toBe(2);
    expect(first.stderr).toContain('on this board code_review is a check (code_review -> qa -> done): a task enters it only handed in by its assignee with finish');
    expect(first.stderr).toContain("fix: laneboard create 'Review me' --status dev --assignee dev-a --as dev-a");
    expect(await ids(s)).toEqual(['API-1']);
  });

  it('into the final status: a name not in review.by is refused, a checker creates it unassigned or for another name', async () => {
    const s = await board();
    const r = await run(s, 'dev-b', ['create', 'Old work', '--status', 'done']);
    expect(r.code).toBe(2);
    expect(r.doc.error.message).toContain('on this board done is set by a check (code_review -> qa -> done), only by rev, orch (config review.by)');
    expect((await run(s, 'orch', ['create', 'Old work', '--status', 'done'])).code).toBe(0);
    expect((await run(s, 'orch', ['create', 'Their work', '--status', 'done', '--assignee', 'dev-a'])).code).toBe(0);
    // The checker that is its assignee holds it after the write: refused as update --assignee itself.
    expect((await run(s, 'orch', ['create', 'My work', '--status', 'done', '--assignee', 'orch'])).code).toBe(2);
  });

  it('import: a task right in the final status by its assignee or by a non-checker is a problem of the import, nothing written', async () => {
    const s = await board();
    const md = path.join(s.root, 'md');
    fs.mkdirSync(md);
    fs.writeFileSync(path.join(md, 'a.md'), '---\ntitle: A\nstage: done\nowner: dev-a\n---\n');
    fs.writeFileSync(path.join(md, 'b.md'), '---\ntitle: B\nstage: ready\n---\n');
    const mine = await run(s, 'dev-a', ['import', 'markdown', 'md', '--status-key', 'stage', '--assignee-key', 'owner']);
    expect(mine.code).toBe(2);
    expect(mine.doc.error.message).toContain('import stopped, nothing was written');
    expect(mine.doc.error.details.invalid).toEqual([
      { source: 'md/a.md', field: 'status', message: expect.stringContaining('the author of the work hands it in to code_review with finish') },
    ]);
    fs.writeFileSync(path.join(s.root, 'TODO.md'), '# T\n- [x] shipped\n- [ ] open\n');
    const dry = await run(s, 'dev-b', ['import', 'checklist', 'TODO.md', '--status', 'ready', '--dry-run']);
    expect(dry.code).toBe(2);
    expect(dry.doc.error.details.invalid[0]).toMatchObject({ source: 'TODO.md#shipped', field: 'status', message: expect.stringContaining('only by rev, orch (config review.by)') });
    expect(await ids(s)).toEqual(['API-1']);
    expect((await run(s, 'orch', ['import', 'checklist', 'TODO.md', '--status', 'ready'])).doc.data.created).toHaveLength(2);
  });

  it('import checklist: a refused checked item gets a fix with --done-status the work status, and that fix runs (review r1)', async () => {
    const s = await board();
    fs.writeFileSync(path.join(s.root, 'TODO.md'), '# T\n- [x] shipped\n- [ ] open\n');
    const refused = await run(s, 'dev-b', ['import', 'checklist', 'TODO.md', '--status', 'ready']);
    expect(refused.code).toBe(2);
    const fix: string = refused.doc.error.fix;
    expect(fix).toContain('laneboard import checklist TODO.md --status ready --done-status dev');
    const argv = (fix.match(/laneboard (import checklist [^;]*?)(?=;|$)/)?.[1] ?? '').split(' ');
    const done = await run(s, 'dev-b', argv);
    expect(done.code).toBe(0);
    expect(done.doc.data.created).toHaveLength(2);
  });
});

describe('B-U6 and P1 (6): prime on a board with checks', () => {
  it('names the checks and checkers and claims into the status before the first check', async () => {
    const s = await board();
    const text = await primeText(s, 'dev-b');
    expect(text).toContain(
      "Checks: code_review -> qa -> done, by rev, orch. The author's finish hands in to code_review; a checker's finish passes on or accepts, never its own work; return work: comment why, then update --status dev.",
    );
    expect(text).toContain('laneboard claim <ID> --status dev --as dev-b --json');
    expect(text).not.toContain('create tasks here');
  });

  it('a first check right after the first status: claim without --status (no work status before the checks)', async () => {
    const s = await newStore({ prefix: 'API', statuses: ['todo', 'review', 'done'] });
    expect((await run(s, 'orch', ['config', '--review-statuses', 'review'])).code).toBe(0);
    expect((await run(s, 'dev-a', ['prime'])).doc.data.roles.work_status).toBeNull();
    expect(await primeText(s, 'dev-a')).toContain('Given a task id instead: laneboard claim <ID> --as dev-a --json');
    expect(await primeText(s, 'dev-a')).not.toContain('return work:');
  });

  it('a checker sees the tasks waiting for its check with the finish that checks them; not the author, not after its own pass', async () => {
    const s = await board();
    expect((await run(s, 'dev-a', ['finish', 'API-1', '--result', 'r', '--no-commit'])).code).toBe(0);
    const rev = await primeText(s, 'rev');
    // S6w I2: each waiting task with its ready pass command, --status naming where it goes.
    expect(rev).toContain('2. A task below waits for your check: run the pass command under it (--status names where it goes)');
    expect(rev).toMatch(/Waiting for your check:\n {2}API-1 {2}\[code_review\] {2}rev \d+ {2}Add endpoint\n {4}pass: laneboard finish API-1 --status qa --result "<result of your check>" --as rev --json/);
    // A name outside review.by and the author see no queue.
    expect(await primeText(s, 'dev-b')).not.toContain('Waiting for your check');
    expect(await primeText(s, 'dev-a')).not.toContain('Waiting for your check');
    // rev passed it to qa: orch's check now, not rev's again.
    expect((await run(s, 'rev', ['finish', 'API-1', '--status', 'qa', '--result', 'ok'])).code).toBe(0);
    expect(await primeText(s, 'rev')).not.toContain('Waiting for your check');
    expect(await primeText(s, 'orch')).toContain('Waiting for your check:\n  API-1  [qa]');
    expect(await primeText(s, 'orch')).toContain('    pass: laneboard finish API-1 --status done --result "<result of your check>" --as orch --json');
    const json = (await run(s, 'orch', ['prime'])).doc.data;
    expect(json.roles).toMatchObject({ checks: ['code_review', 'qa'], checkers: ['rev', 'orch'], work_status: 'dev', creators: null, can_create: true, waiting_total: 1 });
    expect(json.roles.waiting.map((t: { id: string; next_status: string }) => [t.id, t.next_status])).toEqual([['API-1', 'done']]);
  });

  it('without review.by anybody but the author of the work sees the queue; the roles line says so', async () => {
    const s = await board({ by: [] });
    expect((await run(s, 'dev-a', ['finish', 'API-1', '--result', 'r', '--no-commit'])).code).toBe(0);
    const other = await primeText(s, 'dev-b');
    expect(other).toContain('Waiting for your check:\n  API-1  [code_review]');
    expect(other).toContain('Checks: code_review -> qa -> done, by anybody but the author of the work.');
    expect(await primeText(s, 'dev-a')).not.toContain('Waiting for your check');
  });

  it('a checker with work of its own gets the queue with the check command in its header', async () => {
    const s = await board();
    expect((await run(s, 'dev-a', ['finish', 'API-1', '--result', 'r', '--no-commit'])).code).toBe(0);
    expect((await run(s, 'orch', ['create', 'Own', '--status', 'dev', '--assignee', 'rev'])).code).toBe(0);
    const rev = await primeText(s, 'rev');
    expect(rev).toContain('Waiting for your check; check one with the pass command under it:\n  API-1  [code_review]');
    expect(rev).toContain('    pass: laneboard finish API-1 --status qa --result "<result of your check>" --as rev --json');
  });

  it('P1 (6): after rev returns the task, prime of dev-a shows rev\'s comment under it, also when dev-a commented later', async () => {
    const s = await board();
    expect((await run(s, 'dev-a', ['finish', 'API-1', '--result', 'r', '--no-commit'])).code).toBe(0);
    expect((await run(s, 'rev', ['comment', 'API-1', 'Needs a test for the empty body'])).code).toBe(0);
    expect((await run(s, 'rev', ['update', 'API-1', '--status', 'dev'])).code).toBe(0);
    expect(await primeText(s, 'dev-a')).toMatch(/ {2}API-1 {2}\[dev\] {2}rev \d+ {2}Add endpoint\n {4}last comment by rev: > Needs a test for the empty body/);
    expect((await run(s, 'dev-a', ['comment', 'API-1', 'On it'])).code).toBe(0);
    expect(await primeText(s, 'dev-a')).toContain('last comment by rev: > Needs a test for the empty body');
    const json = (await run(s, 'dev-a', ['prime'])).doc.data;
    expect(json.roles.feedback).toEqual([{ id: 'API-1', comment: { at: expect.any(String), actor: 'rev', text: 'Needs a test for the empty body', result: false }, returned: { by: 'rev', at: expect.any(String) } }]);
  });

  it('stays under PRIME_MAX_CHARS with long titles, own tasks with comments, a long queue, free tasks and long checker names', async () => {
    const s = await newStore({ prefix: 'API', statuses: FLOW });
    const names = Array.from({ length: 8 }, (_, i) => `checker-${i}-${'x'.repeat(50)}`);
    expect((await run(s, 'orch', ['config', '--review-statuses', 'code_review,qa', '--reviewers', [...names, 'rev'].join(','), '--creators', 'orch'])).code).toBe(0);
    const long = 'T'.repeat(190);
    for (let i = 0; i < 12; i++) {
      expect((await run(s, 'orch', ['create', `${long} ${i}`, '--status', 'dev', '--assignee', i < 6 ? 'dev-a' : 'dev-b'])).code).toBe(0);
      expect((await run(s, 'orch', ['create', `${long} free ${i}`, '--status', 'ready'])).code).toBe(0);
    }
    for (let i = 1; i <= 23; i += 2) expect((await run(s, 'rev', ['comment', `API-${i}`, `${'why '.repeat(40)}`])).code).toBe(0);
    for (let i = 13; i <= 23; i += 2) expect((await run(s, 'dev-b', ['finish', `API-${i}`, '--result', 'r', '--no-commit'])).code).toBe(0);
    for (const who of ['dev-a', 'rev']) {
      const text = await primeText(s, who);
      // The CLI ends the text with a newline.
      expect(text.replace(/\n$/, '').length, who).toBeLessThanOrEqual(PRIME_MAX_CHARS);
      expect(text, who).toContain('Only orch create tasks');
    }
    expect(await primeText(s, 'dev-a')).toContain('last comment by rev:');
    expect(await primeText(s, 'rev')).toContain('Waiting for your check');
  });

  it('a board without checks and create_by: no roles in prime --json, no roles line, comments of others not under own tasks', async () => {
    const s = await board({ checks: false });
    expect((await run(s, 'rev', ['comment', 'API-1', 'Needs a test'])).code).toBe(0);
    const json = (await run(s, 'dev-a', ['prime'])).doc.data;
    expect('roles' in json).toBe(false);
    const text = await primeText(s, 'dev-a');
    expect(text).not.toContain('last comment by');
    expect(text).not.toContain('Checks:');
    // The claim command keeps the second status (no checks to stop before).
    expect(await primeText(s, 'dev-b')).toContain('laneboard claim <ID> --status ready --as dev-b --json');
  });
});
