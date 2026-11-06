// S6e (LB-31, audit A11, A12, A13): delete leaves a tombstone in archive.json (CLI only, no MCP tool); `redact` removes a text from a
// task and from the store backups; replacing a description keeps the old text in the event; a failed metadata write of attach
// removes the stored file (transact rollback hook).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  archiveTasks,
  attachFile,
  commentTask,
  createTask,
  deleteTask,
  doctor,
  getTask,
  listTasks,
  redactTask,
  restoreTask,
  transact,
  updateTask,
} from '../../src/core/index.ts';
import { contentSha } from '../../src/core/store.ts';
import { as, cleanupTemp, cli, newStore, readStore, rejectsWith, tempDir, writeRaw } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// A source file for attach, outside the store.
function sourceFile(name: string, content: string): string {
  const file = path.join(tempDir(), name);
  fs.writeFileSync(file, content);
  return file;
}

// The stored task of either file.
function stored(s: TestStore, id: string): Record<string, unknown> & { id: string; rev: number } {
  const task = [...readStore(s.dir, 'active').tasks, ...readStore(s.dir, 'archive').tasks].find((t) => t.id === id);
  if (!task) throw new Error(`${id} is in neither file`);
  return task;
}

// sha256 of every store file and backup (to prove a refused write changed nothing).
function storeShas(s: TestStore): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['active.json', 'active.json.bak', 'archive.json', 'archive.json.bak']) {
    const file = path.join(s.dir, name);
    out[name] = fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'missing';
  }
  return out;
}

// How often `text` occurs in each store file and backup (what `grep -c` over .laneboard/*.json* would count, per occurrence).
function occurrences(s: TestStore, text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of ['active.json', 'active.json.bak', 'archive.json', 'archive.json.bak']) {
    const file = path.join(s.dir, name);
    out[name] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(text).length - 1 : 0;
  }
  return out;
}

const NONE = { 'active.json': 0, 'active.json.bak': 0, 'archive.json': 0, 'archive.json.bak': 0 };

// A task with something in every part a delete must drop: description, label, link, field, attachment, history.
async function fullTask(s: TestStore): Promise<void> {
  await createTask(as(s, 'a'), { title: 'Payments export', status: 'todo', description: 'old text', labels: ['ops'], links: [{ kind: 'url', ref: 'https://example.com' }] });
  await commentTask(as(s, 'b'), { id: 'LB-1', text: 'looking' });
  await attachFile(as(s, 'b'), { id: 'LB-1', path: sourceFile('notes.txt', 'notes') });
}

