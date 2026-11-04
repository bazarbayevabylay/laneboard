// laneboard doctor
import { doctor as runDoctor } from '../../core/index.ts';
import { doctorText } from '../format.ts';
import { flag } from './args.ts';
import type { CommandDef } from './types.ts';

export const doctor: CommandDef = {
  name: 'doctor',
  usage: 'doctor [--fix] [--restore-backup]',
  summary: 'Check the store (exit 6 when a problem is left); --fix repairs, --restore-backup swaps in .bak for a damaged file.',
  options: { fix: { type: 'boolean' }, 'restore-backup': { type: 'boolean' } },
  args: { min: 0, max: 0 },
  async run(c) {
    const r = await runDoctor(c.op(), { fix: flag(c.values, 'fix') || undefined, restore_backup: flag(c.values, 'restore-backup') || undefined });
    // A problem left unfixed is not a success for a hook or a script: exit 6 like STORE_INVALID, the report stays a normal result.
    return { ...r, human: doctorText(r.data), exitCode: r.data.healthy ? 0 : 6 };
  },
};
