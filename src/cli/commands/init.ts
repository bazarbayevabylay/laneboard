// laneboard init
import { initStore, initTarget } from '../../core/index.ts';
import { flag, str } from './args.ts';
import type { CommandDef } from './types.ts';

export const init: CommandDef = {
  name: 'init',
  usage: 'init [--prefix P] [--statuses a,b,c] [--no-gitignore]',
  summary: 'Create .laneboard/ here (or at --dir / LANEBOARD_DIR) with an explicit config.',
  options: { prefix: { type: 'string' }, statuses: { type: 'string' }, 'no-gitignore': { type: 'boolean' } },
  args: { min: 0, max: 0 },
  async run(c) {
    const target = initTarget(c.discovery);
    c.setStore(target);
    const statuses = str(c.values, 'statuses');
    const r = await initStore(
      target,
      {
        prefix: str(c.values, 'prefix'),
        statuses: statuses === undefined ? undefined : statuses.split(',').map((s) => s.trim()),
        gitignore: !flag(c.values, 'no-gitignore'),
      },
      { lockWaitMs: c.io.lockWaitMs },
    );
    return { ...r, human: `initialized ${r.data.store} (prefix ${r.data.config.prefix}; statuses: ${r.data.config.statuses.join(', ')})` };
  },
};
