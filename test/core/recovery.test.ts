// W8 corrupt files and config validation; doctor checks, --fix and --restore-backup.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { attachFile, createTask, doctor, getTask, listTasks, migrateStore } from '../../src/core/index.ts';
import { as, cleanupTemp, newStore, readStore, rejectsWith, tempDir, writeRaw } from '../helpers.ts';

afterAll(cleanupTemp);

describe('W8 invalid store files', () => {
  it('unparseable active.json -> STORE_INVALID for reads and writes; doctor --restore-backup swaps in .bak', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'todo' });
    await createTask(as(s), { title: 'b', status: 'todo' });
    writeRaw(path.join(s.dir, 'active.json'), '{"schema": broken');
    await rejectsWith(getTask(as(s), { id: 'LB-1' }), 'STORE_INVALID');
    await rejectsWith(listTasks(as(s), {}), 'STORE_INVALID');
    await rejectsWith(createTask(as(s), { title: 'c', status: 'todo' }), 'STORE_INVALID');

    const report = await doctor(as(s), {});
    expect(report.data.healthy).toBe(false);
    expect(report.data.checks.find((c) => c.name === 'active.json')?.message).toContain('--restore-backup');

    const restored = await doctor(as(s), { restore_backup: true });
    const check = restored.data.checks.find((c) => c.name === 'active.json');
    expect(check).toMatchObject({ ok: false, fixed: true });
    expect(check?.message).toContain('current: unreadable; backup: 1 tasks');
    expect(fs.readdirSync(s.dir).some((f) => f.startsWith('active.json.invalid-'))).toBe(true);
    expect((await getTask(as(s), { id: 'LB-1' })).data.title).toBe('a');
  });

  it('schema-invalid task -> STORE_INVALID naming the path', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'todo' });
    const data = readStore(s.dir, 'active');
    (data.tasks[0] as Record<string, unknown>).rev = 0;
    writeRaw(path.join(s.dir, 'active.json'), JSON.stringify(data));
    const err = await rejectsWith(getTask(as(s), { id: 'LB-1' }), 'STORE_INVALID');
    expect(err.message).toContain('active.json tasks.0.rev');
  });

  it('hand edit -> checksum warning; doctor --fix accepts it', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'todo' });
    const data = readStore(s.dir, 'active');
    (data.tasks[0] as Record<string, unknown>).title = 'edited';
    writeRaw(path.join(s.dir, 'active.json'), JSON.stringify(data));
    const got = await getTask(as(s), { id: 'LB-1' });
    expect(got.data.title).toBe('edited');
    expect(got.warnings.join()).toContain('content_sha256 mismatch');
    const fixed = await doctor(as(s), { fix: true });
    expect(fixed.data.healthy).toBe(true);
    expect((await getTask(as(s), { id: 'LB-1' })).warnings).toEqual([]);
  });
});

describe('config validation', () => {
  it('an unknown key fails loudly (STORE_INVALID); a newer config fails with STORE_TOO_NEW', async () => {
    const s = await newStore();
    const file = path.join(s.dir, 'config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...config, limits: { ...config.limits, event_per_task: 5 } }));
    const err = await rejectsWith(listTasks(as(s), {}), 'STORE_INVALID');
    expect(err.message).toContain('config.json limits');
    fs.writeFileSync(file, JSON.stringify({ ...config, schema: 'laneboard/config@3' }));
    await rejectsWith(listTasks(as(s), {}), 'STORE_TOO_NEW');
  });

  it('duplicate statuses are rejected', async () => {
    const s = await newStore();
    const file = path.join(s.dir, 'config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...config, statuses: ['todo', 'todo'] }));
    await rejectsWith(listTasks(as(s), {}), 'STORE_INVALID');
  });
});

describe('doctor', () => {
  it('reports and fixes duplicates, next_id, orphan tmp and orphan attachment files; reports missing files', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'a', status: 'todo' });
    const src = path.join(tempDir(), 'note.txt');
    fs.writeFileSync(src, 'hello');
    await attachFile(as(s), { id: 'LB-1', path: src });

    const active = readStore(s.dir, 'active');
    const archive = readStore(s.dir, 'archive');
    archive.tasks.push({ ...(active.tasks[0] as { id: string; rev: number }), rev: 99 });
    active.next_id = 1;
    writeRaw(path.join(s.dir, 'active.json'), JSON.stringify(active));
    writeRaw(path.join(s.dir, 'archive.json'), JSON.stringify(archive));
    fs.writeFileSync(path.join(s.dir, 'active.json.123.abc123.tmp'), 'x');
    fs.mkdirSync(path.join(s.dir, 'attachments', 'LB-9'), { recursive: true });
    fs.writeFileSync(path.join(s.dir, 'attachments', 'LB-9', 'stray.txt'), 'x');

    const report = await doctor(as(s), {});
    const failing = report.data.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failing).toEqual(['archive.json checksum', 'duplicates', 'next_id', 'tmp files', 'attachment files']);

    const fixed = await doctor(as(s), { fix: true });
    expect(fixed.data.healthy).toBe(true);
    expect((await doctor(as(s), {})).data.checks.every((c) => c.ok)).toBe(true);
    expect(readStore(s.dir, 'active').tasks).toEqual([]);
    expect(readStore(s.dir, 'active').next_id).toBe(2);
    expect(fs.existsSync(path.join(s.dir, 'attachments', 'LB-9'))).toBe(false);

    fs.chmodSync(path.join(s.dir, 'attachments', 'LB-1', 'note.txt'), 0o644);
    fs.rmSync(path.join(s.dir, 'attachments', 'LB-1', 'note.txt'));
    const missing = await doctor(as(s), {});
    expect(missing.data.checks.find((c) => c.name === 'attachment metadata')?.ok).toBe(false);
  });

  it('migrate verifies store@1 and refuses newer files', async () => {
    const s = await newStore();
    expect((await migrateStore(as(s))).data).toEqual({ schema: 'laneboard/store@1', migrated: [] });
    const data = readStore(s.dir, 'archive');
    data.schema = 'laneboard/store@2';
    writeRaw(path.join(s.dir, 'archive.json'), JSON.stringify(data));
    await rejectsWith(migrateStore(as(s)), 'STORE_TOO_NEW');
  });
});
