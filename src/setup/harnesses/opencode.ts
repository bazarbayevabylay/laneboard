// OpenCode: opencode.json mcp.laneboard (type local, command array, enabled), AGENTS.md block.
// Sources: opencode.ai/docs/mcp-servers (enabled is optional with no stated default, so it is written explicitly), opencode.ai/docs/rules.
import { jsonEdit } from '../json-key.ts';
import { blockEdit, MD_MARKERS } from '../md-block.ts';
import { instructionLines, MCP_COMMAND, pinnedMcpArgs } from './common.ts';
import type { Harness } from './common.ts';
import { gitExclude } from './git-exclude.ts';

export const opencode: Harness = {
  name: 'opencode',
  files: [
    { path: 'opencode.json', scope: 'project', edit: (f, c) => jsonEdit(f, { kind: 'key', path: ['mcp', 'laneboard'], value: { type: 'local', command: [MCP_COMMAND, ...pinnedMcpArgs(c.storeDir)], enabled: true } }) },
    { path: 'AGENTS.md', scope: 'project', edit: (f, c) => blockEdit(f, MD_MARKERS, instructionLines(c.storeDir, 'inline')) },
    // Backups and folder markers stay out of git.
    gitExclude,
  ],
  notes: ['start opencode in this directory; the laneboard MCP server starts with it'],
};
