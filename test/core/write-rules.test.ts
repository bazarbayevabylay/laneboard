// Write rules W2-W11 of ADR-0001 section 4 (single-process parts; multi-process races live in race.test.ts).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { archiveTasks, createTask, deleteTask, getTask, listTasks, restoreTask, updateTask } from '../../src/core/index.ts';
import { acquireLock } from '../../src/core/lock.ts';
import { contentSha } from '../../src/core/store.ts';
import { as, cleanupTemp, CLI_SOURCE, newStore, readStore, rejectsWith, spawnNode, writeRaw } from '../helpers.ts';

afterAll(cleanupTemp);

const tmpFiles = (dir: string): string[] => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
const mode = (file: string): number => fs.statSync(file).mode & 0o777;

describe('W4 atomic write', () => {
  it('a crash after the tmp write leaves the original intact; the next transact removes the tmp', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'first', status: 'todo' });
    const file = path.join(s.dir, 'active.json');
    const before = fs.readFileSync(file, 'utf8');
    await expect(createTask(as(s, 'tester', { faults: { at: 'after_tmp_write' } }), { title: 'second', status: 'todo' })).rejects.toThrow('fault injected');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(tmpFiles(s.dir)).toHaveLength(1);

    const third = await createTask(as(s), { title: 'third', status: 'todo' });
    expect(third.data.id).toBe('LB-2');
    expect(tmpFiles(s.dir)).toEqual([]);
    expect(mode(file)).toBe(0o444);
  });

  it('writes the previous good version to .bak before replacing the file', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'one', status: 'todo' });
    const afterOne = fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8');
    await createTask(as(s), { title: 'two', status: 'todo' });
    expect(fs.readFileSync(path.join(s.dir, 'active.json.bak'), 'utf8')).toBe(afterOne);
    expect(mode(path.join(s.dir, 'active.json.bak'))).toBe(0o444);
  });
});

describe('W5 revisions', () => {
  it('file rev +1 per write, task rev +1 per change', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'todo' });
    expect(readStore(s.dir, 'active').rev).toBe(1);
    const r = await updateTask(as(s), { id: 'LB-1', title: 'b', status: 'review' });
    expect(r.data.rev).toBe(2);
    expect(readStore(s.dir, 'active').rev).toBe(2);
  });

  it('two parallel updates with the same expected_rev: exactly one ok, one REV_CONFLICT with the current task', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'todo' });
    const results = await Promise.allSettled([
      updateTask(as(s, 'one'), { id: 'LB-1', title: 'from one', expected_rev: 1 }),
      updateTask(as(s, 'two'), { id: 'LB-1', title: 'from two', expected_rev: 1 }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason.code).toBe('REV_CONFLICT');
    expect(failed[0]?.reason.details.task.rev).toBe(2);
    expect((await getTask(as(s), { id: 'LB-1' })).data.rev).toBe(2);
  });
});

describe('W6 archive/restore write order', () => {
  it('a crash between the two files keeps the task (in both files); readers see it once in archive; the next transact cleans active', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'done' });
    await expect(archiveTasks(as(s, 'tester', { faults: { at: 'between_files' } }), { ids: ['LB-1'] })).rejects.toThrow('fault injected');
    expect(readStore(s.dir, 'active').tasks.map((t) => t.id)).toEqual(['LB-1']);
    expect(readStore(s.dir, 'archive').tasks.map((t) => t.id)).toEqual(['LB-1']);

    const got = await getTask(as(s), { id: 'LB-1' });
    expect(got.data.archived).toBe(true);
    expect((await listTasks(as(s), { scope: 'all' })).data.total).toBe(1);

    const next = await createTask(as(s), { title: 'b', status: 'todo' });
    expect(next.warnings.join()).toContain('repaired duplicate ids');
    expect(readStore(s.dir, 'active').tasks.map((t) => t.id)).toEqual(['LB-2']);
    expect(readStore(s.dir, 'archive').tasks.map((t) => t.id)).toEqual(['LB-1']);
  });

  it('restore writes active first: a crash between the files shows the task as active', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'done' });
    await archiveTasks(as(s), { ids: ['LB-1'] });
    await expect(restoreTask(as(s, 'tester', { faults: { at: 'between_files' } }), { id: 'LB-1' })).rejects.toThrow('fault injected');
    expect(readStore(s.dir, 'active').tasks.map((t) => t.id)).toEqual(['LB-1']);
    expect(readStore(s.dir, 'archive').tasks.map((t) => t.id)).toEqual(['LB-1']);
    expect((await getTask(as(s), { id: 'LB-1' })).data.archived).toBe(false);
  });
});

