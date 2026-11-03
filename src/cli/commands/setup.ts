// laneboard setup
import path from 'node:path';
import { initTarget, STORE_DIR_NAME } from '../../core/index.ts';
import { HARNESS_NAMES, runSetup } from '../../setup/index.ts';
import { setupText } from '../format.ts';
import { flag } from './args.ts';
import type { CommandDef } from './types.ts';

export const setup: CommandDef = {
  name: 'setup',
  usage: `setup <${HARNESS_NAMES.join('|')}> [--remove] [--dry-run]`,
  summary:
    'Register the laneboard MCP server and instruction block for a harness (run in the project root); --remove rolls it back. ' +
    'The project is pinned to its store: --dir, else LANEBOARD_DIR, else ./.laneboard (Claude Code: env LANEBOARD_DIR in .claude/settings.json; others: in the instructions).',
  options: { remove: { type: 'boolean' }, 'dry-run': { type: 'boolean' } },
  args: { min: 1, max: 1 },
  async run(c) {
    // Like init, the pin never walks up: a store in a parent directory belongs to another project unless --dir names it.
    const storeDir = initTarget(c.discovery);
    c.setStore(storeDir);
    const r = runSetup({ harness: c.positionals[0] ?? '', remove: flag(c.values, 'remove'), dryRun: flag(c.values, 'dry-run'), cwd: c.io.cwd, env: c.io.env, storeDir });
    const fromEnv = c.discovery.dir === undefined && c.discovery.envDir ? c.discovery.envDir : undefined;
    // LANEBOARD_DIR may be left over from another project's session: say where the pin came from.
    if (fromEnv !== undefined && !flag(c.values, 'remove') && storeDir !== path.join(path.resolve(c.io.cwd), STORE_DIR_NAME)) {
      r.warnings.push(`the store pin comes from LANEBOARD_DIR=${fromEnv} in your environment, not ./.laneboard; to pin another store run setup again with --dir <path>`);
    }
    return { ...r, human: setupText(r.data) };
  },
};