describe('A11 delete leaves a tombstone in archive.json', () => {
  it('an active task: gone from active.json; the archive keeps id, title, status, dates, who and when, nothing else', async () => {
    const s = await newStore();
    await fullTask(s);
    await createTask(as(s, 'a'), { title: 'Other', status: 'todo' });
    const before = stored(s, 'LB-1') as unknown as { events: unknown[]; events_dropped: number; rev: number; created_at: string };
    const r = await deleteTask(as(s, 'owner'), { id: 'LB-1', confirm_id: 'LB-1' });
    expect(r.data).toEqual({ id: 'LB-1', deleted: true });
    expect(readStore(s.dir, 'active').tasks.map((t) => t.id)).toEqual(['LB-2']);
    const tomb = readStore(s.dir, 'archive').tasks[0] as unknown as { deleted: { at: string; by: string } };
    expect(tomb).toEqual({
      id: 'LB-1',
      rev: before.rev + 1,
      title: 'Payments export',
      description: '',
      status: 'todo',
      assignee: null,
      labels: [],
      links: [],
      fields: {},
      attachments: [],
      events: [{ at: tomb.deleted.at, actor: 'owner', actor_source: 'explicit', type: 'archived', data: { deleted: true } }],
      events_dropped: before.events_dropped + before.events.length,
      created_at: before.created_at,
      created_by: 'a',
      updated_at: tomb.deleted.at,
      updated_by: 'owner',
      archived_at: tomb.deleted.at,
      deleted: { at: tomb.deleted.at, by: 'owner' },
    });
    expect(tomb.deleted.at).toMatch(ISO);
    expect(fs.existsSync(path.join(s.dir, 'attachments', 'LB-1'))).toBe(false);
    // next_id is untouched (W9) and the store stays healthy.
    expect(readStore(s.dir, 'active').next_id).toBe(3);
    expect((await doctor(as(s), {})).data.healthy).toBe(true);
    // Reads see an archived task with one event.
    const got = (await getTask(as(s), { id: 'LB-1' })).data;
    expect(got).toMatchObject({ archived: true, description: '', events: [{ type: 'archived', actor: 'owner', data: { deleted: true } }] });
    expect((await listTasks(as(s), { scope: 'archive' })).data.items.map((t) => t.id)).toEqual(['LB-1']);
  });

  it('an archived task is replaced by its tombstone (only archive.json changes)', async () => {
    const s = await newStore();
    await fullTask(s);
    await archiveTasks(as(s, 'a'), { ids: ['LB-1'] });
    const active = fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8');
    await deleteTask(as(s, 'owner'), { id: 'LB-1', confirm_id: 'LB-1' });
    expect(fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8')).toBe(active);
    const archive = readStore(s.dir, 'archive').tasks;
    expect(archive).toHaveLength(1);
    expect(archive[0]).toMatchObject({ id: 'LB-1', description: '', deleted: { by: 'owner' } });
  });

  it('restore and a second delete of a tombstone are refused with when and by whom; nothing is written', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'x', status: 'todo' });
    await deleteTask(as(s, 'owner'), { id: 'LB-1', confirm_id: 'LB-1' });
    const at = (stored(s, 'LB-1').deleted as { at: string }).at;
    const shas = storeShas(s);
    const restore = await rejectsWith(restoreTask(as(s, 'a'), { id: 'LB-1' }), 'INVALID_VALUE');
    expect(restore.message).toBe(`LB-1 was deleted at ${at} by owner`);
    expect(restore.fix).toBe('nothing to do: the archive keeps only its title and who deleted it; to see it: laneboard get LB-1 --json');
    const again = await rejectsWith(deleteTask(as(s, 'owner'), { id: 'LB-1', confirm_id: 'LB-1' }), 'INVALID_VALUE');
    expect(again.message).toBe(`LB-1 was deleted at ${at} by owner`);
    // Other writes of an archived task stay refused as before.
    await rejectsWith(commentTask(as(s, 'a'), { id: 'LB-1', text: 'x' }), 'TASK_ARCHIVED');
    expect(storeShas(s)).toEqual(shas);
  });

  it('a crash between the two files (archive.json written first, W6) keeps the tombstone: the newer rev wins the duplicate', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'x', status: 'todo', description: 'body' });
    await expect(deleteTask(as(s, 'owner', { faults: { at: 'between_files' } }), { id: 'LB-1', confirm_id: 'LB-1' })).rejects.toThrow('fault injected');
    expect(readStore(s.dir, 'active').tasks.map((t) => t.id)).toEqual(['LB-1']);
    expect(readStore(s.dir, 'archive').tasks.map((t) => t.id)).toEqual(['LB-1']);
    expect((await getTask(as(s), { id: 'LB-1' })).data).toMatchObject({ archived: true, description: '' });
  });

  it('the tombstone of the 0.3.1 experiment (ADR §24 check) reads and writes; the CLI tombstone has its shape', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'kept', status: 'todo' });
    await createTask(as(s, 'a'), { title: 'Gone task', status: 'todo' });
    // archive.json as scratchpad/lb-plan-architect-exp/tomb.mjs wrote it for 0.3.1 (one task turned into a tombstone by hand).
    const at = '2026-11-04T19:05:54.686Z';
    const fixtureTomb = {
      id: 'LB-9',
      rev: 3,
      title: 'Deleted under 0.3.1',
      description: '',
      status: 'todo',
      assignee: null,
      labels: [],
      links: [],
      fields: {},
      attachments: [],
      events: [{ at, actor: 'owner', type: 'archived', data: { deleted: true } }],
      events_dropped: 2,
      created_at: '2026-11-04T19:00:00.000Z',
      created_by: 'a',
      updated_at: at,
      updated_by: 'owner',
      archived_at: at,
      deleted: { at, by: 'owner' },
    };
    const archive = readStore(s.dir, 'archive');
    writeRaw(path.join(s.dir, 'archive.json'), `${JSON.stringify({ ...archive, tasks: [fixtureTomb], content_sha256: contentSha([fixtureTomb]) }, null, 2)}\n`);
    expect((await getTask(as(s), { id: 'LB-9' })).data).toMatchObject({ archived: true, title: 'Deleted under 0.3.1' });
    expect((await listTasks(as(s), { scope: 'all' })).data.total).toBe(3);
    // The fixture's id is above next_id: create skips past it.
    expect((await createTask(as(s, 'a'), { title: 'new', status: 'todo' })).data.id).toBe('LB-10');
    expect((await doctor(as(s), {})).data.healthy).toBe(true);
    await rejectsWith(restoreTask(as(s, 'a'), { id: 'LB-9' }), 'INVALID_VALUE');
    // A write of archive.json keeps the mark of the fixture.
    await archiveTasks(as(s, 'a'), { ids: ['LB-1'] });
    expect(stored(s, 'LB-9')).toEqual(fixtureTomb);
    // Our own tombstone has exactly the fixture's keys (plus actor_source on its event, as every event since S2g).
    await deleteTask(as(s, 'owner'), { id: 'LB-2', confirm_id: 'LB-2' });
    const ours = stored(s, 'LB-2');
    expect(Object.keys(ours).sort()).toEqual(Object.keys(fixtureTomb).sort());
    expect(Object.keys((ours.events as object[])[0] ?? {}).sort()).toEqual(['actor', 'actor_source', 'at', 'data', 'type']);
  });

  it('CLI: delete replies as before; get shows the trace', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'x', status: 'todo' });
    const del = await cli(['delete', 'LB-1', '--confirm', 'LB-1', '--as', 'owner', '--json'], { cwd: s.root });
    expect(del.code).toBe(0);
    expect(JSON.parse(del.stdout).data).toEqual({ id: 'LB-1', deleted: true });
    const got = await cli(['get', 'LB-1'], { cwd: s.root });
    expect(got.stdout).toContain('owner  archived  deleted=true');
  });
});

