// laneboard comment
import { commentTask, LaneboardError } from '../../core/index.ts';
import { readTextFile, str } from './args.ts';
import { FULL_OPTION, taskReply } from './reply.ts';
import type { CommandDef } from './types.ts';

export const comment: CommandDef = {
  name: 'comment',
  usage: 'comment <id> (<text> | --file P|-) [--full]',
  summary: 'Add a comment (notes, results).',
  options: { file: { type: 'string' }, ...FULL_OPTION },
  args: { min: 1, max: 2 },
  async run(c) {
    const file = str(c.values, 'file');
    const inline = c.positionals[1];
    if ((file === undefined) === (inline === undefined)) {
      throw new LaneboardError('USAGE', 'pass the comment text or --file, exactly one', { edit: file === undefined ? { args: ['<text>'] } : { drop: [{ name: 'file' }] } });
    }
    const text = file !== undefined ? readTextFile(c.io, file, 'file') : (inline ?? '');
    const r = await commentTask(c.op(), { id: c.positionals[0] ?? '', text });
    return taskReply(c, r, 'commented');
  },
};
