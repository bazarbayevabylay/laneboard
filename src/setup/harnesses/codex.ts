// Codex: [mcp_servers.laneboard] in the global $CODEX_HOME/config.toml, default ~/.codex/config.toml (a project file works only
// for trusted projects), AGENTS.md block. The global entry cannot pin one project's store, so it forwards LANEBOARD_DIR (`env_vars`).
// Sources: learn.chatgpt.com/docs/extend/mcp, learn.chatgpt.com/docs/agent-configuration/agents-md.
import path from 'node:path';
import { blockEdit, MD_MARKERS } from '../md-block.ts';
import { tomlTableEdit } from '../toml-block.ts';
import { CODEX_ENV_VARS, instructionLines, MCP_ARGS, MCP_COMMAND } from './common.ts';
import type { Harness, HarnessContext } from './common.ts';
import { gitExclude, gitRoot } from './git-exclude.ts';

// Setup below the root of a git repository (a package of a monorepo, LB-59.3): Codex reads AGENTS.md from the repository root down to
// the folder it starts in, so a Codex started at the root never sees this folder's block. The file stays where setup ran (owner's
// decision 06.11): the warning names the root and both ways out.
function belowRootWarning(c: HarnessContext): string[] {
  const root = gitRoot(c.cwd);
  if (root === undefined || root === c.cwd) return [];
  return [
    `the AGENTS.md block of setup codex goes to ${c.cwd}, below the root of its git repository ${root}: Codex reads AGENTS.md from the repository root down to the folder it starts in, so a Codex started at the root never sees this block; start Codex in ${c.cwd}, or run laneboard setup codex --json in ${root} for the whole repository`,
  ];
}

export const codex: Harness = {
  name: 'codex',
  files: [
    {
      path: '.codex/config.toml',
      scope: 'global',
      edit: (f) => tomlTableEdit(f, 'mcp_servers.laneboard', MCP_COMMAND, MCP_ARGS, [['env_vars', CODEX_ENV_VARS]]),
      moved: (c) => (c.env.CODEX_HOME ? path.join(path.resolve(c.cwd, c.env.CODEX_HOME), 'config.toml') : undefined),
    },
    { path: 'AGENTS.md', scope: 'project', edit: (f, c) => blockEdit(f, MD_MARKERS, instructionLines(c.storeDir, 'inline')) },
    // Backups and folder markers stay out of git.
    gitExclude,
  ],
  warnings: belowRootWarning,
  notes: [
    'the Codex config.toml is a global file: the laneboard MCP server is on in every Codex project; start Codex in this project folder (or LANEBOARD_DIR=<board> codex for one run), never export LANEBOARD_DIR',
  ],
};
