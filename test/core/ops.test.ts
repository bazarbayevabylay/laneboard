// Business rules of core ops: validation, events, claim, attachments, archive, delete, list, events feed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  archiveTasks,
  attachFile,
  claimTask,
  commentTask,
  createTask,
  deleteTask,
  getTask,
  listEvents,
  listTasks,
  restoreTask,
  updateTask,
} from '../../src/core/index.ts';
import { acquireLock } from '../../src/core/lock.ts';
import { as, cleanupTemp, newStore, readStore, rejectsWith, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

// Patch config.json of a test store.
function patchConfig(s: TestStore, patch: (c: Record<string, any>) => void): void {
  const file = path.join(s.dir, 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  patch(config);
  fs.writeFileSync(file, JSON.stringify(config));
}

// Write a source file for attach tests.
function sourceFile(name: string, content: string): string {
  const file = path.join(tempDir(), name);
  fs.writeFileSync(file, content);
  return file;
}

describe('create', () => {
  it('stores every field and one created event', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'dep', status: 'todo' });
    const r = await createTask(as(s, 'dev-1'), {
      title: 'Fix login',
      status: 'in_progress',
      description: 'line 1\nline 2',
      assignee: 'dev-2',
      labels: ['auth', 'auth', 'bug'],
      links: [{ kind: 'task', ref: 'LB-1' }, { kind: 'branch', ref: 'fix/login' }],
      field_args: ['priority=1'],
    });
    expect(r.data).toMatchObject({
      id: 'LB-2',
      rev: 1,
      status: 'in_progress',
      assignee: 'dev-2',
      labels: ['auth', 'bug'],
      fields: { priority: 1 },
      created_by: 'dev-1',
      archived: false,
      archived_at: null,
    });
    expect(r.data.events.map((e) => e.type)).toEqual(['created']);
  });

  it('validates actor, status, title, labels, fields and task links', async () => {
    const s = await newStore();
    await rejectsWith(createTask(as(s, ''), { title: 'a', status: 'todo' }), 'ACTOR_REQUIRED');
    await rejectsWith(createTask(as(s, 'bad actor'), { title: 'a', status: 'todo' }), 'INVALID_VALUE');
    const st = await rejectsWith(createTask(as(s), { title: 'a', status: 'doing' }), 'UNKNOWN_STATUS');
    expect(st.allowed).toEqual(['todo', 'in_progress', 'review', 'done']);
    expect(st.input?.suggestion).toBeUndefined();
    expect((await rejectsWith(createTask(as(s), { title: 'a', status: 'in-progress' }), 'UNKNOWN_STATUS')).input?.suggestion).toBe('in_progress');
    await rejectsWith(createTask(as(s), { title: '   ', status: 'todo' }), 'INVALID_VALUE');
    await rejectsWith(createTask(as(s), { title: 'a\u0000b', status: 'todo' }), 'INVALID_VALUE');
    await rejectsWith(createTask(as(s), { title: 'x'.repeat(201), status: 'todo' }), 'INVALID_VALUE');
    expect((await createTask(as(s), { title: 'x'.repeat(200), status: 'todo' })).data.id).toBe('LB-1');
    await rejectsWith(createTask(as(s), { title: 'a', status: 'todo', labels: ['Bug'] }), 'INVALID_VALUE');
    const uf = await rejectsWith(createTask(as(s), { title: 'a', status: 'todo', field_args: ['prio=1'] }), 'UNKNOWN_FIELD');
    expect(uf.allowed).toEqual(['priority']);
    await rejectsWith(createTask(as(s), { title: 'a', status: 'todo', field_args: ['priority=high'] }), 'INVALID_VALUE');
    await rejectsWith(createTask(as(s), { title: 'a', status: 'todo', fields: { priority: '1' } }), 'INVALID_VALUE');
    await rejectsWith(createTask(as(s), { title: 'a', status: 'todo', links: [{ kind: 'task', ref: 'LB-99' }] }), 'TASK_NOT_FOUND');
    await rejectsWith(createTask(as(s), { title: 'a', status: 'todo', extra: 1 } as never), 'USAGE');
    expect(readStore(s.dir, 'active').tasks).toHaveLength(1);
  });

  it('parses every declared field type from key=value', async () => {
    const s = await newStore();
    patchConfig(s, (c) => {
      c.fields = { n: { type: 'number' }, b: { type: 'boolean' }, s: { type: 'string' }, l: { type: 'string[]' }, j: { type: 'json' } };
    });
    const r = await createTask(as(s), { title: 'a', status: 'todo', field_args: ['n=2.5', 'b=false', 's=x=y', 'l=a,b', 'j={"k":[1]}'] });
    expect(r.data.fields).toEqual({ n: 2.5, b: false, s: 'x=y', l: ['a', 'b'], j: { k: [1] } });
    await rejectsWith(createTask(as(s), { title: 'a', status: 'todo', field_args: ['b=yes'] }), 'INVALID_VALUE');
    await rejectsWith(createTask(as(s), { title: 'a', status: 'todo', field_args: ['j={bad'] }), 'INVALID_VALUE');
  });
});

