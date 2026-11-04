// S6a (LB-27, audit A1 and A27): a write the disk does not take in full (full disk, ulimit -f, a short writeSync) replaces nothing:
// the store file and its .bak keep their bytes, no tmp is left, an attachment is never recorded over broken bytes;
// file modes follow the umask.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { attachFile, createTask, getTask, updateTask } from '../../src/core/index.ts';
import { as, CLI_SOURCE, cleanupTemp, newStore, readStore, rejectsWith, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);
afterEach(() => {
  vi.restoreAllMocks();
});

const realWriteSync = fs.writeSync.bind(fs) as (fd: number, buf: Buffer, offset: number, length: number) => number;

// How the patched writeSync misbehaves on its `failAt`-th call (1-based); earlier calls write normally.
type Misbehave =
  // Writes half and reports half; every later call fails with EFBIG (what ulimit -f does).
  | 'half_then_efbig'
  // Writes half and reports half; later calls write normally (a legal short write the caller must continue).
  | 'half_then_ok'
  // Writes half but reports the full length (only the size check after fsync can see it).
  | 'half_reported_full'
  // Writes the full length with the first byte flipped (only a read-back of the content can see it).
  | 'flip_byte';

// Replace fs.writeSync for buffer writes; returns the number of calls seen.
function patchWriteSync(failAt: number, how: Misbehave): { calls: () => number } {
  let calls = 0;
  let failed = false;
  const fake = (fd: number, buf: Buffer, offset = 0, length = buf.length - offset): number => {
    calls += 1;
    if (failed && how === 'half_then_efbig') throw Object.assign(new Error('EFBIG: file too large, write'), { code: 'EFBIG', errno: -27 });
    if (calls !== failAt) return realWriteSync(fd, buf, offset, length);
    failed = true;
    const half = Math.floor(length / 2);
    if (how === 'flip_byte') {
      const copy = Buffer.from(buf.subarray(offset, offset + length));
      copy[0] = (copy[0] ?? 0) ^ 0xff;
      return realWriteSync(fd, copy, 0, copy.length);
    }
    const written = realWriteSync(fd, buf, offset, half);
    return how === 'half_reported_full' ? length : written;
  };
  // fsio calls writeSync(fd, buffer, offset, length) only.
  vi.spyOn(fs, 'writeSync').mockImplementation(fake as unknown as typeof fs.writeSync);
  return { calls: () => calls };
}

