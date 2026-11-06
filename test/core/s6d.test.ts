// S6d (LB-30, audit A3, A8, A9, A10): doctor --restore-backup loses nothing the other files still know and never gives an id twice;
// a file it cannot read is not restored over; --fix puts files without metadata aside; one id on two tasks in a file is found and
// renumbered; a lock from the future is taken over; the lock wait is explained; doctor exits 6 on problems; SIGXFSZ does not kill.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { acquireLock } from '../../src/core/lock.ts';
import { archiveTasks, attachFile, createTask, doctor, getTask, listTasks } from '../../src/core/index.ts';
import { as, CLI_SOURCE, cleanupTemp, cli, newStore, readStore, rejectsWith, tempDir, writeRaw } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

// sha256 of a file on disk.
function shaOf(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Message of one doctor check (undefined when the check is absent).
function checkOf(r: { data: { checks: Array<{ name: string; ok: boolean; fixed: boolean; message: string }> } }, name: string) {
  return r.data.checks.find((c) => c.name === name);
}

// A store with tasks LB-1..LB-n.
async function storeWith(n: number): Promise<TestStore> {
  const s = await newStore();
  for (let i = 1; i <= n; i += 1) await createTask(as(s), { title: `t${i}`, status: 'todo' });
  return s;
}

describe('A3 doctor --restore-backup keeps what the other files know', () => {
  it('archive.json damaged right after an archive: the task only active.json.bak still holds comes back and is named', async () => {
    const s = await storeWith(3);
    await archiveTasks(as(s), { ids: ['LB-1'] });
    await archiveTasks(as(s), { ids: ['LB-2'] });
    writeRaw(path.join(s.dir, 'archive.json'), fs.readFileSync(path.join(s.dir, 'archive.json'), 'utf8').slice(0, 50));

    const r = await doctor(as(s), { restore_backup: true });
    expect(checkOf(r, 'archive.json')).toMatchObject({ ok: false, fixed: true });
    expect(checkOf(r, 'after restore')?.message).toContain('LB-2 "t2" (to active.json)');
    expect(r.data.healthy).toBe(true);
    expect((await getTask(as(s), { id: 'LB-2' })).data.title).toBe('t2');
    expect(readStore(s.dir, 'archive').tasks.map((t) => t.id)).toEqual(['LB-1']);
    expect((await doctor(as(s), {})).data.healthy).toBe(true);
  });

  it('active.json damaged beyond reading after a create: next_id skips the id that write may have used (next create is LB-4)', async () => {
    const s = await storeWith(3);
    writeRaw(path.join(s.dir, 'active.json'), '{');
    const r = await doctor(as(s), { restore_backup: true });
    expect(checkOf(r, 'after restore')?.message).toContain('may have created LB-3;');
    expect(checkOf(r, 'after restore')?.message).toContain('next_id 3 -> 4');
    expect((await createTask(as(s), { title: 'other', status: 'todo' })).data.id).toBe('LB-4');
  });

  it('a truncated active.json still shows its next_id and ids: they are kept above, and the lost ids are named', async () => {
    const s = await storeWith(3);
    const text = fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8');
    // Cut right after the last task's id: next_id 4 and "LB-3" are in the damaged text, LB-3 is in no good file.
    writeRaw(path.join(s.dir, 'active.json'), text.slice(0, text.lastIndexOf('"LB-3"') + 6));
    const r = await doctor(as(s), { restore_backup: true });
    const msg = checkOf(r, 'after restore')?.message ?? '';
    expect(msg).toContain('lost with the damaged file: LB-3');
    expect(msg).not.toContain('may have created');
    expect(readStore(s.dir, 'active').next_id).toBe(4);
  });

  it('an intact but unreadable active.json (chmod 000) is not restored over: chmod fix, sha unchanged, exit 6', async () => {
    const s = await storeWith(2);
    const file = path.join(s.dir, 'active.json');
    const before = shaOf(file);
    fs.chmodSync(file, 0o000);
    try {
      const report = await doctor(as(s), {});
      expect(checkOf(report, 'active.json')?.message).toContain(`fix: chmod u+rw`);
      expect(checkOf(report, 'active.json')?.message).not.toContain('--restore-backup');
      const r = await doctor(as(s), { restore_backup: true });
      expect(checkOf(r, 'active.json')).toMatchObject({ ok: false, fixed: false });
      expect(checkOf(r, 'active.json')?.message).toContain('not restored');
      expect(r.data.healthy).toBe(false);
      const run = await cli(['doctor', '--restore-backup', '--json'], { cwd: s.root });
      expect(run.code).toBe(6);
      expect(fs.readdirSync(s.dir).some((f) => f.startsWith('active.json.invalid-'))).toBe(false);
    } finally {
      fs.chmodSync(file, 0o444);
    }
    expect(shaOf(file)).toBe(before);
    expect((await getTask(as(s), { id: 'LB-2' })).data.title).toBe('t2');
  });

  it('--fix after a restore moves a file without metadata to attachments/.orphaned/ instead of deleting it', async () => {
    const s = await storeWith(1);
    const src = path.join(tempDir(), 'report.txt');
    fs.writeFileSync(src, 'precious report\n');
    await attachFile(as(s), { id: 'LB-1', path: src });
    writeRaw(path.join(s.dir, 'active.json'), 'garbage');
    const restored = await doctor(as(s), { restore_backup: true });
    expect(checkOf(restored, 'attachment files')?.message).toContain('--fix moves them to attachments/.orphaned/');

    const fixed = await doctor(as(s), { fix: true });
    expect(fixed.data.healthy).toBe(true);
    const kept = path.join(s.dir, 'attachments', '.orphaned', 'LB-1', 'report.txt');
    expect(fs.readFileSync(kept, 'utf8')).toBe('precious report\n');
    expect(checkOf(fixed, 'attachment files')?.message).toContain(`laneboard attach <id> ${kept}`);
    expect(fs.existsSync(path.join(s.dir, 'attachments', 'LB-1', 'report.txt'))).toBe(false);
    // The put-aside folder is not a task folder: the next check is clean.
    expect(checkOf(await doctor(as(s), {}), 'attachment files')?.ok).toBe(true);
  });

  it('the other file does not load (chmod 000): nothing is restored or written, a later restore still keeps next_id up', async () => {
    const s = await storeWith(3);
    const active = path.join(s.dir, 'active.json');
    const archive = path.join(s.dir, 'archive.json');
    writeRaw(active, '{');
    fs.chmodSync(archive, 0o000);
    try {
      const r = await doctor(as(s), { restore_backup: true });
      expect(checkOf(r, 'active.json')).toMatchObject({ ok: false, fixed: false });
      expect(checkOf(r, 'active.json')?.message).toContain('not restored, nothing was written: archive.json must load first');
      expect(checkOf(r, 'archive.json')?.message).toContain('fix: chmod u+rw');
      expect(r.data.healthy).toBe(false);
    } finally {
      fs.chmodSync(archive, 0o444);
    }
    expect(fs.readFileSync(active, 'utf8')).toBe('{');
    expect(fs.readdirSync(s.dir).some((f) => f.includes('.invalid-'))).toBe(false);
    expect((await doctor(as(s), {})).data.healthy).toBe(false);
    await doctor(as(s), { restore_backup: true });
    expect((await createTask(as(s), { title: 'other', status: 'todo' })).data.id).toBe('LB-4');
  });

  it('the lock lost before the commit (LOCK_LOST "nothing was written"): the damaged file is still there, nothing was restored', async () => {
    const s = await storeWith(3);
    const active = path.join(s.dir, 'active.json');
    writeRaw(active, '{');
    const err = await rejectsWith(doctor(as(s, 'tester', { lockMaxHoldMs: 0 }), { restore_backup: true }), 'LOCK_LOST');
    expect(err.message).toContain('nothing was written');
    expect(fs.readFileSync(active, 'utf8')).toBe('{');
    expect(fs.readdirSync(s.dir).some((f) => f.includes('.invalid-'))).toBe(false);
    expect((await doctor(as(s), {})).data.healthy).toBe(false);
    await doctor(as(s), { restore_backup: true });
    expect((await createTask(as(s), { title: 'other', status: 'todo' })).data.id).toBe('LB-4');
  });

  it('hashing slow attachments does not push the restore past the lock deadline: it is written before the report-only checks', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 't1', status: 'todo' });
    const src = path.join(tempDir(), 'big.txt');
    fs.writeFileSync(src, 'report');
    await attachFile(as(s), { id: 'LB-1', path: src });
    await createTask(as(s), { title: 't2', status: 'todo' });
    await createTask(as(s), { title: 't3', status: 'todo' });
    writeRaw(path.join(s.dir, 'active.json'), '{');
    // Every read of an attachment takes 600 ms (a slow disk, a large file); the write deadline is 300 ms after the acquire.
    const read = fs.readFileSync;
    const slow = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file).includes(`${path.sep}attachments${path.sep}`)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
      return (read as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    let r;
    try {
      r = await doctor(as(s, 'tester', { lockMaxHoldMs: 300 }), { restore_backup: true });
    } finally {
      slow.mockRestore();
    }
    expect(checkOf(r, 'attachment content')?.ok).toBe(true);
    expect(checkOf(r, 'after restore')?.message).toContain('next_id 3 -> 4');
    expect((await createTask(as(s), { title: 'other', status: 'todo' })).data.id).toBe('LB-4');
  });

  it('a kept damaged file (*.invalid-*) whose ids are above next_id is reported, and --fix lifts next_id over them', async () => {
    const s = await storeWith(2);
    // What a restore whose floor never reached the disk leaves: the damaged text shows next_id 9 and LB-8.
    fs.writeFileSync(path.join(s.dir, 'active.json.invalid-2026-01-01T00-00-00-000Z'), '{"next_id": 9, "tasks": [{"id": "LB-8"');
    const report = await doctor(as(s), {});
    expect(checkOf(report, 'next_id')).toMatchObject({ ok: false, fixed: false });
    expect(checkOf(report, 'next_id')?.message).toContain('next_id 3 is below 9: ids up to LB-8 were used (active.json.invalid-2026-01-01T00-00-00-000Z)');
    const fixed = await doctor(as(s), { fix: true });
    expect(checkOf(fixed, 'next_id')?.message).toContain('set to 9');
    expect((await createTask(as(s), { title: 'other', status: 'todo' })).data.id).toBe('LB-9');
    expect(checkOf(await doctor(as(s), {}), 'next_id')?.ok).toBe(true);
  });

  it('a .bak edited by hand is restored with its checksum rewritten: the checksum line says so, the board is healthy', async () => {
    const s = await storeWith(2);
    const bak = path.join(s.dir, 'active.json.bak');
    writeRaw(bak, fs.readFileSync(bak, 'utf8').replace('"t1"', '"t1 edited"'));
    writeRaw(path.join(s.dir, 'active.json'), '{');
    const r = await doctor(as(s), { restore_backup: true });
    expect(checkOf(r, 'active.json checksum')).toMatchObject({ ok: false, fixed: true, message: 'content_sha256 mismatch (hand edit): accepted and rewritten' });
    expect(r.data.healthy).toBe(true);
    expect((await doctor(as(s), {})).data.healthy).toBe(true);
  });

  it('a blind restore keeps next_id above every id the board still names (an attachment folder) and names each id it skips', async () => {
    const s = await storeWith(3);
    // Files of a task the lost writes made: LB-6's folder is there, its task is not.
    fs.mkdirSync(path.join(s.dir, 'attachments', 'LB-6'), { recursive: true });
    fs.writeFileSync(path.join(s.dir, 'attachments', 'LB-6', 'notes.txt'), 'x');
    writeRaw(path.join(s.dir, 'active.json'), '{');
    const r = await doctor(as(s), { restore_backup: true });
    const msg = checkOf(r, 'after restore')?.message ?? '';
    expect(msg).toContain('may have created LB-3, LB-4, LB-5, LB-6;');
    expect(msg).toContain('an import there may have created more');
    expect(msg).toContain('next_id 3 -> 7');
    expect((await createTask(as(s), { title: 'other', status: 'todo' })).data.id).toBe('LB-7');
  });
});