describe('A12 redact', () => {
  const SECRET = 'sk-live-4f9a2c7e11';

  it('removes the secret from a comment and from the replaced description, in both files and both backups', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Deploy', status: 'todo', description: `token ${SECRET} for prod` });
    await commentTask(as(s, 'b'), { id: 'LB-1', text: `use ${SECRET} please` });
    // The replace keeps the old text in its event (A13): the secret is in the history twice (comment, previous description).
    await updateTask(as(s, 'a'), { id: 'LB-1', description: 'token is in the vault' });
    await createTask(as(s, 'a'), { title: 'Other', status: 'todo' });
    expect(occurrences(s, SECRET)['active.json']).toBe(2);
    expect(occurrences(s, SECRET)['active.json.bak']).toBeGreaterThan(0);
    const rev = stored(s, 'LB-1').rev;
    const inBackups = occurrences(s, SECRET)['active.json.bak'] + occurrences(s, SECRET)['archive.json.bak'];
    const secretFile = sourceFile('secret.txt', `${SECRET}\n`);
    const run = await cli(['redact', 'LB-1', '--text-file', secretFile, '--as', 'owner', '--json'], { cwd: s.root });
    expect(run.code, run.stderr).toBe(0);
    const reply = JSON.parse(run.stdout);
    expect(reply.data).toEqual({ id: 'LB-1', rev: rev + 1, redacted: 2, backups: inBackups });
    expect(run.stdout).not.toContain(SECRET);
    expect(occurrences(s, SECRET)).toEqual(NONE);
    const task = (await getTask(as(s), { id: 'LB-1' })).data;
    expect(task.events.find((e) => e.type === 'commented')?.data.text).toBe('use [redacted] please');
    expect(task.events.at(-1)).toMatchObject({ actor: 'owner', type: 'updated', data: { redacted: { count: 2, backups: inBackups } } });
    // The other task is untouched and the store is healthy.
    expect(stored(s, 'LB-2').rev).toBe(1);
    expect((await doctor(as(s), {})).data.healthy).toBe(true);
  });

  it('covers title, link refs, field values (nested) and a tombstone in the archive', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), {
      title: `Rotate ${SECRET}`,
      status: 'todo',
      links: [{ kind: 'url', ref: `https://example.com/?key=${SECRET}` }],
      fields: {},
    });
    await deleteTask(as(s, 'owner'), { id: 'LB-1', confirm_id: 'LB-1' });
    // The tombstone keeps the title, so the secret is in archive.json; the active.json.bak still holds the deleted task.
    expect(occurrences(s, SECRET)['archive.json']).toBe(1);
    const r = await redactTask(as(s, 'owner'), { id: 'LB-1', text: SECRET });
    expect(r.data.redacted).toBe(1);
    expect(stored(s, 'LB-1').title).toBe('Rotate [redacted]');
    // Both files and both backups are written from the new content, so the deleted task's copy in active.json.bak goes too.
    expect(occurrences(s, SECRET)).toEqual(NONE);
    // Redact the live task first, then delete (the guide's order: after a delete only the title is left to find).
    const t = await newStore();
    await createTask(as(t, 'a'), { title: 'Rotate key', status: 'todo', links: [{ kind: 'url', ref: `https://example.com/?key=${SECRET}` }] });
    await redactTask(as(t, 'owner'), { id: 'LB-1', text: SECRET });
    expect(stored(t, 'LB-1').links).toEqual([{ kind: 'url', ref: 'https://example.com/?key=[redacted]' }]);
    await deleteTask(as(t, 'owner'), { id: 'LB-1', confirm_id: 'LB-1' });
    expect(occurrences(t, SECRET)).toEqual(NONE);
  });

  it('redacts string field values, also inside json fields', async () => {
    const s = await newStore();
    const config = path.join(s.dir, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(config, 'utf8'));
    cfg.fields = { note: { type: 'string' }, extra: { type: 'json' } };
    writeRaw(config, JSON.stringify(cfg));
    await createTask(as(s, 'a'), { title: 'x', status: 'todo', fields: { note: `k=${SECRET}`, extra: { deep: [SECRET, 1] } } });
    expect((await redactTask(as(s, 'owner'), { id: 'LB-1', text: SECRET })).data.redacted).toBe(2);
    expect(stored(s, 'LB-1').fields).toEqual({ note: 'k=[redacted]', extra: { deep: ['[redacted]', 1] } });
    expect(occurrences(s, SECRET)).toEqual(NONE);
  });

  it('a text that does not occur, or a blank one, is refused without a write and without echoing the text', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'x', status: 'todo' });
    const shas = storeShas(s);
    const missing = await rejectsWith(redactTask(as(s, 'owner'), { id: 'LB-1', text: SECRET }), 'INVALID_VALUE');
    expect(missing.message).toBe('the text does not occur in LB-1 (title, description, links, fields, history) or in the store backups; nothing was changed');
    expect(JSON.stringify({ m: missing.message, f: missing.fix, i: missing.input })).not.toContain(SECRET);
    await rejectsWith(redactTask(as(s, 'owner'), { id: 'LB-1', text: ' \n ' }), 'INVALID_VALUE');
    await rejectsWith(redactTask(as(s, 'owner'), { id: 'LB-9', text: SECRET }), 'TASK_NOT_FOUND');
    await rejectsWith(redactTask({ store: s.store }, { id: 'LB-1', text: 'x' }), 'ACTOR_REQUIRED');
    expect(storeShas(s)).toEqual(shas);
  });

  it('a replacement longer than a short secret never pushes the title past 200 characters', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'zq9k'.repeat(50), status: 'todo' });
    // 50 in the title, 50 in the created event's copy of it.
    const r = await redactTask(as(s, 'owner'), { id: 'LB-1', text: 'zq9k' });
    expect(r.data.redacted).toBe(100);
    expect(r.warnings).toContain('title cut to 200 characters after redact (300 lost)');
    const title = stored(s, 'LB-1').title as string;
    expect(title.length).toBeLessThanOrEqual(200);
    expect(title.startsWith('[redacted][redacted]')).toBe(true);
    // The store still reads (a title over 200 would be STORE_INVALID).
    expect((await getTask(as(s), { id: 'LB-1' })).data.id).toBe('LB-1');
  });

  it('the description and a link ref stay within 100 000 and 2 000 characters (review S6e MAJOR 4)', async () => {
    const s = await newStore();
    const description = `${'x'.repeat(99996)}zq9k`;
    const ref = `https://example.com/?k=${'y'.repeat(2000 - 23 - 4)}zq9k`;
    expect([description.length, ref.length]).toEqual([100000, 2000]);
    await createTask(as(s, 'a'), { title: 'long', status: 'todo', description, links: [{ kind: 'url', ref }] });
    const r = await redactTask(as(s, 'owner'), { id: 'LB-1', text: 'zq9k' });
    expect(r.warnings).toEqual(expect.arrayContaining(['description cut to 100000 characters after redact (6 lost)', 'links[0].ref cut to 2000 characters after redact (6 lost)']));
    const task = (await getTask(as(s), { id: 'LB-1' })).data;
    expect(task.description).toHaveLength(100000);
    expect(task.description.endsWith('x[red')).toBe(true);
    expect(task.links[0]?.ref).toHaveLength(2000);
    expect(occurrences(s, 'zq9k')).toEqual(NONE);
    expect((await doctor(as(s), {})).data.healthy).toBe(true);
  });

  it('a secret left in a label or an attachment name is refused before any write; the fix order then clears it (review S6e MAJOR 1)', async () => {
    const s = await newStore();
    const secret = 'sk7secret9tok';
    await createTask(as(s, 'a'), { title: `t ${secret}`, status: 'todo', labels: [secret, 'ops'] });
    await attachFile(as(s, 'a'), { id: 'LB-1', path: sourceFile('notes.txt', 'n'), name: `${secret}.txt` });
    const shas = storeShas(s);
    const refused = await rejectsWith(redactTask(as(s, 'owner'), { id: 'LB-1', text: secret }), 'INVALID_VALUE');
    expect(refused.message).toBe('the text also occurs where redact cannot replace it: labels[0], attachments[0].name; nothing was changed');
    expect(refused.fix).toBe(
      'remove the label: laneboard update LB-1 --remove-label <label> --json; remove the attachment (its file goes too): laneboard attach LB-1 --remove <name> --json; then run laneboard redact LB-1 --json again (it also clears the events of the removal) (laneboard get LB-1 --json shows them)',
    );
    expect(JSON.stringify({ m: refused.message, f: refused.fix, i: refused.input })).not.toContain(secret);
    expect(storeShas(s)).toEqual(shas);
    expect(fs.existsSync(path.join(s.dir, 'attachments', 'LB-1', `${secret}.txt`))).toBe(true);
    // An archived task first goes back: the fix says so.
    const t = await newStore();
    await createTask(as(t, 'a'), { title: 'x', status: 'todo', labels: [secret] });
    await archiveTasks(as(t, 'a'), { ids: ['LB-1'] });
    expect((await rejectsWith(redactTask(as(t, 'owner'), { id: 'LB-1', text: secret }), 'INVALID_VALUE')).fix).toMatch(/^restore it first: laneboard restore LB-1 --json; remove the label/);
    // Following the fix: remove both, redact again; nothing of the secret stays in the store files, backups or attachments.
    await updateTask(as(s, 'a'), { id: 'LB-1', remove_labels: [secret] });
    await attachFile(as(s, 'a'), { id: 'LB-1', remove: `${secret}.txt` });
    const r = await redactTask(as(s, 'owner'), { id: 'LB-1', text: secret });
    expect(r.data.redacted).toBeGreaterThan(0);
    expect(occurrences(s, secret)).toEqual(NONE);
    expect(fs.readdirSync(path.join(s.dir, 'attachments', 'LB-1'))).toEqual([]);
    expect(stored(s, 'LB-1').labels).toEqual(['ops']);
    // A text that is a key the board keeps (here a field name) is refused with the generic fix.
    const u = await newStore();
    const config = path.join(u.dir, 'config.json');
    writeRaw(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, 'utf8')), fields: { ticket_ref: { type: 'string' } } }));
    await createTask(as(u, 'a'), { title: 'x', status: 'todo', fields: { ticket_ref: 'v' } });
    const key = await rejectsWith(redactTask(as(u, 'owner'), { id: 'LB-1', text: 'ticket_ref' }), 'INVALID_VALUE');
    expect(key.message).toMatch(/^the text also occurs where redact cannot replace it: .*fields\.ticket_ref \(key\).*; nothing was changed$/);
    expect(key.fix).toContain('which redact never changes');
  });

  it('a task deleted before the redact: the secret only in a backup is found and removed (review S6e MAJOR 3)', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'a', status: 'todo', description: `desc ${SECRET}` });
    await createTask(as(s, 'a'), { title: 'b', status: 'todo' });
    await deleteTask(as(s, 'owner'), { id: 'LB-1', confirm_id: 'LB-1' });
    const before = occurrences(s, SECRET);
    expect(before).toEqual({ ...NONE, 'active.json.bak': 1 });
    const run = await cli(['redact', 'LB-1', '--text-file', '-', '--as', 'owner'], { cwd: s.root, stdin: `${SECRET}\n` });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe('LB-1 redacted: 0 occurrences replaced with [redacted], 1 removed from the store backups (rev 3)\n');
    expect(occurrences(s, SECRET)).toEqual(NONE);
    expect(stored(s, 'LB-1').events).toEqual([
      expect.objectContaining({ type: 'archived', data: { deleted: true } }),
      expect.objectContaining({ actor: 'owner', type: 'updated', data: { redacted: { count: 0, backups: 1 } } }),
    ]);
    // A secret also in another task: that one is named in a warning (redact rewrites one task).
    const t = await newStore();
    await createTask(as(t, 'a'), { title: `one ${SECRET}`, status: 'todo' });
    await createTask(as(t, 'a'), { title: `two ${SECRET}`, status: 'todo' });
    expect((await redactTask(as(t, 'owner'), { id: 'LB-1', text: SECRET })).warnings).toEqual(['the text also occurs in LB-2: redact each of them too']);
  });

  it('copies of other tasks in a backup are theirs: a text only there is not found; only the own old copy counts (review S6e r2 MAJOR)', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'a', status: 'todo' });
    await createTask(as(s, 'a'), { title: `b ${SECRET}`, status: 'todo' });
    await commentTask(as(s, 'a'), { id: 'LB-1', text: 'hi' });
    // LB-2's title and the created event's copy of it, in active.json and in its backup.
    expect(occurrences(s, SECRET)).toEqual({ ...NONE, 'active.json': 2, 'active.json.bak': 2 });
    const shas = storeShas(s);
    const missing = await rejectsWith(redactTask(as(s, 'owner'), { id: 'LB-1', text: SECRET }), 'INVALID_VALUE');
    expect(missing.message).toBe('the text does not occur in LB-1 (title, description, links, fields, history) or in the store backups; nothing was changed');
    expect(storeShas(s)).toEqual(shas);
    // A task deleted before the redact: its own copy in the backup counts (1), LB-2's two do not and are named in a warning.
    await createTask(as(s, 'a'), { title: 'c', status: 'todo', description: SECRET });
    await deleteTask(as(s, 'owner'), { id: 'LB-3', confirm_id: 'LB-3' });
    expect(occurrences(s, SECRET)['active.json.bak']).toBe(3);
    const r = await redactTask(as(s, 'owner'), { id: 'LB-3', text: SECRET });
    expect(r.data).toMatchObject({ redacted: 0, backups: 1 });
    expect(r.warnings).toEqual(['the text also occurs in LB-2: redact each of them too']);
    // What stays is LB-2's live text and its fresh backup; redacting LB-2 clears the rest.
    expect(occurrences(s, SECRET)).toEqual({ ...NONE, 'active.json': 2, 'active.json.bak': 2 });
    expect((await redactTask(as(s, 'owner'), { id: 'LB-2', text: SECRET })).data).toMatchObject({ redacted: 2, backups: 2 });
    expect(occurrences(s, SECRET)).toEqual(NONE);
    // A damaged backup cannot be split into tasks: what it holds beyond the new content of its file counts, and the write drops it.
    writeRaw(path.join(s.dir, 'archive.json.bak'), `{ damaged ${SECRET}`);
    expect((await redactTask(as(s, 'owner'), { id: 'LB-1', text: SECRET })).data).toMatchObject({ redacted: 0, backups: 1 });
    expect(occurrences(s, SECRET)).toEqual(NONE);
  });

  it('a text shorter than 4 characters, part of [redacted], the id, the prefix, a status or an actor is refused (no write)', async () => {
    const s = await newStore({ prefix: 'PROJX' });
    await createTask(as(s, 'alice'), { title: 'abc PROJX-1 PROJX todo alice dact in_prog', status: 'todo', assignee: 'carol' });
    const shas = storeShas(s);
    const cases: Array<[string, string]> = [
      ['abc', 'is shorter than 4 characters'],
      ['😀😀😀', 'is shorter than 4 characters'],
      ['dact', 'is a part of [redacted]'],
      ['PROJX-1', 'is (part of) the task id'],
      ['ROJX-1', 'is (part of) the task id'],
      ['PROJX', 'is (part of) the board prefix'],
      ['ROJX', 'is (part of) the board prefix'],
      ['todo', 'is (part of) a status name'],
      // A part of a status (review S6e r2 MINOR): it would rewrite every in_progress in the history.
      ['in_prog', 'is (part of) a status name'],
      ['alice', 'is (part of) an actor name'],
      ['lice', 'is (part of) an actor name'],
      ['carol', 'is (part of) an actor name'],
      ['owner', 'is (part of) an actor name'],
    ];
    for (const [text, why] of cases) {
      const err = await rejectsWith(redactTask(as(s, 'owner'), { id: 'PROJX-1', text }), 'INVALID_VALUE');
      expect(err.message, text).toBe(`the text to redact ${why}; nothing was changed`);
      expect(err.fix).toBe('pass the whole secret (at least 4 characters), exactly as it was pasted: laneboard redact PROJX-1 --text-file <path> --json');
    }
    expect(storeShas(s)).toEqual(shas);
    // Four characters are enough.
    expect((await redactTask(as(s, 'owner'), { id: 'PROJX-1', text: 'abc ' })).data.redacted).toBe(2);
  });

  it('CLI: the text comes only from --text-file (path or -); without it USAGE; not an MCP tool', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'x', status: 'todo', description: SECRET });
    const none = await cli(['redact', 'LB-1', '--as', 'owner', '--json'], { cwd: s.root });
    expect(none.code).toBe(2);
    expect(JSON.parse(none.stdout).error).toMatchObject({ code: 'USAGE', message: '--text-file is required' });
    const stdin = await cli(['redact', 'LB-1', '--text-file', '-', '--as', 'owner'], { cwd: s.root, stdin: `${SECRET}\r\n` });
    expect(stdin.stdout).toBe('LB-1 redacted: 1 occurrence replaced with [redacted] (rev 2)\n');
    expect(occurrences(s, SECRET)).toEqual(NONE);
  });
});

