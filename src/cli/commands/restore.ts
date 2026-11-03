// laneboard restore
import { restoreTask } from '../../core/index.ts';
import type { CommandDef } from './types.ts';

export const restore: CommandDef = {
  name: 'restore',
  usage: 'restore <id>',
  summary: 'Move an archived task back to active.',
  options: {},
  args: { min: 1, max: 1 },
  async run(c) {
    const r = await restoreTask(c.op(), { id: c.positionals[0] ?? '' });
    return { ...r, human: `${r.data.id} restored (rev ${r.data.rev})` };
  },
};