describe('ids', () => {
  it('are exact; 12 and lb-12 fail with the exact id as suggestion', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'todo' });
    expect((await rejectsWith(getTask(as(s), { id: '1' }), 'INVALID_VALUE')).input?.suggestion).toBe('LB-1');
    expect((await rejectsWith(getTask(as(s), { id: 'lb-1' }), 'INVALID_VALUE')).input?.suggestion).toBe('LB-1');
    await rejectsWith(getTask(as(s), { id: 'LB-2' }), 'TASK_NOT_FOUND');
  });
});

describe('update', () => {
  it('records one updated event (description as char counts) plus status and assigned events', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'todo', description: 'abc', labels: ['x'] });
    const r = await updateTask(as(s, 'dev'), {
      id: 'LB-1',
      title: 'b',
      description: 'abcdef',
      status: 'review',
      assignee: 'dev',
      add_labels: ['y'],
      remove_labels: ['x'],
      add_links: [{ kind: 'pr', ref: 'https://example.com/pr/1' }],
      field_args: ['priority=0'],
    });
    expect(r.data.rev).toBe(2);
    const [created, updated, status, assigned] = r.data.events;
    expect(created?.type).toBe('created');
    expect(updated).toMatchObject({
      type: 'updated',
      actor: 'dev',
      data: { title: ['a', 'b'], description: { chars: [3, 6] }, labels: [['x'], ['y']], 'fields.priority': [null, 0] },
    });
    expect(status).toMatchObject({ type: 'status', data: { from: 'todo', to: 'review' } });
    expect(assigned).toMatchObject({ type: 'assigned', data: { from: null, to: 'dev' } });

    const unset = await updateTask(as(s), { id: 'LB-1', unset_fields: ['priority'], assignee: null, remove_links: [{ kind: 'pr', ref: 'https://example.com/pr/1' }] });
    expect(unset.data).toMatchObject({ fields: {}, assignee: null, links: [], rev: 3 });
  });

  it('equal values are a no-op with a warning; no change requested is USAGE', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'todo' });
    const r = await updateTask(as(s), { id: 'LB-1', title: 'a', status: 'todo' });
    expect(r.data.rev).toBe(1);
    expect(r.warnings[0]).toContain('no changes');
    await rejectsWith(updateTask(as(s), { id: 'LB-1' }), 'USAGE');
    await rejectsWith(updateTask(as(s), { id: 'LB-1', add_labels: ['a'], remove_labels: ['a'] }), 'USAGE');
    await rejectsWith(updateTask(as(s), { id: 'LB-1', unset_fields: ['nope'] }), 'UNKNOWN_FIELD');
  });

  it('archived tasks are read-only', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'done' });
    await archiveTasks(as(s), { ids: ['LB-1'] });
    expect((await rejectsWith(updateTask(as(s), { id: 'LB-1', title: 'b' }), 'TASK_ARCHIVED')).fix).toBe('laneboard restore LB-1');
    await rejectsWith(claimTask(as(s), { id: 'LB-1' }), 'TASK_ARCHIVED');
    await rejectsWith(commentTask(as(s), { id: 'LB-1', text: 'x' }), 'TASK_ARCHIVED');
    await rejectsWith(attachFile(as(s), { id: 'LB-1', path: sourceFile('a.txt', 'a') }), 'TASK_ARCHIVED');
  });

  it('caps events at limits.events_per_task and counts the dropped ones', async () => {
    const s = await newStore();
    patchConfig(s, (c) => {
      c.limits.events_per_task = 3;
    });
    await createTask(as(s), { title: 'a', status: 'todo' });
    for (let i = 0; i < 4; i++) await commentTask(as(s), { id: 'LB-1', text: `c${i}` });
    const t = (await getTask(as(s), { id: 'LB-1' })).data;
    expect(t.events.map((e) => e.data.text)).toEqual(['c1', 'c2', 'c3']);
    expect(t.events_dropped).toBe(2);
    expect((await getTask(as(s), { id: 'LB-1', events: 1 })).data.events.map((e) => e.data.text)).toEqual(['c3']);
  });
});