describe('A13 replacing the description keeps the old text in the event', () => {
  it('previous holds the replaced text; an empty one adds nothing; append is as before', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'x', status: 'todo' });
    const first = await updateTask(as(s, 'a'), { id: 'LB-1', description: 'v1 text' });
    expect(first.data.events.at(-1)?.data).toEqual({ description: { chars: [0, 7] } });
    const second = await updateTask(as(s, 'a'), { id: 'LB-1', description: 'v2' });
    expect(second.data.events.at(-1)?.data).toEqual({ description: { chars: [7, 2], previous: 'v1 text' } });
    const appended = await updateTask(as(s, 'a'), { id: 'LB-1', append_description: 'more' });
    expect(appended.data.events.at(-1)?.data).toEqual({ description: { chars: [2, 8], appended: true } });
  });

  it('a long old text is cut to 10 000 code points with previous_cut', async () => {
    const s = await newStore();
    // 10 001 code points, the emoji are 2 UTF-16 units each: the cut counts code points.
    const long = '😀'.repeat(10001);
    await createTask(as(s, 'a'), { title: 'x', status: 'todo', description: long });
    const r = await updateTask(as(s, 'a'), { id: 'LB-1', description: 'short' });
    const data = r.data.events.at(-1)?.data.description as { chars: number[]; previous: string; previous_cut?: boolean };
    expect(data.chars).toEqual([20002, 5]);
    expect([...data.previous]).toHaveLength(10000);
    expect(data.previous_cut).toBe(true);
    // Exactly 10 000: kept whole, no cut mark.
    await updateTask(as(s, 'a'), { id: 'LB-1', description: '😀'.repeat(10000) });
    const whole = (await updateTask(as(s, 'a'), { id: 'LB-1', description: 'x' })).data.events.at(-1)?.data.description;
    expect(whole).toEqual({ chars: [20000, 1], previous: '😀'.repeat(10000) });
  });
});

