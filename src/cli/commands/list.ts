// laneboard list
import { listTasks } from '../../core/index.ts';
import type { Scope } from '../../core/index.ts';
import { listText } from '../format.ts';
import { flag, int, list as many, str } from './args.ts';
import type { CommandDef } from './types.ts';

export const list: CommandDef = {
  name: 'list',
  usage: 'list [--status S]... [--assignee A | --unassigned] [--label L]... [--text Q] [--parent ID] [--scope active|archive|all] [--limit N] [--offset N]',
  summary: 'List tasks, newest update first (default: scope active, limit 20).',
  options: {
    status: { type: 'string', multiple: true },
    assignee: { type: 'string' },
    unassigned: { type: 'boolean' },
    label: { type: 'string', multiple: true },
    text: { type: 'string' },
    parent: { type: 'string' },
    scope: { type: 'string' },
    limit: { type: 'string' },
    offset: { type: 'string' },
  },
  readOnly: true,
  args: { min: 0, max: 0 },
  async run(c) {
    const r = await listTasks(c.op(), {
      status: many(c.values, 'status'),
      assignee: str(c.values, 'assignee'),
      unassigned: flag(c.values, 'unassigned') || undefined,
      labels: many(c.values, 'label'),
      text: str(c.values, 'text'),
      parent: str(c.values, 'parent'),
      scope: str(c.values, 'scope') as Scope | undefined,
      limit: int(c.values, 'limit'),
      offset: int(c.values, 'offset'),
    });
    return { ...r, human: listText(r.data) };
  },
};
