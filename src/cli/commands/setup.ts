// laneboard setup
import path from 'node:path';
import { LaneboardError, registerStore, samePath, setupTarget, STORE_DIR_NAME, toLaneboardError } from '../../core/index.ts';
import { HARNESS_NAMES, runSetup } from '../../setup/index.ts';
import { setupText } from '../format.ts';
import { flag } from './args.ts';
import type { CommandDef } from './types.ts';

// Add the board at `storeDir` to the machine registry for `harness`; its warnings, or one with the fix when that fails.
async function register(home: string, storeDir: string, harness: string, lockWaitMs: number | undefined): Promise<string[]> {
  try {
    return (await registerStore(home, storeDir, { lockWaitMs, harness })).warnings;
  } catch (raw) {
    // The harness files are written already (or setup refused for another reason): a broken store or registry must not turn
    // that into this failure: say what to fix.
    const err = toLaneboardError(raw);
    return [`the board was not added to the machine registry (laneboard boards): ${err.message}; fix: ${err.fix}`];
  }
}

export const setup: CommandDef = {
  name: 'setup',
  usage: `setup <${HARNESS_NAMES.join('|')}> [--remove [--global]] [--dry-run]`,
  summary:
    'Register the laneboard MCP server and instruction block for a harness (run in the project root); --remove rolls it back. ' +
    'The project is pinned to its store: --dir, else LANEBOARD_DIR, else the board of this git repository found above (a package of a monorepo, a linked worktree), else ./.laneboard (Claude Code: env LANEBOARD_DIR and the default agent name in .claude/settings.local.json, ' +
    'kept out of git by .git/info/exclude; or .claude/settings.json in a folder inside another git repository and at a repository root that holds other boards; others: in the instructions). ' +
    'An existing board is added to the machine registry. ' +
    '--remove keeps the entry of a global file (codex: ~/.codex/config.toml) while other projects of the machine registry may use it; --global removes it anyway.',
  options: { remove: { type: 'boolean' }, global: { type: 'boolean' }, 'dry-run': { type: 'boolean' } },
  args: { min: 1, max: 1 },
  async run(c) {
    // The pin walks up only inside one git repository (a package of a monorepo, a linked worktree): elsewhere a store in a parent
    // directory may be another project's unless --dir names it.
    const target = setupTarget(c.discovery);
    const storeDir = target.dir;
    c.setStore(storeDir);
    const harness = c.positionals[0] ?? '';
    const remove = flag(c.values, 'remove');
    const dryRun = flag(c.values, 'dry-run');
    const home = c.io.env.HOME;
    let r: ReturnType<typeof runSetup>;
    try {
      r = runSetup({ harness, remove, global: flag(c.values, 'global'), dryRun, cwd: c.io.cwd, env: c.io.env, storeDir, storeAbove: target.found === 'parent' || target.found === 'worktree' });
    } catch (raw) {
      // SETUP_CONFLICT for a repository root's pin: its fix runs setup at the root, which finds this folder's board only in the
      // registry. Register the board first (a board made before the registry or under another HOME is missing there), then refuse.
      if (raw instanceof LaneboardError && raw.code === 'SETUP_CONFLICT' && home && !remove && !dryRun) await register(home, storeDir, harness, c.io.lockWaitMs);
      throw raw;
    }
    // The pinned board joins the machine registry (laneboard boards), so other agents can tell it apart by its description.
    if (r.registered && home) r.warnings.push(...(await register(home, storeDir, harness, c.io.lockWaitMs)));
    const fromEnv = c.discovery.dir === undefined && c.discovery.envDir ? c.discovery.envDir : undefined;
    // LANEBOARD_DIR may be left over from another project's session: say where the pin came from.
    if (fromEnv !== undefined && !remove && !samePath(storeDir, path.join(path.resolve(c.io.cwd), STORE_DIR_NAME))) {
      r.warnings.push(`the store pin comes from LANEBOARD_DIR=${fromEnv} in your environment, not ./.laneboard; to pin another store run setup again with --dir <path>`);
    }
    return { data: r.data, warnings: r.warnings, human: setupText(r.data) };
  },
};
