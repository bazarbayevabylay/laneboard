// Output of a write that changed one task: short data and one human line, or the whole task with --full.
import { writeReply } from '../../core/index.ts';
import type { OpResult, TaskView } from '../../core/index.ts';
import { taskText } from '../format.ts';
import { flag } from './args.ts';
import type { CommandContext, CommandOutput, OptionSpec } from './types.ts';

// The option every such write takes.
export const FULL_OPTION: OptionSpec = { full: { type: 'boolean' } };

// Commit shown in the human line of finish (the JSON reply has the full sha).
const COMMIT_SHOWN = 12;

// `LB-1 commented (rev 2, todo, unassigned)` and the short data (id, rev, status, assignee, plus what the write did: resumed_from,
// commit); --full: the task as `get` shows it. `attached`: the write added an attachment, so the short data names it.
export function taskReply(c: CommandContext, r: OpResult<TaskView>, what: string, attached = false): CommandOutput {
  const t = r.data;
  if (flag(c.values, 'full')) return { data: t, warnings: r.warnings, human: taskText(t) };
  const commit = r.reply?.commit;
  const linked = commit === undefined ? '' : commit === null ? '; no commit linked' : `; commit ${commit.slice(0, COMMIT_SHOWN)} linked`;
  return { data: writeReply(t, attached, r.reply), warnings: r.warnings, human: `${t.id} ${what} (rev ${t.rev}, ${t.status}, ${t.assignee ?? 'unassigned'})${linked}` };
}

// The reply of a write that starts your work (claim; create with you as assignee): its human line names `next`, the comment of your
// plan, as the short data does (0.5.1: now, not after the work); --full shows the task instead.
export function withPlan(c: CommandContext, out: CommandOutput, next: string | undefined): CommandOutput {
  return next === undefined || flag(c.values, 'full') ? out : { ...out, human: `${out.human}; now comment your plan, then each step: ${next}` };
}
