// S6z over MCP (UX run 7, U1): task_prime roles.feedback of the author after a return for rework comes from reworkReturn only, the
// returner's comments since the last hand-in (null comment: returned with no reason), and task_update of a return with no reason warns
// the returner with the comment that adds it.
import { afterAll, describe, expect, it } from 'vitest';
import { claimTask, commentTask, configureStore, createTask, finishTask, updateTask } from '../../src/core/index.ts';
import { callTool } from '../../src/mcp/tools.ts';
import { as, cleanupTemp, newStore } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

// A board with checks code_review, qa (reviewers rev, orch): dev-1 handed API-1 in, rev returned it with R1, dev-1 handed it in again.
async function secondRound(): Promise<TestStore> {
  const s = await newStore({ prefix: 'API', statuses: ['todo', 'in_progress', 'code_review', 'qa', 'done'] });
  await configureStore(as(s, 'orch'), { review_statuses: ['code_review', 'qa'], reviewers: ['rev', 'orch'] });
  await createTask(as(s, 'orch'), { title: 'Totals', status: 'todo' });
  await claimTask(as(s, 'dev-1'), { id: 'API-1', status: 'in_progress' });
  await finishTask(as(s, 'dev-1'), { id: 'API-1', result: 'work', no_commit: true });
  await commentTask(as(s, 'rev'), { id: 'API-1', text: 'R1: negative totals not rounded' });
  await updateTask(as(s, 'rev'), { id: 'API-1', status: 'in_progress' });
  await finishTask(as(s, 'dev-1'), { id: 'API-1', status: 'code_review', result: 'rounded', no_commit: true });
  return s;
}

// The warnings of a tool reply (the envelope in its second text part).
function warnings(r: { content: Array<{ text: string }> }): string[] {
  return (JSON.parse(r.content[1]?.text ?? '{}') as { warnings: string[] }).warnings;
}

describe('S6z over MCP', () => {
  it('U1: orch returns the fixed task with no comment: a warning with the comment command; the author\'s feedback is "no reason", never R1', async () => {
    const s = await secondRound();
    const env = { cwd: s.root, env: {} };
    const r = await callTool('task_update', { id: 'API-1', status: 'in_progress', actor: 'orch' }, env);
    expect(r.isError).toBeUndefined();
    expect(warnings(r).filter((w) => w.includes('no reason'))).toEqual([
      "API-1 went back for rework with no reason from you: dev-1's prime says it was returned with no reason; add the reason (shown to dev-1 until the next hand-in): task_comment {\"id\":\"API-1\",\"actor\":\"orch\",\"text\":\"<why it goes back>\"}",
    ]);
    const prime = (await callTool('task_prime', { actor: 'dev-1' }, env)).structuredContent as Record<string, any>;
    expect(prime.roles.feedback).toEqual([{ id: 'API-1', comment: null, returned: { by: 'orch', at: expect.any(String) } }]);
    expect(JSON.stringify(prime.roles.feedback)).not.toContain('R1');
    // task_comment by the returner adds the reason.
    expect((await callTool('task_comment', { id: 'API-1', text: 'zero total is wrong', actor: 'orch' }, env)).isError).toBeUndefined();
    const after = (await callTool('task_prime', { actor: 'dev-1' }, env)).structuredContent as Record<string, any>;
    expect(after.roles.feedback).toEqual([{ id: 'API-1', comment: expect.objectContaining({ actor: 'orch', text: 'zero total is wrong' }), returned: { by: 'orch', at: expect.any(String) } }]);
  });

  it('U1 control: a return with its reason gives no warning and that reason is the feedback', async () => {
    const s = await secondRound();
    const env = { cwd: s.root, env: {} };
    await callTool('task_comment', { id: 'API-1', text: 'R2: zero total', actor: 'rev' }, env);
    const r = await callTool('task_update', { id: 'API-1', status: 'in_progress', actor: 'rev' }, env);
    expect(warnings(r).filter((w) => w.includes('no reason'))).toEqual([]);
    const prime = (await callTool('task_prime', { actor: 'dev-1' }, env)).structuredContent as Record<string, any>;
    expect(prime.roles.feedback).toEqual([{ id: 'API-1', comment: expect.objectContaining({ actor: 'rev', text: 'R2: zero total' }), returned: { by: 'rev', at: expect.any(String) } }]);
  });
});
