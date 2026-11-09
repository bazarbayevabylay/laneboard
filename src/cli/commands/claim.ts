// laneboard claim
import { claimTask } from '../../core/index.ts';
import { flag, int, str } from './args.ts';
import { FULL_OPTION, taskReply } from './reply.ts';
import type { CommandDef } from './types.ts';

export const claim: CommandDef = {
  name: 'claim',
  usage: 'claim <id> [--status S] [--expected-rev N] [--resume] [--full]',
  summary:
    'Take a task: assignee := you. Fails with ALREADY_CLAIMED if someone else holds it. ' +
    'Without --status, your own task, or one you take back with --resume, leaves the first status for the work status (the one before the checks, else the second unless it is the final one). ' +
    'On a board with checks a task that waits for a check is claimed by nobody: a checker passes it on with finish --status <next>, no claim. ' +
    '--resume: take over a task of another session of your session default name (your own work before /clear or a restart, listed by prime); ' +
    'one that waits for a check is handed in already: that session and this one are its author. A closed task is not resumed: new work is a new task.',
  options: { status: { type: 'string' }, 'expected-rev': { type: 'string' }, resume: { type: 'boolean' }, ...FULL_OPTION },
  args: { min: 1, max: 1 },
  defaults: { status: 'claim moves your task from the first status to the work status', 'expected-rev': 'claim needs no rev' },
  async run(c) {
    const r = await claimTask(c.op(), { id: c.positionals[0] ?? '', status: str(c.values, 'status'), expected_rev: int(c.values, 'expected-rev'), resume: flag(c.values, 'resume') || undefined });
    const out = taskReply(c, r, r.reply?.resumed_from === undefined ? 'claimed' : `resumed from ${r.reply.resumed_from}`);
    // The short reply carries `next` (the comment command); the human line names it too.
    const next = r.reply?.next;
    return next === undefined || flag(c.values, 'full') ? out : { ...out, human: `${out.human}; after each step: ${next}` };
  },
};
