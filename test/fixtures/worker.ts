// Child process for multi-process tests: concurrent creates, archive/restore flipping, holding the lock.
import { archiveTasks, createTask, restoreTask } from '../../src/core/index.ts';
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
} else {
  process.stderr.write(`unknown mode ${String(mode)}\n`);
  process.exitCode = 2;
}
