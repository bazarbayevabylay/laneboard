// Multi-process rules: W2 concurrent creates under the lock, W7 two-file reads vs a flipper, W8 SIGKILLed holder.
import { spawn } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { createTask, getTask, listTasks } from '../../src/core/index.ts';
import { as, cleanupTemp, newStore, readStore, spawnNode, WORKER } from '../helpers.ts';

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
