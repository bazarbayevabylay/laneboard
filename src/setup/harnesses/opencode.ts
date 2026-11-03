// OpenCode: opencode.json mcp.laneboard (type local, command array, enabled), AGENTS.md block.
// Sources: opencode.ai/docs/mcp-servers (enabled is optional with no stated default, so it is written explicitly), opencode.ai/docs/rules.
import { jsonEdit } from '../json-key.ts';
import { blockEdit, MD_MARKERS } from '../md-block.ts';
import { instructionLines, MCP_ARGS, MCP_COMMAND } from './common.ts';
import type { Harness } from './common.ts';

export const opencode: Harness = {
  name: 'opencode',
  files: [
    { path: 'opencode.json', scope: 'project', edit: (f) => jsonEdit(f, { kind: 'key', path: ['mcp', 'laneboard'], value: { type: 'local', command: [MCP_COMMAND, ...MCP_ARGS], enabled: true } }) },
    { path: 'AGENTS.md', scope: 'project', edit: (f, c) => blockEdit(f, MD_MARKERS, instructionLines(c.storeDir, 'inline')) },
  ],
  notes: ['start opencode in this directory; the laneboard MCP server starts with it'],
};
