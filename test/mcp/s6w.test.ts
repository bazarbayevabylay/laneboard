// S6w over MCP (UX run 4, U1-U3): the same invariants as the CLI, through the tools. I1: task_update, task_claim, task_create never put a
// task into a check. I2: a checker's task_finish names the next status (task_prime roles.waiting[].next_status), so a stale read never
// passes the next check. I3: the fix of a checker refusal only reads the task (task_get, LB-60.1), run as printed it changes nothing.
import { afterAll, describe, expect, it } from 'vitest';
import { claimTask, configureStore, createTask, finishTask } from '../../src/core/index.ts';
import { callTool } from '../../src/mcp/tools.ts';
import { as, cleanupTemp, newStore, readStore } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';
import { runFix } from './tool-calls.ts';

afterAll(cleanupTemp);

interface Layout {
  name: string;
  statuses: string[];
  checks: string[];
  work: string;
}

const TWO: Layout = { name: 'two checks', statuses: ['backlog', 'ready', 'dev', 'code_review', 'qa', 'done'], checks: ['code_review', 'qa'], work: 'dev' };
const BETWEEN: Layout = { name: 'work status between checks', statuses: ['backlog', 'dev', 'code_review', 'fixing', 'qa', 'done'], checks: ['code_review', 'qa'], work: 'dev' };
const ONE: Layout = { name: 'one check', statuses: ['todo', 'in_progress', 'review', 'done'], checks: ['review'], work: 'in_progress' };

// A board of `l` (checks on unless `checks` is false; reviewers rev, orch) with API-1 of dev-1 in its work status; `handIn`: handed in.
async function board(l: Layout, handIn: boolean, checks = true): Promise<TestStore> {
  const s = await newStore({ prefix: 'API', statuses: l.statuses });
  if (checks) await configureStore(as(s, 'orch'), { review_statuses: l.checks, reviewers: ['rev', 'orch'] });
  await createTask(as(s, 'orch'), { title: 'Add endpoint', status: l.statuses[0] ?? '' });
  await claimTask(as(s, 'dev-1'), { id: 'API-1', status: l.work });
  if (handIn) await finishTask(as(s, 'dev-1'), { id: 'API-1', result: 'work', no_commit: true });
  return s;
}

// The stored task.
function stored(s: TestStore, id: string): Record<string, any> {
  return readStore(s.dir, 'active').tasks.find((t) => t.id === id) as Record<string, any>;
}

