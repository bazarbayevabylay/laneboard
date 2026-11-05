// S6x (UX run 5): A-U1 no earlier-session task is cut from prime silently (oldest first, a total, a footer with list --sessions-of);
// B-U1 config names the work status of a board with checks; A risk 1 prime --hook takes the session id from the hook input when
// CLAUDE_CODE_SESSION_ID is not set; B-U2 a checker that gets a task waiting for its check is warned that it no longer checks it.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRIME_MAX_CHARS } from '../../src/cli/format.ts';
import { callTool } from '../../src/mcp/tools.ts';
import { cleanupTemp, cli, newStore } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

const BASE = 'claude-code@ann';
const ID_1 = '11111111-1a1a-4a1a-8a1a-000000000001';
const ID_2 = '22222222-2b2b-4b2b-8b2b-000000000002';
const SESSION_1 = { LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: ID_1 };
const SESSION_2 = { LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: ID_2 };
const NAME_1 = `${BASE}:11111111`;
const NAME_2 = `${BASE}:22222222`;
const MIN = 60_000;

// Only Date is faked: each task of the abandoned session gets its own update time, timers (the store lock) stay real.
let clock = Date.parse('2026-11-06T10:00:00.000Z');
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
});
afterEach(() => {
  vi.useRealTimers();
});
function later(ms: number): void {
  clock += ms;
  vi.setSystemTime(clock);
}

// Run the CLI with --json in `s` with `env` (and `--as` when given); the exit code and the parsed envelope.
async function json(s: TestStore, argv: string[], env: Record<string, string> = {}): Promise<{ code: number; doc: Record<string, any> }> {
  const r = await cli([...argv, '--json'], { cwd: s.root, env });
  return { code: r.code, doc: JSON.parse(r.stdout) };
}

// The persona A board (todo,doing,done): session 1 left `n` tasks in doing, one every 2 minutes (LB-1 the oldest), then went quiet.
async function abandoned(n: number): Promise<TestStore> {
  const s = await newStore({ statuses: ['todo', 'doing', 'done'] });
  for (let i = 1; i <= n; i++) {
    expect((await json(s, ['create', `abandoned-${i}`, '--status', 'doing', '--assignee', NAME_1], SESSION_1)).code).toBe(0);
    later(2 * MIN);
  }
  later(20 * MIN);
  return s;
}

// The SessionStart hook of a new session: prime --hook with the hook input on stdin.
async function hook(s: TestStore, env: Record<string, string>, input: Record<string, string>): Promise<string> {
  return (await cli(['prime', '--hook'], { cwd: s.root, env, stdin: JSON.stringify(input) })).stdout;
}

