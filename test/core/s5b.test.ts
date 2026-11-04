// S5b (ADR §28-§29): the newest comment on cards and list rows, the card marks (handed in, in work, stale, parent, children), the
// waiting-owner label, list over every board of the machine and the all-boards overview of prime.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  boardsOverview,
  claimTask,
  commentTask,
  createTask,
  finishTask,
  lastComment,
  listTasks,
  registerStore,
  STALE_AFTER_MS,
  updateTask,
  viewBoard,
  WAITING_OWNER_LABEL,
} from '../../src/core/index.ts';
import type { TaskT, ViewCard } from '../../src/core/index.ts';
import { as, cleanupTemp, newStore, readStore, rejectsWith, tempDir, writeRaw } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

// Move a task's last change `ms` into the past (a fixture: the clock of viewBoard is the real one).
function ageTask(s: TestStore, id: string, ms: number): void {
  const doc = readStore(s.dir, 'active');
  const task = doc.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`${id} not in active.json`);
  task.updated_at = new Date(Date.now() - ms).toISOString();
  writeRaw(path.join(s.dir, 'active.json'), JSON.stringify(doc, null, 2));
}

// Every card of a view by id.
async function cards(s: TestStore): Promise<Map<string, ViewCard>> {
  const v = (await viewBoard(as(s), {})).data;
  return new Map(v.columns.flatMap((c) => c.cards).map((c) => [c.id, c]));
}

describe('lastComment (ADR §28)', () => {
  const task = (events: Array<{ type: string; data: Record<string, unknown> }>): TaskT =>
    ({ events: events.map((e, i) => ({ at: `2026-01-0${i + 1}T00:00:00.000Z`, actor: `a${i}`, ...e })) }) as unknown as TaskT;

  it('null without a comment; else the newest one: its first non-blank line, trimmed, with time, actor and the result mark', () => {
    expect(lastComment(task([{ type: 'created', data: {} }]))).toBeNull();
    const t = task([
      { type: 'commented', data: { text: 'old' } },
      { type: 'commented', data: { text: '\n   \n  Root cause: the redirect drops the query  \nsecond line' } },
      { type: 'status', data: { from: 'a', to: 'b' } },
    ]);
    expect(lastComment(t)).toEqual({ at: '2026-01-02T00:00:00.000Z', actor: 'a1', text: 'Root cause: the redirect drops the query', result: false });
    expect(lastComment(task([{ type: 'commented', data: { text: 'done: ok', result: true } }]))?.result).toBe(true);
  });

  it('a first line over 120 characters is cut to 120 with an ellipsis (code points)', () => {
    const long = 'я'.repeat(119) + 'ab';
    const c = lastComment(task([{ type: 'commented', data: { text: long } }]));
    expect([...(c?.text ?? '')]).toHaveLength(120);
    expect(c?.text).toBe(`${'я'.repeat(119)}…`);
    expect(lastComment(task([{ type: 'commented', data: { text: 'x'.repeat(120) } }]))?.text).toBe('x'.repeat(120));
  });
});

