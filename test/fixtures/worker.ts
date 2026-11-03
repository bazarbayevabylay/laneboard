// Child process for multi-process tests: concurrent creates, archive/restore flipping, holding the lock, a paused writer.
import fs from 'node:fs';
import path from 'node:path';
import { archiveTasks, createTask, LaneboardError, restoreTask, transact } from '../../src/core/index.ts';
import { acquireLock } from '../../src/core/lock.ts';

const [mode, dir = '', arg = ''] = process.argv.slice(2);
const ctx = { store: { dir }, actor: `worker-${process.pid}` };

if (mode === 'create') {
  for (let i = 0; i < Number(arg); i++) await createTask(ctx, { title: `t${process.pid}-${i}`, status: 'todo' });
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
} else {
  process.stderr.write(`unknown mode ${String(mode)}\n`);
  process.exitCode = 2;
}