describe('S6w over MCP', () => {
  for (const l of [TWO, BETWEEN, ONE]) {
    it(`${l.name}: I1 task_update / task_claim of the holder and task_create into a check: INVALID_VALUE, the fix hands in with finish`, async () => {
      const s = await board(l, false);
      const env = { cwd: s.root, env: {} };
      const rev = stored(s, 'API-1').rev;
      for (const tool of ['task_update', 'task_claim']) {
        const r = await callTool(tool, { id: 'API-1', status: l.checks[0], actor: 'dev-1' }, env);
        expect(r.isError, tool).toBe(true);
        expect(r.structuredContent, tool).toMatchObject({ code: 'INVALID_VALUE', fix: `task_finish {"id":"API-1","status":"${l.checks[0]}","result":"<what you did, how you checked it>","actor":"dev-1"}` });
      }
      const created = await callTool('task_create', { title: 'In a check', status: l.checks[0], actor: 'orch' }, env);
      expect(created.structuredContent).toMatchObject({ code: 'INVALID_VALUE' });
      expect(String((created.structuredContent as Record<string, unknown>).message)).toContain(`on this board ${l.checks[0]} is a check`);
      expect(stored(s, 'API-1')).toMatchObject({ status: l.work, rev });
      expect(readStore(s.dir, 'active').tasks).toHaveLength(1);
    });

    it(`${l.name}: I2 + I3 task_finish of a checker without status or with the current check: fix get (run: no change); next_status passes`, async () => {
      const s = await board(l, true);
      const env = { cwd: s.root, env: {} };
      const rev = stored(s, 'API-1').rev;
      for (const args of [{ result: 'ok' }, { status: l.checks[0], result: 'qa failed: crash' }]) {
        const r = await callTool('task_finish', { id: 'API-1', ...args, actor: 'orch' }, env);
        expect(r.isError, JSON.stringify(args)).toBe(true);
        expect(r.structuredContent, JSON.stringify(args)).toMatchObject({ code: 'INVALID_VALUE', fix: 'task_get {"id":"API-1"}' });
        expect(r.structuredContent).not.toHaveProperty('input');
        expect(await runFix((r.structuredContent as Record<string, string>).fix ?? '', env)).toBe(0);
      }
      expect(stored(s, 'API-1')).toMatchObject({ status: l.checks[0], rev });
      const prime = await callTool('task_prime', { actor: 'orch' }, env);
      const waiting = (prime.structuredContent as Record<string, any>).roles.waiting as Array<{ id: string; next_status: string }>;
      expect(waiting).toEqual([expect.objectContaining({ id: 'API-1', next_status: l.checks[1] ?? 'done' })]);
      const pass = await callTool('task_finish', { id: 'API-1', status: waiting[0]?.next_status, result: 'ok', actor: 'orch' }, env);
      expect(pass.structuredContent).toMatchObject({ status: l.checks[1] ?? 'done' });
    });
  }

  it('two checks, U3 over MCP: rev and orch read the same prime, both name qa; the second is refused, qa is not skipped', async () => {
    const s = await board(TWO, true);
    const env = { cwd: s.root, env: {} };
    const seen = ((await callTool('task_prime', { actor: 'orch' }, env)).structuredContent as Record<string, any>).roles.waiting[0].next_status as string;
    expect(seen).toBe('qa');
    expect((await callTool('task_finish', { id: 'API-1', status: seen, result: 'review ok', actor: 'rev' }, env)).structuredContent).toMatchObject({ status: 'qa', passed: true });
    const stale = await callTool('task_finish', { id: 'API-1', status: seen, result: 'code review ok (orch)', actor: 'orch' }, env);
    expect(stale.structuredContent).toMatchObject({ code: 'INVALID_VALUE', fix: 'task_get {"id":"API-1"}' });
    expect(stored(s, 'API-1').status).toBe('qa');
  });

  it('two checks, I1: task_update of a waiting task by a checker into another check: fix get, nothing moves', async () => {
    const s = await board(TWO, true);
    const env = { cwd: s.root, env: {} };
    const r = await callTool('task_update', { id: 'API-1', status: 'qa', actor: 'rev' }, env);
    expect(r.structuredContent).toMatchObject({ code: 'INVALID_VALUE', fix: 'task_get {"id":"API-1"}' });
    expect(String((r.structuredContent as Record<string, unknown>).message)).toContain('laneboard finish API-1 --status qa --result "<result of your check>" --as rev');
    expect(stored(s, 'API-1').status).toBe('code_review');
  });

  it('a board without checks is unchanged: task_update into code_review, task_finish of another name without status accepts', async () => {
    const s = await board(TWO, false, false);
    const env = { cwd: s.root, env: {} };
    expect((await callTool('task_update', { id: 'API-1', status: 'code_review', actor: 'orch' }, env)).structuredContent).toMatchObject({ status: 'code_review' });
    await finishTask(as(s, 'dev-1'), { id: 'API-1', status: 'qa', result: 'r', no_commit: true });
    expect((await callTool('task_finish', { id: 'API-1', result: 'ok', actor: 'rev' }, env)).structuredContent).toMatchObject({ status: 'done', accepted: true });
  });
});

