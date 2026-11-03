// laneboard claim
import { claimTask } from '../../core/index.ts';
import { int, str } from './args.ts';
import type { CommandDef } from './types.ts';

export const claim: CommandDef = {
  name: 'claim',
  usage: 'claim <id> [--status S] [--expected-rev N]',
  summary: 'Take a task: assignee := you. Fails with ALREADY_CLAIMED if someone else holds it.',
  options: { status: { type: 'string' }, 'expected-rev': { type: 'string' } },
  args: { min: 1, max: 1 },
  async run(c) {
    const r = await claimTask(c.op(), { id: c.positionals[0] ?? '', status: str(c.values, 'status'), expected_rev: int(c.values, 'expected-rev') });
    return { ...r, human: `${r.data.id} claimed by ${r.data.assignee ?? '-'} (rev ${r.data.rev})` };
  },
};