describe('A-U1: prime never cuts an earlier-session task silently', () => {
  it('7 abandoned tasks: the hook lists 5, oldest first, then "2 more (7 in all)" with list --sessions-of, which prints all 7', async () => {
    const s = await abandoned(7);
    const out = await hook(s, SESSION_2, { session_id: ID_2, source: 'startup' });
    expect(out.length).toBeLessThanOrEqual(PRIME_MAX_CHARS);
    const section = out.slice(out.indexOf('Your earlier sessions, unfinished'));
    const ids = [...section.matchAll(/^ {2}(LB-\d+) {2}\[doing\]/gm)].map((m) => m[1]);
    expect(ids).toEqual(['LB-1', 'LB-2', 'LB-3', 'LB-4', 'LB-5']);
    expect(section).toContain('  LB-1  [doing]  34m ago  session 11111111  abandoned-1\n');
    const footer = `... 2 more (7 in all): laneboard list --sessions-of ${BASE} --json`;
    expect(section).toContain(`\n${footer}`);
    // The footer command as printed, in the new session: every abandoned task, the total says so.
    const listed = await json(s, footer.slice(footer.indexOf('laneboard ') + 'laneboard '.length).replace(/ --json$/, '').split(' '), SESSION_2);
    expect(listed.code).toBe(0);
    expect(listed.doc.data.total).toBe(7);
    expect(listed.doc.data.items.map((t: { id: string }) => t.id).sort()).toEqual(['LB-1', 'LB-2', 'LB-3', 'LB-4', 'LB-5', 'LB-6', 'LB-7']);
  });

  it('prime --json and MCP task_prime: resumable oldest first, at most 5, and resumable_total; task_list sessions_of lists all', async () => {
    const s = await abandoned(7);
    const data = (await json(s, ['prime'], SESSION_2)).doc.data;
    expect(data.resumable.map((t: { id: string }) => t.id)).toEqual(['LB-1', 'LB-2', 'LB-3', 'LB-4', 'LB-5']);
    expect(data.resumable_total).toBe(7);
    const text = (await cli(['prime'], { cwd: s.root, env: SESSION_2 })).stdout;
    expect(text).toContain(`\n... 2 more (7 in all): laneboard list --sessions-of ${BASE} --json`);
    const env = { cwd: s.root, env: SESSION_2 };
    const prime = (await callTool('task_prime', {}, env)).structuredContent as Record<string, any>;
    expect(prime.resumable.map((t: { id: string }) => t.id)).toEqual(['LB-1', 'LB-2', 'LB-3', 'LB-4', 'LB-5']);
    expect(prime.resumable_total).toBe(7);
    const list = (await callTool('task_list', { sessions_of: BASE }, env)).structuredContent as Record<string, any>;
    expect(list.total).toBe(7);
  });

  it('5 or fewer: all listed, no footer; a session without earlier tasks: resumable_total 0', async () => {
    const s = await abandoned(5);
    const out = await hook(s, SESSION_2, { session_id: ID_2, source: 'clear' });
    expect([...out.matchAll(/^ {2}LB-\d+ {2}\[doing\]/gm)]).toHaveLength(5);
    expect(out).not.toContain('in all)');
    expect((await json(s, ['prime'], SESSION_1)).doc.data).toMatchObject({ resumable: [], resumable_total: 0 });
  });

  it('list --sessions-of counts what prime counts: not final, not another base, not an explicit name, not waiting for a check', async () => {
    const s = await newStore({ prefix: 'API', statuses: ['todo', 'dev', 'review', 'done'] });
    expect((await json(s, ['config', '--review-statuses', 'review', '--as', 'orch'])).code).toBe(0);
    const create = async (title: string, env: Record<string, string>, extra: string[] = []) => expect((await json(s, ['create', title, '--status', 'dev', '--assignee', NAME_1, ...extra], env)).code).toBe(0);
    await create('kept-1', SESSION_1);
    await create('kept-2', SESSION_1);
    await create('moved back', SESSION_1);
    expect((await json(s, ['update', 'API-3', '--status', 'todo'], SESSION_1)).code).toBe(0);
    await create('handed in', SESSION_1);
    expect((await json(s, ['finish', 'API-4', '--result', 'work', '--no-commit'], SESSION_1)).doc.data.status).toBe('review');
    // Taken under the explicit name (another session passed --as): no default name of a session, so no resume either.
    await create('explicit', SESSION_2, ['--as', NAME_1]);
    expect((await json(s, ['create', 'other base', '--status', 'dev', '--assignee', 'claude-code@bob:11111111', '--as', 'claude-code@bob:11111111'], {})).code).toBe(0);
    const prime = (await json(s, ['prime'], SESSION_2)).doc.data;
    const listed = (await json(s, ['list', '--sessions-of', BASE], SESSION_2)).doc.data;
    expect(prime.resumable.map((t: { id: string }) => t.id).sort()).toEqual(['API-1', 'API-2', 'API-3']);
    expect(listed.items.map((t: { id: string }) => t.id).sort()).toEqual(['API-1', 'API-2', 'API-3']);
    expect(prime.resumable_total).toBe(listed.total);
    // Into the final status by its checker: no longer resumable, by either.
    expect((await json(s, ['finish', 'API-1', '--status', 'review', '--result', 'w', '--no-commit'], SESSION_1)).code).toBe(0);
    expect((await json(s, ['finish', 'API-1', '--status', 'done', '--result', 'ok', '--as', 'orch'])).code).toBe(0);
    expect((await json(s, ['list', '--sessions-of', BASE], SESSION_2)).doc.data.total).toBe(2);
    expect((await json(s, ['prime'], SESSION_2)).doc.data.resumable_total).toBe(2);
  });

  it('--sessions-of with --assignee or --unassigned: USAGE (exit 2)', async () => {
    const s = await abandoned(1);
    for (const extra of [['--assignee', NAME_1], ['--unassigned']]) {
      const r = await json(s, ['list', '--sessions-of', BASE, ...extra], SESSION_2);
      expect(r.code, extra.join(' ')).toBe(2);
      expect(r.doc.error.code).toBe('USAGE');
    }
  });
});

