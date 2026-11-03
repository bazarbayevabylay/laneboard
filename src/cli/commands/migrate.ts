// laneboard migrate
import { migrateStore } from '../../core/index.ts';
import type { CommandDef } from './types.ts';

export const migrate: CommandDef = {
  name: 'migrate',
  usage: 'migrate',
  summary: 'Upgrade store files written by an older laneboard.',
  options: {},
  args: { min: 0, max: 0 },
  async run(c) {
    const r = await migrateStore(c.op());
    const human = r.data.migrated.length ? `migrated ${r.data.migrated.join(', ')} to ${r.data.schema}` : `store is up to date (${r.data.schema})`;
    return { ...r, human };
  },
};
