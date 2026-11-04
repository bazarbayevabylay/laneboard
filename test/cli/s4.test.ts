// S4 (dogfooding 0.2.0): LB-9 finish by somebody else accepts a task from review into the final status; LB-10 view and prime count
// only tasks not in the final status as active, the final column of view lists the newest few and points to list --status <final>.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claimTask, createTask, finishTask, reviewStatuses, updateTask, VIEW_FINAL_MAX, viewBoard } from '../../src/core/index.ts';
import { renderBoard } from '../../src/cli/board-view.ts';
import { callTool } from '../../src/mcp/tools.ts';
import { as, cleanupTemp, cli, newStore, readStore, rejectsWith, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

// A real git repository in `dir` with one empty commit (isolated from the user's git config); returns HEAD.
function gitRepo(dir: string): string {
  const home = tempDir();
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, env, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  return git('rev-parse', 'HEAD');
}

// The task as stored (events with their data).
function stored(s: TestStore, id: string): { rev: number; status: string; assignee: string | null; links: unknown[]; events: Array<{ type: string; actor: string; data: Record<string, unknown> }> } {
  const task = readStore(s.dir, 'active').tasks.find((t) => t.id === id);
  if (!task) throw new Error(`${id} not in active.json`);
  return task as never;
}

// LB-1 held by dev-1 and handed in to review with finish (dev-1's result comment), as our process does.
async function inReview(): Promise<TestStore> {
  const s = await newStore();
  await createTask(as(s, 'a'), { title: 'Fix login', status: 'todo', assignee: 'dev-1' });
  await claimTask(as(s, 'dev-1'), { id: 'LB-1', status: 'in_progress' });
  await finishTask(as(s, 'dev-1'), { id: 'LB-1', result: 'fixed, tests green', status: 'review', no_commit: true });
  return s;
}

// The refusal text of a finish by somebody else that is not an acceptance.
const REFUSED = (id: string, holder: string, status: string) =>
  `task ${id} is claimed by ${holder} and is ${status}; somebody else's finish only accepts a task from review into done; do not take it over: comment or ask the orchestrator`;

describe('LB-9: finish by somebody else accepts a task from review', () => {
  it('review statuses: after the first two, before the final one', () => {
    expect(reviewStatuses(['todo', 'in_progress', 'review', 'done'])).toEqual(['review']);
    expect(reviewStatuses(['todo', 'in_progress', 'review', 'blocked', 'done'])).toEqual(['review', 'blocked']);
    expect(reviewStatuses(['backlog', 'doing', 'shipped'])).toEqual([]);
    expect(reviewStatuses(['open', 'closed'])).toEqual([]);
  });

  it('from review into done: one write (result, commit, status), the assignee stays, the status event says accepted and who', async () => {
    const s = await inReview();
    const head = gitRepo(s.root);
    const before = stored(s, 'LB-1').rev;
    const r = await cli(['finish', 'LB-1', '--result', 'accepted: reviewed the diff', '--as', 'orch', '--json'], { cwd: s.root });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.data).toEqual({ id: 'LB-1', rev: before + 1, status: 'done', assignee: 'dev-1', commit: head, accepted: true });
    expect(doc.warnings).toEqual([]);
    const t = stored(s, 'LB-1');
    expect(t).toMatchObject({ status: 'done', assignee: 'dev-1', links: [{ kind: 'commit', ref: head }] });
    expect(t.events.slice(-3).map((e) => [e.actor, e.type, e.data.text ?? e.data.to])).toEqual([
      ['orch', 'commented', 'accepted: reviewed the diff'],
      ['orch', 'updated', undefined],
      ['orch', 'status', 'done'],
    ]);
    expect(t.events.at(-1)?.data).toEqual({ from: 'review', to: 'done', accepted: true });
  });

  it('human output: "accepted" in the reply line and in get; the owner\'s own finish stays "finished" without accepted', async () => {
    const s = await inReview();
    const r = await cli(['finish', 'LB-1', '--result', 'ok', '--no-commit', '--as', 'orch'], { cwd: s.root });
    expect(r.stdout).toBe(`LB-1 accepted (rev ${stored(s, 'LB-1').rev}, done, dev-1); no commit linked\n`);
    const get = (await cli(['get', 'LB-1'], { cwd: s.root })).stdout;
    expect(get).toMatch(/ orch {2}status {2}accepted from=review to=done\n/);
    await createTask(as(s, 'a'), { title: 'Own', status: 'review', assignee: 'dev-1' });
    const own = await cli(['finish', 'LB-2', '--result', 'ok', '--no-commit', '--as', 'dev-1', '--json'], { cwd: s.root });
    expect(JSON.parse(own.stdout).data).toEqual({ id: 'LB-2', rev: 2, status: 'done', assignee: 'dev-1', commit: null });
    expect(stored(s, 'LB-2').events.at(-1)?.data).toEqual({ from: 'review', to: 'done' });
  });

  it('from todo or in_progress: ALREADY_CLAIMED (exit 4) that names acceptance from review, the comment fix, nothing written', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Todo', status: 'todo', assignee: 'dev-1' });
    await createTask(as(s, 'a'), { title: 'Working', status: 'in_progress', assignee: 'dev-1' });
    const before = fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8');
    for (const [id, status] of [['LB-1', 'todo'], ['LB-2', 'in_progress']] as const) {
      const r = await cli(['finish', id, '--result', 'x', '--as', 'orch', '--json'], { cwd: s.root });
      expect(r.code).toBe(4);
      expect(JSON.parse(r.stdout).error).toMatchObject({ code: 'ALREADY_CLAIMED', message: REFUSED(id, 'dev-1', status), details: { assignee: 'dev-1' }, fix: `laneboard comment ${id} "<note for dev-1>" --as orch` });
    }
    expect(fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8')).toBe(before);
  });

  it('from review into a status that is not final (somebody else\'s --status review / in_progress): refused too', async () => {
    const s = await inReview();
    const rev = stored(s, 'LB-1').rev;
    for (const status of ['review', 'in_progress']) {
      const err = await rejectsWith(finishTask(as(s, 'orch'), { id: 'LB-1', result: 'x', status, no_commit: true }), 'ALREADY_CLAIMED');
      expect(err.message).toBe(REFUSED('LB-1', 'dev-1', 'review'));
    }
    expect(stored(s, 'LB-1').rev).toBe(rev);
  });

  it('a board without a review status has no acceptance: the message says so', async () => {
    const s = await newStore({ statuses: ['backlog', 'doing', 'shipped'] });
    await createTask(as(s, 'a'), { title: 'T', status: 'doing', assignee: 'dev-1' });
    const err = await rejectsWith(finishTask(as(s, 'orch'), { id: 'LB-1', result: 'x', no_commit: true }), 'ALREADY_CLAIMED');
    expect(err.message).toBe("task LB-1 is claimed by dev-1 and is doing; somebody else's finish only accepts a task from review (this board has no such status) into shipped; do not take it over: comment or ask the orchestrator");
  });

  it('MCP task_finish: acceptance from review (accepted: true), refusal from in_progress', async () => {
    const s = await inReview();
    await createTask(as(s, 'a'), { title: 'Working', status: 'in_progress', assignee: 'dev-1' });
    const env = { cwd: s.root, env: {} };
    const ok = await callTool('task_finish', { id: 'LB-1', result: 'accepted', no_commit: true, actor: 'orch' }, env);
    expect(ok.structuredContent).toMatchObject({ id: 'LB-1', status: 'done', assignee: 'dev-1', commit: null, accepted: true });
    expect(stored(s, 'LB-1').events.at(-1)).toMatchObject({ actor: 'orch', type: 'status', data: { from: 'review', to: 'done', accepted: true } });
    const no = await callTool('task_finish', { id: 'LB-2', result: 'x', no_commit: true, actor: 'orch' }, env);
    expect(no.isError).toBe(true);
    expect(no.structuredContent).toMatchObject({ code: 'ALREADY_CLAIMED', message: REFUSED('LB-2', 'dev-1', 'in_progress'), fix: 'laneboard comment LB-2 "<note for dev-1>" --as orch' });
  });

  it('claim keeps its ALREADY_CLAIMED text (only finish accepts)', async () => {
    const s = await inReview();
    const err = await rejectsWith(claimTask(as(s, 'orch'), { id: 'LB-1' }), 'ALREADY_CLAIMED');
    expect(err.message).toBe("task LB-1 is already claimed by dev-1; do not take it over: reassignment is the orchestrator's decision");
  });
});

