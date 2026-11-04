// laneboard delete
import { deleteTask } from '../../core/index.ts';
import { int, str } from './args.ts';
import type { CommandDef } from './types.ts';

export const remove: CommandDef = {
  name: 'delete',
  usage: 'delete <id> --confirm <id> [--expected-rev N]',
  summary: 'Delete a task (active or archive) and its attachments; the archive keeps its id, title and who deleted it.',
  options: { confirm: { type: 'string' }, 'expected-rev': { type: 'string' } },
  args: { min: 1, max: 1 },
  flags: { confirm_id: '--confirm' },
  async run(c) {
    const r = await deleteTask(c.op(), {
      id: c.positionals[0] ?? '',
      confirm_id: str(c.values, 'confirm') as string,
      expected_rev: int(c.values, 'expected-rev'),
    });
    return { ...r, human: `${r.data.id} deleted` };
  },
};
