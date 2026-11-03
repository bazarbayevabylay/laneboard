// laneboard mcp
import { serveMcp } from '../../mcp/server.ts';
import { str } from './args.ts';
import type { CommandDef } from './types.ts';

export const mcp: CommandDef = {
  name: 'mcp',
  usage: 'mcp [--dir <path>]',
  summary: 'Run the MCP server on stdio (harnesses start it; tools take `actor`). The store is found per call, as in the CLI.',
  options: {},
  args: { min: 0, max: 0 },
  async run(c) {
    await serveMcp({ cwd: c.io.cwd, env: c.io.env, dir: str(c.values, 'dir') });
    // stdout belongs to the protocol: print nothing after the server stops.
    return { data: null, warnings: [], human: '', silent: true };
  },
};