describe('attach rollback (review S6a MINOR 1): a failed metadata write removes the stored file', () => {
  it('the active.json write fails: no attachment file, the task unchanged', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'x', status: 'todo' });
    const active = fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8');
    await expect(attachFile(as(s, 'a', { faults: { at: 'after_tmp_write' } }), { id: 'LB-1', path: sourceFile('notes.txt', 'notes') })).rejects.toThrow('fault injected');
    expect(fs.existsSync(path.join(s.dir, 'attachments', 'LB-1', 'notes.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8')).toBe(active);
    // The next attach of the same file works.
    expect((await attachFile(as(s, 'a'), { id: 'LB-1', path: sourceFile('notes.txt', 'notes') })).data.attachments).toHaveLength(1);
  });

  it('transact runs rollback hooks only while no store file may be replaced', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'x', status: 'todo' });
    // A move between files writes two files: a fault after the first one keeps the hook (that file may hold what the hook undoes).
    const run = async (at: 'after_tmp_write' | 'between_files'): Promise<boolean> => {
      let undone = false;
      const write = transact(
        s.store,
        { files: ['active', 'archive'] },
        (st) => {
          st.onRollback(() => {
            undone = true;
          });
          const task = st.active.tasks[0];
          if (!task) throw new Error('no task');
          st.active.tasks = [];
          st.archive.tasks.push(task);
        },
        { faults: { at } },
      );
      await expect(write).rejects.toThrow('fault injected');
      return undone;
    };
    expect(await run('after_tmp_write')).toBe(true);
    expect(await run('between_files')).toBe(false);
    // An error thrown by the callback itself runs the hooks too.
    let undone = false;
    await expect(
      transact(s.store, { files: ['active'] }, (st) => {
        st.onRollback(() => {
          undone = true;
        });
        throw new Error('callback failed');
      }),
    ).rejects.toThrow('callback failed');
    expect(undone).toBe(true);
  });

  it('after LOCK_LOST no rollback hook runs: another process may own the lock and the path now (review S6e MAJOR 2)', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'x', status: 'todo' });
    let undone = false;
    const write = transact(
      s.store,
      { files: ['active'] },
      (st) => {
        st.onRollback(() => {
          undone = true;
        });
        const task = st.active.tasks[0];
        if (!task) throw new Error('no task');
        task.title = 'changed';
        // Held past the write deadline (a paused process): the commit refuses with LOCK_LOST before replacing any file.
        const until = Date.now() + 20;
        while (Date.now() < until) {
          // busy wait
        }
      },
      { lockMaxHoldMs: 5 },
    );
    await rejectsWith(write, 'LOCK_LOST');
    expect(undone).toBe(false);
    expect(stored(s, 'LB-1').title).toBe('x');
  });
});

