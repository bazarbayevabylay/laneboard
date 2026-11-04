// Multi-process rules: W2 concurrent creates and the lost lock, W7 two-file reads vs a flipper, W8 SIGKILLed holder, K5 parent cycles,
// parallel description appends (review S5a MINOR 3).
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTask, getTask, listTasks } from '../../src/core/index.ts';
import { as, CLI_SOURCE, cleanupTemp, newStore, readStore, rejectsWith, spawnNode, WORKER } from '../helpers.ts';

afterAll(cleanupTemp);

describe('W2 concurrent writers', () => {
  it('8 processes x 25 creates -> 200 tasks, ids LB-1..LB-200 without duplicates', async () => {
    const s = await newStore();
    const runs = await Promise.all(Array.from({ length: 8 }, () => spawnNode([WORKER, 'create', s.dir, '25'])));
    for (const r of runs) expect(r, r.stderr).toMatchObject({ code: 0 });
    const active = readStore(s.dir, 'active');
    const ids = active.tasks.map((t) => t.id);
    expect(ids).toHaveLength(200);
    expect(new Set(ids).size).toBe(200);
    expect(new Set(ids)).toEqual(new Set(Array.from({ length: 200 }, (_, i) => `LB-${i + 1}`)));
    expect(active.next_id).toBe(201);
    expect(active.rev).toBe(200);
  });
});

// Poll until `check` is true (max 20 s).
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in 20 s');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Start a child that holds the store lock until killed; resolves once it has the lock.
async function holdLock(dir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [WORKER, 'hold', dir, '60000'], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve) => child.stdout?.on('data', (d: Buffer) => d.toString().includes('locked') && resolve()));
  return child;
}

describe('W2 lost lock', () => {
  it('a writer paused past the stale window neither overwrites the process that took the lock over nor removes a later lock', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'first', status: 'todo' });
    const go = path.join(s.root, 'go');
    const paused = spawnNode([WORKER, 'pause', s.dir, go]);
    await until(() => fs.existsSync(path.join(s.root, 'holding')));

    // B waits until the lock looks stale (no heartbeat for 10 s), takes it over and writes LB-2.
    const b = await spawnNode([CLI_SOURCE, 'create', 'B task', '--status', 'todo', '--as', 'b', '--json'], { cwd: s.root });
    expect(b.code, b.stdout + b.stderr).toBe(0);
    expect(JSON.parse(b.stdout).data.id).toBe('LB-2');

    // C owns the lock when the paused writer wakes up: the writer must refuse to write and leave C's lock alone.
    const holder = await holdLock(s.dir);
    try {
      fs.writeFileSync(go, '');
      const a = await paused;
      // B's task survives and next_id never goes back (W9); then the paused writer reports the lost lock.
      const active = readStore(s.dir, 'active');
      expect(active.tasks.map((t) => [t.id, t.title])).toEqual([
        ['LB-1', 'first'],
        ['LB-2', 'B task'],
      ]);
      expect(active.next_id).toBe(3);
      expect(a.stdout.trim(), a.stderr).toBe('LOCK_LOST');
      await rejectsWith(createTask(as(s, 'tester', { lockWaitMs: 300 }), { title: 'while C holds', status: 'todo' }), 'LOCK_TIMEOUT');
    } finally {
      holder.kill('SIGTERM');
      await new Promise((resolve) => holder.on('exit', resolve));
    }
    expect((await createTask(as(s), { title: 'after', status: 'todo' })).data.id).toBe('LB-3');
  });
});

