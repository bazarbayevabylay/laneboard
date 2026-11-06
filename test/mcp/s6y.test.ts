// S6y over MCP (UX run 6, U1, U2): the same rules as the CLI, through the tools. U1: task_finish of the holder into a status that is no
// check is refused, its fix (comment, then update) puts the task there not handed in. U2: a checker's stale task_finish of a task
// returned for rework gets the fix that reads it, and task_prime's feedback of the author keeps the reason of the return.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claimTask, commentTask, configureStore, createTask, finishTask, updateTask } from '../../src/core/index.ts';
import { callTool } from '../../src/mcp/tools.ts';
import { as, cleanupTemp, CLI_SOURCE, newStore, readStore, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

const STATUSES = ['todo', 'blocked', 'in_progress', 'code_review', 'qa', 'done'];

// A board with checks code_review, qa (reviewers rev, orch) and API-1 of dev-1 in in_progress; `handIn`: handed in to code_review.
async function board(handIn: boolean): Promise<TestStore> {
  const s = await newStore({ prefix: 'API', statuses: STATUSES });
  await configureStore(as(s, 'orch'), { review_statuses: ['code_review', 'qa'], reviewers: ['rev', 'orch'] });
  await createTask(as(s, 'orch'), { title: 'Add form', status: 'todo' });
  await claimTask(as(s, 'dev-1'), { id: 'API-1', status: 'in_progress' });
  if (handIn) await finishTask(as(s, 'dev-1'), { id: 'API-1', result: 'work', no_commit: true });
  return s;
}

// The stored task.
function stored(s: TestStore, id: string): Record<string, any> {
  return readStore(s.dir, 'active').tasks.find((t) => t.id === id) as Record<string, any>;
}

// Run a fix as printed in a shell (rule 13), with `laneboard` on PATH running this source, in the store's folder; its exit code.
function sh(s: TestStore, line: string): number {
  const bin = tempDir();
  fs.writeFileSync(path.join(bin, 'laneboard'), `#!/bin/sh\nexec "${process.execPath}" "${CLI_SOURCE}" "$@"\n`, { mode: 0o755 });
  try {
    execFileSync('sh', ['-c', line], { cwd: s.root, env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: tempDir() }, stdio: 'pipe' });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

describe('S6y over MCP', () => {
  it('U1: task_finish of the holder into blocked is refused, nothing written; the fix puts it into blocked not handed in; task_prime of rev lists nothing', async () => {
    const s = await board(false);
    const env = { cwd: s.root, env: {} };
    const rev = stored(s, 'API-1').rev;
    const r = await callTool('task_finish', { id: 'API-1', status: 'blocked', result: 'Form done, ready for review', no_commit: true, actor: 'dev-1' }, env);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      code: 'INVALID_VALUE',
      fix: "laneboard comment API-1 --as dev-1 -- 'Form done, ready for review' && laneboard update API-1 --status blocked --as dev-1",
    });
    expect(String((r.structuredContent as Record<string, unknown>).message)).toContain('laneboard finish API-1 --status code_review --result');
    expect(stored(s, 'API-1')).toMatchObject({ status: 'in_progress', rev });
    expect(sh(s, (r.structuredContent as Record<string, string>).fix ?? '')).toBe(0);
    expect(stored(s, 'API-1')).toMatchObject({ status: 'blocked', assignee: 'dev-1' });
    const prime = (await callTool('task_prime', { actor: 'rev' }, env)).structuredContent as Record<string, any>;
    expect(prime.roles.waiting).toEqual([]);
    const handIn = await callTool('task_finish', { id: 'API-1', status: 'code_review', result: 'Form done', no_commit: true, actor: 'dev-1' }, env);
    expect(handIn.structuredContent).toMatchObject({ status: 'code_review' });
    const after = (await callTool('task_prime', { actor: 'rev' }, env)).structuredContent as Record<string, any>;
    expect(after.roles.waiting).toEqual([expect.objectContaining({ id: 'API-1', next_status: 'qa' })]);
  });

  it('U2: rev returns the task; orch\'s stale task_finish --status qa: ALREADY_CLAIMED, fix get (run: no change); the author\'s feedback is rev\'s reason', async () => {
    const s = await board(true);
    const env = { cwd: s.root, env: {} };
    await commentTask(as(s, 'rev'), { id: 'API-1', text: 'Empty state text missing i18n' });
    await updateTask(as(s, 'rev'), { id: 'API-1', status: 'in_progress' });
    const rev = stored(s, 'API-1').rev;
    const r = await callTool('task_finish', { id: 'API-1', status: 'qa', result: 'CR ok', actor: 'orch' }, env);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ code: 'ALREADY_CLAIMED', fix: 'laneboard get API-1' });
    expect(String((r.structuredContent as Record<string, unknown>).message)).toMatch(/^API-1 was returned for rework by rev at \S+ \(code_review -> in_progress\), reason: "Empty state text missing i18n";/);
    expect(sh(s, (r.structuredContent as Record<string, string>).fix ?? '')).toBe(0);
    expect(stored(s, 'API-1')).toMatchObject({ status: 'in_progress', rev });
    const update = await callTool('task_update', { id: 'API-1', status: 'qa', actor: 'orch' }, env);
    expect(update.structuredContent).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard get API-1' });
    const prime = (await callTool('task_prime', { actor: 'dev-1' }, env)).structuredContent as Record<string, any>;
    expect(prime.roles.feedback).toEqual([{ id: 'API-1', comment: expect.objectContaining({ actor: 'rev', text: 'Empty state text missing i18n' }) }]);
  });

  it('r1: rev returns the task, the author moves it to blocked; orch\'s stale task_finish --status qa still gets the read and rev\'s reason', async () => {
    const s = await board(true);
    const env = { cwd: s.root, env: {} };
    await commentTask(as(s, 'rev'), { id: 'API-1', text: 'Empty state text missing i18n' });
    await updateTask(as(s, 'rev'), { id: 'API-1', status: 'in_progress' });
    await updateTask(as(s, 'dev-1'), { id: 'API-1', status: 'blocked' });
    const rev = stored(s, 'API-1').rev;
    const r = await callTool('task_finish', { id: 'API-1', status: 'qa', result: 'CR ok', actor: 'orch' }, env);
    expect(r.structuredContent).toMatchObject({ code: 'ALREADY_CLAIMED', fix: 'laneboard get API-1' });
    expect(String((r.structuredContent as Record<string, unknown>).message)).toMatch(/^API-1 was returned for rework by rev at \S+ \(code_review -> in_progress\), reason: "Empty state text missing i18n"; it is blocked with dev-1/);
    expect(stored(s, 'API-1')).toMatchObject({ status: 'blocked', rev });
    const prime = (await callTool('task_prime', { actor: 'dev-1' }, env)).structuredContent as Record<string, any>;
    expect(prime.roles.feedback).toEqual([{ id: 'API-1', comment: expect.objectContaining({ actor: 'rev', text: 'Empty state text missing i18n' }) }]);
  });
});