describe('delete of an active task that carries a deleted mark (review S6e MINOR: a tombstone restored by 0.3.1)', () => {
  it('is deleted as usual; the archived tombstone itself stays refused', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'x', status: 'todo' });
    const active = readStore(s.dir, 'active');
    const marked = { ...active.tasks[0], deleted: { at: '2026-11-04T19:05:54.686Z', by: 'owner' } };
    writeRaw(path.join(s.dir, 'active.json'), `${JSON.stringify({ ...active, tasks: [marked], content_sha256: contentSha([marked]) }, null, 2)}\n`);
    expect((await deleteTask(as(s, 'owner'), { id: 'LB-1', confirm_id: 'LB-1' })).data).toEqual({ id: 'LB-1', deleted: true });
    expect(stored(s, 'LB-1')).toMatchObject({ archived_at: expect.stringMatching(ISO), deleted: { by: 'owner' } });
    await rejectsWith(deleteTask(as(s, 'owner'), { id: 'LB-1', confirm_id: 'LB-1' }), 'INVALID_VALUE');
  });
});

// LB-64.5: 0.3.1 restored a tombstone to active.json with its `deleted` mark (it keeps unknown keys). Archiving that live task
// must not turn it back into a tombstone: the mark goes, restore and get see an ordinary archived task.
describe('archive of an active task that carries a deleted mark (LB-64.5, a tombstone restored by 0.3.1)', () => {
  it('the archived task has no deleted mark: get shows no deleted, restore brings it back', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'kept', status: 'todo' });
    const at = '2026-11-04T19:05:54.686Z';
    // The 0.3.1 tombstone of the ADR §24 experiment after `laneboard restore` of 0.3.1: archived_at gone, deleted kept, a restored event.
    const restoredBy031 = {
      id: 'LB-9',
      rev: 4,
      title: 'Deleted under 0.3.1',
      description: '',
      status: 'todo',
      assignee: null,
      labels: [],
      links: [],
      fields: {},
      attachments: [],
      events: [
        { at, actor: 'owner', type: 'archived', data: { deleted: true } },
        { at: '2026-11-04T19:06:00.000Z', actor: 'owner', type: 'restored', data: {} },
      ],
      events_dropped: 2,
      created_at: '2026-11-04T19:00:00.000Z',
      created_by: 'a',
      updated_at: '2026-11-04T19:06:00.000Z',
      updated_by: 'owner',
      deleted: { at, by: 'owner' },
    };
    const active = readStore(s.dir, 'active');
    const tasks = [...active.tasks, restoredBy031];
    writeRaw(path.join(s.dir, 'active.json'), `${JSON.stringify({ ...active, next_id: 10, tasks, content_sha256: contentSha(tasks) }, null, 2)}\n`);
    await archiveTasks(as(s, 'owner'), { ids: ['LB-9'] });
    expect(stored(s, 'LB-9')).not.toHaveProperty('deleted');
    expect((await getTask(as(s), { id: 'LB-9' })).data).not.toHaveProperty('deleted');
    expect((await restoreTask(as(s, 'owner'), { id: 'LB-9' })).data).toMatchObject({ id: 'LB-9', archived: false });
  });
});

