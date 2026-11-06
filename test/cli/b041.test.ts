// 0.4.1 slice B (LB-56.1, 57.1, 57.3, 61.1, 61.2, 61.5, 63.2 create, LB-66): the edit hook under a default name no longer stays quiet
// for a closed earlier session's task, its --help says how it decides; rule 7 names checkers only on a board with checks; in_progress
// leaves out the first status; a creator on a board with create_by gets no "not to you" warning and no "Create one now"; the create_by
// fixes carry --json; a checker of a second round sees the reason of the return before.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { agentRules } from '../../src/core/index.ts';
import { EARLIER_SESSION_SILENT_MS } from '../../src/core/ops/common.ts';
import { boardRules } from '../../src/cli/format.ts';
import { callTool, mcpRules } from '../../src/mcp/tools.ts';
import { cleanupTemp, cli, newStore, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);
afterEach(() => {
  vi.useRealTimers();
});

const BASE = 'claude-code@Test-Person';
const A = { LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: '1a2b3c4d-0000-4000-8000-000000000001' };
const B = { LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: '9f8e7d6c-0000-4000-8000-000000000002' };
const OTHER = { LANEBOARD_DEFAULT_AGENT: 'claude-code@Other-Person', CLAUDE_CODE_SESSION_ID: '5e5e5e5e-0000-4000-8000-000000000003' };
const MIN = 60_000;
const CHECKER_SENTENCE = "a checker's `finish` accepts a task handed in with `finish` or passes it to the next check, never its own work.";

// Run the CLI with --json in `s` (as `actor` when given); the exit code and the parsed envelope.
async function run(s: TestStore, actor: string, argv: string[], env: Record<string, string> = {}): Promise<{ code: number; doc: Record<string, any> }> {
  const r = await cli([...argv, ...(actor === '' ? [] : ['--as', actor]), '--json'], { cwd: s.root, env });
  return { code: r.code, doc: JSON.parse(r.stdout) };
}

// The edit hook's output in `s` for a session.
async function editHook(s: TestStore, env: Record<string, string>): Promise<string> {
  const r = await cli(['prime', '--edit-hook'], { cwd: s.root, env });
  expect(r.code).toBe(0);
  return r.stdout;
}

describe('LB-56.1: the edit hook under a default name does not count a closed earlier session\'s task', () => {
  // Only Date is faked: the clock moves on between the sessions, the store lock keeps real timers.
  let clock = Date.parse('2026-11-06T10:00:00.000Z');
  const later = (ms: number): void => {
    clock += ms;
    vi.setSystemTime(clock);
  };

  it('the repro: session A holds a task (in todo) and goes silent; session B is reminded from 15 min on, quiet before', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);
    const s = await newStore();
    expect((await run(s, '', ['create', 'abandoned', '--status', 'todo', '--assignee', `${BASE}:1a2b3c4d`], A)).code).toBe(0);
    later(EARLIER_SESSION_SILENT_MS - MIN);
    expect(await editHook(s, B)).toBe('');
    later(MIN);
    expect(await editHook(s, B)).toContain('laneboard: no task is in progress in store');
    // The holder's own session still holds it: no reminder there.
    expect(await editHook(s, A)).toBe('');
  });

  it('LB-66 stays: a task under a name of its own or another user\'s session keeps the hook quiet however long it is silent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);
    const s = await newStore();
    expect((await run(s, 'my-own-name', ['create', 'explicit', '--status', 'todo', '--assignee', 'my-own-name'], A)).code).toBe(0);
    later(EARLIER_SESSION_SILENT_MS * 4);
    expect(await editHook(s, B)).toBe('');
    const t = await newStore();
    expect((await run(t, '', ['create', 'colleague', '--status', 'todo', '--assignee', 'claude-code@Other-Person:5e5e5e5e'], OTHER)).code).toBe(0);
    later(EARLIER_SESSION_SILENT_MS * 4);
    expect(await editHook(t, B)).toBe('');
    // A named hook looks at that name only, as before.
    expect(await editHook(t, { ...B, LANEBOARD_AGENT: 'dev-9' })).toContain('no task is in progress for dev-9');
  });

  it('LB-66: --help says when the hook stays quiet, the 15 minutes and LANEBOARD_AGENT with its condition', async () => {
    const r = await cli(['prime', '--help'], { cwd: process.cwd() });
    const help = r.stdout.replace(/\s+/g, ' ');
    expect(help).not.toContain('reminder when you have no task in progress');
    expect(help).toContain('only while no task is held (assigned, not final), else nothing: under --as or LANEBOARD_AGENT, no task of that name;');
    expect(help).toContain(`under the session default name, no task of anybody on the board (an agent may write under its own --as), not counting tasks of your earlier sessions silent for ${EARLIER_SESSION_SILENT_MS / MIN} min;`);
    expect(help).toContain('LANEBOARD_AGENT (only if no subagent runs under you: they inherit it)');
  });
});

