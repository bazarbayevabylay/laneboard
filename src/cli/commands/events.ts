// laneboard events
import { listEvents } from '../../core/index.ts';
import type { Scope } from '../../core/index.ts';
import { eventsText } from '../format.ts';
import { int, str } from './args.ts';
import type { CommandDef } from './types.ts';

export const events: CommandDef = {
  name: 'events',
  usage: 'events [--task id] [--since ts] [--limit N] [--scope active|archive|all]',
  summary: 'Event feed, newest first.',
  options: { task: { type: 'string' }, since: { type: 'string' }, limit: { type: 'string' }, scope: { type: 'string' } },
  readOnly: true,
  args: { min: 0, max: 0 },
  async run(c) {
    const r = await listEvents(c.op(), {
      task: str(c.values, 'task'),
      since: str(c.values, 'since'),
      limit: int(c.values, 'limit'),
      scope: str(c.values, 'scope') as Scope | undefined,
    });
    return { ...r, human: eventsText(r.data) };
  },
};
