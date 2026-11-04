// S5c (ADR §30): task links to tasks of other boards (checked on their board before the own lock, shown by get), the not-found error
// of an id of another board; review S5b MINOR 1 (a board whose folder cannot be read is unreadable, not missing).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  archiveTasks,
  attachFile,
  boardsOverview,
  claimTask,
  commentTask,
  createTask,
  deleteTask,
  finishTask,
  getTask,
  listBoards,
  listEvents,
  listTasks,
  liveBoards,
  registerStore,
  restoreTask,
  updateTask,
} from '../../src/core/index.ts';
import { as, cleanupTemp, newStore, readStore, rejectsWith, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

// Two registered boards in a fresh HOME: LB and WEB (both todo..done), WEB-1 open, WEB-2 done, WEB-3 archived.
async function twoBoards(): Promise<{ home: string; lb: TestStore; web: TestStore }> {
  const home = tempDir();
  const lb = await newStore();
  const web = await newStore({ prefix: 'WEB' });
  await registerStore(home, lb.dir);
  await registerStore(home, web.dir);
  await createTask(as(web, 'w'), { title: 'Web open', status: 'todo' });
  await createTask(as(web, 'w'), { title: 'Web done', status: 'done' });
  await createTask(as(web, 'w'), { title: 'Web archived', status: 'done' });
  await archiveTasks(as(web, 'w'), { ids: ['WEB-3'] });
  return { home, lb, web };
}

describe('links to tasks of other boards (ADR §30)', () => {
  it('create --link and update --add-link accept a task of another live board; it is stored as a plain task link', async () => {
    const { home, lb } = await twoBoards();
    const created = await createTask(as(lb, 'a', { home }), { title: 'Depends on web', status: 'todo', links: [{ kind: 'task', ref: 'WEB-1' }] });
    expect(created.data.links).toEqual([{ kind: 'task', ref: 'WEB-1' }]);
    await createTask(as(lb, 'a', { home }), { title: 'Other', status: 'todo' });
    // Own and foreign links in one write; an archived task of the other board is a task too.
    const updated = await updateTask(as(lb, 'a', { home }), { id: 'LB-2', add_links: [{ kind: 'task', ref: 'LB-1' }, { kind: 'task', ref: 'WEB-3' }] });
    expect(updated.data.links).toEqual([
      { kind: 'task', ref: 'LB-1' },
      { kind: 'task', ref: 'WEB-3' },
    ]);
    expect(readStore(lb.dir, 'active').tasks[0]?.links).toEqual([{ kind: 'task', ref: 'WEB-1' }]);
  });

  it('a missing task of that board: TASK_NOT_FOUND naming the board, with a search there as fix; nothing written', async () => {
    const { home, lb, web } = await twoBoards();
    const err = await rejectsWith(createTask(as(lb, 'a', { home }), { title: 'x', status: 'todo', links: [{ kind: 'task', ref: 'WEB-99' }] }), 'TASK_NOT_FOUND');
    expect(err.message).toBe(`link task=WEB-99: no such task on board WEB (${web.dir})`);
    expect(err.fix).toBe('laneboard list --board WEB --scope all --text "<words from the title>"');
    expect(readStore(lb.dir, 'active').tasks).toHaveLength(0);
  });

  it('a prefix no live board has: INVALID_VALUE with the live prefixes as allowed, fix laneboard boards; a missing board is no board', async () => {
    const { home, lb } = await twoBoards();
    const gone = await newStore({ prefix: 'GONE' });
    await registerStore(home, gone.dir);
    fs.rmSync(gone.dir, { recursive: true });
    for (const ref of ['NOPE-1', 'GONE-1']) {
      const err = await rejectsWith(createTask(as(lb, 'a', { home }), { title: 'x', status: 'todo', links: [{ kind: 'task', ref }] }), 'INVALID_VALUE');
      expect(err.message).toBe(`link task=${ref}: no live board with prefix ${ref.split('-')[0]} on this machine`);
      expect(err.allowed).toEqual(['WEB']);
      expect(err.fix).toBe('laneboard boards');
    }
  });

  it('no HOME: USAGE whose CLI fix sets it; a link to this board needs no HOME', async () => {
    const { lb } = await twoBoards();
    await createTask(as(lb, 'a'), { title: 'Own', status: 'todo' });
    expect((await createTask(as(lb, 'a'), { title: 'Own 2', status: 'todo', links: [{ kind: 'task', ref: 'LB-1' }] })).data.id).toBe('LB-2');
    const err = await rejectsWith(updateTask(as(lb, 'a'), { id: 'LB-1', add_links: [{ kind: 'task', ref: 'WEB-1' }] }), 'USAGE');
    expect(err.edit).toEqual({ env: 'HOME=<your home directory>' });
  });

  it('get lists where each task link stands: this board, another board (open, final, archived), a missing task, a board not found', async () => {
    const { home, lb } = await twoBoards();
    await createTask(as(lb, 'a'), { title: 'Own target', status: 'in_progress' });
    await createTask(as(lb, 'a', { home }), {
      title: 'Linked',
      status: 'todo',
      links: [
        { kind: 'url', ref: 'https://example.com' },
        { kind: 'task', ref: 'WEB-1' },
        { kind: 'task', ref: 'LB-1' },
        { kind: 'task', ref: 'WEB-2' },
        { kind: 'task', ref: 'WEB-3' },
      ],
    });
    // A link the write checked, to a task deleted since (a delete leaves links to it).
    await deleteTask(as(lb, 'w', { home }), { id: 'LB-1', confirm_id: 'LB-1' });
    const got = (await getTask(as(lb, 'x', { home }), { id: 'LB-2' })).data;
    expect(got.linked_tasks).toEqual([
      { ref: 'WEB-1', board: 'WEB', found: true, title: 'Web open', status: 'todo', final: false, archived: false },
      { ref: 'LB-1', board: 'LB', found: false },
      { ref: 'WEB-2', board: 'WEB', found: true, title: 'Web done', status: 'done', final: true, archived: false },
      { ref: 'WEB-3', board: 'WEB', found: true, title: 'Web archived', status: 'done', final: true, archived: true },
    ]);
    // Reads fail open: without HOME the other board is named with the reason, the task itself is still there.
    const noHome = (await getTask(as(lb, 'x'), { id: 'LB-2' })).data.linked_tasks;
    expect(noHome[0]).toEqual({ ref: 'WEB-1', board: 'WEB', found: false, problem: 'HOME is not set, so the board registry cannot be read' });
    // A registry without board WEB.
    const otherHome = tempDir();
    await registerStore(otherHome, lb.dir);
    expect((await getTask(as(lb, 'x', { home: otherHome }), { id: 'LB-2' })).data.linked_tasks[0]).toEqual({ ref: 'WEB-1', board: 'WEB', found: false, problem: 'no live board with prefix WEB on this machine' });
  });

  it('get reads the other board after releasing its own lock, one board at a time', async () => {
    const { home, lb, web } = await twoBoards();
    await createTask(as(lb, 'a', { home }), { title: 'L', status: 'todo', links: [{ kind: 'task', ref: 'WEB-1' }] });
    // A broken other board: get still answers, the link says why.
    fs.chmodSync(path.join(web.dir, 'active.json'), 0o644);
    fs.writeFileSync(path.join(web.dir, 'active.json'), '{ broken');
    const linked = (await getTask(as(lb, 'x', { home }), { id: 'LB-1' })).data.linked_tasks;
    expect(linked[0]).toMatchObject({ ref: 'WEB-1', board: 'WEB', found: false, problem: expect.stringMatching(/^active\.json is not valid JSON/) });
  });
});

describe('an id of another board on this board (ADR §30)', () => {
  it('reads (get, events --task, list --parent): TASK_NOT_FOUND naming the board; the edit opens it with --board', async () => {
    const { home, lb, web } = await twoBoards();
    const message = `WEB-1 is on board WEB (${web.dir}), not on this board (LB)`;
    const read = { drop: [{ name: 'dir' }, { name: 'board' }], add: [{ name: 'board', value: 'WEB' }] };
    const calls = [() => getTask(as(lb, 'x', { home }), { id: 'WEB-1' }), () => listEvents(as(lb, 'x', { home }), { task: 'WEB-1' }), () => listTasks(as(lb, 'x', { home }), { parent: 'WEB-1' })];
    for (const call of calls) {
      const err = await rejectsWith(call(), 'TASK_NOT_FOUND');
      expect({ message: err.message, edit: err.edit, fix: err.fix }).toEqual({ message, edit: read, fix: 'read it on its board: laneboard get WEB-1 --board WEB --json' });
    }
  });

  it('writes (update, claim, comment, finish, attach, archive, restore, delete): the edit points --dir at its store', async () => {
    const { home, lb, web } = await twoBoards();
    fs.writeFileSync(path.join(lb.root, 'f.txt'), 'x');
    const ctx = as(lb, 'a', { home, cwd: lb.root });
    const calls = [
      () => updateTask(ctx, { id: 'WEB-1', title: 'x' }),
      () => claimTask(ctx, { id: 'WEB-1' }),
      () => commentTask(ctx, { id: 'WEB-1', text: 'x' }),
      () => finishTask(ctx, { id: 'WEB-1', result: 'x', no_commit: true }),
      () => attachFile(ctx, { id: 'WEB-1', path: path.join(lb.root, 'f.txt') }),
      () => archiveTasks(ctx, { ids: ['WEB-1'] }),
      () => restoreTask(ctx, { id: 'WEB-3' }),
      () => deleteTask(ctx, { id: 'WEB-1', confirm_id: 'WEB-1' }),
    ];
    for (const call of calls) {
      const err = await rejectsWith(call(), 'TASK_NOT_FOUND');
      expect(err.message).toMatch(new RegExp(`^WEB-[13] is on board WEB \\(${web.dir}\\), not on this board \\(LB\\)$`));
      expect(err.edit).toEqual({ drop: [{ name: 'dir' }], add: [{ name: 'dir', value: web.dir }] });
      expect(err.fix).toBe(`write on its board: the same laneboard command with --dir ${web.dir} (an MCP server writes to its own board only)`);
    }
  });

  it('an id of this board, of no live board, or without HOME: the plain not-found', async () => {
    const { home, lb } = await twoBoards();
    for (const [id, h] of [
      ['LB-9', home],
      ['NOPE-1', home],
      ['WEB-1', undefined],
    ] as const) {
      const err = await rejectsWith(getTask(as(lb, 'x', h === undefined ? {} : { home: h }), { id }), 'TASK_NOT_FOUND');
      expect(err.message).toBe(`task ${id} does not exist (active or archive)`);
      expect(err.edit).toBeUndefined();
    }
    // list --parent of this board that names no task: an empty list, as before.
    expect((await listTasks(as(lb, 'x', { home }), { parent: 'LB-9' })).data.total).toBe(0);
  });
});

describe('review S5b MINOR 1: a board whose folder cannot be read is unreadable, not missing', () => {
  it('list --all-boards warns with the chmod fix, the overview says unreadable, boards shows the problem; a deleted one stays missing', async () => {
    const { home, lb, web } = await twoBoards();
    fs.chmodSync(web.dir, 0o000);
    try {
      expect(liveBoards(home, lb.store).missing).toEqual([]);
      const r = await listTasks(as(lb, 'x', { home }), { all_boards: true });
      const row = r.data.boards?.find((b) => b.prefix === 'WEB');
      expect(row?.problem).toMatch(/^config\.json cannot be read \(EACCES\)/);
      expect(r.warnings).toEqual([expect.stringMatching(new RegExp(`^board WEB \\(${web.dir}\\) skipped: config\\.json cannot be read \\(EACCES\\)`))]);
      const overview = (await boardsOverview(home, lb.store)).data.find((b) => b.prefix === 'WEB');
      expect(overview?.problem).toMatch(/cannot be read \(EACCES\)/);
      const listed = (await listBoards(home)).data.boards.find((b) => b.prefix === 'WEB');
      expect({ missing: listed?.missing, problem: listed?.problem?.slice(0, 33) }).toEqual({ missing: false, problem: 'config.json cannot be read (EACCE' });
    } finally {
      fs.chmodSync(web.dir, 0o755);
    }
    fs.rmSync(web.dir, { recursive: true });
    expect(liveBoards(home, lb.store).missing.map((m) => m.problem)).toEqual(['missing (no store at this path)']);
  });
});