describe('LB-57.1: rule 7 names checkers only on a board with checks', () => {
  it('prime and its hook on a board without checks: rule 7 ends after its resume part; with checks, no board, JSON, MCP: the whole rule', async () => {
    expect(agentRules()).toContain(`restart). With checks, ${CHECKER_SENTENCE}`);
    const s = await newStore({ statuses: ['todo', 'doing', 'done'] });
    const text = (await cli(['prime', '--as', 'dev-1'], { cwd: s.root })).stdout;
    expect(text).toContain('7. ALREADY_CLAIMED: do not take over; run its `fix` (`--resume`: only your own task from before /clear or a restart).\n8. ');
    expect(text).not.toContain('checker');
    expect((await cli(['prime', '--hook'], { cwd: s.root, env: { LANEBOARD_AGENT: 'dev-1' } })).stdout.startsWith(`${boardRules(agentRules(), false)}\n`)).toBe(true);
    // The rules of prime --json are the same text on every board, as the MCP instructions.
    expect((await run(s, 'dev-1', ['prime'])).doc.data.rules).toBe(agentRules());
    expect(boardRules(agentRules(), false)).not.toContain('checker');
    // No board read: all the rules.
    expect((await cli(['prime'], { cwd: tempDir() })).stdout).toContain(CHECKER_SENTENCE);
    expect((await run(s, 'orch', ['config', '--review-statuses', 'doing'])).code).toBe(0);
    expect((await cli(['prime', '--as', 'dev-1'], { cwd: s.root })).stdout).toContain(CHECKER_SENTENCE);
    // The skill and the MCP instructions know no board: they keep the sentence.
    expect(mcpRules()).toContain(CHECKER_SENTENCE);
  });
});

