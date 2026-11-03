// laneboard get
import { getTask } from '../../core/index.ts';
import { taskText } from '../format.ts';
import { int } from './args.ts';
import type { CommandDef } from './types.ts';

export const get: CommandDef = {
  name: 'get',
  usage: 'get <id> [--events N]',
  summary: 'Show one task (searches the archive too; the result has "archived").',
  options: { events: { type: 'string' } },
  args: { min: 1, max: 1 },
  async run(c) {
    const r = await getTask(c.op(), { id: c.positionals[0] ?? '', events: int(c.values, 'events') });
    return { ...r, human: taskText(r.data) };
  },
};
