// S7a over MCP (UX run 8, U6): task_update of a checker returning a handed-in task for rework (task_comment why, then task_update into
// the work status) is confirmed in the reply (`returned`: the holder and the reason), with no A17 warning naming the author's hand-in.
import { afterAll, describe, expect, it } from 'vitest';
import { claimTask, configureStore, createTask, finishTask } from '../../src/core/index.ts';
import { callTool } from '../../src/mcp/tools.ts';
import { as, cleanupTemp, newStore } from '../helpers.ts';

afterAll(cleanupTemp);

// The data (first text part) and the warnings (the envelope in the second text part) of a tool reply.
function envelope(r: { content: Array<{ text: string }> }): { data: Record<string, unknown>; warnings: string[] } {
  const data = JSON.parse(r.content[0]?.text ?? '{}') as Record<string, unknown>;
  return { data, warnings: (JSON.parse(r.content[1]?.text ?? '{}') as { warnings: string[] }).warnings };
}

describe('S7a U6 over MCP', () => {
  it('task_comment then task_update by rev: reply returned {to, reason}, no warning; with no reason only the S6z warning', async () => {
    const s = await newStore({ prefix: 'API', statuses: ['todo', 'in_progress', 'code_review', 'qa', 'done'] });
    await configureStore(as(s, 'orch'), { review_statuses: ['code_review', 'qa'], reviewers: ['rev', 'orch'] });
    await createTask(as(s, 'orch'), { title: 'Totals', status: 'todo' });
    await claimTask(as(s, 'dev-1'), { id: 'API-1', status: 'in_progress' });
    await finishTask(as(s, 'dev-1'), { id: 'API-1', result: 'work', no_commit: true });
    const env = { cwd: s.root, env: {} };
    expect((await callTool('task_comment', { id: 'API-1', text: 'negative totals not rounded', actor: 'rev' }, env)).isError).toBeUndefined();
    const back = envelope(await callTool('task_update', { id: 'API-1', status: 'in_progress', actor: 'rev' }, env));
    expect(back.warnings).toEqual([]);
    expect(back.data).toMatchObject({ status: 'in_progress', assignee: 'dev-1', returned: { to: 'dev-1', reason: 'negative totals not rounded' } });
    await finishTask(as(s, 'dev-1'), { id: 'API-1', result: 'rounded', no_commit: true });
    const bare = envelope(await callTool('task_update', { id: 'API-1', status: 'in_progress', actor: 'orch' }, env));
    expect(bare.data.returned).toEqual({ to: 'dev-1', reason: null });
    expect(bare.warnings).toHaveLength(1);
    expect(bare.warnings[0]).toContain('went back for rework with no reason from you');
  });
});
