// laneboard init
import { initStore, initTarget } from '../../core/index.ts';
import { shellQuote } from '../format.ts';
import { flag, str } from './args.ts';
import type { CommandDef } from './types.ts';

// What follows init: prime prints the agent rules, the board and the command that creates the agent's task. A board made by --dir
// keeps --dir: without it the next command would find another store (LANEBOARD_DIR of a parent folder, a walk-up).
function nextStep(target: string, byDir: boolean): string {
  return byDir ? `laneboard prime --dir ${shellQuote(target)}` : 'laneboard prime';
}

export const init: CommandDef = {
  name: 'init',
  usage: 'init --description "<whose project, what work>" [--name N] [--prefix P] [--statuses a,b,c] [--no-gitignore]',
  summary:
    'Create the board .laneboard/ here (or at --dir / LANEBOARD_DIR) with an explicit config and add it to the machine registry (laneboard boards). ' +
    'The name defaults to the folder name; the id prefix is derived from the name and must be free on this machine.',
  options: {
    name: { type: 'string' },
    description: { type: 'string' },
    prefix: { type: 'string' },
    statuses: { type: 'string' },
    'no-gitignore': { type: 'boolean' },
  },
  args: { min: 0, max: 0 },
  async run(c) {
    const target = initTarget(c.discovery);
    c.setStore(target);
    const statuses = str(c.values, 'statuses');
    // A target from LANEBOARD_DIR may be another project's pin: STORE_EXISTS then offers this folder's own board.
    const envCwd = c.discovery.dir === undefined && c.discovery.envDir ? c.io.cwd : undefined;
    const next = nextStep(target, c.discovery.dir !== undefined);
    const r = await initStore(
      target,
      {
        name: str(c.values, 'name'),
        description: str(c.values, 'description'),
        prefix: str(c.values, 'prefix'),
        statuses: statuses === undefined ? undefined : statuses.split(',').map((s) => s.trim()),
        gitignore: !flag(c.values, 'no-gitignore'),
      },
      { lockWaitMs: c.io.lockWaitMs, home: c.io.env.HOME || undefined, envCwd },
    );
    const cfg = r.data.config;
    // An agent that just created the board has not seen the rules yet: name the next command (also in --json).
    return {
      data: { ...r.data, next },
      warnings: r.warnings,
      human: `initialized ${r.data.store} (${cfg.name ?? '-'}, prefix ${cfg.prefix}; statuses: ${cfg.statuses.join(', ')})\n  ${cfg.description ?? ''}\nnext: ${next} (agent rules, this board and the command that creates your task)`,
    };
  },
};