describe('W9 next_id', () => {
  it('never decreases: delete the highest id, then create gets a larger id', async () => {
    const s = await newStore();
    for (const t of ['a', 'b', 'c']) await createTask(as(s), { title: t, status: 'todo' });
    await deleteTask(as(s), { id: 'LB-3', confirm_id: 'LB-3' });
    expect((await createTask(as(s), { title: 'd', status: 'todo' })).data.id).toBe('LB-4');
    expect(readStore(s.dir, 'active').next_id).toBe(5);
  });
});

describe('W10 newer store version', () => {
  it('writes fail with STORE_TOO_NEW; reads still work', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'todo' });
    const file = path.join(s.dir, 'active.json');
    const data = readStore(s.dir, 'active');
    data.schema = 'laneboard/store@2';
    writeRaw(file, JSON.stringify(data, null, 2));
    await rejectsWith(createTask(as(s), { title: 'b', status: 'todo' }), 'STORE_TOO_NEW');
    expect((await getTask(as(s), { id: 'LB-1' })).data.title).toBe('a');
    expect((await listTasks(as(s), {})).data.total).toBe(1);
  });
});

describe('W11 unknown properties', () => {
  it('survive a rewrite at file, task and event level', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'todo' });
    const file = path.join(s.dir, 'active.json');
    const data = readStore(s.dir, 'active');
    data.x_future = { file: true };
    const task = data.tasks[0] as unknown as { events: Array<Record<string, unknown>> } & Record<string, unknown>;
    task.x_future = 'task';
    task.events[0] = { ...task.events[0], x_future: 'event' };
    data.content_sha256 = contentSha(data.tasks);
    writeRaw(file, JSON.stringify(data, null, 2));

    await updateTask(as(s), { id: 'LB-1', title: 'b' });
    const after = readStore(s.dir, 'active');
    expect(after.x_future).toEqual({ file: true });
    expect(after.tasks[0]?.x_future).toBe('task');
    expect((after.tasks[0]?.events as Array<Record<string, unknown>>)[0]?.x_future).toBe('event');
    expect(after.tasks[0]?.title).toBe('b');
  });
});

describe('W3 fresh reads', () => {
  it('a long-lived process sees a write made by another process on its next read', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'before', status: 'todo' });
    expect((await getTask(as(s), { id: 'LB-1' })).data.title).toBe('before');
    const run = await spawnNode([CLI_SOURCE, 'update', 'LB-1', '--title', 'after', '--as', 'other', '--dir', s.dir]);
    expect(run.code).toBe(0);
    expect((await getTask(as(s), { id: 'LB-1' })).data.title).toBe('after');
  });
});

describe('W2 lock wait budget', () => {
  it('a live holder makes writers fail with LOCK_TIMEOUT after the wait budget', async () => {
    const s = await newStore();
    const held = await acquireLock(s.dir);
    try {
      const started = Date.now();
      await rejectsWith(createTask(as(s, 'tester', { lockWaitMs: 300 }), { title: 'a', status: 'todo' }), 'LOCK_TIMEOUT');
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    } finally {
      await held.release();
    }
    expect((await createTask(as(s), { title: 'a', status: 'todo' })).data.id).toBe('LB-1');
  });

  it('a stale lock directory (mtime older than 10 s) is taken over at once', async () => {
    const s = await newStore();
    const lockDir = path.join(s.dir, 'lock');
    fs.mkdirSync(lockDir);
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(lockDir, old, old);
    const started = Date.now();
    expect((await createTask(as(s, 'tester', { lockWaitMs: 2000 }), { title: 'a', status: 'todo' })).data.id).toBe('LB-1');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
