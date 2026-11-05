// laneboard import
import path from 'node:path';
import { LaneboardError } from '../../core/index.ts';
import { IMPORT_FORMATS, runImport } from '../../import/index.ts';
import { importText } from '../format.ts';
import { flag, list, str } from './args.ts';
import type { CommandDef, Values } from './types.ts';

// Repeatable `from=to` option values as a map; a key given twice with different targets is an error.
function pairs(values: Values, option: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of list(values, option) ?? []) {
    const eq = raw.indexOf('=');
    if (eq <= 0 || eq === raw.length - 1) {
      throw new LaneboardError('INVALID_VALUE', `--${option} "${raw}" must be <from>=<to>`, { input: { field: option, value: raw, format: '<from>=<to>' }, fix: `pass --${option} as <from>=<to>, e.g. --${option} wip=in_progress` });
    }
    const from = raw.slice(0, eq);
    const to = raw.slice(eq + 1);
    const before = out.get(from);
    if (before !== undefined && before !== to) {
      throw new LaneboardError('USAGE', `--${option} maps "${from}" twice (${before}, ${to}); pass it once`, { edit: { drop: [{ name: option, value: raw }] } });
    }
    out.set(from, to);
  }
  return out;
}

// Options of markdown/json that `import checklist` does not take, and the other way round.
const KEY_OPTIONS = ['status-key', 'status-map', 'title-key', 'assignee-key', 'labels-key', 'description-key', 'history-key', 'field-map', 'ignore-key'];
const CHECKLIST_OPTIONS = ['status', 'done-status', 'heading-labels'];

// USAGE error for an option given to a format that does not take it.
function refuseOptions(values: Values, options: readonly string[], why: string): void {
  for (const option of options) {
    if (values[option] !== undefined) throw new LaneboardError('USAGE', `--${option} ${why}`, { edit: { drop: [{ name: option }] } });
  }
}

export const importCommand: CommandDef = {
  name: 'import',
  usage:
    'import <markdown|json> <path> --status-key K [--status-map from=to]... [--title-key K] [--assignee-key K] [--labels-key K] ' +
    '[--description-key K] [--history-key K] [--field-map key=field]... [--ignore-key K]... [--exclude NAME]... [--dry-run]  |  ' +
    'import checklist <path> --status S [--done-status S] [--heading-labels] [--exclude NAME]... [--dry-run]',
  summary:
    'Create tasks from task files of another tracker (a directory or one file). markdown: YAML frontmatter -> keys, body -> description; json: one task object per file. ' +
    'Keys become declared fields unless named by a --*-key option, renamed by --field-map or dropped by --ignore-key; an undeclared key or a status not configured stops the import ' +
    'and lists every value found. Each task gets the link file=<path from the project folder>, so a second run skips files imported before. ' +
    'checklist: a Markdown TODO list, one task per "- [ ]" / "- [x]" item: open items get --status, checked ones --done-status (default: the final status), ' +
    'an indented item becomes a subtask of the item above it, --heading-labels labels each item with its heading; the link is file=<path>#<item text>, ' +
    'so a second run skips items imported before and an edited item text makes a new task.',
  options: {
    'status-key': { type: 'string' },
    'status-map': { type: 'string', multiple: true },
    'title-key': { type: 'string' },
    'assignee-key': { type: 'string' },
    'labels-key': { type: 'string' },
    'description-key': { type: 'string' },
    'history-key': { type: 'string' },
    'field-map': { type: 'string', multiple: true },
    'ignore-key': { type: 'string', multiple: true },
    exclude: { type: 'string', multiple: true },
    'dry-run': { type: 'boolean' },
    status: { type: 'string' },
    'done-status': { type: 'string' },
    'heading-labels': { type: 'boolean' },
  },
  args: { min: 2, max: 2 },
  async run(c) {
    const format = c.positionals[0] ?? '';
    if (!(IMPORT_FORMATS as readonly string[]).includes(format)) {
      throw new LaneboardError('INVALID_VALUE', `unknown import format "${format}"`, { allowed: [...IMPORT_FORMATS], input: { field: 'format', value: format }, fix: 'use a format from `allowed`' });
    }
    const target = path.resolve(c.io.cwd, c.positionals[1] ?? '');
    const shown = c.positionals[1] ?? '';
    const exclude = list(c.values, 'exclude') ?? [];
    const dryRun = flag(c.values, 'dry-run');
    if (format === 'checklist') {
      refuseOptions(c.values, KEY_OPTIONS, 'is only for markdown and json (checklist: --status, --done-status)');
      const status = str(c.values, 'status');
      if (status === undefined) {
        throw new LaneboardError('USAGE', '--status is required (the status of an open "- [ ]" item; checked items get --done-status, default the final status)', {
          edit: { add: [{ name: 'status', value: '<status>' }] },
        });
      }
      const r = await runImport(c.op(), { format, target, shown, exclude, dryRun, status, doneStatus: str(c.values, 'done-status'), headingLabels: flag(c.values, 'heading-labels') });
      return { ...r, human: importText(r.data) };
    }
    refuseOptions(c.values, CHECKLIST_OPTIONS, 'is only for checklist (markdown and json: --status-key, --status-map)');
    const statusKey = str(c.values, 'status-key');
    if (statusKey === undefined) {
      throw new LaneboardError('USAGE', '--status-key is required (the source key that holds the status)', { edit: { add: [{ name: 'status-key', value: '<source key of the status>' }] } });
    }
    if (format === 'markdown') {
      for (const option of ['description-key', 'history-key']) {
        if (c.values[option] !== undefined) {
          throw new LaneboardError('USAGE', `--${option} is only for json (markdown: the body is the description)`, { edit: { drop: [{ name: option }] } });
        }
      }
    }
    const r = await runImport(c.op(), {
      format: format === 'json' ? 'json' : 'markdown',
      target,
      shown,
      titleKey: str(c.values, 'title-key') ?? 'title',
      statusKey,
      statusMap: pairs(c.values, 'status-map'),
      fieldMap: pairs(c.values, 'field-map'),
      ignoreKeys: list(c.values, 'ignore-key') ?? [],
      assigneeKey: str(c.values, 'assignee-key'),
      labelsKey: str(c.values, 'labels-key'),
      descriptionKey: format === 'json' ? (str(c.values, 'description-key') ?? 'description') : undefined,
      historyKey: str(c.values, 'history-key'),
      exclude,
      dryRun,
    });
    return { ...r, human: importText(r.data) };
  },
};