describe('W7 reads across both files', () => {
  it('a reader never misses a task while another process archives/restores it 200 times', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'flip', status: 'todo' });
    let done = false;
    const flipper = spawnNode([WORKER, 'flip', s.dir, '200']).then((r) => {
      done = true;
      return r;
    });
    let reads = 0;
    let wrong = 0;
    while (!done) {
      const got = await getTask(as(s), { id: 'LB-1' }).catch(() => undefined);
      if (!got) wrong++;
      const all = await listTasks(as(s), { scope: 'all' });
      if (all.data.total !== 1) wrong++;
      reads += 2;
      // Yield to the event loop so the child's exit is seen even when reads never block.
      await new Promise((resolve) => setImmediate(resolve));
    }
    const r = await flipper;
    expect(r.code, r.stderr).toBe(0);
    expect(reads).toBeGreaterThan(0);
    expect(wrong).toBe(0);
  });
});

describe('W8 crash recovery', () => {
  it('a SIGKILLed lock holder is taken over after the stale window (10 s)', async () => {
    const s = await newStore();
    const child = spawn(process.execPath, [WORKER, 'hold', s.dir, '60000'], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => child.stdout.on('data', (d: Buffer) => d.toString().includes('locked') && resolve()));
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));
    const started = Date.now();
    const created = await createTask(as(s), { title: 'after crash', status: 'todo' });
    const waited = Date.now() - started;
    expect(created.data.id).toBe('LB-1');
    expect(waited).toBeLessThan(15_000);
  });
});

describe('K5 (ADR §25): no parent cycle under parallel writers', () => {
  it('two processes cross-set parents (LB-1 under LB-2, LB-2 under LB-1): exactly one wins, the other gets INVALID_VALUE; no cycle stored', async () => {
    for (let round = 0; round < 3; round++) {
      const s = await newStore();
      await createTask(as(s), { title: 'A', status: 'todo' });
      await createTask(as(s), { title: 'B', status: 'todo' });
      const update = (id: string, parent: string) => spawnNode([CLI_SOURCE, 'update', id, '--parent', parent, '--as', `w-${id}`, '--json'], { cwd: s.root });
      const runs = await Promise.all([update('LB-1', 'LB-2'), update('LB-2', 'LB-1')]);
      expect(runs.map((r) => r.code).sort(), runs.map((r) => r.stdout + r.stderr).join('\n')).toEqual([0, 2]);
      const failed = runs.find((r) => r.code === 2);
      expect(JSON.parse(failed?.stdout ?? '{}').error.code).toBe('INVALID_VALUE');
      const parents = await Promise.all(['LB-1', 'LB-2'].map(async (id) => (await getTask(as(s), { id })).data.parent));
      expect(parents.filter((p) => p !== null)).toHaveLength(1);
    }
  });
});

describe('review S5a MINOR 3 (ADR §26): appends computed under the lock, never from an earlier read', () => {
  it('8 processes append and 1 renames while another process holds the lock, then all write: every paragraph, the new title, rev 10', async () => {
    const s = await newStore();
    await createTask(as(s), { title: 'Shared', status: 'todo', description: 'start' });
    // Every writer starts while the lock is held, so a writer that built its text before taking the lock would read the same old text.
    const holder = await holdLock(s.dir);
    const writers: Array<Promise<Awaited<ReturnType<typeof spawnNode>>>> = [];
    try {
      for (let i = 0; i < 8; i++) writers.push(spawnNode([CLI_SOURCE, 'update', 'LB-1', '--append-description', `para-${i}`, '--as', `w-${i}`, '--json'], { cwd: s.root }));
      writers.push(spawnNode([CLI_SOURCE, 'update', 'LB-1', '--title', 'Renamed', '--as', 'w-title', '--json'], { cwd: s.root }));
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } finally {
      holder.kill('SIGTERM');
      await new Promise((resolve) => holder.on('exit', resolve));
    }
    const runs = await Promise.all(writers);
    for (const r of runs) expect(r, r.stdout + r.stderr).toMatchObject({ code: 0 });
    const task = (await getTask(as(s), { id: 'LB-1' })).data;
    expect(task.description.split('\n\n').sort()).toEqual(['start', ...Array.from({ length: 8 }, (_, i) => `para-${i}`)].sort());
    expect(task.title).toBe('Renamed');
    expect(task.rev).toBe(10);
  });
});
