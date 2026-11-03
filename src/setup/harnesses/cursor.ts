// Cursor: .cursor/mcp.json (stdio entry), AGENTS.md block. Sources: cursor.com/docs/context/mcp, cursor.com/docs/context/rules.
import { jsonEdit } from '../json-key.ts';
import { blockEdit, MD_MARKERS } from '../md-block.ts';
import { instructionLines, MCP_ARGS, MCP_COMMAND } from './common.ts';
import type { Harness } from './common.ts';

export const cursor: Harness = {
  name: 'cursor',
  files: [
    { path: '.cursor/mcp.json', scope: 'project', edit: (f) => jsonEdit(f, { kind: 'key', path: ['mcpServers', 'laneboard'], value: { type: 'stdio', command: MCP_COMMAND, args: [...MCP_ARGS] } }) },
    { path: 'AGENTS.md', scope: 'project', edit: (f, c) => blockEdit(f, MD_MARKERS, instructionLines(c.storeDir, 'inline')) },
  ],
  notes: ['open the project in Cursor and enable the "laneboard" MCP server in its settings if it is off'],
};
