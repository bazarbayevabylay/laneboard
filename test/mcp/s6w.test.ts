// S6w over MCP (UX run 4, U1-U3): the same invariants as the CLI, through the tools. I1: task_update, task_claim, task_create never put a
// task into a check. I2: a checker's task_finish names the next status (task_prime roles.waiting[].next_status), so a stale read never
// passes the next check. I3: the fix of a checker refusal only reads the task (laneboard get), run as printed it changes nothing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claimTask, configureStore, createTask, finishTask } from '../../src/core/index.ts';
import { callTool } from '../../src/mcp/tools.ts';
import { as, cleanupTemp, CLI_SOURCE, newStore, readStore, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

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

describe('S6w over MCP', () => {
  for (const l of [TWO, BETWEEN, ONE]) {
    it(`${l.name}: I1 task_update / task_claim of the holder and task_create into a check: INVALID_VALUE, the fix hands in with finish`, async () => {
      const s = await board(l, false);
      const env = { cwd: s.root, env: {} };
      const rev = stored(s, 'API-1').rev;
      for (const tool of ['task_update', 'task_claim']) {
        const r = await callTool(tool, { id: 'API-1', status: l.checks[0], actor: 'dev-1' }, env);
        expect(r.isError, tool).toBe(true);
        expect(r.structuredContent, tool).toMatchObject({ code: 'INVALID_VALUE', fix: `laneboard finish API-1 --status ${l.checks[0]} --result "<what you did, how you checked it>" --as dev-1` });
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
        expect(r.structuredContent, JSON.stringify(args)).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard get API-1' });
        expect(r.structuredContent).not.toHaveProperty('input');
        expect(sh(s, (r.structuredContent as Record<string, string>).fix ?? '')).toBe(0);
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
    expect(stale.structuredContent).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard get API-1' });
    expect(stored(s, 'API-1').status).toBe('qa');
  });

  it('two checks, I1: task_update of a waiting task by a checker into another check: fix get, nothing moves', async () => {
    const s = await board(TWO, true);
    const env = { cwd: s.root, env: {} };
    const r = await callTool('task_update', { id: 'API-1', status: 'qa', actor: 'rev' }, env);
    expect(r.structuredContent).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard get API-1' });
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
      expect(r.structuredContent).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard get API-1' });
      expect(String((r.structuredContent as Record<string, unknown>).message)).toContain('laneboard finish API-1 --status qa --result "<result of your check>" --as rev');
      expect(sh(s, `${(r.structuredContent as Record<string, string>).fix ?? ''} --as rev`)).toBe(0);
    }
    expect(stored(s, 'API-1')).toMatchObject({ status: 'code_review', assignee: null, rev });
    const prime = (await callTool('task_prime', { actor: 'rev' }, env)).structuredContent as Record<string, any>;
    expect(prime).toMatchObject({ unassigned: [], unassigned_total: 0 });
    expect(prime.roles).toMatchObject({ waiting: [expect.objectContaining({ id: 'API-1', next_status: 'qa' })], no_checker: null });
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
