// laneboard config
import { configureStore } from '../../core/index.ts';
import type { ConfigureResult } from '../../core/index.ts';
import { commaList, list, str } from './args.ts';
import type { CommandDef, Values } from './types.ts';

// A comma list option where `none` turns the setting off (null), else the list; undefined when the option is not given.
function listOrNone(values: Values, name: string): string[] | null | undefined {
  const items = commaList(values, name);
  return items !== undefined && items.length === 1 && items[0] === 'none' ? null : items;
}

// The checks and creators lines of a board that has them (config@2); nothing for a board without them.
function v2Lines(d: ConfigureResult): string {
  const final = d.statuses.at(-1) ?? '-';
  const checks = d.review === undefined ? '' : `\n  checks: ${[...d.review.statuses, final].join(' -> ')}; checkers: ${d.review.by.length ? d.review.by.join(', ') : "anybody but the task's assignee"}`;
  const creators = d.create_by === undefined ? '' : `\n  creators: ${d.create_by.join(', ')}`;
  return checks + creators;
}

// One line of declared fields: `priority (number, 0 = highest), team (string)`, or a hint how to declare one.
function fieldsText(fields: ConfigureResult['fields']): string {
  const shown = Object.entries(fields).map(([key, def]) => `${key} (${[def.type, def.description].filter(Boolean).join(', ')})`);
  return shown.length ? shown.join(', ') : 'none (laneboard config --field <key>:<type>[:<description>])';
}

export const config: CommandDef = {
  name: 'config',
  usage:
    'config [--name N] [--description "<whose project, what work>"] [--prefix P] [--statuses a,b,c] [--field key:type[:description]]... [--drop-field key]... [--review-statuses a,b|none] [--reviewers x,y|none] [--creators x,y|none]',
  summary:
    'Show the board name, description, prefix, statuses and fields; --name / --description change them, --prefix only while the board has no task (ids keep their prefix). ' +
    '--statuses sets the whole status list in order (at least 2), the last one final: add and reorder freely; a status that active tasks are in is removed only after they move. ' +
    '--field declares a task field or changes it (type string, number, boolean, string[] or json; without a description the current one stays), ' +
    '--drop-field removes one: a field whose active values do not fit is changed only after they are unset. ' +
    '--name, --description and --prefix update the machine registry. ' +
    "--review-statuses sets the checks in order (statuses between the first and the final one): an assignee's finish hands in to the first, " +
    "a checker's finish passes the task on to the next and from the last one accepts it into the final status; the assignee never closes its own task. " +
    '--reviewers names who checks (default: anybody but the assignee), --creators who creates tasks; none turns each off. ' +
    'Checks, reviewers or creators write config.json as laneboard/config@2, which laneboard 0.3.1 cannot read; all of them off: config@1 again.',
  options: {
    name: { type: 'string' },
    description: { type: 'string' },
    prefix: { type: 'string' },
    statuses: { type: 'string' },
    field: { type: 'string', multiple: true },
    'drop-field': { type: 'string', multiple: true },
    'review-statuses': { type: 'string' },
    reviewers: { type: 'string' },
    creators: { type: 'string' },
  },
  args: { min: 0, max: 0 },
  // Op parameters named in fixes (a field both declared and dropped drops its --drop-field).
  flags: { fields: '--field', drop_fields: '--drop-field', review_statuses: '--review-statuses' },
  async run(c) {
    const r = await configureStore(c.op(), {
      name: str(c.values, 'name'),
      description: str(c.values, 'description'),
      prefix: str(c.values, 'prefix'),
      statuses: commaList(c.values, 'statuses'),
      fields: list(c.values, 'field'),
      drop_fields: list(c.values, 'drop-field'),
      review_statuses: listOrNone(c.values, 'review-statuses'),
      reviewers: listOrNone(c.values, 'reviewers'),
      creators: listOrNone(c.values, 'creators'),
    });
    const d = r.data;
    const head = d.changed ? 'updated config.json' : 'board';
    return {
      ...r,
      human:
        `${head}: ${d.name ?? '-'} (prefix ${d.prefix})\n  ${d.description ?? '(no description: laneboard config --description "<whose project, what work>")'}\n` +
        `  statuses: ${d.statuses.join(', ')} (final: ${d.statuses.at(-1) ?? '-'})\n  fields: ${fieldsText(d.fields)}${v2Lines(d)}`,
    };
  },
};
