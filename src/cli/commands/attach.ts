// laneboard attach
import path from 'node:path';
import { attachFile, LaneboardError } from '../../core/index.ts';
import { str } from './args.ts';
import type { CommandDef } from './types.ts';

export const attach: CommandDef = {
  name: 'attach',
  usage: 'attach <id> <path> [--name N]  |  attach <id> --remove <name>',
  summary: 'Attach a file to a task, or remove an attachment.',
  options: { name: { type: 'string' }, remove: { type: 'string' } },
  args: { min: 1, max: 2 },
  async run(c) {
    const source = c.positionals[1];
    const remove = str(c.values, 'remove');
    if ((source === undefined) === (remove === undefined)) throw new LaneboardError('USAGE', 'pass a file path, or --remove <name>, exactly one');
    const r = await attachFile(c.op(), {
      id: c.positionals[0] ?? '',
      path: source === undefined ? undefined : path.resolve(c.io.cwd, source),
      name: str(c.values, 'name'),
      remove,
    });
    if (remove !== undefined) return { ...r, human: `${r.data.id} detached ${remove} (rev ${r.data.rev})` };
    const added = r.data.attachments[r.data.attachments.length - 1];
    return { ...r, human: `${r.data.id} attached ${added?.name ?? ''}, ${added?.size ?? 0} bytes (rev ${r.data.rev})` };
  },
};
