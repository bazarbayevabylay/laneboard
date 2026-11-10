// S5a (ADR §25-§27): subtasks (`parent`), appending to the description, the result mark on finish's comment.
import { afterAll, describe, expect, it } from 'vitest';
import { archiveTasks, claimTask, commentTask, createTask, deleteTask, finishTask, getTask, listTasks, updateTask } from '../../src/core/index.ts';
import { as, cleanupTemp, newStore, otherWarnings, readStore, rejectsWith } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

// A store with LB-1 (todo) and its subtask LB-2 (todo).
async function withChild(): Promise<TestStore> {
  const s = await newStore();
  await createTask(as(s, 'a'), { title: 'Parent', status: 'todo' });
  await createTask(as(s, 'a'), { title: 'Child', status: 'todo', parent: 'LB-1' });
  return s;
}

// Stored task by id (active or archive).
function stored(s: TestStore, id: string): Record<string, unknown> & { events: Array<{ type: string; data: Record<string, unknown> }> } {
  const all = [...readStore(s.dir, 'active').tasks, ...readStore(s.dir, 'archive').tasks];
  return all.find((t) => t.id === id) as never;
}

describe('§25 subtasks: parent', () => {
  it('create stores parent and names it in the created event; get lists children and the parent, list filters by parent', async () => {
    const s = await withChild();
    expect(stored(s, 'LB-2').parent).toBe('LB-1');
    expect(stored(s, 'LB-1')).not.toHaveProperty('parent');
    expect(stored(s, 'LB-2').events[0]?.data).toEqual({ title: 'Child', status: 'todo', assignee: null, parent: 'LB-1' });
    const parent = (await getTask(as(s), { id: 'LB-1' })).data;
    expect(parent).toMatchObject({ parent: null, parent_task: null, children: [{ id: 'LB-2', title: 'Child', status: 'todo', assignee: null, archived: false }] });
    const child = (await getTask(as(s), { id: 'LB-2' })).data;
    expect(child).toMatchObject({ parent: 'LB-1', parent_task: { id: 'LB-1', title: 'Parent', status: 'todo', archived: false }, children: [] });
    const list = (await listTasks(as(s), { parent: 'LB-1' })).data;
    expect(list.items.map((i) => [i.id, i.parent])).toEqual([['LB-2', 'LB-1']]);
    expect((await listTasks(as(s), { parent: 'LB-2' })).data.total).toBe(0);
  });

  it('children in id order from both files, archived ones marked', async () => {
    const s = await withChild();
    for (let i = 0; i < 9; i++) await createTask(as(s, 'a'), { title: `c${i}`, status: 'todo', parent: 'LB-1' });
    await archiveTasks(as(s, 'a'), { ids: ['LB-3'] });
    const children = (await getTask(as(s), { id: 'LB-1' })).data.children;
    expect(children.map((c) => c.id)).toEqual(['LB-2', 'LB-3', 'LB-4', 'LB-5', 'LB-6', 'LB-7', 'LB-8', 'LB-9', 'LB-10', 'LB-11']);
    expect(children.find((c) => c.id === 'LB-3')?.archived).toBe(true);
  });

  it('a parent on another board: INVALID_VALUE whose edit drops parent and links the task instead', async () => {
    const s = await withChild();
    const created = await rejectsWith(createTask(as(s, 'a'), { title: 'x', status: 'todo', parent: 'WEB-3' }), 'INVALID_VALUE');
    expect(created.message).toBe('parent must be a task on this board (LB); WEB-3 is on another board: link it instead');
    expect(created.edit).toEqual({ drop: [{ name: 'parent' }], add: [{ name: 'links', value: 'task=WEB-3' }] });
    const updated = await rejectsWith(updateTask(as(s, 'a'), { id: 'LB-2', parent: 'WEB-3' }), 'INVALID_VALUE');
    expect(updated.edit).toEqual({ drop: [{ name: 'parent' }], add: [{ name: 'add_links', value: 'task=WEB-3' }] });
    expect(updated.fix).toBe('drop parent and pass add_links [{"kind": "task", "ref": "WEB-3"}] (CLI: --add-link task=WEB-3)');
  });

  it('a missing, archived or inexact parent is refused with its fix', async () => {
    const s = await withChild();
    const missing = await rejectsWith(createTask(as(s, 'a'), { title: 'x', status: 'todo', parent: 'LB-9' }), 'TASK_NOT_FOUND');
    expect(missing.message).toBe('parent LB-9: no such task');
    await archiveTasks(as(s, 'a'), { ids: ['LB-1'] });
    const archived = await rejectsWith(createTask(as(s, 'a'), { title: 'x', status: 'todo', parent: 'LB-1' }), 'TASK_ARCHIVED');
    expect(archived.fix).toBe('laneboard restore LB-1 --json');
    const inexact = await rejectsWith(updateTask(as(s, 'a'), { id: 'LB-2', parent: '1' }), 'INVALID_VALUE');
    expect(inexact.input).toEqual({ field: 'parent', value: '1', suggestion: 'LB-1' });
    // Nothing was written by the failed calls.
    expect(readStore(s.dir, 'active').next_id).toBe(3);
  });

  it('a cycle is refused: the task itself, or one of its descendants, with the chain', async () => {
    const s = await withChild();
    await createTask(as(s, 'a'), { title: 'Grandchild', status: 'todo', parent: 'LB-2' });
    const self = await rejectsWith(updateTask(as(s, 'a'), { id: 'LB-1', parent: 'LB-1' }), 'INVALID_VALUE');
    expect(self.message).toBe('LB-1 cannot be the parent of LB-1: a task cannot be its own parent');
    const deep = await rejectsWith(updateTask(as(s, 'a'), { id: 'LB-1', parent: 'LB-3' }), 'INVALID_VALUE');
    expect(deep.message).toBe('LB-3 cannot be the parent of LB-1: LB-3 is under LB-1 (LB-1 > LB-2 > LB-3)');
    expect(deep.fix).toBe('laneboard update LB-1 --parent <id of a task not under LB-1> --json');
    expect(deep.edit).toEqual({ drop: [{ name: 'parent' }], add: [{ name: 'parent', value: '<id of a task not under LB-1>' }] });
    // Not a cycle: a sibling, and the grandchild moved up to the top.
    await createTask(as(s, 'a'), { title: 'Other', status: 'todo' });
    expect((await updateTask(as(s, 'a'), { id: 'LB-1', parent: 'LB-4' })).data.parent).toBe('LB-4');
  });

  it('update sets, changes and removes parent with one updated event; the same value changes nothing', async () => {
    const s = await withChild();
    await createTask(as(s, 'a'), { title: 'Other', status: 'todo' });
    const moved = await updateTask(as(s, 'a'), { id: 'LB-2', parent: 'LB-3' });
    expect(moved.data).toMatchObject({ parent: 'LB-3', rev: 2 });
    expect(moved.data.events.at(-1)).toMatchObject({ type: 'updated', data: { parent: ['LB-1', 'LB-3'] } });
    const same = await updateTask(as(s, 'a'), { id: 'LB-2', parent: 'LB-3' });
    expect(same.warnings).toEqual(['no changes: LB-2 already has these values']);
    const top = await updateTask(as(s, 'a'), { id: 'LB-2', parent: null });
    expect(top.data).toMatchObject({ parent: null, rev: 3 });
    expect(top.data.events.at(-1)?.data).toEqual({ parent: ['LB-3', null] });
    expect(stored(s, 'LB-2')).not.toHaveProperty('parent');
  });

  it('delete of a parent removes parent from its children in both files, with an event each', async () => {
    const s = await withChild();
    await createTask(as(s, 'a'), { title: 'Done child', status: 'done', parent: 'LB-1' });
    await archiveTasks(as(s, 'a'), { ids: ['LB-3'] });
    await deleteTask(as(s, 'a'), { id: 'LB-1', confirm_id: 'LB-1' });
    for (const id of ['LB-2', 'LB-3']) {
      const child = stored(s, id);
      expect(child).not.toHaveProperty('parent');
      expect(child.events.at(-1)).toMatchObject({ type: 'updated', actor: 'a', data: { parent: ['LB-1', null] } });
    }
    expect(stored(s, 'LB-2').rev).toBe(2);
  });

  it('a parent closed or archived while children are open: a warning, the children keep their parent (Q2)', async () => {
    const s = await withChild();
    await createTask(as(s, 'a'), { title: 'Done child', status: 'done', parent: 'LB-1' });
    const open = 'LB-1 has open children: LB-2 [todo]; they keep parent LB-1';
    await claimTask(as(s, 'dev'), { id: 'LB-1' });
    const handIn = await finishTask(as(s, 'dev'), { id: 'LB-1', result: 'ready', status: 'review', no_commit: true });
    expect(otherWarnings(handIn.warnings)).toEqual([]);
    const accepted = await finishTask(as(s, 'boss'), { id: 'LB-1', result: 'accepted' });
    expect(accepted.warnings).toEqual([open]);
    expect((await updateTask(as(s, 'a'), { id: 'LB-1', status: 'todo' })).warnings).toEqual([]);
    expect((await updateTask(as(s, 'a'), { id: 'LB-1', status: 'done' })).warnings).toEqual([open]);
    await updateTask(as(s, 'a'), { id: 'LB-1', status: 'in_progress' });
    expect(otherWarnings((await finishTask(as(s, 'dev'), { id: 'LB-1', result: 'done', no_commit: true })).warnings)).toEqual([open]);
    expect((await archiveTasks(as(s, 'a'), { ids: ['LB-1'] })).warnings).toEqual([open]);
    expect(stored(s, 'LB-2').parent).toBe('LB-1');
    // No open child: no warning.
    const t = await newStore();
    await createTask(as(t, 'a'), { title: 'P', status: 'todo' });
    await createTask(as(t, 'a'), { title: 'C', status: 'done', parent: 'LB-1' });
    expect((await updateTask(as(t, 'a'), { id: 'LB-1', status: 'done' })).warnings).toEqual([]);
  });
});