describe('cards and list rows (ADR §28)', () => {
  it('list items and cards carry the newest comment; finish marks it as the result', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'T', status: 'todo', assignee: 'dev-1' });
    expect((await listTasks(as(s), {})).data.items[0]?.last_comment).toBeNull();
    await commentTask(as(s, 'dev-1'), { id: 'LB-1', text: 'Step one\nmore' });
    expect((await listTasks(as(s), {})).data.items[0]?.last_comment).toMatchObject({ actor: 'dev-1', text: 'Step one', result: false });
    await finishTask(as(s, 'dev-1'), { id: 'LB-1', result: 'Shipped', status: 'review', no_commit: true });
    expect((await cards(s)).get('LB-1')?.last_comment).toMatchObject({ text: 'Shipped', result: true });
  });

  it('handed_in, in_work, stale: by the data and the 4-hour threshold; a todo task with an assignee and a handed-in one are never stale', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'todo assigned', status: 'todo', assignee: 'dev-1' });
    await createTask(as(s, 'a'), { title: 'in work', status: 'in_progress', assignee: 'dev-1' });
    await createTask(as(s, 'a'), { title: 'handed in', status: 'in_progress', assignee: 'dev-2' });
    await finishTask(as(s, 'dev-2'), { id: 'LB-3', result: 'ready', status: 'review', no_commit: true });
    await createTask(as(s, 'a'), { title: 'free', status: 'in_progress' });
    await createTask(as(s, 'a'), { title: 'moved to review by update', status: 'review', assignee: 'dev-3' });
    await createTask(as(s, 'a'), { title: 'done', status: 'done', assignee: 'dev-1' });
    const minute = 60_000;
    for (const id of ['LB-1', 'LB-3', 'LB-4', 'LB-6']) ageTask(s, id, STALE_AFTER_MS + minute);
    ageTask(s, 'LB-2', STALE_AFTER_MS + minute);
    ageTask(s, 'LB-5', STALE_AFTER_MS - minute);
    const c = await cards(s);
    const flags = (id: string) => ({ handed_in: c.get(id)?.handed_in, in_work: c.get(id)?.in_work, stale: c.get(id)?.stale });
    expect(flags('LB-1')).toEqual({ handed_in: false, in_work: false, stale: false });
    expect(flags('LB-2')).toEqual({ handed_in: false, in_work: true, stale: true });
    expect(flags('LB-3')).toEqual({ handed_in: true, in_work: false, stale: false });
    expect(flags('LB-4')).toEqual({ handed_in: false, in_work: false, stale: false });
    // Assigned in a middle status without a finish: in work; 4 h minus a minute is not stale yet.
    expect(flags('LB-5')).toEqual({ handed_in: false, in_work: true, stale: false });
    expect(flags('LB-6')).toEqual({ handed_in: false, in_work: false, stale: false });
    expect(c.get('LB-2')?.updated_at).toBe(readStore(s.dir, 'active').tasks[1]?.updated_at);
  });

  it('parent and children {total, final} from active.json; the card keeps the contract key order for the web board', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Parent', status: 'todo', assignee: 'orc' });
    await createTask(as(s, 'a'), { title: 'Child 1', status: 'todo', parent: 'LB-1', assignee: 'dev-1' });
    await createTask(as(s, 'a'), { title: 'Child 2', status: 'done', parent: 'LB-1', assignee: 'dev-1' });
    const c = await cards(s);
    expect(c.get('LB-1')).toMatchObject({ parent: null, children: { total: 2, final: 1 } });
    expect(c.get('LB-2')).toMatchObject({ parent: 'LB-1', children: { total: 0, final: 0 } });
    expect(Object.keys(c.get('LB-1') ?? {})).toEqual(['id', 'title', 'assignee', 'labels', 'status_since', 'rev', 'last_comment', 'parent', 'children', 'updated_at', 'handed_in', 'in_work', 'stale']);
    // Counted before the filters (review S5b MINOR 3): a filter that hides the children keeps the parent's count.
    const filtered = (await viewBoard(as(s), { assignee: 'orc' })).data.columns.flatMap((col) => col.cards);
    expect(filtered.map((card) => [card.id, card.children])).toEqual([['LB-1', { total: 2, final: 1 }]]);
  });

  it('waiting-owner is a plain label: the usual filters find it', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Ask the owner', status: 'in_progress', assignee: 'orchestrator' });
    await createTask(as(s, 'a'), { title: 'Other', status: 'todo' });
    await updateTask(as(s, 'orchestrator'), { id: 'LB-1', add_labels: [WAITING_OWNER_LABEL] });
    expect((await listTasks(as(s), { labels: [WAITING_OWNER_LABEL] })).data.items.map((t) => t.id)).toEqual(['LB-1']);
    const v = (await viewBoard(as(s), { labels: [WAITING_OWNER_LABEL] })).data;
    expect(v.columns.flatMap((col) => col.cards).map((card) => card.id)).toEqual(['LB-1']);
  });
});

// Two registered boards in a fresh HOME: LB (todo/in_progress/review/done) and WEB (backlog/doing/shipped).
async function twoBoards(): Promise<{ home: string; lb: TestStore; web: TestStore }> {
  const home = tempDir();
  const lb = await newStore();
  const web = await newStore({ prefix: 'WEB', statuses: ['backlog', 'doing', 'shipped'] });
  await registerStore(home, lb.dir);
  await registerStore(home, web.dir);
  return { home, lb, web };
}

