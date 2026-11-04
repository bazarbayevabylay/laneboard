// S4 (dogfooding 0.2.0): LB-9 finish by somebody else accepts a task its assignee handed in with finish (S4b: by the data) into the
// final status; LB-10 view and prime count only tasks not in the final status as active, the final column of view lists the newest
// few and points to list --status <final>.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claimTask, createTask, finishTask, updateTask, VIEW_FINAL_MAX, viewBoard } from '../../src/core/index.ts';
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

// The refusal of somebody else's finish of a task its assignee did not hand in with finish (S4b, by the data), and its fix.
const NOT_HANDED_IN = (id: string, holder: string, status: string, actor = 'orch') =>
  `task ${id} is claimed by ${holder} and is ${status}, not handed in with finish; somebody else's finish only accepts a task its assignee handed in (laneboard finish ${id} --status <status>); do not take it over: ask ${holder} to hand it in, or close it as the orchestrator: laneboard update ${id} --status done --as ${actor}`;
// Rewritten in LB-11: the hand-in statuses are the non-final finish statuses (a, not the current one), and a second way out closes it (d).
const OPEN = '<one of: in_progress, review>';
const HAND_IN_FIX = (id: string, handIn = OPEN, actor = 'orch') =>
  `laneboard comment ${id} "hand it in: laneboard finish ${id} --status ${handIn} --result <result>" --as ${actor}, or as the orchestrator: laneboard update ${id} --status done --as ${actor}`;
// The refusal of somebody else's finish into a status that is not final.
const NOT_FINAL = (id: string, holder: string, status: string) =>
  `task ${id} is claimed by ${holder} and is ${status}; somebody else's finish only accepts a task its assignee handed in, into done; do not take it over: comment or ask the orchestrator`;

// active.json as text: a refused finish must not change a byte.
const activeText = (s: TestStore): string => fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8');