describe('A risk 1: prime --hook names the session by the session_id of the hook input when CLAUDE_CODE_SESSION_ID is not set', () => {
  const NO_ENV_ID = { LANEBOARD_DEFAULT_AGENT: BASE };

  it('no env: the name and the resume section come from session_id; the commands carry --as with that name', async () => {
    const s = await abandoned(2);
    const out = await hook(s, NO_ENV_ID, { session_id: ID_2, source: 'startup' });
    expect(out).toContain(`Your name: session default ${NAME_2} (the session id is from the hook input, CLAUDE_CODE_SESSION_ID is not set: pass --as ${NAME_2} on every command).`);
    expect(out).toContain('Your earlier sessions, unfinished');
    expect(out).toContain('  LB-1  [doing]');
    expect(out).toContain(`laneboard create "<short title of your work>" --status todo --assignee ${NAME_2} --as ${NAME_2} --json`);
    expect(out).toContain(`The request names a task id: laneboard claim <ID> --status doing --as ${NAME_2} --json`);
    // The printed --as is this session's default name where the env has the id: the write stays "default", and resume works.
    const claim = await json(s, ['claim', 'LB-1', '--resume', '--as', NAME_2], SESSION_2);
    expect(claim.code).toBe(0);
    expect(claim.doc.data).toMatchObject({ assignee: NAME_2, resumed_from: NAME_1 });
  });

  it('env set: the env wins over the input; no input id and no env: the name has no session part, as before', async () => {
    const s = await abandoned(1);
    const both = await hook(s, SESSION_2, { session_id: ID_1, source: 'startup' });
    expect(both).toContain(`Your name: session default ${NAME_2} (no --as needed).`);
    const none = await hook(s, NO_ENV_ID, { source: 'startup' });
    expect(none).toContain(`Your name: session default ${BASE} (no --as needed).`);
    expect(none).not.toContain('Your earlier sessions');
    // An empty or non-string session_id is no id.
    for (const session_id of ['', '42']) {
      const input = JSON.parse(`{"session_id": ${session_id === '' ? '""' : session_id}, "source": "startup"}`);
      expect(await hook(s, NO_ENV_ID, input), session_id).toContain(`Your name: session default ${BASE} (no --as needed).`);
    }
  });

  it('plain prime never reads the hook input', async () => {
    const s = await abandoned(1);
    const out = (await cli(['prime'], { cwd: s.root, env: NO_ENV_ID, stdin: JSON.stringify({ session_id: ID_2, source: 'startup' }) })).stdout;
    expect(out).toContain(`Your name: session default ${BASE} (no --as needed).`);
  });
});

describe('B-U1: config names the work status of a board with checks', () => {
  const LINE = (work: string) => `  work status: ${work} (the status before the first check) - claims and returns for rework go here; to change it, reorder --statuses`;

  it('todo,in_progress,blocked,code_review,qa,done: blocked, in the text and in JSON; reordered: in_progress', async () => {
    const s = await newStore({ prefix: 'API', statuses: ['todo', 'in_progress', 'blocked', 'code_review', 'qa', 'done'] });
    const set = await cli(['config', '--review-statuses', 'code_review,qa', '--reviewers', 'rev2', '--as', 'orch'], { cwd: s.root });
    expect(set.stdout.split('\n')).toContain(LINE('blocked'));
    expect((await json(s, ['config'])).doc.data.review).toEqual({ statuses: ['code_review', 'qa'], by: ['rev2'], work_status: 'blocked' });
    // prime says the same: claims and returns go to blocked.
    expect((await cli(['prime', '--as', 'dev-b'], { cwd: s.root })).stdout).toContain('return work: comment why, then update --status blocked');
    const reordered = await cli(['config', '--statuses', 'todo,blocked,in_progress,code_review,qa,done', '--as', 'orch'], { cwd: s.root });
    expect(reordered.stdout.split('\n')).toContain(LINE('in_progress'));
    expect((await json(s, ['config'])).doc.data.review.work_status).toBe('in_progress');
  });

  it('the first check right after the first status: that status; no checks: no line and no review', async () => {
    const s = await newStore({ statuses: ['todo', 'review', 'done'] });
    expect((await cli(['config'], { cwd: s.root })).stdout).not.toContain('work status');
    expect((await json(s, ['config'])).doc.data.review).toBeUndefined();
    expect((await cli(['config', '--review-statuses', 'review', '--as', 'o'], { cwd: s.root })).stdout.split('\n')).toContain(LINE('todo'));
  });
});

