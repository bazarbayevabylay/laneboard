// `laneboard import markdown|json|checklist`: read source files, map them by the options, hand them to the core import op (one write, idempotent).
import path from 'node:path';
import { finalStatuses, importTasks, LaneboardError, loadConfig, shellQuote } from '../core/index.ts';
import type { ImportResult, OpContext } from '../core/index.ts';
import { mapChecklist, mapRecords } from './mapping.ts';
import type { Mapped, MappingOptions, MappingProblem } from './mapping.ts';
import { readSources } from './sources.ts';
import type { ImportFormat } from './sources.ts';

export type { ImportFormat } from './sources.ts';
export const IMPORT_FORMATS: readonly ImportFormat[] = ['markdown', 'json', 'checklist'];

export interface ImportOptions extends Omit<MappingOptions, 'actor' | 'now'> {
  format: 'markdown' | 'json';
  // File or directory to read (absolute).
  target: string;
  // The path as the caller typed it (for commands in warnings); the absolute target when absent.
  shown?: string;
  // File names to skip (`*` and `?` wildcards).
  exclude: readonly string[];
  dryRun: boolean;
}

// `import checklist`: statuses of open and checked items, heading labels.
export interface ChecklistImportOptions {
  format: 'checklist';
  target: string;
  shown?: string;
  exclude: readonly string[];
  dryRun: boolean;
  // Status of an open item (`- [ ]`).
  status: string;
  // Status of a checked item (`- [x]`); the board's final status when absent.
  doneStatus?: string;
  headingLabels: boolean;
}

export interface ImportData extends ImportResult {
  format: ImportFormat;
  // Files that are not tasks (Markdown without frontmatter).
  ignored: Array<{ source: string; reason: string }>;
}

// How to resolve the problems the core listed, with this command's flags (only the kinds that occurred).
function problemsFix(details: Record<string, unknown>, format: ImportFormat): string {
  const has = (key: string): boolean => Array.isArray(details[key]) && (details[key] as unknown[]).length > 0;
  const steps: string[] = [];
  if (has('unknown_fields')) {
    steps.push('for each key in details.unknown_fields: ask the board owner to declare it (laneboard config --field <key>:<type>), or pass --field-map <key>=<declared field>, or --ignore-key <key> (drops it)');
  }
  if (has('unknown_statuses')) {
    steps.push(
      format === 'checklist'
        ? 'pass --status (open items) and --done-status (checked items) with statuses from details.statuses'
        : 'for each value in details.unknown_statuses: pass --status-map <value>=<status from details.statuses>',
    );
  }
  if (has('invalid')) steps.push(format === 'checklist' ? 'correct each item in details.invalid in its file (source is <file>#<item text>)' : 'correct each value in details.invalid in its source file');
  return `${steps.join('; ')}; then run the same import again (--dry-run checks without writing)`;
}

// One error for the problems found while reading and mapping (before the core sees the tasks).
function mappingError(problems: readonly MappingProblem[]): LaneboardError {
  const shown = problems.slice(0, 5).map((p) => `${p.source}: ${p.message}`);
  return new LaneboardError('INVALID_VALUE', `import stopped, nothing was written: ${problems.length} problem${problems.length === 1 ? '' : 's'} in the source files: ${shown.join('; ')}${problems.length > 5 ? `; … ${problems.length - 5} more` : ''}`, {
    details: { invalid: problems },
    fix: 'fix or remove (--exclude <name>) each file in details.invalid, or name the right keys (--title-key, --status-key), then run the import again',
  });
}

// Warning for Markdown files left out that hold checkbox items: the command that makes a task of each item.
function checklistHint(ctx: OpContext, root: string, o: ImportOptions, checklists: Mapped['checklists']): string | undefined {
  const one = checklists.length === 1 ? checklists[0] : undefined;
  if (!checklists.length) return undefined;
  const files = checklists.map((c) => `${c.source} (${c.checkboxes} item${c.checkboxes === 1 ? '' : 's'})`).join(', ');
  const first = loadConfig(ctx.store.dir).statuses[0] ?? '<status>';
  // The file as the caller would type it: the typed path itself, or the typed directory joined with the file name.
  const file = one === undefined ? undefined : path.join(root, one.source);
  const shown = o.shown ?? o.target;
  const target = file === undefined ? '<file>' : shellQuote(file === o.target ? shown : path.join(shown, path.relative(o.target, file)));
  return `checklist items (- [ ] / - [x]) are not read by import markdown: ${files}; to make a task of each item run: laneboard import checklist ${target} --status ${first} --dry-run (checked items get the final status, indented items get their parent)`;
}

// Hand mapped tasks to the core; the fix of a core problem list names this command's flags.
async function importMapped(ctx: OpContext, mapped: Mapped, format: ImportFormat, dryRun: boolean): Promise<{ data: ImportResult; warnings: string[] }> {
  if (mapped.problems.length) throw mappingError(mapped.problems);
  try {
    return await importTasks(ctx, { tasks: mapped.tasks, dry_run: dryRun });
  } catch (err) {
    // The core lists unknown keys and statuses; the fix names this command's flags for them.
    if (err instanceof LaneboardError && err.details && 'unknown_fields' in err.details) {
      throw new LaneboardError(err.code, err.message, { ...(err.allowed ? { allowed: err.allowed } : {}), details: err.details, fix: problemsFix(err.details, format) });
    }
    throw err;
  }
}

// Run one import; sources are relative to the project folder (the store's parent), so the link file=<source> is stable.
export async function runImport(ctx: OpContext, o: ImportOptions | ChecklistImportOptions): Promise<{ data: ImportData; warnings: string[] }> {
  const root = path.dirname(path.resolve(ctx.store.dir));
  const records = await readSources(o.format, o.target, root, o.exclude);
  let mapped: Mapped;
  if (o.format === 'checklist') {
    // A checked item takes the board's final status unless --done-status names another.
    const doneStatus = o.doneStatus ?? finalStatuses(loadConfig(ctx.store.dir).statuses).at(-1) ?? o.status;
    mapped = mapChecklist(records, { status: o.status, doneStatus, headingLabels: o.headingLabels });
  } else {
    mapped = mapRecords(records, { ...o, actor: ctx.actor ?? 'import', now: new Date().toISOString() });
  }
  const result = await importMapped(ctx, mapped, o.format, o.dryRun);
  const warnings = [...result.warnings];
  if (mapped.ignored.length) {
    const why = o.format === 'checklist' ? 'no checklist items' : 'no YAML frontmatter';
    warnings.push(`${mapped.ignored.length} file(s) are not tasks and were left out (${why}): ${mapped.ignored.map((i) => i.source).join(', ')}`);
  }
  const hint = o.format === 'markdown' ? checklistHint(ctx, root, o, mapped.checklists) : undefined;
  if (hint !== undefined) warnings.push(hint);
  if (mapped.truncated) warnings.push(`${mapped.truncated} history text(s) were cut to the comment limit`);
  if (mapped.unlabeled.length) warnings.push(`--heading-labels: no label for heading(s) ${mapped.unlabeled.map((h) => JSON.stringify(h)).join(', ')} (labels use a-z 0-9 . _ -); add labels later with laneboard update <id> --add-label <label>`);
  if (!records.length) warnings.push(`no ${o.format === 'json' ? '.json' : '.md'} files found in ${o.target}`);
  return { data: { format: o.format, ...result.data, ignored: mapped.ignored }, warnings };
}