describe('claim', () => {
  it('assigns the actor, sets status, and refuses a task held by someone else', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'todo' });
    const r = await claimTask(as(s, 'dev-1'), { id: 'LB-1', status: 'in_progress' });
    expect(r.data).toMatchObject({ assignee: 'dev-1', status: 'in_progress', rev: 2 });
    const again = await claimTask(as(s, 'dev-1'), { id: 'LB-1' });
    expect(again.data.rev).toBe(2);
    const err = await rejectsWith(claimTask(as(s, 'dev-2'), { id: 'LB-1' }), 'ALREADY_CLAIMED');
    expect(err.details).toEqual({ assignee: 'dev-1' });
    // Agents run a fix as is, so neither the fix nor the message names a takeover command.
    expect(err.fix).toBe('laneboard comment LB-1 "<note for dev-1>" --as dev-2');
    expect(err.message).toBe("task LB-1 is already claimed by dev-1; do not take it over: reassignment is the orchestrator's decision");
    expect(err.message).not.toContain('--assignee');
    await rejectsWith(claimTask(as(s, 'dev-1'), { id: 'LB-1', expected_rev: 1 }), 'REV_CONFLICT');
  });
});

describe('comment', () => {
  it('appends a commented event; blank and over-long text are rejected', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'todo' });
    const r = await commentTask(as(s), { id: 'LB-1', text: 'done: see PR' });
    expect(r.data.events.at(-1)).toMatchObject({ type: 'commented', data: { text: 'done: see PR' } });
    await rejectsWith(commentTask(as(s), { id: 'LB-1', text: ' \n ' }), 'INVALID_VALUE');
    await rejectsWith(commentTask(as(s), { id: 'LB-1', text: 'x'.repeat(10001) }), 'INVALID_VALUE');
  });
});

