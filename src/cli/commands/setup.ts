// laneboard setup
import { HARNESS_NAMES, runSetup } from '../../setup/index.ts';
import { setupText } from '../format.ts';
import { flag } from './args.ts';
import type { CommandDef } from './types.ts';

export const setup: CommandDef = {
  name: 'setup',
  usage: `setup <${HARNESS_NAMES.join('|')}> [--remove] [--dry-run]`,
  summary: 'Register the laneboard MCP server and instruction block for a harness (run in the project root); --remove rolls it back.',
  options: { remove: { type: 'boolean' }, 'dry-run': { type: 'boolean' } },
  args: { min: 1, max: 1 },
  async run(c) {
    const r = runSetup({ harness: c.positionals[0] ?? '', remove: flag(c.values, 'remove'), dryRun: flag(c.values, 'dry-run'), cwd: c.io.cwd, env: c.io.env });
    return { ...r, human: setupText(r.data) };
  },
};
