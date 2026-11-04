// laneboard config
import { configureStore } from '../../core/index.ts';
import { commaList, str } from './args.ts';
import type { CommandDef } from './types.ts';

export const config: CommandDef = {
  name: 'config',
  usage: 'config [--name N] [--description "<whose project, what work>"] [--prefix P] [--statuses a,b,c]',
  summary:
    'Show the board name, description, prefix and statuses; --name / --description change them, --prefix only while the board has no task (ids keep their prefix). ' +
    '--statuses sets the whole status list in order, the last one final: add and reorder freely; a status that active tasks are in is removed only after they move. ' +
    'Updates the machine registry.',
  options: { name: { type: 'string' }, description: { type: 'string' }, prefix: { type: 'string' }, statuses: { type: 'string' } },
  args: { min: 0, max: 0 },
  async run(c) {
    const r = await configureStore(c.op(), {
      name: str(c.values, 'name'),
      description: str(c.values, 'description'),
      prefix: str(c.values, 'prefix'),
      statuses: commaList(c.values, 'statuses'),
    });
    const d = r.data;
    const head = d.changed ? 'updated config.json' : 'board';
    return {
      ...r,
      human:
        `${head}: ${d.name ?? '-'} (prefix ${d.prefix})\n  ${d.description ?? '(no description: laneboard config --description "<whose project, what work>")'}\n` +
        `  statuses: ${d.statuses.join(', ')} (final: ${d.statuses.at(-1) ?? '-'})`,
    };
  },
};