describe('S6w review r2 over MCP', () => {
  it('task_claim of a waiting task by a checker: fix get (run: no change); task_prime lists it as waiting, not as free', async () => {
    const s = await board(TWO, true);
    const env = { cwd: s.root, env: {} };
    await callTool('task_update', { id: 'API-1', assignee: null, actor: 'dev-1' }, env);
    const rev = stored(s, 'API-1').rev;
    for (const status of [undefined, 'dev']) {
      const r = await callTool('task_claim', { id: 'API-1', ...(status === undefined ? {} : { status }), actor: 'rev' }, env);
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({ code: 'INVALID_VALUE', fix: 'task_get {"id":"API-1"}' });
      expect(String((r.structuredContent as Record<string, unknown>).message)).toContain('laneboard finish API-1 --status qa --result "<result of your check>" --as rev');
      expect(await runFix((r.structuredContent as Record<string, string>).fix ?? '', env)).toBe(0);
    }
    expect(stored(s, 'API-1')).toMatchObject({ status: 'code_review', assignee: null, rev });
    const prime = (await callTool('task_prime', { actor: 'rev' }, env)).structuredContent as Record<string, any>;
    expect(prime).toMatchObject({ unassigned: [], unassigned_total: 0 });
    expect(prime.roles).toMatchObject({ waiting: [expect.objectContaining({ id: 'API-1', next_status: 'qa' })], no_checker: null });
  });

  it('the only checker passed code_review: task_prime of it lists the task in qa, next_status done, passed_by_you', async () => {
    const s = await newStore({ prefix: 'API', statuses: TWO.statuses });
    await configureStore(as(s, 'orch'), { review_statuses: ['code_review', 'qa'], reviewers: ['rev'] });
    await createTask(as(s, 'orch'), { title: 'Add endpoint', status: 'backlog' });
    await claimTask(as(s, 'dev-1'), { id: 'API-1', status: 'dev' });
    await finishTask(as(s, 'dev-1'), { id: 'API-1', result: 'work', no_commit: true });
    const env = { cwd: s.root, env: {} };
    expect((await callTool('task_finish', { id: 'API-1', status: 'qa', result: 'cr ok', actor: 'rev' }, env)).structuredContent).toMatchObject({ status: 'qa', passed: true });
    const prime = (await callTool('task_prime', { actor: 'rev' }, env)).structuredContent as Record<string, any>;
    expect(prime.roles.waiting).toEqual([expect.objectContaining({ id: 'API-1', next_status: 'done', passed_by_you: true })]);
    expect((await callTool('task_finish', { id: 'API-1', status: 'done', result: 'qa ok', actor: 'rev' }, env)).structuredContent).toMatchObject({ status: 'done', accepted: true });
  });

  it('no checker left (the only checker holds the task): task_prime roles.no_checker names the owner\'s command', async () => {
    const s = await newStore({ prefix: 'API', statuses: ONE.statuses });
    await configureStore(as(s, 'orch'), { review_statuses: ['review'], reviewers: ['rev'] });
    await createTask(as(s, 'orch'), { title: 'Add endpoint', status: 'todo' });
    await claimTask(as(s, 'dev-1'), { id: 'API-1', status: 'in_progress' });
    await finishTask(as(s, 'dev-1'), { id: 'API-1', result: 'work', no_commit: true });
    const env = { cwd: s.root, env: {} };
    await callTool('task_update', { id: 'API-1', assignee: 'rev', actor: 'orch' }, env);
    const prime = (await callTool('task_prime', { actor: 'orch' }, env)).structuredContent as Record<string, any>;
    expect(prime.roles.no_checker).toEqual({ ids: ['API-1'], fix: 'laneboard config --reviewers "rev,<another checker>"' });
  });
});

describe('S6w review r3 over MCP: another session of the author\'s default name is the author', () => {
  const BASE = 'claude-code@ann';
  const SESSION_A = { LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: 'aaaa1111-1a1a-4a1a-8a1a-000000000001' };
  const SESSION_B = { LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: 'bbbb2222-2b2b-4b2b-8b2b-000000000002' };

  for (const l of [TWO, BETWEEN, ONE]) {
    it(`${l.name}: session B's task_prime lists the task of session A neither to resume nor to check; task_claim resume, task_finish, task_update: handed in already`, async () => {
      const s = await newStore({ prefix: 'API', statuses: l.statuses });
      await configureStore(as(s, 'orch'), { review_statuses: l.checks });
      await createTask(as(s, 'orch'), { title: 'Add endpoint', status: l.statuses[0] ?? '' });
      const a = { cwd: s.root, env: SESSION_A };
      const b = { cwd: s.root, env: SESSION_B };
      expect((await callTool('task_claim', { id: 'API-1', status: l.work }, a)).structuredContent).toMatchObject({ assignee: `${BASE}:aaaa1111` });
      expect((await callTool('task_finish', { id: 'API-1', result: 'work', no_commit: true }, a)).structuredContent).toMatchObject({ status: l.checks[0] });
      const rev = stored(s, 'API-1').rev;
      const prime = (await callTool('task_prime', {}, b)).structuredContent as Record<string, any>;
      expect(prime.resumable).toEqual([]);
      expect(prime.roles.waiting).toEqual([]);
      const next = l.checks[1] ?? 'done';
      for (const [tool, args] of [
        ['task_claim', { id: 'API-1', resume: true }],
        ['task_finish', { id: 'API-1', status: next, result: 'ok' }],
        ['task_update', { id: 'API-1', status: 'done' }],
      ] as const) {
        const r = await callTool(tool, args, b);
        expect(r.isError, tool).toBe(true);
        const err = r.structuredContent as Record<string, string>;
        expect(err, tool).toMatchObject({ code: 'INVALID_VALUE', fix: `task_comment {"id":"API-1","text":"<note for the check>","actor":"${BASE}:bbbb2222"}` });
        expect(err.message, tool).toContain('is handed in already');
      }
      expect(stored(s, 'API-1')).toMatchObject({ status: l.checks[0], assignee: `${BASE}:aaaa1111`, rev });
      // Another name checks it as before.
      expect((await callTool('task_finish', { id: 'API-1', status: next, result: 'ok', actor: 'rev' }, b)).structuredContent).toMatchObject({ status: next });
    });
  }
});