// LB-64.4: archiving by id a task that is not finished and has an assignee goes through, with a warning naming who holds it.
describe('archive of an open task with an assignee (LB-64.4)', () => {
  it('archived with a warning; a finished task or one without an assignee gets none', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'open, held', status: 'in_progress', assignee: 'other' });
    await createTask(as(s, 'a'), { title: 'open, free', status: 'todo' });
    await createTask(as(s, 'a'), { title: 'done, held', status: 'done', assignee: 'other' });
    const held = await archiveTasks(as(s, 'owner'), { ids: ['LB-1'] });
    expect(held.data.archived).toEqual([{ id: 'LB-1', rev: 2 }]);
    expect(held.warnings).toEqual(['LB-1 is in_progress (not a final status) and assigned to other: archived anyway; to bring it back: laneboard restore LB-1 --json']);
    expect((await archiveTasks(as(s, 'owner'), { ids: ['LB-2', 'LB-3'] })).warnings).toEqual([]);
  });

  // Review r1: the bulk form names the status itself, so a warning on each task it picks would be noise.
  it('the bulk form (status + updated_before) archives an open task with an assignee without a warning', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'open, held, old', status: 'in_progress', assignee: 'other' });
    const active = readStore(s.dir, 'active');
    const tasks = active.tasks.map((t) => ({ ...t, updated_at: '2020-01-01T00:00:00.000Z' }));
    writeRaw(path.join(s.dir, 'active.json'), `${JSON.stringify({ ...active, tasks, content_sha256: contentSha(tasks) }, null, 2)}\n`);
    const bulk = await archiveTasks(as(s, 'owner'), { status: 'in_progress', updated_before: '1d' });
    expect(bulk.data.archived).toEqual([{ id: 'LB-1', rev: 2 }]);
    expect(bulk.warnings).toEqual([]);
  });
});
