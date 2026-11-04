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
    '--resume: take over a task of another session of your session default name (your own work before /clear, listed by prime).',
  options: { status: { type: 'string' }, 'expected-rev': { type: 'string' }, resume: { type: 'boolean' }, ...FULL_OPTION },
  args: { min: 1, max: 1 },
  async run(c) {
    const r = await claimTask(c.op(), { id: c.positionals[0] ?? '', status: str(c.values, 'status'), expected_rev: int(c.values, 'expected-rev'), resume: flag(c.values, 'resume') || undefined });
    return taskReply(c, r, r.reply?.resumed_from === undefined ? 'claimed' : `resumed from ${r.reply.resumed_from}`);
  },
};
