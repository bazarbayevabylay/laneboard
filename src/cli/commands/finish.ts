// laneboard finish
import { finishTask } from '../../core/index.ts';
import type { WriteReply } from '../../core/index.ts';
import { flag, str } from './args.ts';
import { FULL_OPTION, taskReply } from './reply.ts';
import type { CommandDef } from './types.ts';

export const finish: CommandDef = {
  name: 'finish',
  usage: 'finish <id> --result T [--status S] [--commit SHA | --no-commit] [--full]',
  summary:
    'Close your task in one write: the result comment, a link to the current git commit (HEAD of this folder; --commit SHA: that commit, ' +
    'e.g. from your git worktree when you run finish elsewhere; --no-commit: none), then the final status ' +
    '(--status: any but the first one, e.g. review to hand in). Only the assignee (or anybody for an unassigned task); no --expected-rev. ' +
    'Your finish into a status that is not final hands the task in (the status event and the reply say handed_in). ' +
    "Somebody else's task only to accept it after its assignee handed it in with finish: into the final status, no commit link (the status event says accepted). " +
    'Commit your changes first: uncommitted changes (staged too) or a HEAD commit older than your claim give a warning (git is asked; without it: a warning). ' +
    'In the main checkout of a repository whose other worktrees have newer commits: a warning naming them, with the command that fixes the link. ' +
    'Again in the same status: a new result is recorded (handed in again after rework), the same result again changes nothing; a new commit is linked; ' +
    'a closed task keeps its result. ' +
    'On a board with checks (laneboard config --review-statuses): your finish hands in to the check the task is in, else the first check, never into a later one or the final status, nor into a status that is no check (to put it there with your result: comment, then update --status); ' +
    "a checker's finish --status <next> passes the handed-in task on to the next check (the status event says passed) and from the last one --status <final> accepts it; " +
    'without --status, with the check the task is in or past the next one it is refused (the task may have moved on since you read it; prime prints the command); config review.by names the checkers.',
  options: { result: { type: 'string' }, status: { type: 'string' }, commit: { type: 'string' }, 'no-commit': { type: 'boolean' }, ...FULL_OPTION },
  args: { min: 1, max: 1 },
  textOption: 'result',
  async run(c) {
    const r = await finishTask(c.op(), { id: c.positionals[0] ?? '', result: str(c.values, 'result') as string, status: str(c.values, 'status'), commit: str(c.values, 'commit'), no_commit: flag(c.values, 'no-commit') || undefined });
    const what = r.reply === undefined || r.unchanged === true ? 'unchanged' : r.reply.accepted === true ? 'accepted' : r.reply.passed === true ? `passed to ${r.data.status}` : r.handed_in === true ? 'handed in' : 'finished';
    const out = taskReply(c, r, what);
    // A hand-in says so in the short reply too (LB-63.3), not only in the human line; --full shows the task, whose status event says it.
    return r.handed_in === true && !flag(c.values, 'full') ? { ...out, data: { ...(out.data as WriteReply), handed_in: true } } : out;
  },
};
