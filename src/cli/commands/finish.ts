// laneboard finish
import { finishTask } from '../../core/index.ts';
import { flag, str } from './args.ts';
import { FULL_OPTION, taskReply } from './reply.ts';
import type { CommandDef } from './types.ts';

export const finish: CommandDef = {
  name: 'finish',
  usage: 'finish <id> --result T [--status S] [--no-commit] [--full]',
  summary:
    'Close your task in one write: the result comment, a link to the current git commit (HEAD; --no-commit: none), then the final status ' +
    '(--status: any but the first one, e.g. review to hand in). Only the assignee (or anybody for an unassigned task); no --expected-rev. ' +
    'Commit your changes first: uncommitted changes (staged too) or a HEAD commit older than your claim give a warning (git is asked; without it: a warning). ' +
    'Again in the same status: unchanged, a new commit is linked.',
  options: { result: { type: 'string' }, status: { type: 'string' }, 'no-commit': { type: 'boolean' }, ...FULL_OPTION },
  args: { min: 1, max: 1 },
  async run(c) {
    const r = await finishTask(c.op(), { id: c.positionals[0] ?? '', result: str(c.values, 'result') as string, status: str(c.values, 'status'), no_commit: flag(c.values, 'no-commit') || undefined });
    return taskReply(c, r, r.reply === undefined || r.unchanged === true ? 'unchanged' : 'finished');
  },
};