describe('LB-9: finish by somebody else accepts a task its assignee handed in with finish', () => {
  // Rewritten in S4b (review S4 MAJOR): the positional review statuses are gone; the repro configs of the review are refused.
  it('review repro: blocked set by update (todo,in_progress,review,blocked,done) and in_progress after a backlog status: refused, nothing written', async () => {
    const a = await newStore({ statuses: ['todo', 'in_progress', 'review', 'blocked', 'done'] });
    await createTask(as(a, 'a'), { title: 'T', status: 'todo', assignee: 'dev-1' });
    await claimTask(as(a, 'dev-1'), { id: 'LB-1', status: 'in_progress' });
    await updateTask(as(a, 'dev-1'), { id: 'LB-1', status: 'blocked' });
    const b = await newStore({ statuses: ['backlog', 'todo', 'in_progress', 'review', 'done'] });
    await createTask(as(b, 'a'), { title: 'T', status: 'backlog', assignee: 'dev-1' });
    await claimTask(as(b, 'dev-1'), { id: 'LB-1', status: 'in_progress' });
    for (const [s, status, handIn] of [[a, 'blocked', '<one of: in_progress, review, blocked>'], [b, 'in_progress', '<one of: todo, in_progress, review>']] as const) {
      const before = activeText(s);
      const r = await cli(['finish', 'LB-1', '--result', 'x', '--as', 'orch', '--json'], { cwd: s.root });
      expect(r.code, status).toBe(4);
      expect(JSON.parse(r.stdout).error).toEqual({ code: 'ALREADY_CLAIMED', message: NOT_HANDED_IN('LB-1', 'dev-1', status), details: { assignee: 'dev-1' }, fix: HAND_IN_FIX('LB-1', handIn) });
      expect(activeText(s)).toBe(before);
    }
  });

  it('handed in with finish: the status event says handed_in (get: "handed in"); then accepted on any config, blocked too', async () => {
    const s = await newStore({ statuses: ['todo', 'in_progress', 'review', 'blocked', 'done'] });
    await createTask(as(s, 'a'), { title: 'T', status: 'todo', assignee: 'dev-1' });
    await claimTask(as(s, 'dev-1'), { id: 'LB-1', status: 'in_progress' });
    await finishTask(as(s, 'dev-1'), { id: 'LB-1', result: 'stuck on the API key', status: 'blocked', no_commit: true });
    expect(stored(s, 'LB-1').events.at(-1)).toMatchObject({ actor: 'dev-1', type: 'status', data: { from: 'in_progress', to: 'blocked', handed_in: true } });
    expect((await cli(['get', 'LB-1'], { cwd: s.root })).stdout).toMatch(/ dev-1 {2}status {2}handed in from=in_progress to=blocked\n/);
    const r = await finishTask(as(s, 'orch'), { id: 'LB-1', result: 'accepted as is', no_commit: true });
    expect(r.reply).toEqual({ commit: null, accepted: true });
    expect(stored(s, 'LB-1').events.at(-1)?.data).toEqual({ from: 'blocked', to: 'done', accepted: true });
  });

  it('from review into done: one write (result, status), no commit link even in a git checkout, the assignee stays, accepted and who', async () => {
    const s = await inReview();
    gitRepo(s.root);
    // Uncommitted work in the acceptor's folder (staged: a tracked change) says nothing about the assignee's work: no warning.
    fs.writeFileSync(path.join(s.root, 'dirty.txt'), 'x');
    execFileSync('git', ['add', 'dirty.txt'], { cwd: s.root, env: { ...process.env, HOME: tempDir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    const before = stored(s, 'LB-1').rev;
    const r = await cli(['finish', 'LB-1', '--result', 'accepted: reviewed the diff', '--as', 'orch', '--json'], { cwd: s.root });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.data).toEqual({ id: 'LB-1', rev: before + 1, status: 'done', assignee: 'dev-1', commit: null, accepted: true });
    expect(doc.warnings).toEqual([]);
    const t = stored(s, 'LB-1');
    expect(t).toMatchObject({ status: 'done', assignee: 'dev-1', links: [] });
    expect(t.events.slice(-2).map((e) => [e.actor, e.type, e.data.text ?? e.data.to])).toEqual([
      ['orch', 'commented', 'accepted: reviewed the diff'],
      ['orch', 'status', 'done'],
    ]);
    expect(t.events.at(-1)?.data).toEqual({ from: 'review', to: 'done', accepted: true });
  });

  it('accepting again (or a retry): a no-op with a warning, exit 0, nothing written', async () => {
    const s = await inReview();
    await finishTask(as(s, 'orch'), { id: 'LB-1', result: 'ok', no_commit: true });
    const before = activeText(s);
    const r = await cli(['finish', 'LB-1', '--result', 'ok again', '--as', 'orch', '--json'], { cwd: s.root });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ data: { id: 'LB-1', status: 'done', assignee: 'dev-1' }, warnings: ['no changes: LB-1 is already done; the result was not recorded (add it with laneboard comment LB-1 "<text>")'] });
    expect(JSON.parse(r.stdout).data.accepted).toBeUndefined();
    expect(activeText(s)).toBe(before);
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

  it('not handed in: created in review, moved there by update, moved back by the orchestrator, reassigned: refused, nothing written', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Created in review', status: 'review', assignee: 'dev-1' });
    await createTask(as(s, 'a'), { title: 'Moved by update', status: 'todo', assignee: 'dev-1' });
    await updateTask(as(s, 'dev-1'), { id: 'LB-2', status: 'review' });
    await createTask(as(s, 'a'), { title: 'Sent back', status: 'todo', assignee: 'dev-1' });
    await finishTask(as(s, 'dev-1'), { id: 'LB-3', result: 'ready', status: 'review', no_commit: true });
    await updateTask(as(s, 'orch'), { id: 'LB-3', status: 'in_progress' });
    await updateTask(as(s, 'orch'), { id: 'LB-3', status: 'review' });
    await createTask(as(s, 'a'), { title: 'Reassigned', status: 'todo', assignee: 'dev-1' });
    await finishTask(as(s, 'dev-1'), { id: 'LB-4', result: 'ready', status: 'review', no_commit: true });
    await updateTask(as(s, 'orch'), { id: 'LB-4', assignee: 'dev-2' });
    const before = activeText(s);
    for (const [id, holder] of [['LB-1', 'dev-1'], ['LB-2', 'dev-1'], ['LB-3', 'dev-1'], ['LB-4', 'dev-2']] as const) {
      const err = await rejectsWith(finishTask(as(s, 'orch'), { id, result: 'x', no_commit: true }), 'ALREADY_CLAIMED');
      expect(err.message, id).toBe(NOT_HANDED_IN(id, holder, 'review'));
      expect(err.fix, id).toBe(HAND_IN_FIX(id));
    }
    expect(activeText(s)).toBe(before);
  });

  it('the fix works: a task in review without the mark (handed in before S4b) is handed in by its assignee\'s finish, then accepted', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Old hand-in', status: 'in_progress', assignee: 'dev-1' });
    await updateTask(as(s, 'dev-1'), { id: 'LB-1', status: 'review' });
    await rejectsWith(finishTask(as(s, 'orch'), { id: 'LB-1', result: 'x', no_commit: true }), 'ALREADY_CLAIMED');
    const again = await finishTask(as(s, 'dev-1'), { id: 'LB-1', result: 'handed in again', status: 'review', no_commit: true });
    expect(again.warnings).toEqual([]);
    expect(stored(s, 'LB-1').events.slice(-2).map((e) => [e.type, e.data])).toEqual([
      ['commented', { text: 'handed in again' }],
      ['status', { from: 'review', to: 'review', handed_in: true }],
    ]);
    // Handed in now: a second hand-in is unchanged; the acceptance goes through.
    expect((await finishTask(as(s, 'dev-1'), { id: 'LB-1', result: 'x', status: 'review', no_commit: true })).warnings[0]).toMatch(/^no changes: LB-1 is already review/);
    expect((await finishTask(as(s, 'orch'), { id: 'LB-1', result: 'ok', no_commit: true })).reply).toEqual({ commit: null, accepted: true });
  });

  it('a 3-status board accepts too, after the assignee hands the task in to its middle status', async () => {
    const s = await newStore({ statuses: ['backlog', 'doing', 'shipped'] });
    await createTask(as(s, 'a'), { title: 'T', status: 'backlog', assignee: 'dev-1' });
    await claimTask(as(s, 'dev-1'), { id: 'LB-1', status: 'doing' });
    const err = await rejectsWith(finishTask(as(s, 'orch'), { id: 'LB-1', result: 'x', no_commit: true }), 'ALREADY_CLAIMED');
    expect(err.message).toBe(NOT_HANDED_IN('LB-1', 'dev-1', 'doing').replace('--status done', '--status shipped'));
    await finishTask(as(s, 'dev-1'), { id: 'LB-1', result: 'ready', status: 'doing', no_commit: true });
    expect((await finishTask(as(s, 'orch'), { id: 'LB-1', result: 'ok', no_commit: true })).data.status).toBe('shipped');
  });

  it('from todo or in_progress: ALREADY_CLAIMED (exit 4) with the hand-in fix (the hand-in statuses, not the current one), nothing written', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Todo', status: 'todo', assignee: 'dev-1' });
    await createTask(as(s, 'a'), { title: 'Working', status: 'in_progress', assignee: 'dev-1' });
    const before = activeText(s);
    for (const [id, status, handIn] of [['LB-1', 'todo', OPEN], ['LB-2', 'in_progress', OPEN]] as const) {
      const r = await cli(['finish', id, '--result', 'x', '--as', 'orch', '--json'], { cwd: s.root });
      expect(r.code).toBe(4);
      expect(JSON.parse(r.stdout).error).toMatchObject({ code: 'ALREADY_CLAIMED', message: NOT_HANDED_IN(id, 'dev-1', status), details: { assignee: 'dev-1' }, fix: HAND_IN_FIX(id, handIn) });
    }
    expect(activeText(s)).toBe(before);
  });

  it('from review into a status that is not final (somebody else\'s --status review / in_progress): refused, the comment fix', async () => {
    const s = await inReview();
    const rev = stored(s, 'LB-1').rev;
    for (const status of ['review', 'in_progress']) {
      const err = await rejectsWith(finishTask(as(s, 'orch'), { id: 'LB-1', result: 'x', status, no_commit: true }), 'ALREADY_CLAIMED');
      expect(err.message).toBe(NOT_FINAL('LB-1', 'dev-1', 'review'));
      expect(err.fix).toBe('laneboard comment LB-1 "<note for dev-1>" --as orch');
    }
    expect(stored(s, 'LB-1').rev).toBe(rev);
  });

  it('MCP task_finish: acceptance of a handed-in task (accepted: true, commit null), refusal from in_progress', async () => {
    const s = await inReview();
    await createTask(as(s, 'a'), { title: 'Working', status: 'in_progress', assignee: 'dev-1' });
    const env = { cwd: s.root, env: {} };
    const ok = await callTool('task_finish', { id: 'LB-1', result: 'accepted', no_commit: true, actor: 'orch' }, env);
    expect(ok.structuredContent).toMatchObject({ id: 'LB-1', status: 'done', assignee: 'dev-1', commit: null, accepted: true });
    expect(stored(s, 'LB-1').events.at(-1)).toMatchObject({ actor: 'orch', type: 'status', data: { from: 'review', to: 'done', accepted: true } });
    const no = await callTool('task_finish', { id: 'LB-2', result: 'x', no_commit: true, actor: 'orch' }, env);
    expect(no.isError).toBe(true);
    expect(no.structuredContent).toMatchObject({ code: 'ALREADY_CLAIMED', message: NOT_HANDED_IN('LB-2', 'dev-1', 'in_progress'), fix: HAND_IN_FIX('LB-2') });
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
