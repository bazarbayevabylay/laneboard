// Output of a write that changed one task: short data and one human line, or the whole task with --full.
import { writeReply } from '../../core/index.ts';
import type { OpResult, TaskView } from '../../core/index.ts';
import { taskText } from '../format.ts';
import { flag } from './args.ts';
import type { CommandContext, CommandOutput, OptionSpec } from './types.ts';

// The option every such write takes.
export const FULL_OPTION: OptionSpec = { full: { type: 'boolean' } };

// `LB-1 commented (rev 2, todo, unassigned)` and the short data (id, rev, status, assignee); --full: the task as `get` shows it.
// `attached`: the write added an attachment, so the short data names it.
export function taskReply(c: CommandContext, r: OpResult<TaskView>, what: string, attached = false): CommandOutput {
  const t = r.data;
  if (flag(c.values, 'full')) return { data: t, warnings: r.warnings, human: taskText(t) };
  return { data: writeReply(t, attached), warnings: r.warnings, human: `${t.id} ${what} (rev ${t.rev}, ${t.status}, ${t.assignee ?? 'unassigned'})` };
}
