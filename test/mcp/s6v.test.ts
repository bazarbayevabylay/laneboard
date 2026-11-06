// S6v (UX run 3, B-U1) over MCP: task_finish of a checker asking for a status before the current one gets the return for rework as
// its fix (task_comment why, then task_update into the work status), never a finish that passes the task on or accepts it.
import { afterAll, describe, expect, it } from 'vitest';
import { claimTask, configureStore, createTask, finishTask } from '../../src/core/index.ts';
import { callTool } from '../../src/mcp/tools.ts';
import { as, cleanupTemp, newStore, readStore } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

const FLOW = ['backlog', 'ready', 'dev', 'code_review', 'qa', 'done'];

// API-1 of dev-2 handed in to code_review and passed on to qa by rev.
async function inQa(): Promise<TestStore> {
  const s = await newStore({ prefix: 'API', statuses: FLOW });
  await configureStore(as(s, 'orch'), { review_statuses: ['code_review', 'qa'], reviewers: ['rev', 'orch'] });
  await createTask(as(s, 'orch'), { title: 'Add endpoint', status: 'ready' });
  await claimTask(as(s, 'dev-2'), { id: 'API-1', status: 'dev' });
  await finishTask(as(s, 'dev-2'), { id: 'API-1', result: 'work', no_commit: true });
  await finishTask(as(s, 'rev'), { id: 'API-1', status: 'qa', result: 'review ok' });
  return s;
}

// The stored task.
function stored(s: TestStore, id: string): Record<string, any> {
  return readStore(s.dir, 'active').tasks.find((t) => t.id === id) as Record<string, any>;
}

describe('S6v B-U1 over MCP', () => {
  it('task_finish status code_review in qa by rev: refused, fix is the return for rework; task_comment + task_update leave it in dev, not accepted', async () => {
    const s = await inQa();
    const env = { cwd: s.root, env: {} };
    const r = await callTool('task_finish', { id: 'API-1', status: 'code_review', result: 'back: missing test', actor: 'rev' }, env);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      code: 'INVALID_VALUE',
      fix: 'task_comment {"id":"API-1","actor":"rev","text":"back: missing test"}, then task_update {"id":"API-1","status":"dev","actor":"rev"}',
    });
    expect(stored(s, 'API-1').status).toBe('qa');
    expect((await callTool('task_comment', { id: 'API-1', text: 'back: missing test', actor: 'rev' }, env)).structuredContent).toMatchObject({ id: 'API-1', status: 'qa' });
    expect((await callTool('task_update', { id: 'API-1', status: 'dev', actor: 'rev' }, env)).structuredContent).toMatchObject({ status: 'dev', assignee: 'dev-2' });
    expect(stored(s, 'API-1').events.some((e: any) => e.type === 'status' && e.data.accepted === true)).toBe(false);
  });

  it('task_finish into the starting status: back to the start with the comment, never status done', async () => {
    const s = await inQa();
    const r = await callTool('task_finish', { id: 'API-1', status: 'backlog', result: 'not now', actor: 'orch' }, { cwd: s.root, env: {} });
    expect(r.structuredContent).toMatchObject({ code: 'INVALID_VALUE', fix: 'task_comment {"id":"API-1","actor":"orch","text":"not now"}, then task_update {"id":"API-1","status":"backlog","actor":"orch"}' });
    expect(stored(s, 'API-1').status).toBe('qa');
  });

  it('review r1: task_finish into a work status between the checks (fixing, after code_review) is the return for rework, never passed on to qa', async () => {
    const s = await newStore({ prefix: 'API', statuses: ['backlog', 'dev', 'code_review', 'fixing', 'qa', 'done'] });
    await configureStore(as(s, 'orch'), { review_statuses: ['code_review', 'qa'], reviewers: ['rev', 'orch'] });
    await createTask(as(s, 'orch'), { title: 'Add endpoint', status: 'backlog' });
    await claimTask(as(s, 'dev-2'), { id: 'API-1', status: 'dev' });
    await finishTask(as(s, 'dev-2'), { id: 'API-1', result: 'work', no_commit: true });
    const env = { cwd: s.root, env: {} };
    const r = await callTool('task_finish', { id: 'API-1', status: 'fixing', result: '- fix lint', actor: 'rev' }, env);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      code: 'INVALID_VALUE',
      fix: 'task_comment {"id":"API-1","actor":"rev","text":"- fix lint"}, then task_update {"id":"API-1","status":"fixing","actor":"rev"}',
    });
    expect(r.structuredContent).not.toHaveProperty('input');
    expect(stored(s, 'API-1').status).toBe('code_review');
  });
});