// Turn LB-3 into a second LB-2 (what a git merge of two branches that each created a task leaves), next_id back to 3.
function mergeLikeDuplicate(s: TestStore): void {
  const data = readStore(s.dir, 'active');
  const third = data.tasks.find((t) => t.id === 'LB-3') as Record<string, unknown>;
  third.id = 'LB-2';
  data.next_id = 3;
  writeRaw(path.join(s.dir, 'active.json'), JSON.stringify(data, null, 2));
  const from = path.join(s.dir, 'attachments', 'LB-3');
  for (const name of fs.readdirSync(from)) fs.renameSync(path.join(from, name), path.join(s.dir, 'attachments', 'LB-2', name));
  fs.rmdirSync(from);
}

describe('A8 one id on two tasks in a file', () => {
  it('is STORE_INVALID for reads and writes with the fix doctor --fix; doctor names it; --fix renumbers the later copy and its files', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'base', status: 'todo' });
    await createTask(as(s), { title: 'from-A', status: 'todo' });
    await createTask(as(s), { title: 'from-B', status: 'todo' });
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'B');
    await attachFile(as(s), { id: 'LB-2', path: path.join(dir, 'a.txt') });
    await attachFile(as(s), { id: 'LB-3', path: path.join(dir, 'b.txt') });
    mergeLikeDuplicate(s);

    const err = await rejectsWith(listTasks(as(s), {}), 'STORE_INVALID');
    expect(err.message).toContain('duplicate id LB-2 in active.json');
    expect(err.fix).toContain('laneboard doctor --fix');
    await rejectsWith(createTask(as(s), { title: 'x', status: 'todo' }), 'STORE_INVALID');

    const report = await doctor(as(s), {});
    expect(checkOf(report, 'duplicate ids')?.message).toContain('LB-2 in active.json ("from-A", "from-B")');
    expect(report.data.healthy).toBe(false);
    expect((await cli(['doctor'], { cwd: s.root })).code).toBe(6);

    const fixed = await doctor(as(s), { fix: true });
    expect(checkOf(fixed, 'duplicate ids')?.message).toContain('LB-2 "from-B" -> LB-3');
    expect(fixed.data.healthy).toBe(true);
    expect((await getTask(as(s), { id: 'LB-2' })).data.title).toBe('from-A');
    const moved = (await getTask(as(s), { id: 'LB-3' })).data;
    expect(moved.title).toBe('from-B');
    const task = readStore(s.dir, 'active').tasks.find((t) => t.id === 'LB-3') as unknown as { events: Array<{ type: string; data: unknown }> };
    expect(task.events.at(-1)).toMatchObject({ type: 'updated', data: { id: ['LB-2', 'LB-3'] } });
    expect(fs.readFileSync(path.join(s.dir, 'attachments', 'LB-3', 'b.txt'), 'utf8')).toBe('B');
    expect(fs.existsSync(path.join(s.dir, 'attachments', 'LB-2', 'b.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(s.dir, 'attachments', 'LB-2', 'a.txt'), 'utf8')).toBe('A');
    expect((await doctor(as(s), {})).data.checks.every((c) => c.ok)).toBe(true);
    expect((await createTask(as(s), { title: 'next', status: 'todo' })).data.id).toBe('LB-4');
  });

  it('the copy created later gets the new id even when it comes first in the file (a merge may put it there)', async () => {
    const s = await storeWith(3);
    const data = readStore(s.dir, 'active');
    const [first, second, third] = data.tasks as Array<Record<string, unknown>>;
    Object.assign(second as object, { title: 'from-A', created_at: '2026-01-01T00:00:00.000Z' });
    Object.assign(third as object, { id: 'LB-2', title: 'from-B', created_at: '2026-01-02T00:00:00.000Z' });
    data.tasks = [first, third, second] as typeof data.tasks;
    data.next_id = 3;
    writeRaw(path.join(s.dir, 'active.json'), JSON.stringify(data, null, 2));
    const fixed = await doctor(as(s), { fix: true });
    expect(checkOf(fixed, 'duplicate ids')?.message).toContain('LB-2 "from-B" -> LB-3');
    expect((await getTask(as(s), { id: 'LB-2' })).data.title).toBe('from-A');
    expect((await getTask(as(s), { id: 'LB-3' })).data.title).toBe('from-B');
  });

  it('subtasks and links that name the repeated id are named with the command to move them; they keep the first copy', async () => {
    const s = await storeWith(4);
    const data = readStore(s.dir, 'active');
    for (const t of data.tasks as Array<Record<string, unknown>>) {
      if (t.id === 'LB-3') t.id = 'LB-2';
      if (t.id === 'LB-4') t.parent = 'LB-2';
      if (t.id === 'LB-1') t.links = [{ kind: 'task', ref: 'LB-2' }];
    }
    data.next_id = 5;
    writeRaw(path.join(s.dir, 'active.json'), JSON.stringify(data, null, 2));
    const fixed = await doctor(as(s), { fix: true });
    const msg = checkOf(fixed, 'duplicate ids')?.message ?? '';
    expect(msg).toContain('LB-2 "t3" -> LB-5');
    expect(msg).toContain('LB-4 (parent LB-2; if it meant the renumbered one: laneboard update LB-4 --parent LB-5)');
    expect(msg).toContain('LB-1 (link task=LB-2; if it meant the renumbered one: laneboard update LB-1 --remove-link task=LB-2 --add-link task=LB-5)');
    expect((await getTask(as(s), { id: 'LB-4' })).data.parent).toBe('LB-2');
  });

  it('a byte order mark (Notepad) is read past; git conflict markers get "resolve the merge conflict", the restore last', async () => {
    const s = await storeWith(1);
    const file = path.join(s.dir, 'active.json');
    const text = fs.readFileSync(file, 'utf8');
    writeRaw(file, `﻿${text}`);
    expect((await getTask(as(s), { id: 'LB-1' })).data.title).toBe('t1');

    writeRaw(file, `<<<<<<< HEAD\n${text}=======\n${text}>>>>>>> devB\n`);
    const err = await rejectsWith(listTasks(as(s), {}), 'STORE_INVALID');
    expect(err.message).toContain('git merge conflict markers');
    expect(err.fix).toMatch(/^resolve the merge conflict in .*active\.json.*laneboard doctor --restore-backup --json$/);
    const report = await doctor(as(s), {});
    expect(checkOf(report, 'active.json')?.message).toContain('fix: resolve the merge conflict');
  });
});

