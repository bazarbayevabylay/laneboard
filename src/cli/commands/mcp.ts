// laneboard mcp
import { ACTOR_RE, LaneboardError } from '../../core/index.ts';
import { serveMcp } from '../../mcp/server.ts';
import { str } from './args.ts';
import type { CommandDef } from './types.ts';

export const mcp: CommandDef = {
  name: 'mcp',
  usage: 'mcp [--dir <path>] [--as <name>]',
  summary:
    'Run the MCP server on stdio (harnesses start it; tools take `actor`). The store is found per call, as in the CLI. ' +
    '--as: the actor of a call without `actor` (before LANEBOARD_AGENT), for a client config that names its agent.',
  options: {},
  args: { min: 0, max: 0 },
  async run(c) {
    const agent = str(c.values, 'as');
    // A bad name fails at start, on stderr, not on every write of the session (UX C-U6).
    if (agent !== undefined && agent !== '' && !ACTOR_RE.test(agent)) {
      throw new LaneboardError('INVALID_VALUE', `--as "${agent}" must match ^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$`, {
        input: { field: 'as', value: agent, format: '<name like dev-1>' },
        fix: 'use letters, digits and . _ : @ - without spaces for --as, e.g. laneboard mcp --as dev-1',
      });
    }
    await serveMcp({ cwd: c.io.cwd, env: c.io.env, dir: str(c.values, 'dir'), agent: agent || undefined });
    // stdout belongs to the protocol: print nothing after the server stops.
    return { data: null, warnings: [], human: '', silent: true };
  },
};
