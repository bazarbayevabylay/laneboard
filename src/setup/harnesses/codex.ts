// Codex: [mcp_servers.laneboard] in the global ~/.codex/config.toml (a project file works only for trusted projects), AGENTS.md block.
// Sources: learn.chatgpt.com/docs/extend/mcp, learn.chatgpt.com/docs/agent-configuration/agents-md.
import { blockEdit, MD_MARKERS } from '../md-block.ts';
import { tomlTableEdit } from '../toml-block.ts';
import { INSTRUCTION_LINES, MCP_ARGS, MCP_COMMAND } from './common.ts';
import type { Harness } from './common.ts';

export const codex: Harness = {
  name: 'codex',
  files: [
    { path: '.codex/config.toml', scope: 'global', edit: (f) => tomlTableEdit(f, 'mcp_servers.laneboard', MCP_COMMAND, MCP_ARGS) },
    { path: 'AGENTS.md', scope: 'project', edit: (f) => blockEdit(f, MD_MARKERS, INSTRUCTION_LINES) },
  ],
  notes: ['~/.codex/config.toml is a global file: the laneboard MCP server is on in every Codex project'],
};
