// `laneboard import markdown|json`: read source files, map them by the options, hand them to the core import op (one write, idempotent).
import path from 'node:path';
import { importTasks, LaneboardError } from '../core/index.ts';
import type { ImportResult, OpContext } from '../core/index.ts';
import { mapRecords } from './mapping.ts';
import type { MappingOptions, MappingProblem } from './mapping.ts';
import { readSources } from './sources.ts';
import type { ImportFormat } from './sources.ts';

export type { ImportFormat } from './sources.ts';
export const IMPORT_FORMATS: readonly ImportFormat[] = ['markdown', 'json'];

export interface ImportOptions extends Omit<MappingOptions, 'actor' | 'now'> {
  format: ImportFormat;
  // File or directory to read (absolute).
  target: string;
  // File names to skip (`*` and `?` wildcards).
  exclude: readonly string[];
  dryRun: boolean;
}

export interface ImportData extends ImportResult {
  format: ImportFormat;
  // Files that are not tasks (Markdown without frontmatter).
  ignored: Array<{ source: string; reason: string }>;
}

// How to resolve the problems the core listed, with this command's flags (only the kinds that occurred).
function problemsFix(details: Record<string, unknown>): string {
  const has = (key: string): boolean => Array.isArray(details[key]) && (details[key] as unknown[]).length > 0;
  const steps: string[] = [];
  if (has('unknown_fields')) {
    steps.push('for each key in details.unknown_fields: ask the board owner to declare it (laneboard config --field <key>:<type>), or pass --field-map <key>=<declared field>, or --ignore-key <key> (drops it)');
  }
  if (has('unknown_statuses')) steps.push('for each value in details.unknown_statuses: pass --status-map <value>=<status from details.statuses>');
  if (has('invalid')) steps.push('correct each value in details.invalid in its source file');
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

// Run one import; sources are relative to the project folder (the store's parent), so the link file=<source> is stable.
export async function runImport(ctx: OpContext, o: ImportOptions): Promise<{ data: ImportData; warnings: string[] }> {
  const root = path.dirname(path.resolve(ctx.store.dir));
  const records = await readSources(o.format, o.target, root, o.exclude);
  const mapped = mapRecords(records, { ...o, actor: ctx.actor ?? 'import', now: new Date().toISOString() });
  if (mapped.problems.length) throw mappingError(mapped.problems);
  let result: { data: ImportResult; warnings: string[] };
  try {
    result = await importTasks(ctx, { tasks: mapped.tasks, dry_run: o.dryRun });
  } catch (err) {
    // The core lists unknown keys and statuses; the fix names this command's flags for them.
    if (err instanceof LaneboardError && err.details && 'unknown_fields' in err.details) {
      throw new LaneboardError(err.code, err.message, { ...(err.allowed ? { allowed: err.allowed } : {}), details: err.details, fix: problemsFix(err.details) });
    }
    throw err;
  }
  const warnings = [...result.warnings];
  if (mapped.ignored.length) warnings.push(`${mapped.ignored.length} file(s) are not tasks and were left out (no YAML frontmatter): ${mapped.ignored.map((i) => i.source).join(', ')}`);
  if (mapped.truncated) warnings.push(`${mapped.truncated} history text(s) were cut to the comment limit`);
  if (!records.length) warnings.push(`no ${o.format === 'markdown' ? '.md' : '.json'} files found in ${o.target}`);
  return { data: { format: o.format, ...result.data, ignored: mapped.ignored }, warnings };
}