describe('LB-57.3: in_progress leaves out the first status', () => {
  it('an own task in todo is listed but not in progress (prime --json and task_prime); after claim --status it is; prime offers no create', async () => {
    const s = await newStore({ statuses: ['todo', 'doing', 'done'] });
    expect((await run(s, 'dev-1', ['create', 'mine', '--status', 'todo', '--assignee', 'dev-1'])).code).toBe(0);
    const before = (await run(s, 'dev-1', ['prime'])).doc.data;
    expect(before).toMatchObject({ in_progress: 0, tasks: [{ id: 'LB-1', status: 'todo' }] });
    const mcp = await callTool('task_prime', { actor: 'dev-1' }, { cwd: s.root, env: {} });
    expect(mcp.structuredContent).toMatchObject({ in_progress: 0, tasks: [{ id: 'LB-1' }] });
    const text = (await cli(['prime', '--as', 'dev-1'], { cwd: s.root })).stdout;
    expect(text).toContain('Your active tasks (dev-1), newest update first:\n  LB-1  [todo]');
    expect(text).not.toContain('You have no task in progress');
    expect((await run(s, 'dev-1', ['claim', 'LB-1', '--status', 'doing'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['prime'])).doc.data.in_progress).toBe(1);
    // The edit hook counts every held task that is not final, in doing now as in todo before (LB-66): quiet.
    expect((await cli(['prime', '--edit-hook', '--as', 'dev-1'], { cwd: s.root })).stdout).toBe('');
  });
});

describe('LB-61.1, 61.2, 63.2: a creator on a board with create_by', () => {
  async function creatorsBoard(): Promise<TestStore> {
    const s = await newStore({ prefix: 'B61', statuses: ['todo', 'doing', 'done'] });
    expect((await run(s, 'orch', ['config', '--creators', 'orch'])).code).toBe(0);
    return s;
  }

  it('61.1: create --assignee dev-1 --as orch gives no "not to you" warning; without create_by the warning stays', async () => {
    const s = await creatorsBoard();
    expect((await run(s, 'orch', ['create', 'for dev', '--status', 'todo', '--assignee', 'dev-1'])).doc).toMatchObject({ ok: true, warnings: [] });
    const plain = await newStore();
    expect((await run(plain, 'orch', ['create', 'for dev', '--status', 'todo', '--assignee', 'dev-1'])).doc.warnings.join()).toContain('is assigned to dev-1, not to you (orch)');
  });

  it('61.2: prime of a creator with no task says tasks for others take their --assignee, not "Create one now"', async () => {
    const s = await creatorsBoard();
    const text = (await cli(['prime', '--as', 'orch'], { cwd: s.root })).stdout;
    expect(text).not.toContain('Create one now');
    expect(text).toContain(
      "You have no task of your own in progress. You create tasks here: for another agent's work create its task with --assignee <its name>; before a file change of your own, create yours:\n" +
        '  laneboard create "<short title of your work>" --status todo --assignee orch --as orch --json\n' +
        'Given a task id instead: laneboard claim <ID> --status doing --as orch --json',
    );
    // With a free task the numbered ways end the same way.
    expect((await run(s, 'orch', ['create', 'free', '--status', 'todo'])).code).toBe(0);
    expect((await cli(['prime', '--as', 'orch'], { cwd: s.root })).stdout).toContain(
      "3. Otherwise, before a file change of your own, create one (for another agent's work create its task with --assignee <its name>):\n  laneboard create",
    );
  });

  it('63.2: the create_by refusal fixes carry --json (rule 3)', async () => {
    const s = await creatorsBoard();
    expect((await run(s, 'dev-b', ['create', 'x', '--status', 'todo'])).doc.error.fix).toBe('report the task you need to whoever started you (orch create tasks here), then wait for its id: laneboard claim <ID> --as dev-b --json');
    expect((await run(s, 'orch', ['create', 'mine', '--status', 'todo', '--assignee', 'dev-b'])).code).toBe(0);
    expect((await run(s, 'dev-b', ['create', 'x', '--status', 'todo'])).doc.error.fix).toBe('laneboard comment B61-1 "<task you need, for orch to create>" --as dev-b --json');
  });
});

describe('LB-61.5: a checker of a second round sees the reason of the return before', () => {
  async function secondRound(): Promise<TestStore> {
    const s = await newStore({ prefix: 'API', statuses: ['todo', 'dev', 'code_review', 'done'] });
    expect((await run(s, 'orch', ['config', '--review-statuses', 'code_review', '--reviewers', 'rev'])).code).toBe(0);
    expect((await run(s, 'orch', ['create', 'Add endpoint', '--status', 'todo'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['claim', 'API-1', '--status', 'dev'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['finish', 'API-1', '--result', 'work', '--no-commit'])).code).toBe(0);
    return s;
  }

  it('first round: no return line; after a return with REASON-XYZ and a new hand-in: the line under the task, JSON last_return', async () => {
    const s = await secondRound();
    expect((await run(s, 'rev', ['prime'])).doc.data.roles.waiting[0]).toMatchObject({ id: 'API-1', last_return: null });
    expect((await cli(['prime', '--as', 'rev'], { cwd: s.root })).stdout).not.toContain('returned before');
    expect((await run(s, 'rev', ['comment', 'API-1', 'REASON-XYZ: totals not rounded'])).code).toBe(0);
    expect((await run(s, 'rev', ['update', 'API-1', '--status', 'dev'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['comment', 'API-1', 'second'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['finish', 'API-1', '--result', 'rounded', '--no-commit'])).code).toBe(0);
    const waiting = (await run(s, 'rev', ['prime'])).doc.data.roles.waiting[0];
    expect(waiting).toMatchObject({ id: 'API-1', last_return: { by: 'rev', comment: { actor: 'rev', text: 'REASON-XYZ: totals not rounded' } } });
    const text = (await cli(['prime', '--as', 'rev'], { cwd: s.root })).stdout;
    expect(text).toMatch(/\n {2}API-1 {2}\[code_review\].*\n {4}returned before by rev: > REASON-XYZ: totals not rounded\n {4}pass: laneboard finish API-1/);
  });

  it('a return with no reason says so', async () => {
    const s = await secondRound();
    expect((await run(s, 'rev', ['update', 'API-1', '--status', 'dev'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['finish', 'API-1', '--result', 'again', '--no-commit'])).code).toBe(0);
    expect((await run(s, 'rev', ['prime'])).doc.data.roles.waiting[0].last_return).toMatchObject({ by: 'rev', comment: null });
    expect((await cli(['prime', '--as', 'rev'], { cwd: s.root })).stdout).toMatch(/\n {4}returned before by rev at \S+ with no reason\n {4}pass: /);
  });
});
