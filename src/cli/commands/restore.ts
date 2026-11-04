// laneboard restore
import { restoreTask } from '../../core/index.ts';
import { FULL_OPTION, taskReply } from './reply.ts';
import type { CommandDef } from './types.ts';

export const restore: CommandDef = {
  name: 'restore',
  usage: 'restore <id> [--full]',
  summary: 'Move an archived task back to active.',
  options: { ...FULL_OPTION },
  args: { min: 1, max: 1 },
  async run(c) {
    const r = await restoreTask(c.op(), { id: c.positionals[0] ?? '' });
    return taskReply(c, r, 'restored');
  },
};