describe('attach', () => {
  it('copies the file, records metadata, refuses duplicates, secrets and oversize files, and detaches', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'todo' });
    const src = sourceFile('report.md', '# hi\n');
    const r = await attachFile(as(s), { id: 'LB-1', path: src });
    expect(r.data.attachments[0]).toMatchObject({ name: 'report.md', size: 5, mime: 'text/markdown' });
    const stored = path.join(s.dir, 'attachments', 'LB-1', 'report.md');
    expect(fs.readFileSync(stored, 'utf8')).toBe('# hi\n');
    expect(fs.readdirSync(s.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    await rejectsWith(attachFile(as(s), { id: 'LB-1', path: src }), 'ATTACHMENT_EXISTS');
    await rejectsWith(attachFile(as(s), { id: 'LB-1', path: sourceFile('server.pem', 'k') }), 'INVALID_VALUE');
    await rejectsWith(attachFile(as(s), { id: 'LB-1', path: sourceFile('.env.local', 'k'), name: 'notes.txt' }), 'INVALID_VALUE');
    await rejectsWith(attachFile(as(s), { id: 'LB-1', path: 'relative.txt' }), 'INVALID_VALUE');
    patchConfig(s, (c) => {
      c.limits.attachment_bytes = 3;
    });
    await rejectsWith(attachFile(as(s), { id: 'LB-1', path: sourceFile('big.txt', 'four'), name: 'big.txt' }), 'INVALID_VALUE');

    const off = await attachFile(as(s), { id: 'LB-1', remove: 'report.md' });
    expect(off.data.attachments).toEqual([]);
    expect(fs.existsSync(stored)).toBe(false);
    await rejectsWith(attachFile(as(s), { id: 'LB-1', remove: 'report.md' }), 'ATTACHMENT_NOT_FOUND');
  });

  it('a symlink to a secret is refused by its target name; a secret is refused before the name format check', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'todo' });
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=x\n');
    fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'config-notes.txt'));
    const viaLink = await rejectsWith(attachFile(as(s), { id: 'LB-1', path: path.join(dir, 'config-notes.txt') }), 'INVALID_VALUE');
    expect(viaLink.message).toContain('link target of config-notes.txt ".env" matches attachments.deny_names');
    expect(fs.existsSync(path.join(s.dir, 'attachments', 'LB-1'))).toBe(false);
    // `.env` fails the name format too; the secret rule must win, or the fix would suggest renaming a secret.
    const direct = await rejectsWith(attachFile(as(s), { id: 'LB-1', path: path.join(dir, '.env') }), 'INVALID_VALUE');
    expect(direct.message).toContain('deny_names');
    expect(direct.fix).not.toContain('--name');
    // A link to an ordinary file is fine and stores the target's bytes.
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'plain');
    fs.symlinkSync(path.join(dir, 'notes.txt'), path.join(dir, 'link.txt'));
    const ok = await attachFile(as(s), { id: 'LB-1', path: path.join(dir, 'link.txt') });
    expect(ok.data.attachments[0]).toMatchObject({ name: 'link.txt', size: 5 });
  });

  it('reads the source before taking the lock (M2): bytes changed while waiting for the lock are not stored', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'todo' });
    const src = sourceFile('log.txt', 'before');
    const held = await acquireLock(s.dir);
    const pending = attachFile(as(s, 'tester', { lockWaitMs: 5000 }), { id: 'LB-1', path: src });
    fs.writeFileSync(src, 'after, while the lock was busy');
    await held.release();
    const r = await pending;
    expect(fs.readFileSync(path.join(s.dir, 'attachments', 'LB-1', 'log.txt'), 'utf8')).toBe('before');
    expect(r.data.attachments[0]).toMatchObject({ size: 6 });
  });

  it('refuses a directory and a FIFO without hanging, with a concrete fix', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'todo' });
    const dir = tempDir();
    const asDir = await rejectsWith(attachFile(as(s), { id: 'LB-1', path: dir }), 'INVALID_VALUE');
    expect(asDir.fix).toContain('regular file');
    const fifo = path.join(dir, 'pipe.txt');
    execFileSync('mkfifo', [fifo]);
    await rejectsWith(attachFile(as(s), { id: 'LB-1', path: fifo }), 'INVALID_VALUE');
    patchConfig(s, (c) => {
      c.limits.attachment_bytes = 3;
    });
    const big = await rejectsWith(attachFile(as(s), { id: 'LB-1', path: sourceFile('big.txt', 'four') }), 'INVALID_VALUE');
    expect(big.fix).toBe('attach a file of at most 3 bytes, or raise limits.attachment_bytes in .laneboard/config.json');
    expect((await attachFile(as(s), { id: 'LB-1', path: sourceFile('ok.txt', 'abc') })).data.attachments[0]).toMatchObject({ size: 3 });
  });
});

