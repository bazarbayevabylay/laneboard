// Codex: [mcp_servers.laneboard] in the global $CODEX_HOME/config.toml, default ~/.codex/config.toml (a project file works only
// for trusted projects), AGENTS.md block. Sources: learn.chatgpt.com/docs/extend/mcp, learn.chatgpt.com/docs/agent-configuration/agents-md.
import path from 'node:path';
import { blockEdit, MD_MARKERS } from '../md-block.ts';
import { tomlTableEdit } from '../toml-block.ts';
import { instructionLines, MCP_ARGS, MCP_COMMAND } from './common.ts';
import type { Harness } from './common.ts';

export const codex: Harness = {
  name: 'codex',
  files: [
    {
      path: '.codex/config.toml',
      scope: 'global',
      edit: (f) => tomlTableEdit(f, 'mcp_servers.laneboard', MCP_COMMAND, MCP_ARGS),
      moved: (c) => (c.env.CODEX_HOME ? path.join(path.resolve(c.cwd, c.env.CODEX_HOME), 'config.toml') : undefined),
    },
    { path: 'AGENTS.md', scope: 'project', edit: (f, c) => blockEdit(f, MD_MARKERS, instructionLines(c.storeDir, 'inline')) },
  ],
  notes: ['the Codex config.toml is a global file: the laneboard MCP server is on in every Codex project'],
};
