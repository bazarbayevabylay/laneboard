// laneboard init
import { initStore, initTarget } from '../../core/index.ts';
import type { ConfigT } from '../../core/index.ts';
import { HARNESS_NAMES } from '../../setup/index.ts';
import { shellQuote } from '../format.ts';
import { commaList, flag, str } from './args.ts';
import type { CommandDef } from './types.ts';

// What follows init: prime prints the agent rules, the board and the command that creates the agent's task. A board made by --dir
// keeps --dir: without it the next command would find another store (LANEBOARD_DIR of a parent folder, a walk-up).
function nextStep(target: string, byDir: boolean): string {
  return byDir ? `laneboard prime --dir ${shellQuote(target)}` : 'laneboard prime';
}

// The command that connects the agent's harness to the new board (hooks, MCP, the instruction block), before prime (A-U5): an agent
// that runs `next` alone would work on a board its harness does not know.
function setupCommand(target: string, byDir: boolean): string {
  return `laneboard setup <${HARNESS_NAMES.join('|')}>${byDir ? ` --dir ${shellQuote(target)}` : ''}`;
}

// The checks line of a new board (P1, A-U5): init turns none on (config@2 only by the owner's choice, TG 8723), so it names the
// command that does, with a middle status of the board (review when there is one); nothing for a board of two statuses.
function checksHint(config: ConfigT, target: string, byDir: boolean): string {
  const middle = config.statuses.slice(1, -1);
  if (middle.length === 0) return '';
  const status = middle.includes('review') ? 'review' : '<status>';
  return `checks: none, an assignee's finish closes its task; to hand in for a check first: laneboard config --review-statuses ${status} [--reviewers <names>]${byDir ? ` --dir ${shellQuote(target)}` : ''}\n`;
}

// The fields line of a new board (LB-58.1): init declares priority by default, so the owner sees it and how to change the fields.
function fieldsHint(config: ConfigT, target: string, byDir: boolean): string {
  const fields = Object.entries(config.fields).map(([key, f]) => `${key} (${[f.type, f.description].filter(Boolean).join(', ')})`);
  if (fields.length === 0) return '';
  const dir = byDir ? ` --dir ${shellQuote(target)}` : '';
  return `fields: ${fields.join(', ')}; another: laneboard config --field <key>:<type>${dir}, drop one: laneboard config --drop-field <key>${dir}\n`;
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
    // A target from LANEBOARD_DIR may be another project's pin: STORE_EXISTS then offers this folder's own board.
    const envCwd = c.discovery.dir === undefined && c.discovery.envDir ? c.io.cwd : undefined;
    const byDir = c.discovery.dir !== undefined;
    const next = nextStep(target, byDir);
    const setup = setupCommand(target, byDir);
    const r = await initStore(
      target,
      {
        name: str(c.values, 'name'),
        description: str(c.values, 'description'),
        prefix: str(c.values, 'prefix'),
        statuses: commaList(c.values, 'statuses'),
        gitignore: !flag(c.values, 'no-gitignore'),
      },
      { lockWaitMs: c.io.lockWaitMs, home: c.io.env.HOME || undefined, envCwd },
    );
    const cfg = r.data.config;
    // An agent that just created the board has not seen the rules yet: name the setup and the next command (also in --json, LB-58.2).
    return {
      data: { ...r.data, setup, next },
      warnings: r.warnings,
      human:
        `initialized ${r.data.store} (${cfg.name ?? '-'}, prefix ${cfg.prefix}; statuses: ${cfg.statuses.join(', ')})\n  ${cfg.description ?? ''}\n` +
        `ids: ${cfg.prefix}-1, ${cfg.prefix}-2, ...; another prefix while the board has no task: ${prefixCommand(target, byDir)}\n` +
        fieldsHint(cfg, target, byDir) +
        checksHint(cfg, target, byDir) +
        `setup: ${setup} connects your agent (hooks, MCP), once per project\n` +
        `next: ${next} (agent rules, this board and the command that creates your task)`,
    };
  },
};
