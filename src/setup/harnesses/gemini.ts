// Gemini CLI: .gemini/settings.json mcpServers, GEMINI.md block. Sources: geminicli.com/docs/tools/mcp-server, geminicli.com/docs/cli/gemini-md.
import { jsonEdit } from '../json-key.ts';
import { blockEdit, MD_MARKERS } from '../md-block.ts';
import { instructionLines, MCP_COMMAND, pinnedMcpArgs } from './common.ts';
import type { Harness } from './common.ts';

export const gemini: Harness = {
  name: 'gemini',
  files: [
    { path: '.gemini/settings.json', scope: 'project', edit: (f, c) => jsonEdit(f, { kind: 'key', path: ['mcpServers', 'laneboard'], value: { command: MCP_COMMAND, args: pinnedMcpArgs(c.storeDir) } }) },
    { path: 'GEMINI.md', scope: 'project', edit: (f, c) => blockEdit(f, MD_MARKERS, instructionLines(c.storeDir, 'inline')) },
  ],
  notes: ['start gemini in this directory; /mcp lists the laneboard server'],
};
