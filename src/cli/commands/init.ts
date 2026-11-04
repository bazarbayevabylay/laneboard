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

// The command that changes the prefix of the new (still empty) board, with --dir when the board was made by --dir.
function prefixCommand(target: string, byDir: boolean): string {
  return `laneboard config --prefix <PREFIX>${byDir ? ` --dir ${shellQuote(target)}` : ''}`;
}

export const init: CommandDef = {
  name: 'init',
  usage: 'init --description "<whose project, what work>" [--name N] [--prefix P] [--statuses a,b,c] [--no-gitignore]',
  summary:
    'Create the board .laneboard/ here (or at --dir / LANEBOARD_DIR) with an explicit config and add it to the machine registry (laneboard boards). ' +
    'The name defaults to the folder name; the id prefix (at most 4 characters: initials of the name\'s words, or the first letters of one word) is derived ' +
    'from the name unless --prefix gives it, and must be free on this machine. laneboard config --prefix changes it while the board has no task.',
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
      human:
        `initialized ${r.data.store} (${cfg.name ?? '-'}, prefix ${cfg.prefix}; statuses: ${cfg.statuses.join(', ')})\n  ${cfg.description ?? ''}\n` +
        `ids: ${cfg.prefix}-1, ${cfg.prefix}-2, ...; another prefix while the board has no task: ${prefixCommand(target, c.discovery.dir !== undefined)}\n` +
        `next: ${next} (agent rules, this board and the command that creates your task)`,
    };
  },
};