describe('A9 the store lock', () => {
  it('a lock with a time in the future, unchanged for the stale window, is removed with a warning; the write goes through', async () => {
    const s = await storeWith(1);
    const lockPath = path.join(s.dir, 'lock');
    fs.mkdirSync(lockPath);
    const future = new Date(Date.now() + 3600_000);
    fs.utimesSync(lockPath, future, future);
    const started = Date.now();
    const r = await createTask(as(s), { title: 'after the clock went back', status: 'todo' });
    expect(Date.now() - started).toBeLessThan(14_000);
    expect(r.data.id).toBe('LB-2');
    expect(r.warnings.join('\n')).toContain(`removed a stale store lock ${lockPath}`);
  }, 30_000);

  it('a lock from the future is removed only after 10 s unchanged: every touch restarts the window (a live holder is never taken)', async () => {
    const s = await storeWith(1);
    const lockPath = path.join(s.dir, 'lock');
    fs.mkdirSync(lockPath);
    const base = Date.now() + 3600_000;
    let touches = 0;
    let lastTouch = 0;
    const touch = (): void => {
      touches += 1;
      const at = new Date(base + touches * 1000);
      fs.utimesSync(lockPath, at, at);
      lastTouch = Date.now();
    };
    touch();
    // Touched every 3 s (well inside the window, same inode) three more times, then left alone like a dead holder's lock.
    const timer = setInterval(() => (touches < 4 ? touch() : clearInterval(timer)), 3000);
    try {
      const r = await createTask(as(s, 'tester', { lockWaitMs: 25_000 }), { title: 'after the touches stopped', status: 'todo' });
      expect(r.data.id).toBe('LB-2');
      expect(r.warnings.join('\n')).toContain(`removed a stale store lock ${lockPath}`);
    } finally {
      clearInterval(timer);
    }
    expect(touches).toBe(4);
    // Not before the whole window passed since the last touch.
    expect(Date.now() - lastTouch).toBeGreaterThanOrEqual(9_900);
  }, 40_000);

  it('LOCK_TIMEOUT names the lock and its time; for a lock from the future the fix is rmdir <lock>', async () => {
    const s = await storeWith(1);
    const lockPath = path.join(s.dir, 'lock');
    fs.mkdirSync(lockPath);
    // A whole second: utimes keeps sub-millisecond parts that would round the printed time.
    const future = new Date(Math.floor(Date.now() / 1000) * 1000 + 3600_000);
    fs.utimesSync(lockPath, future, future);
    const err = await rejectsWith(createTask(as(s, 'tester', { lockWaitMs: 300 }), { title: 'x', status: 'todo' }), 'LOCK_TIMEOUT');
    expect(err.message).toContain(`its time ${future.toISOString()} is in the future`);
    expect(err.fix).toBe(`if no laneboard command is running on this board: rmdir ${lockPath}, then run the same command again`);
    fs.rmdirSync(lockPath);
  });

  it('a live holder: the lock is not taken; a person hears after 1 s why the command waits, --json output stays clean', async () => {
    const s = await storeWith(1);
    const held = await acquireLock(s.dir);
    try {
      const human = await cli(['create', 'x', '--status', 'todo', '--as', 'a'], { cwd: s.root, lockWaitMs: 1600 });
      expect(human.code).toBe(5);
      expect(human.stderr).toContain(`waiting for the store lock ${path.join(s.dir, 'lock')}`);
      expect(human.stderr).toContain('the lock was last touched at');
      const json = await cli(['create', 'x', '--status', 'todo', '--as', 'a', '--json'], { cwd: s.root, lockWaitMs: 1600 });
      expect(json.code).toBe(5);
      expect(json.stderr).toBe('');
    } finally {
      await held.release();
    }
  });

  it('under a file size limit (ulimit -f) the CLI is not killed by SIGXFSZ: it replies INTERNAL (EFBIG), the store is unchanged', () => {
    const root = tempDir();
    // HOME apart from the project: <HOME>/.laneboard is the machine registry, not a board.
    const env = { PATH: process.env.PATH ?? '', HOME: tempDir() };
    const init = spawnSync(process.execPath, [CLI_SOURCE, 'init', '--description', 'u', '--prefix', 'UU'], { cwd: root, env });
    expect(init.status).toBe(0);
    const before = shaOf(path.join(root, '.laneboard', 'active.json'));
    const desc = path.join(tempDir(), 'desc.txt');
    fs.writeFileSync(desc, 'a'.repeat(90_000));
    // bash: ulimit -f counts 1024-byte blocks; 20 blocks is far below the 90 KB description.
    const res = spawnSync('/bin/bash', ['-c', 'ulimit -f 20 && exec "$0" "$@"', process.execPath, CLI_SOURCE, 'create', 'big', '--status', 'todo', '--description-file', desc, '--as', 'a', '--json'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    expect(res.signal).toBeNull();
    expect(res.status).toBe(1);
    expect(JSON.parse(res.stdout).error.message).toContain('(EFBIG)');
    expect(shaOf(path.join(root, '.laneboard', 'active.json'))).toBe(before);
  });
});

describe('A10 doctor exit code and report', () => {
  it('exit 0 when healthy, exit 6 (ok:true, healthy:false) when a problem is left', async () => {
    const s = await storeWith(1);
    expect((await cli(['doctor'], { cwd: s.root })).code).toBe(0);
    writeRaw(path.join(s.dir, 'active.json'), '{');
    const human = await cli(['doctor'], { cwd: s.root });
    expect(human.code).toBe(6);
    expect(human.stdout).toContain('problem(s) found');
    const json = await cli(['doctor', '--json'], { cwd: s.root });
    expect(json.code).toBe(6);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, data: { healthy: false } });
  });

  it('reports a status outside config, a missing parent, an attachment that differs from its metadata and fields against config', async () => {
    const s = await storeWith(2);
    const src = path.join(tempDir(), 'r.txt');
    fs.writeFileSync(src, 'right bytes');
    await attachFile(as(s), { id: 'LB-1', path: src });
    const stored = path.join(s.dir, 'attachments', 'LB-1', 'r.txt');
    fs.chmodSync(stored, 0o644);
    fs.writeFileSync(stored, 'wrong bytes');
    const data = readStore(s.dir, 'active');
    const [one, two] = data.tasks as Array<Record<string, unknown>>;
    (one as Record<string, unknown>).status = 'parked';
    (two as Record<string, unknown>).parent = 'LB-9';
    (two as Record<string, unknown>).fields = { color: 'red' };
    writeRaw(path.join(s.dir, 'active.json'), JSON.stringify(data));

    const r = await doctor(as(s), { fix: true });
    expect(checkOf(r, 'statuses')).toMatchObject({ ok: false, fixed: false });
    expect(checkOf(r, 'statuses')?.message).toContain('LB-1 (parked)');
    expect(checkOf(r, 'parents')?.message).toContain('LB-2 (parent LB-9)');
    expect(checkOf(r, 'attachment content')?.message).toContain('LB-1/r.txt (sha256 differs)');
    expect(checkOf(r, 'fields')?.message).toContain('LB-2 color (not declared)');
    expect(r.data.healthy).toBe(false);
    fs.writeFileSync(stored, 'short');
    expect(checkOf(await doctor(as(s), {}), 'attachment content')?.message).toContain('LB-1/r.txt (5 bytes, metadata 11)');
  });
});
