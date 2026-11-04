// laneboard create
import { createTask, parseLinkArg } from '../../core/index.ts';
import { description, list, str } from './args.ts';
import { FULL_OPTION, taskReply } from './reply.ts';
import type { CommandDef } from './types.ts';

export const create: CommandDef = {
  name: 'create',
  usage: 'create <title> --status S [--description T | --description-file P|-] [--assignee A] [--label L]... [--link kind=ref]... [--field k=v]... [--full]',
  summary: 'Create a task; prints its id, rev, status and assignee (--full: the whole task).',
  options: {
    status: { type: 'string' },
    description: { type: 'string' },
    'description-file': { type: 'string' },
    assignee: { type: 'string' },
    label: { type: 'string', multiple: true },
    link: { type: 'string', multiple: true },
    field: { type: 'string', multiple: true },
    ...FULL_OPTION,
  },
  args: { min: 1, max: 1 },
  flags: { status: '--status' },
  async run(c) {
    const r = await createTask(c.op(), {
      title: c.positionals[0] ?? '',
      status: str(c.values, 'status') as string,
      description: description(c.values, c.io),
      assignee: str(c.values, 'assignee'),
      labels: list(c.values, 'label'),
      links: list(c.values, 'link')?.map(parseLinkArg),
      field_args: list(c.values, 'field'),
    });
    return taskReply(c, r, 'created');
  },
};