describe('archive, restore, delete', () => {
  it('archives by id, refuses a second archive, restores, and bulk-archives by status and age', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'done' });
    await createTask(as(s), { title: 'b', status: 'done' });
    const a = await archiveTasks(as(s), { ids: ['LB-1'] });
    expect(a.data).toEqual({ archived: [{ id: 'LB-1', rev: 2 }], dry_run: false });
    expect((await getTask(as(s), { id: 'LB-1' })).data).toMatchObject({ archived: true, rev: 2 });
    await rejectsWith(archiveTasks(as(s), { ids: ['LB-1'] }), 'TASK_ARCHIVED');
    await rejectsWith(restoreTask(as(s), { id: 'LB-2' }), 'INVALID_VALUE');
    const back = await restoreTask(as(s), { id: 'LB-1' });
    expect(back.data).toMatchObject({ archived: false, archived_at: null, rev: 3 });
    expect(back.data.events.map((e) => e.type)).toEqual(['created', 'archived', 'restored']);

    const none = await archiveTasks(as(s), { status: 'done', updated_before: '1d', dry_run: true });
    expect(none.data.archived).toEqual([]);
    await rejectsWith(archiveTasks(as(s), { status: 'done', updated_before: '1 day' }), 'INVALID_VALUE');
    await rejectsWith(archiveTasks(as(s), { status: 'done' }), 'USAGE');
    await rejectsWith(archiveTasks(as(s), { ids: ['LB-1', 'LB-2'], expected_rev: 1 }), 'USAGE');
    await rejectsWith(archiveTasks(as(s), { ids: ['LB-1', 'LB-9'] }), 'TASK_NOT_FOUND');
    expect(readStore(s.dir, 'archive').tasks).toEqual([]);
  });

  it('bulk archive selects by updated_at (dry run writes nothing)', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'old', status: 'done' });
    await createTask(as(s), { title: 'new', status: 'done' });
    await createTask(as(s), { title: 'todo', status: 'todo' });
    const file = path.join(s.dir, 'active.json');
    const data = readStore(s.dir, 'active');
    (data.tasks[0] as Record<string, unknown>).updated_at = '2020-01-01T00:00:00.000Z';
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, JSON.stringify(data));
    const before = fs.readFileSync(file, 'utf8');
    const dry = await archiveTasks(as(s), { status: 'done', updated_before: '30d', dry_run: true });
    expect(dry.data).toEqual({ archived: [{ id: 'LB-1', rev: 1 }], dry_run: true });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    const real = await archiveTasks(as(s), { status: 'done', updated_before: '30d' });
    expect(real.data.archived.map((t) => t.id)).toEqual(['LB-1']);
  });

  it('delete needs the exact confirm id, works in active and archive, and removes attachments', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'todo' });
    await createTask(as(s), { title: 'b', status: 'done' });
    await attachFile(as(s), { id: 'LB-1', path: sourceFile('a.txt', 'a') });
    const bad = await rejectsWith(deleteTask(as(s), { id: 'LB-1', confirm_id: 'LB-2' }), 'INVALID_VALUE');
    expect(bad.input?.suggestion).toBe('LB-1');
    await rejectsWith(deleteTask(as(s), { id: 'LB-1', confirm_id: 'LB-1', expected_rev: 1 }), 'REV_CONFLICT');
    expect((await deleteTask(as(s), { id: 'LB-1', confirm_id: 'LB-1' })).data).toEqual({ id: 'LB-1', deleted: true });
    expect(fs.existsSync(path.join(s.dir, 'attachments', 'LB-1'))).toBe(false);
    await archiveTasks(as(s), { ids: ['LB-2'] });
    await deleteTask(as(s), { id: 'LB-2', confirm_id: 'LB-2' });
    expect((await listTasks(as(s), { scope: 'all' })).data.total).toBe(0);
    await rejectsWith(deleteTask(as(s), { id: 'LB-2', confirm_id: 'LB-2' }), 'TASK_NOT_FOUND');
  });
});

describe('list', () => {
  it('filters, sorts by updated_at desc, pages, and states scope/limit/offset/total', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'Alpha login', status: 'todo', labels: ['auth'] });
    await createTask(as(s), { title: 'Beta', status: 'review', assignee: 'dev-1' });
    await createTask(as(s), { title: 'Gamma', status: 'todo', description: 'about LOGIN too' });
    await createTask(as(s), { title: 'Old', status: 'done' });
    await archiveTasks(as(s), { ids: ['LB-4'] });

    const all = await listTasks(as(s), {});
    expect(all.data).toMatchObject({ scope: 'active', limit: 20, offset: 0, total: 3 });
    expect(all.data.items.map((i) => i.id)).toEqual(['LB-3', 'LB-2', 'LB-1']);
    expect(Object.keys(all.data.items[0] ?? {})).toEqual(['id', 'title', 'status', 'assignee', 'labels', 'updated_at', 'updated_by', 'rev', 'archived']);
    expect((await listTasks(as(s), { status: ['todo'] })).data.total).toBe(2);
    expect((await listTasks(as(s), { assignee: 'dev-1' })).data.items.map((i) => i.id)).toEqual(['LB-2']);
    expect((await listTasks(as(s), { unassigned: true })).data.total).toBe(2);
    expect((await listTasks(as(s), { labels: ['auth'] })).data.items.map((i) => i.id)).toEqual(['LB-1']);
    expect((await listTasks(as(s), { text: 'login' })).data.items.map((i) => i.id)).toEqual(['LB-3', 'LB-1']);
    const page = await listTasks(as(s), { limit: 2, offset: 2 });
    expect(page.data).toMatchObject({ limit: 2, offset: 2, total: 3 });
    expect(page.data.items.map((i) => i.id)).toEqual(['LB-1']);
    expect((await listTasks(as(s), { scope: 'archive' })).data.items).toMatchObject([{ id: 'LB-4', archived: true }]);
    expect((await listTasks(as(s), { scope: 'all', text: 'old' })).data.total).toBe(1);
    await rejectsWith(listTasks(as(s), { limit: 201 }), 'INVALID_VALUE');
    await rejectsWith(listTasks(as(s), { status: ['doing'] }), 'UNKNOWN_STATUS');
    await rejectsWith(listTasks(as(s), { assignee: 'a', unassigned: true }), 'USAGE');
    await rejectsWith(listTasks(as(s), { scope: 'everything' as never }), 'INVALID_VALUE');
  });
});

