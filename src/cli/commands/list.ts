// laneboard list
import { LaneboardError, listTasks } from '../../core/index.ts';
import type { ListContext, Scope } from '../../core/index.ts';
import { listText } from '../format.ts';
import { flag, int, list as many, str } from './args.ts';
import type { CommandContext, CommandDef } from './types.ts';

// The op context of list. --all-boards also runs where no board is found (a folder outside every project, such as the orchestrator's
// root, where prime --all-boards points to it; review S5b MINOR 4): then only the registry's boards are read. A --dir, LANEBOARD_DIR or
// --board that names no store still fails.
function listContext(c: CommandContext, allBoards: boolean): ListContext {
  try {
    return c.op();
  } catch (err) {
    const named = c.discovery.dir !== undefined || (c.discovery.envDir ?? '') !== '' || c.values.board !== undefined;
    if (!allBoards || named || !(err instanceof LaneboardError) || err.code !== 'STORE_NOT_FOUND') throw err;
    return { home: c.discovery.home, lockWaitMs: c.io.lockWaitMs };
  }
}

export const list: CommandDef = {
  name: 'list',
  usage: 'list [--status S]... [--open] [--assignee A | --unassigned] [--label L]... [--text Q] [--parent ID] [--all-boards] [--scope active|archive|all] [--limit N] [--offset N]',
  summary: 'List tasks, newest update first (default: scope active, limit 20, or list_limit_max of the board when lower; each item also says handed_in, in_work, stale), each with its newest comment line. --open: not in the final status. --all-boards: every board of this machine (laneboard boards), merged.',
  options: {
    status: { type: 'string', multiple: true },
    assignee: { type: 'string' },
    unassigned: { type: 'boolean' },
    label: { type: 'string', multiple: true },
    text: { type: 'string' },
    parent: { type: 'string' },
    'all-boards': { type: 'boolean' },
    open: { type: 'boolean' },
    scope: { type: 'string' },
    limit: { type: 'string' },
    offset: { type: 'string' },
  },
  readOnly: true,
  args: { min: 0, max: 0 },
  async run(c) {
    const allBoards = flag(c.values, 'all-boards');
    const r = await listTasks(listContext(c, allBoards), {
      status: many(c.values, 'status'),
      assignee: str(c.values, 'assignee'),
      unassigned: flag(c.values, 'unassigned') || undefined,
      labels: many(c.values, 'label'),
      text: str(c.values, 'text'),
      parent: str(c.values, 'parent'),
      all_boards: allBoards || undefined,
      open: flag(c.values, 'open') || undefined,
      scope: str(c.values, 'scope') as Scope | undefined,
      limit: int(c.values, 'limit'),
      offset: int(c.values, 'offset'),
    });
    return { ...r, human: listText(r.data) };
  },
};