// sha256 of a file on disk.
function shaOf(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// sha256 of active.json and active.json.bak.
function storeShas(s: TestStore): { active: string; bak: string } {
  return { active: shaOf(path.join(s.dir, 'active.json')), bak: shaOf(path.join(s.dir, 'active.json.bak')) };
}

// Tmp files left anywhere in the store directory.
function tmpFiles(s: TestStore): string[] {
  return fs.readdirSync(s.dir, { recursive: true }).map(String).filter((f) => f.endsWith('.tmp'));
}

// A store with two tasks, so active.json and active.json.bak both exist and differ.
async function storeWithTwoTasks(): Promise<TestStore> {
  const s = await newStore();
  await createTask(as(s), { title: 'first', status: 'todo' });
  await createTask(as(s), { title: 'second', status: 'todo' });
  return s;
}

describe('A1 a short write replaces nothing', () => {
  it('short write of active.json.bak (first write) -> INTERNAL naming EFBIG; active.json and .bak keep their bytes, no tmp', async () => {
    const s = await storeWithTwoTasks();
    const before = storeShas(s);
    patchWriteSync(1, 'half_then_efbig');
    const err = await rejectsWith(updateTask(as(s), { id: 'LB-1', title: 'changed' }), 'INTERNAL');
    vi.restoreAllMocks();
    expect(err.message).toBe(`${path.join(s.dir, 'active.json.bak')} was not written (EFBIG); the file on disk was not replaced`);
    expect(err.fix).toBe('free disk space, then run the same command again');
    expect(storeShas(s)).toEqual(before);
    expect(tmpFiles(s)).toEqual([]);
    expect((await getTask(as(s), { id: 'LB-1' })).data.title).toBe('first');
  });

  it('short write of active.json (after .bak) -> INTERNAL naming EFBIG; active.json keeps its bytes, the board still reads', async () => {
    const s = await storeWithTwoTasks();
    const before = storeShas(s);
    const spy = patchWriteSync(2, 'half_then_efbig');
    const err = await rejectsWith(updateTask(as(s), { id: 'LB-1', title: 'changed' }), 'INTERNAL');
    expect(spy.calls()).toBeGreaterThanOrEqual(3);
    vi.restoreAllMocks();
    expect(err.message).toContain(`${path.join(s.dir, 'active.json')} was not written (EFBIG)`);
    expect(shaOf(path.join(s.dir, 'active.json'))).toBe(before.active);
    // .bak was rewritten whole with the current (valid) active.json.
    expect(fs.readFileSync(path.join(s.dir, 'active.json.bak'))).toEqual(fs.readFileSync(path.join(s.dir, 'active.json')));
    expect(tmpFiles(s)).toEqual([]);
    expect((await getTask(as(s), { id: 'LB-1' })).data.title).toBe('first');
  });

  it('a short write the disk then completes is continued: the file is whole', async () => {
    const s = await storeWithTwoTasks();
    patchWriteSync(2, 'half_then_ok');
    await updateTask(as(s), { id: 'LB-1', title: 'changed' });
    vi.restoreAllMocks();
    expect(readStore(s.dir, 'active').tasks.map((t) => t.title)).toEqual(['changed', 'second']);
    expect(tmpFiles(s)).toEqual([]);
  });

  it('a writeSync that reports more than reached the file -> the size check after fsync refuses the rename', async () => {
    const s = await storeWithTwoTasks();
    const before = storeShas(s);
    patchWriteSync(2, 'half_reported_full');
    const err = await rejectsWith(updateTask(as(s), { id: 'LB-1', title: 'changed' }), 'INTERNAL');
    vi.restoreAllMocks();
    expect(err.message).toContain(`${path.join(s.dir, 'active.json')} was not written (SHORT_WRITE)`);
    expect(shaOf(path.join(s.dir, 'active.json'))).toBe(before.active);
    expect(tmpFiles(s)).toEqual([]);
  });
});

describe('A1 an attachment is recorded only over its exact bytes', () => {
  // A 200 KB random source file in its own temp folder.
  function sourceFile(): { file: string; bytes: Buffer } {
    const bytes = crypto.randomBytes(200_000);
    const file = path.join(tempDir(), 'report.bin');
    fs.writeFileSync(file, bytes);
    return { file, bytes };
  }

  it('short attachment write -> INTERNAL, no file, no metadata, active.json untouched', async () => {
    const s = await storeWithTwoTasks();
    const { file } = sourceFile();
    const before = storeShas(s);
    patchWriteSync(1, 'half_then_efbig');
    const err = await rejectsWith(attachFile(as(s), { id: 'LB-1', path: file }), 'INTERNAL');
    vi.restoreAllMocks();
    expect(err.message).toContain('report.bin was not written (EFBIG)');
    expect(fs.readdirSync(path.join(s.dir, 'attachments', 'LB-1'))).toEqual([]);
    expect((await getTask(as(s), { id: 'LB-1' })).data.attachments).toEqual([]);
    expect(storeShas(s)).toEqual(before);
    expect(tmpFiles(s)).toEqual([]);
  });

  it('stored bytes differ from the source (same size) -> the read-back refuses: file removed, no metadata', async () => {
    const s = await storeWithTwoTasks();
    const { file } = sourceFile();
    const before = storeShas(s);
    patchWriteSync(1, 'flip_byte');
    const err = await rejectsWith(attachFile(as(s), { id: 'LB-1', path: file }), 'INTERNAL');
    vi.restoreAllMocks();
    expect(err.message).toBe(`${path.join(s.dir, 'attachments', 'LB-1', 'report.bin')} was stored broken (sha256 differs) and was removed; the task is unchanged`);
    expect(err.fix).toBe('free disk space, then run the same command again');
    expect(fs.readdirSync(path.join(s.dir, 'attachments', 'LB-1'))).toEqual([]);
    expect((await getTask(as(s), { id: 'LB-1' })).data.attachments).toEqual([]);
    expect(storeShas(s)).toEqual(before);
  });

  it('a normal attach records size and sha256 equal to the stored file', async () => {
    const s = await storeWithTwoTasks();
    const { file, bytes } = sourceFile();
    const view = await attachFile(as(s), { id: 'LB-1', path: file });
    const stored = path.join(s.dir, 'attachments', 'LB-1', 'report.bin');
    expect(view.data.attachments[0]).toMatchObject({ size: bytes.length, sha256: shaOf(stored) });
    expect(shaOf(stored)).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
  });
});

describe('A27 file modes follow the umask', () => {
  // Run the CLI from source in a child shell with `umask <mask>`, an isolated HOME and cwd.
  function cliWithUmask(mask: string, cwd: string, home: string, args: string[]): { code: number | null; stdout: string; stderr: string } {
    const res = spawnSync('/bin/sh', ['-c', `umask ${mask} && exec "$0" "$@"`, process.execPath, CLI_SOURCE, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: home },
      encoding: 'utf8',
    });
    return { code: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  // Permission bits of a file.
  function modeOf(file: string): number {
    return fs.statSync(file).mode & 0o777;
  }

  it.each([
    ['077', { attachment: 0o400, store: 0o400, config: 0o600, registry: 0o600 }],
    ['022', { attachment: 0o444, store: 0o444, config: 0o644, registry: 0o644 }],
  ])('umask %s -> attachment, active.json, config.json and boards.json modes', (mask, want) => {
    const root = tempDir();
    const home = tempDir();
    const src = path.join(root, 'u.txt');
    fs.writeFileSync(src, 'secret-ish\n', { mode: 0o600 });
    for (const args of [
      ['init', '--name', 'um', '--description', 'umask test', '--prefix', 'UM'],
      ['create', 'a', '--status', 'todo', '--as', 'qa'],
      ['attach', 'UM-1', src, '--as', 'qa'],
    ]) {
      const run = cliWithUmask(mask, root, home, args);
      expect(run.code, `${args.join(' ')}: ${run.stderr}`).toBe(0);
    }
    const dir = path.join(root, '.laneboard');
    expect(modeOf(path.join(dir, 'attachments', 'UM-1', 'u.txt'))).toBe(want.attachment);
    expect(modeOf(path.join(dir, 'active.json'))).toBe(want.store);
    expect(modeOf(path.join(dir, 'config.json'))).toBe(want.config);
    expect(modeOf(path.join(home, '.laneboard', 'boards.json'))).toBe(want.registry);
  });
});