describe('events feed', () => {
  it('lists events newest first, by task, since a time, with a limit', async () => {
    const s = await newStore();
    // Distinct timestamps: events from different tasks in the same millisecond have no defined order.
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 3));
    await createTask(as(s), { title: 'a', status: 'todo' });
    await tick();
    await createTask(as(s), { title: 'b', status: 'todo' });
    await tick();
    await commentTask(as(s), { id: 'LB-1', text: 'hi' });
    const all = await listEvents(as(s), {});
    expect(all.data.items.map((e) => `${e.task_id}:${e.type}`)).toEqual(['LB-1:commented', 'LB-2:created', 'LB-1:created']);
    expect(all.data.total).toBe(3);
    expect((await listEvents(as(s), { task: 'LB-2' })).data.items.map((e) => e.type)).toEqual(['created']);
    expect((await listEvents(as(s), { limit: 1 })).data).toMatchObject({ limit: 1, total: 3 });
    const since = all.data.items[1]?.at ?? '';
    expect((await listEvents(as(s), { since })).data.items.every((e) => e.at > since)).toBe(true);
    await rejectsWith(listEvents(as(s), { since: 'yesterday' }), 'INVALID_VALUE');
  });
});

// Usability round 1: what agents had to learn from a second error, they now get from the first one.
describe('errors and results that answer the next question', () => {
  it('UNKNOWN_FIELD names each declared field with its type, description and an example', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'x', status: 'todo' });
    const err = await rejectsWith(updateTask(as(s, 'a'), { id: 'LB-1', field_args: ['prio=3'] }), 'UNKNOWN_FIELD');
    expect(err.message).toBe('field "prio" is not declared in config.fields (declared: priority (number, 0 = highest))');
    expect(err.details).toEqual({ fields: { priority: { type: 'number', description: '0 = highest', example: 'priority=1' } } });
  });

  it('INVALID_VALUE for a field names its type with an example, for key=value and typed fields', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'x', status: 'todo' });
    const cli = await rejectsWith(updateTask(as(s, 'a'), { id: 'LB-1', field_args: ['priority=zzz'] }), 'INVALID_VALUE');
    expect(cli.message).toBe('field priority is number: expected a number (e.g. priority=1), got "zzz"');
    expect(cli.details).toEqual({ field: 'priority', type: 'number', example: 'priority=1' });
    const typed = await rejectsWith(updateTask(as(s, 'a'), { id: 'LB-1', fields: { priority: 'zzz' } }), 'INVALID_VALUE');
    expect(typed.message).toBe('field priority must be number (e.g. {"priority": 1}), got "zzz"');
    expect(typed.fix).toBe('pass priority as a number value, e.g. fields: {"priority": 1}');
  });

  it('a comment returns the new rev, so an update right after it with that rev succeeds; REV_CONFLICT carries the current task', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'x', status: 'todo' });
    const commented = await commentTask(as(s, 'a'), { id: 'LB-1', text: 'note' });
    expect(commented.data.rev).toBe(2);
    expect((await updateTask(as(s, 'a'), { id: 'LB-1', title: 'y', expected_rev: commented.data.rev })).data.rev).toBe(3);
    const err = await rejectsWith(updateTask(as(s, 'a'), { id: 'LB-1', title: 'z', expected_rev: 2 }), 'REV_CONFLICT');
    expect(err.details?.task as { rev: number; title: string }).toMatchObject({ rev: 3, title: 'y' });
    expect(err.fix).toBe("details.task is the current LB-1 (rev 3): re-apply your change on it (merge, do not overwrite others' edits) with --expected-rev 3");
  });

  it('list items say who changed the task last', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'x', status: 'todo' });
    await updateTask(as(s, 'agent-omega'), { id: 'LB-1', status: 'done' });
    expect((await listTasks(as(s), {})).data.items[0]).toMatchObject({ id: 'LB-1', assignee: null, updated_by: 'agent-omega' });
  });
});
