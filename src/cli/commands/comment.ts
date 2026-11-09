// laneboard comment
import { commentTask, LaneboardError } from '../../core/index.ts';
import { exclusive, readTextFile, str } from './args.ts';
import { FULL_OPTION, taskReply } from './reply.ts';
import type { CommandDef } from './types.ts';

export const comment: CommandDef = {
  name: 'comment',
  usage: 'comment <id> (<text> | - | --file P|-) [--full]',
  summary:
    'Add a comment (notes, results). - as the text, --file - or --text-file -: the text from stdin; text with quotes, tabs or newlines goes best as a heredoc: ' +
    "laneboard comment LB-1 - --json <<'EOF' ... EOF. --file P: from a file.",
  options: { file: { type: 'string' }, 'text-file': { type: 'string' }, ...FULL_OPTION },
  args: { min: 1, max: 2 },
  async run(c) {
    // --text-file (the name redact gives the same option) is --file.
    exclusive(c.values, 'file', 'text-file');
    const file = str(c.values, 'file') ?? str(c.values, 'text-file');
    const inline = c.positionals[1];
    if ((file === undefined) === (inline === undefined)) {
      throw new LaneboardError('USAGE', 'pass the comment text or --file, exactly one', { edit: file === undefined ? { args: ['<text>'] } : { drop: [{ name: 'file' }, { name: 'text-file' }] } });
    }
    // `comment LB-1 -`: the text from stdin, as `--file -`.
    const text = file !== undefined ? readTextFile(c.io, file, str(c.values, 'file') === undefined ? 'text-file' : 'file') : inline === '-' ? c.io.readStdin() : (inline ?? '');
    const r = await commentTask(c.op(), { id: c.positionals[0] ?? '', text });
    return taskReply(c, r, 'commented');
  },
};
