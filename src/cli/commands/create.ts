// laneboard create
import { createTask, LaneboardError, loadConfig, parseLinkArg, resolveStore } from '../../core/index.ts';
import type { DiscoveryInput } from '../../core/index.ts';
import { description, list, str } from './args.ts';
import { FULL_OPTION, taskReply, withPlan } from './reply.ts';
import type { CommandDef } from './types.ts';

// The first status of the store create would write to (where new work starts); `<status>` while no store is readable.
function firstStatus(discovery: DiscoveryInput): string {
  try {
    return loadConfig(resolveStore(discovery).dir).statuses[0] ?? '<status>';
  } catch (err) {
    // No store or a broken one: the fix keeps the placeholder, and running it reports the store problem itself.
    if (err instanceof LaneboardError) return '<status>';
    throw err;
  }
}

export const create: CommandDef = {
  name: 'create',
  usage: 'create <title> --status S [--description T | --description-file P|-] [--assignee A] [--parent ID] [--label L]... [--link kind=ref]... [--field k=v]... [--full]',
  summary:
    'Create a task; prints its id, rev, status and assignee (--full: the whole task). The title is an argument. ' +
    'A label: lowercase letters, digits, dot, dash or underscore, starting with a letter or digit, at most 40 (ui-bug, zone-api).',
  options: {
    status: { type: 'string' },
    description: { type: 'string' },
    'description-file': { type: 'string' },
    assignee: { type: 'string' },
    parent: { type: 'string' },
    label: { type: 'string', multiple: true },
    link: { type: 'string', multiple: true },
    field: { type: 'string', multiple: true },
    ...FULL_OPTION,
  },
  args: { min: 1, max: 1 },
  // Op parameters named in fixes (a parent on another board becomes --link task=<id>).
  flags: { status: '--status', links: '--link' },
  required: (discovery) => [{ name: 'status', value: firstStatus(discovery) }],
  async run(c) {
    const r = await createTask(c.op(), {
      title: c.positionals[0] ?? '',
      status: str(c.values, 'status') as string,
      description: description(c.values, c.io),
      assignee: str(c.values, 'assignee'),
      parent: str(c.values, 'parent'),
      labels: list(c.values, 'label'),
      links: list(c.values, 'link')?.map(parseLinkArg),
      field_args: list(c.values, 'field'),
    });
    // Your own task: `next`, the comment of your plan, as after a claim.
    return withPlan(c, taskReply(c, r, 'created'), r.reply?.next);
  },
};