describe('list all_boards (ADR §29)', () => {
  it('tasks of every board, the current one first in `boards`; open drops each board its own final status; paging over the merge', async () => {
    const { home, lb, web } = await twoBoards();
    await createTask(as(lb, 'a'), { title: 'lb todo', status: 'todo' });
    await createTask(as(web, 'a'), { title: 'web doing', status: 'doing' });
    await createTask(as(lb, 'a'), { title: 'lb done', status: 'done' });
    await createTask(as(web, 'a'), { title: 'web shipped', status: 'shipped' });
    const all = (await listTasks(as(web, 'x', { home }), { all_boards: true })).data;
    expect(all.items.map((t) => t.id)).toEqual(['WEB-2', 'LB-2', 'WEB-1', 'LB-1']);
    expect(all.boards).toEqual([
      { prefix: 'WEB', name: 'test', path: web.dir, problem: null },
      { prefix: 'LB', name: 'test', path: lb.dir, problem: null },
    ]);
    expect((await listTasks(as(lb, 'x', { home }), { all_boards: true, open: true })).data.items.map((t) => t.id)).toEqual(['WEB-1', 'LB-1']);
    const page = (await listTasks(as(lb, 'x', { home }), { all_boards: true, limit: 1, offset: 1 })).data;
    expect({ ids: page.items.map((t) => t.id), total: page.total }).toEqual({ ids: ['LB-2'], total: 4 });
    // Without all_boards: one board, no `boards` key; open works there too.
    const one = (await listTasks(as(lb, 'x', { home }), { open: true })).data;
    expect(one.items.map((t) => t.id)).toEqual(['LB-1']);
    expect(one).not.toHaveProperty('boards');
  });

  it('a status matches on the boards that know it; one no board knows: UNKNOWN_STATUS with every board status allowed', async () => {
    const { home, lb, web } = await twoBoards();
    await createTask(as(lb, 'a'), { title: 'lb', status: 'todo' });
    await createTask(as(web, 'a'), { title: 'web', status: 'backlog' });
    expect((await listTasks(as(lb, 'x', { home }), { all_boards: true, status: ['backlog'] })).data.items.map((t) => t.id)).toEqual(['WEB-1']);
    const err = await rejectsWith(listTasks(as(lb, 'x', { home }), { all_boards: true, status: ['nope'] }), 'UNKNOWN_STATUS');
    expect(err.allowed).toEqual(['todo', 'in_progress', 'review', 'done', 'backlog', 'doing', 'shipped']);
  });

  it('a board that cannot be read is skipped with a warning; a registered path without a store is listed as missing', async () => {
    const { home, lb, web } = await twoBoards();
    await createTask(as(lb, 'a'), { title: 'lb', status: 'todo' });
    const gone = await newStore({ prefix: 'GONE' });
    await registerStore(home, gone.dir);
    fs.rmSync(gone.dir, { recursive: true });
    writeRaw(path.join(web.dir, 'active.json'), '{ broken');
    const r = await listTasks(as(lb, 'x', { home }), { all_boards: true });
    expect(r.data.items.map((t) => t.id)).toEqual(['LB-1']);
    expect(r.data.boards?.map((b) => [b.prefix, b.problem === null ? 'ok' : b.problem.slice(0, 20)])).toEqual([
      ['LB', 'ok'],
      ['WEB', 'active.json is not v'],
      ['GONE', 'missing (no store at'],
    ]);
    expect(r.warnings).toEqual([expect.stringMatching(new RegExp(`^board WEB \\(${web.dir}\\) skipped: active\\.json is not valid JSON`))]);
  });

  it('parent picks its board by the id; without HOME or with --board: USAGE with an edit', async () => {
    const { home, lb, web } = await twoBoards();
    await createTask(as(web, 'a'), { title: 'p', status: 'backlog' });
    await createTask(as(web, 'a'), { title: 'c', status: 'backlog', parent: 'WEB-1' });
    await createTask(as(lb, 'a'), { title: 'lb', status: 'todo' });
    expect((await listTasks(as(lb, 'x', { home }), { all_boards: true, parent: 'WEB-1' })).data.items.map((t) => t.id)).toEqual(['WEB-2']);
    const noHome = await rejectsWith(listTasks(as(lb, 'x'), { all_boards: true }), 'USAGE');
    expect(noHome.edit).toEqual({ env: 'HOME=<your home directory>' });
    const board = await rejectsWith(listTasks({ store: { dir: web.dir, found: 'board', readOnly: true }, home }, { all_boards: true }), 'USAGE');
    expect(board.edit).toEqual({ drop: [{ name: 'board' }] });
  });
});

describe('boardsOverview (ADR §29)', () => {
  it('every board as viewBoard sees it, the current one first: counts, final total, cards not final with their status; problems listed', async () => {
    const { home, lb, web } = await twoBoards();
    await createTask(as(lb, 'a'), { title: 'lb todo', status: 'todo' });
    await createTask(as(lb, 'a'), { title: 'lb done', status: 'done' });
    await createTask(as(web, 'a'), { title: 'web doing', status: 'doing', assignee: 'dev-1' });
    await claimTask(as(web, 'dev-1'), { id: 'WEB-1' });
    const r = (await boardsOverview(home, { dir: web.dir })).data;
    expect(r.map((b) => [b.prefix, b.current, b.problem])).toEqual([
      ['WEB', true, null],
      ['LB', false, null],
    ]);
    expect(r[1]).toMatchObject({ counts: [{ status: 'todo', count: 1 }, { status: 'in_progress', count: 0 }, { status: 'review', count: 0 }, { status: 'done', count: 1 }], final_status: 'done', final_total: 1 });
    expect(r[1]?.cards.map((c) => [c.id, c.status])).toEqual([['LB-1', 'todo']]);
    expect(r[0]?.cards[0]).toMatchObject({ id: 'WEB-1', status: 'doing', in_work: true });
  });
});