describe('B-U2: a checker that gets a task waiting for its check is warned that it never checks it now', () => {
  // ONE check (review), reviewers `by`; API-1 handed in by dev-1.
  async function waiting(by: string | undefined): Promise<TestStore> {
    const s = await newStore({ prefix: 'API', statuses: ['todo', 'in_progress', 'review', 'done'] });
    expect((await json(s, ['config', '--review-statuses', 'review', ...(by === undefined ? [] : ['--reviewers', by]), '--as', 'orch'])).code).toBe(0);
    expect((await json(s, ['create', 'Add endpoint', '--status', 'todo', '--as', 'orch'])).code).toBe(0);
    expect((await json(s, ['claim', 'API-1', '--status', 'in_progress', '--as', 'dev-1'])).code).toBe(0);
    expect((await json(s, ['finish', 'API-1', '--result', 'work', '--no-commit', '--as', 'dev-1'])).doc.data.status).toBe('review');
    return s;
  }
  const HEAD = 'API-1 waits in review for a check, and you hold it now: a holder is an author of the work and never checks it (giving it to another name later does not change that); ';
  const TAIL = '. A check needs no claim or assignment: a checker runs laneboard finish API-1 --status done --result "<result of your check>"';

  it('rev of rev,orch takes it: the check stays with orch, who accepts it', async () => {
    const s = await waiting('rev,orch');
    const r = await json(s, ['update', 'API-1', '--assignee', 'rev', '--as', 'rev']);
    expect(r.code).toBe(0);
    expect(r.doc.warnings).toEqual([`${HEAD}the check stays with orch${TAIL}`]);
    expect((await json(s, ['finish', 'API-1', '--status', 'done', '--result', 'ok', '--as', 'orch'])).doc.data).toMatchObject({ status: 'done', accepted: true });
  });

  it('the only checker takes it: no checker left, the owner\'s config --reviewers', async () => {
    const s = await waiting('rev2');
    const r = await json(s, ['update', 'API-1', '--assignee', 'rev2', '--as', 'rev2']);
    expect(r.doc.warnings).toEqual([`${HEAD}no checker is left for it, so the owner adds one: laneboard config --reviewers "rev2,<another checker>"${TAIL}`]);
  });

  it('no reviewers set: anybody else checks it; the orchestrator gives it to rev: rev is named', async () => {
    const s = await waiting(undefined);
    expect((await json(s, ['update', 'API-1', '--assignee', 'rev', '--as', 'rev'])).doc.warnings).toEqual([`${HEAD}anybody else but its authors checks it${TAIL}`]);
    const t = await waiting('rev,orch');
    const r = await json(t, ['update', 'API-1', '--assignee', 'rev', '--as', 'orch']);
    expect(r.doc.warnings).toEqual([`${HEAD.replace('you hold it now', 'rev holds it now')}the check stays with orch${TAIL}`]);
  });

  it('no warning: a name that is no checker, the author, a return for rework with the same write, a board without checks', async () => {
    const s = await waiting('rev,orch');
    expect((await json(s, ['update', 'API-1', '--assignee', 'dev-2', '--as', 'orch'])).doc.warnings).toEqual([]);
    expect((await json(s, ['update', 'API-1', '--assignee', 'dev-1', '--as', 'orch'])).doc.warnings).toEqual([]);
    const back = await json(s, ['update', 'API-1', '--status', 'in_progress', '--assignee', 'rev', '--as', 'rev']);
    expect(back.code).toBe(0);
    expect(back.doc.warnings.join('\n')).not.toContain('never checks it');
    const plain = await newStore();
    expect((await json(plain, ['create', 'x', '--status', 'review', '--assignee', 'dev-1', '--as', 'dev-1'])).code).toBe(0);
    expect((await json(plain, ['update', 'LB-1', '--assignee', 'rev', '--as', 'rev'])).doc.warnings).toEqual([]);
  });
});
