// laneboard config
import { configureStore } from '../../core/index.ts';
import { str } from './args.ts';
import type { CommandDef } from './types.ts';

export const config: CommandDef = {
  name: 'config',
  usage: 'config [--name N] [--description "<whose project, what work>"]',
  summary: 'Show the board name, description and prefix; --name / --description change them (the prefix stays: ids keep it). Updates the machine registry.',
  options: { name: { type: 'string' }, description: { type: 'string' } },
  args: { min: 0, max: 0 },
  async run(c) {
    const r = await configureStore(c.op(), { name: str(c.values, 'name'), description: str(c.values, 'description') });
    const d = r.data;
    const head = d.changed ? 'updated config.json' : 'board';
    return { ...r, human: `${head}: ${d.name ?? '-'} (prefix ${d.prefix})\n  ${d.description ?? '(no description: laneboard config --description "<whose project, what work>")'}` };
  },
};
