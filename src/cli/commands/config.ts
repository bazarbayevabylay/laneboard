// laneboard config
import { configureStore } from '../../core/index.ts';
import type { ConfigureResult } from '../../core/index.ts';
import { commaList, list, str } from './args.ts';
import type { CommandDef } from './types.ts';

// One line of declared fields: `priority (number, 0 = highest), team (string)`, or a hint how to declare one.
function fieldsText(fields: ConfigureResult['fields']): string {
  const shown = Object.entries(fields).map(([key, def]) => `${key} (${[def.type, def.description].filter(Boolean).join(', ')})`);
  return shown.length ? shown.join(', ') : 'none (laneboard config --field <key>:<type>[:<description>])';
}

export const config: CommandDef = {
  name: 'config',
  usage: 'config [--name N] [--description "<whose project, what work>"] [--prefix P] [--statuses a,b,c] [--field key:type[:description]]... [--drop-field key]...',
  summary:
    'Show the board name, description, prefix, statuses and fields; --name / --description change them, --prefix only while the board has no task (ids keep their prefix). ' +
    '--statuses sets the whole status list in order (at least 2), the last one final: add and reorder freely; a status that active tasks are in is removed only after they move. ' +
    '--field declares a task field or changes it (type string, number, boolean, string[] or json; without a description the current one stays), ' +
    '--drop-field removes one: a field whose active values do not fit is changed only after they are unset. ' +
    '--name, --description and --prefix update the machine registry.',
  options: {
    name: { type: 'string' },
    description: { type: 'string' },
    prefix: { type: 'string' },
    statuses: { type: 'string' },
    field: { type: 'string', multiple: true },
    'drop-field': { type: 'string', multiple: true },
  },
  args: { min: 0, max: 0 },
  // Op parameters named in fixes (a field both declared and dropped drops its --drop-field).
  flags: { fields: '--field', drop_fields: '--drop-field' },
  async run(c) {
    const r = await configureStore(c.op(), {
      name: str(c.values, 'name'),
      description: str(c.values, 'description'),
      prefix: str(c.values, 'prefix'),
      statuses: commaList(c.values, 'statuses'),
      fields: list(c.values, 'field'),
      drop_fields: list(c.values, 'drop-field'),
    });
    const d = r.data;
    const head = d.changed ? 'updated config.json' : 'board';
    return {
      ...r,
      human:
        `${head}: ${d.name ?? '-'} (prefix ${d.prefix})\n  ${d.description ?? '(no description: laneboard config --description "<whose project, what work>")'}\n` +
        `  statuses: ${d.statuses.join(', ')} (final: ${d.statuses.at(-1) ?? '-'})\n  fields: ${fieldsText(d.fields)}`,
    };
  },
};