describe('§26 description append', () => {
  it('adds after a blank line (none on an empty description), under the lock: no expected_rev, another write in between is kept', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'T', status: 'todo' });
    const first = await updateTask(as(s, 'a'), { id: 'LB-1', append_description: 'one' });
    expect(first.data.description).toBe('one');
    expect(first.data.events.at(-1)).toMatchObject({ type: 'updated', data: { description: { chars: [0, 3], appended: true } } });
    await updateTask(as(s, 'b'), { id: 'LB-1', title: 'T2' });
    const second = await updateTask(as(s, 'a'), { id: 'LB-1', append_description: 'two' });
    expect(second.data).toMatchObject({ title: 'T2', description: 'one\n\ntwo' });
    expect(second.data.events.at(-1)?.data).toEqual({ description: { chars: [3, 8], appended: true } });
  });

  it('over 100000 characters: INVALID_VALUE with the attach fix, nothing written', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'T', status: 'todo', description: 'x'.repeat(99990) });
    const err = await rejectsWith(updateTask(as(s, 'a'), { id: 'LB-1', append_description: 'y'.repeat(9) }), 'INVALID_VALUE');
    expect(err.message).toBe('description would be 100001 characters, over 100000');
    expect(err.fix).toBe('laneboard attach LB-1 <path of a file with the text> --json');
    expect(stored(s, 'LB-1').rev).toBe(1);
    expect((await updateTask(as(s, 'a'), { id: 'LB-1', append_description: 'y'.repeat(8) })).data.description).toHaveLength(100000);
  });

  it('with description: USAGE that drops the append; blank text: INVALID_VALUE', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'T', status: 'todo' });
    const both = await rejectsWith(updateTask(as(s, 'a'), { id: 'LB-1', description: 'a', append_description: 'b' }), 'USAGE');
    expect(both.edit).toEqual({ drop: [{ name: 'append_description' }] });
    await rejectsWith(updateTask(as(s, 'a'), { id: 'LB-1', append_description: '  ' }), 'INVALID_VALUE');
  });
});

describe('§27 result mark', () => {
  it("finish marks its comment result: true (the assignee's and an acceptance); comment never does", async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'T', status: 'todo' });
    await claimTask(as(s, 'dev'), { id: 'LB-1' });
    await commentTask(as(s, 'dev'), { id: 'LB-1', text: 'a note' });
    await finishTask(as(s, 'dev'), { id: 'LB-1', result: 'ready', status: 'review', no_commit: true });
    await finishTask(as(s, 'boss'), { id: 'LB-1', result: 'accepted' });
    const comments = stored(s, 'LB-1').events.filter((e) => e.type === 'commented').map((e) => e.data);
    expect(comments).toEqual([{ text: 'a note' }, { text: 'ready', result: true }, { text: 'accepted', result: true }]);
  });
});