// A board with one task per open status and `done` finished tasks (LB-4.. in creation order).
async function boardWithDone(done: number): Promise<TestStore> {
  const s = await newStore();
  await createTask(as(s, 'a'), { title: 'Open', status: 'todo', assignee: 'dev-1' });
  await createTask(as(s, 'a'), { title: 'Working', status: 'in_progress', assignee: 'dev-1' });
  await createTask(as(s, 'a'), { title: 'Handed in', status: 'review', assignee: 'dev-2' });
  for (let i = 0; i < done; i++) await createTask(as(s, 'a'), { title: `Shipped ${i + 1}`, status: 'done', assignee: 'dev-1' });
  return s;
}

describe('LB-10: finished tasks are not active; the final column shows the newest few', () => {
  it('prime: active counts without done, done after them; the agent\'s list leaves out its finished tasks', async () => {
    const s = await boardWithDone(4);
    const r = await cli(['prime', '--as', 'dev-1'], { cwd: s.root });
    expect(r.stdout).toContain('\nStatuses in order (final: done), active tasks: todo 1, in_progress 1, review 1; done 4\n');
    expect(r.stdout).toContain('Your active tasks (dev-1), newest update first:\n  LB-2  [in_progress]  rev 1  Working\n  LB-1  [todo]  rev 1  Open\n');
    expect(r.stdout).not.toContain('[done]');
    const json = JSON.parse((await cli(['prime', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout).data;
    expect(json.tasks.map((t: { id: string }) => t.id)).toEqual(['LB-2', 'LB-1']);
    expect(json.statuses).toEqual([{ status: 'todo', count: 1 }, { status: 'in_progress', count: 1 }, { status: 'review', count: 1 }, { status: 'done', count: 4 }]);
  });

  it('view data: total and shown count non-final tasks, final_* the done ones; the done column keeps the newest VIEW_FINAL_MAX', async () => {
    const s = await boardWithDone(VIEW_FINAL_MAX + 2);
    // LB-4 is updated last, so it is the newest done task.
    await updateTask(as(s, 'a'), { id: 'LB-4', title: 'Shipped 1 (renamed)' });
    const d = (await viewBoard(as(s, 'a'), {})).data;
    expect(d).toMatchObject({ shown: 3, total: 3, final_status: 'done', final_shown: 7, final_total: 7 });
    const done = d.columns.find((c) => c.status === 'done');
    expect(done?.cards.map((c) => c.id)).toEqual(['LB-4', 'LB-10', 'LB-9', 'LB-8', 'LB-7']);
    expect(done?.more).toBe(2);
    expect(d.columns.filter((c) => c.status !== 'done').map((c) => c.more)).toEqual([0, 0, 0]);
    const filtered = (await viewBoard(as(s, 'a'), { assignee: 'dev-1' })).data;
    expect(filtered).toMatchObject({ shown: 2, total: 3, final_shown: 7, final_total: 7 });
  });

  it('view text: column title counts all, "+K more: laneboard list --status done" under the cards (columns and narrow list), footer counts', async () => {
    const s = await boardWithDone(VIEW_FINAL_MAX + 2);
    const wide = await cli(['view'], { cwd: s.root, env: { COLUMNS: '170' } });
    expect(wide.code).toBe(0);
    expect(wide.stdout).toContain('done (7)');
    expect(wide.stdout).toMatch(/ {2}\+2 more: laneboard list --status done\n/);
    expect(wide.stdout.trimEnd().endsWith('3 active tasks, 7 done')).toBe(true);
    // A column narrower than the hint: it is wrapped at spaces, never cut.
    const d = (await viewBoard(as(s, 'a'), {})).data;
    const text = renderBoard(d, { width: 100, color: false, now: new Date(), store: '/s', filters: [] });
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l.endsWith('+2 more: laneboard list'));
    expect(at, text).toBeGreaterThan(0);
    expect(lines[at + 1]?.trimEnd().endsWith('--status done')).toBe(true);
    expect(text).not.toContain('…--status');
    const narrow = await cli(['view'], { cwd: s.root, env: { COLUMNS: '40' } });
    expect(narrow.stdout).toContain('\n  +2 more: laneboard list --status done\n');
    const filtered = await cli(['view', '--assignee', 'dev-2'], { cwd: s.root, env: { COLUMNS: '140' } });
    expect(filtered.stdout.trimEnd().endsWith('1 of 3 active tasks shown, 0 of 7 done (assignee=dev-2)')).toBe(true);
  });

  it('the done column is ordered by time only: a high priority does not keep an old done task among the newest', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Old but urgent', status: 'done', fields: { priority: 0 } });
    for (let i = 0; i < VIEW_FINAL_MAX; i++) await createTask(as(s, 'a'), { title: `Newer ${i + 1}`, status: 'done' });
    const done = (await viewBoard(as(s, 'a'), {})).data.columns.find((c) => c.status === 'done');
    expect(done?.cards.map((c) => c.id)).toEqual(['LB-6', 'LB-5', 'LB-4', 'LB-3', 'LB-2']);
    expect(done?.more).toBe(1);
  });

  it('at most VIEW_FINAL_MAX done tasks: no "more" line', async () => {
    const s = await boardWithDone(VIEW_FINAL_MAX);
    const r = await cli(['view'], { cwd: s.root, env: { COLUMNS: '140' } });
    expect(r.stdout).toContain(`done (${VIEW_FINAL_MAX})`);
    expect(r.stdout).not.toContain('more: laneboard list');
  });
});
