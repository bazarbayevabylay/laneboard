// Child process for multi-process tests: concurrent creates, archive/restore flipping, holding the lock, a paused writer, creates that
// link a task of another board (ADR §30).
import fs from 'node:fs';
import path from 'node:path';
import { archiveTasks, createTask, LaneboardError, restoreTask, transact } from '../../src/core/index.ts';
import { acquireLock } from '../../src/core/lock.ts';

const [mode, dir = '', arg = '', count = '0', home = ''] = process.argv.slice(2);
const ctx = { store: { dir }, actor: `worker-${process.pid}` };

if (mode === 'create') {
  // W2 checks the ids of concurrent writers, not the 15 s wait budget (LOCK_TIMEOUT has tests of its own): the lock takes no turns,
  // and beside two full `npm test` runs one create of 8 writers waited up to 22.6 s (S6q measure, lb-audit/s6q-dev/w2-probe.ts).
  for (let i = 0; i < Number(arg); i++) await createTask({ ...ctx, lockWaitMs: 120_000 }, { title: `t${process.pid}-${i}`, status: 'todo' });
} else if (mode === 'flip') {
  for (let i = 0; i < Number(arg); i++) {
    await archiveTasks(ctx, { ids: ['LB-1'] });
    await restoreTask(ctx, { id: 'LB-1' });
  }
} else if (mode === 'hold') {
  await acquireLock(dir);
  process.stdout.write('locked\n');
  await new Promise((resolve) => setTimeout(resolve, Number(arg)));
} else if (mode === 'pause') {
  // A writer that stalls inside its mutation (like SIGSTOP or a laptop sleep) until the file `arg` appears.
  const holding = path.join(path.dirname(dir), 'holding');
  try {
    await transact({ dir }, { files: ['active', 'archive'] }, (s) => {
      fs.writeFileSync(holding, String(process.pid));
      const giveUp = Date.now() + 40_000;
      // Busy wait: the event loop never runs, so the lock heartbeat cannot either.
      while (!fs.existsSync(arg) && Date.now() < giveUp);
      const task = s.active.tasks[0];
      if (task) task.title = 'written by the paused writer';
    });
    process.stdout.write('committed\n');
  } catch (err) {
    process.stdout.write(`${err instanceof LaneboardError ? err.code : String(err)}\n`);
  }
} else if (mode === 'link') {
  // `count` creates on the board at `dir`, each linking task `arg` of another board of the registry under `home`; prints each outcome.
  const outcomes: string[] = [];
  for (let i = 0; i < Number(count); i++) {
    try {
      await createTask({ ...ctx, home, lockWaitMs: 5000 }, { title: `link ${i}`, status: 'todo', links: [{ kind: 'task', ref: arg }] });
      outcomes.push('ok');
    } catch (err) {
      outcomes.push(err instanceof LaneboardError ? err.code : String(err));
    }
  }
  process.stdout.write(`${outcomes.join(' ')}\n`);
} else {
  process.stderr.write(`unknown mode ${String(mode)}\n`);
  process.exitCode = 2;
}
