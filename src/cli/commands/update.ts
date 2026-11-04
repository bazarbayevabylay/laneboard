// laneboard update
import { parseLinkArg, updateTask } from '../../core/index.ts';
import { appendedDescription, description, exclusive, flag, int, list, str } from './args.ts';
import { FULL_OPTION, taskReply } from './reply.ts';
import type { CommandDef } from './types.ts';

export const update: CommandDef = {
  name: 'update',
  usage:
    'update <id> [--title T] [--description T | --description-file P|- | --append-description T | --append-description-file P|-] [--status S] [--assignee A | --unassign] [--parent ID | --no-parent] [--add-label L]... [--remove-label L]... [--add-link kind=ref]... [--remove-link kind=ref]... [--field k=v]... [--unset-field k]... [--expected-rev N] [--full]',
  summary:
    'Change a task (at least one change). --description replaces the whole text; --append-description adds to it (after a blank line, no --expected-rev needed). --parent makes it a subtask of a task on this board, --no-parent a top-level task. --expected-rev is optional: only for edits on top of what you read (description, fields). Closing a task: laneboard finish.',
  options: {
    title: { type: 'string' },
    description: { type: 'string' },
    'description-file': { type: 'string' },
    'append-description': { type: 'string' },
    'append-description-file': { type: 'string' },
    status: { type: 'string' },
    assignee: { type: 'string' },
    unassign: { type: 'boolean' },
    parent: { type: 'string' },
    'no-parent': { type: 'boolean' },
    'add-label': { type: 'string', multiple: true },
    'remove-label': { type: 'string', multiple: true },
    'add-link': { type: 'string', multiple: true },
    'remove-link': { type: 'string', multiple: true },
    field: { type: 'string', multiple: true },
    'unset-field': { type: 'string', multiple: true },
    'expected-rev': { type: 'string' },
    ...FULL_OPTION,
  },
  args: { min: 1, max: 1 },
  // Op parameters named in fixes (a label both added and removed drops its --remove-label).
  flags: { add_labels: '--add-label', remove_labels: '--remove-label', add_links: '--add-link', remove_links: '--remove-link', unset_fields: '--unset-field', expected_rev: '--expected-rev' },
  async run(c) {
    exclusive(c.values, 'assignee', 'unassign');
    exclusive(c.values, 'parent', 'no-parent');
    const r = await updateTask(c.op(), {
      id: c.positionals[0] ?? '',
      title: str(c.values, 'title'),
      description: description(c.values, c.io),
      append_description: appendedDescription(c.values, c.io),
      status: str(c.values, 'status'),
      assignee: flag(c.values, 'unassign') ? null : str(c.values, 'assignee'),
      parent: flag(c.values, 'no-parent') ? null : str(c.values, 'parent'),
      add_labels: list(c.values, 'add-label'),
      remove_labels: list(c.values, 'remove-label'),
      add_links: list(c.values, 'add-link')?.map(parseLinkArg),
      remove_links: list(c.values, 'remove-link')?.map(parseLinkArg),
      field_args: list(c.values, 'field'),
      unset_fields: list(c.values, 'unset-field'),
      expected_rev: int(c.values, 'expected-rev'),
    });
    const verb = r.warnings.some((w) => w.startsWith('no changes')) ? 'unchanged' : 'updated';
    return taskReply(c, r, verb);
  },
};
