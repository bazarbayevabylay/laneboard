// Output for the CLI: JSON envelopes, human text, and error fixes rebuilt from argv.
import { ERRORS, fieldsLine, LaneboardError, toErrorObject } from '../core/index.ts';
import type { DoctorResult, EventsResult, FieldInfo, ListItem, ListResult, TaskView } from '../core/index.ts';
import type { SetupResult } from '../setup/index.ts';

// Quote one argv token for a copy-pasteable shell command.
export function shellQuote(token: string): string {
  if (/^[A-Za-z0-9_\-.,:/=@+%]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

// `laneboard <argv...>` with each token quoted, except placeholder tokens like `<name>`.
export function commandLine(argv: readonly string[], placeholders: ReadonlySet<number> = new Set()): string {
  return ['laneboard', ...argv.map((t, i) => (placeholders.has(i) ? t : shellQuote(t)))].join(' ');
}

// Replace the offending value in argv with the suggestion, else a format or `allowed` placeholder.
function replaceValue(argv: readonly string[], err: LaneboardError): string | undefined {
  const input = err.input;
  if (!input) return undefined;
  const replacement = input.suggestion ?? input.format ?? (err.allowed?.length ? `<${input.field} from allowed>` : undefined);
  if (replacement === undefined) return undefined;
  const value = input.value;
  // The value is a whole token, the tail of `--flag=value`, or the key of `key=value` (`--field priorty=1`).
  const rewrite = (token: string): string | undefined => {
    if (token === value) return replacement;
    if (token.endsWith(`=${value}`)) return `${token.slice(0, token.length - value.length)}${replacement}`;
    if (token.startsWith(`${value}=`)) return `${replacement}${token.slice(value.length)}`;
    const inner = new RegExp(`^(--[^=]+=)${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(=.*)$`, 's').exec(token);
    return inner ? `${inner[1] ?? ''}${replacement}${inner[2] ?? ''}` : undefined;
  };
  const flag = `--${input.field.replace(/_/g, '-')}`;
  const hits: number[] = [];
  argv.forEach((token, i) => {
    if (rewrite(token) !== undefined) hits.push(i);
  });
  const index = hits.length === 1 ? hits[0] : hits.find((i) => argv[i - 1] === flag || argv[i]?.startsWith(`${flag}=`));
  if (index === undefined) return undefined;
  const out = [...argv];
  out[index] = rewrite(out[index] ?? '') ?? replacement;
  const placeholders = input.suggestion === undefined ? new Set([index]) : new Set<number>();
  return commandLine(out, placeholders);
}

// argv with extra option tokens inserted before `--` (after it they would be read as text).
function withOptions(argv: readonly string[], extra: readonly string[]): string[] {
  const end = argv.indexOf('--');
  return end < 0 ? [...argv, ...extra] : [...argv.slice(0, end), ...extra, ...argv.slice(end)];
}

// The fix shown to a CLI user: a corrected command when one can be built, else the usage line, else the core fix.
export function cliFix(err: LaneboardError, argv: readonly string[], command: { name: string; usage: string } | undefined): string {
  const rebuilt = replaceValue(argv, err);
  if (rebuilt) return rebuilt;
  if (err.code === 'ACTOR_REQUIRED') {
    // Only the command, so it can be run as given; the LANEBOARD_AGENT alternative is in the CLI message (cliMessage).
    const out = withOptions(argv, ['--as', '<your-name>']);
    return commandLine(out, new Set([out.indexOf('<your-name>')]));
  }
  if ((err.code === 'USAGE' || err.code === 'UNKNOWN_OPTION') && err.fix === ERRORS[err.code].fix) {
    return command ? `laneboard ${command.usage}` : 'laneboard <command from allowed> [options]';
  }
  return command ? err.fix.replace('<command>', command.name) : err.fix;
}

// The message a CLI user sees: ACTOR_REQUIRED also names the environment variable (the fix holds only the command).
export function cliMessage(err: LaneboardError): LaneboardError {
  if (err.code !== 'ACTOR_REQUIRED') return err;
  return new LaneboardError(err.code, `${err.message}: pass --as <your-name>, or export LANEBOARD_AGENT=<your-name> once for the session`, { fix: err.fix });
}

// Success envelope (one JSON document on stdout).
export function okEnvelope(store: string | null, data: unknown, warnings: string[]): string {
  return `${JSON.stringify({ ok: true, store, data, warnings })}\n`;
}

// Error envelope (also on stdout; stderr stays empty in --json mode).
export function errorEnvelope(store: string | null, err: LaneboardError, fix: string): string {
  return `${JSON.stringify({ ok: false, store, error: toErrorObject(err, fix) })}\n`;
}

// Human error block for stderr.
export function errorText(err: LaneboardError, fix: string): string {
  const lines = [`error ${err.code}: ${err.message}`];
  if (err.allowed) lines.push(`  allowed: ${err.allowed.length ? err.allowed.join(', ') : '(none)'}`);
  lines.push(`  fix: ${fix}`);
  // A snippet to add by hand (setup) is part of the fix, so human output shows it too.
  const snippet = err.details?.snippet;
  if (typeof snippet === 'string') lines.push('  snippet:', ...snippet.split('\n').map((l) => `    ${l}`));
  return `${lines.join('\n')}\n`;
}

// Human warning lines for stderr.
export function warningText(warnings: readonly string[]): string {
  return warnings.map((w) => `warning: ${w}\n`).join('');
}

// Align rows into columns separated by two spaces.
function table(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join('  '));
}

// Compact one-line JSON for event data.
function inline(value: unknown): string {
  return JSON.stringify(value);
}

// Human view of one task.
export function taskText(t: TaskView): string {
  const lines = [`${t.id}  ${t.title}`];
  lines.push(`  status: ${t.status} · assignee: ${t.assignee ?? '-'} · rev: ${t.rev} · archived: ${t.archived ? `yes (${t.archived_at ?? ''})` : 'no'}`);
  if (t.labels.length) lines.push(`  labels: ${t.labels.join(', ')}`);
  if (t.links.length) lines.push(`  links: ${t.links.map((l) => `${l.kind}=${l.ref}`).join(', ')}`);
  const fields = Object.entries(t.fields);
  if (fields.length) lines.push(`  fields: ${fields.map(([k, v]) => `${k}=${typeof v === 'string' ? v : inline(v)}`).join(', ')}`);
  if (t.attachments.length) lines.push(`  attachments: ${t.attachments.map((a) => `${a.name} (${a.size} B)`).join(', ')}`);
  lines.push(`  created: ${t.created_at} by ${t.created_by} · updated: ${t.updated_at} by ${t.updated_by}`);
  if (t.description) {
    lines.push('  description:');
    for (const line of t.description.split('\n')) lines.push(`    ${line}`);
  }
  const dropped = t.events_dropped ? `, ${t.events_dropped} older dropped` : '';
  lines.push(`  events (${t.events.length} shown${dropped}):`);
  for (const e of t.events) lines.push(`    ${e.at}  ${e.actor}  ${e.type}  ${inline(e.data)}`);
  return lines.join('\n');
}

// Human view of a task list with the paging footer.
export function listText(r: ListResult): string {
  const lines: string[] = [];
  if (r.items.length) {
    const rows = [['ID', 'STATUS', 'ASSIGNEE', 'REV', 'UPDATED', 'TITLE']];
    for (const i of r.items) rows.push([i.id, i.status, i.assignee ?? '-', String(i.rev), i.updated_at, i.archived ? `${i.title} [archived]` : i.title]);
    lines.push(...table(rows));
  }
  const shown = r.items.length;
  const more = r.offset + shown < r.total ? `; next: --offset ${r.offset + shown}` : '';
  lines.push(`${shown} of ${r.total} shown (scope ${r.scope})${more}`);
  return lines.join('\n');
}

// Human view of the event feed.
export function eventsText(r: EventsResult): string {
  const lines: string[] = [];
  if (r.items.length) {
    const rows = [['AT', 'TASK', 'ACTOR', 'TYPE', 'DATA']];
    for (const e of r.items) rows.push([e.at, e.task_id, e.actor, e.type, inline(e.data)]);
    lines.push(...table(rows));
  }
  lines.push(`${r.items.length} of ${r.total} shown (scope ${r.scope}, newest first)`);
  return lines.join('\n');
}

// Human doctor report.
export function doctorText(r: DoctorResult): string {
  const lines = table(r.checks.map((c) => [c.ok ? 'ok' : c.fixed ? 'fixed' : 'FAIL', `${c.name}:`, c.message]));
  const problems = r.checks.filter((c) => !c.ok && !c.fixed).length;
  lines.push(r.healthy ? 'healthy' : `${problems} problem(s) found; see the messages above`);
  return lines.join('\n');
}

// `prime` output is capped so a SessionStart hook stays small (ADR-0001 section 9).
export const PRIME_MAX_CHARS = 4000;

export interface PrimeData {
  rules: string;
  agent: string | null;
  store_problem: string | null;
  statuses: Array<{ status: string; count: number }>;
  // The last configured status (work there is done); null without a store.
  final_status: string | null;
  fields: Record<string, FieldInfo>;
  tasks: ListItem[];
}

// `line` cut to `room` characters, marked with an ellipsis when cut.
function fit(line: string, room: number): string {
  return line.length <= room ? line : `${line.slice(0, Math.max(0, room - 1))}…`;
}

// Rules, statuses (final one named), fields, then the agent's active tasks (or a hint); at most PRIME_MAX_CHARS characters.
export function primeText(d: PrimeData): string {
  const head = `${d.rules}\n`;
  if (d.store_problem !== null) return fit(`${head}\nlaneboard store: ${d.store_problem}`, PRIME_MAX_CHARS);
  const more = (n: number): string => `\n... ${n} more: laneboard list --assignee ${d.agent ?? '<you>'} --json`;
  let closing: string;
  if (d.agent === null) closing = 'Set your name to see your tasks: export LANEBOARD_AGENT=<your-name> (or pass --as <your-name>).';
  else if (!d.tasks.length) closing = `Your active tasks (${d.agent}): none. Find work: laneboard list --unassigned --json`;
  else closing = `Your active tasks (${d.agent}), newest update first:`;
  // Status and field lines share what is left after the rules, the closing line and the longest footer.
  const room = PRIME_MAX_CHARS - head.length - closing.length - (d.agent !== null && d.tasks.length ? more(d.tasks.length).length : 0) - 3;
  let status = `Statuses in order (final: ${d.final_status ?? '-'}), active tasks: ${d.statuses.map((x) => `${x.status} ${x.count}`).join(', ') || 'none'}`;
  let fields = `Fields (--field key=value): ${fieldsLine(d.fields) || 'none declared'}`;
  if (status.length + 1 + fields.length > room) {
    fields = fit(fields, Math.floor(room / 3));
    status = fit(status, room - 1 - fields.length);
  }
  let text = [head, status, fields, closing].join('\n');
  if (d.agent === null || !d.tasks.length) return fit(text, PRIME_MAX_CHARS);
  for (const [i, t] of d.tasks.entries()) {
    const line = `\n  ${t.id}  [${t.status}]  rev ${t.rev}  ${t.title}`;
    const left = d.tasks.length - i - 1;
    // Keep room for the "N more" footer unless this is the last task.
    if (text.length + line.length + (left ? more(left).length : 0) > PRIME_MAX_CHARS) return text + more(d.tasks.length - i);
    text += line;
  }
  return text;
}

// Human setup report: one line per file, diffs of replaced values, notes.
export function setupText(r: SetupResult): string {
  const lines: string[] = [];
  if (r.dry_run) lines.push('dry run: nothing was written');
  for (const f of r.files) {
    lines.push(`${f.result} ${f.path}${f.scope === 'global' ? ' (global file)' : ''}`);
    for (const d of f.diff ?? []) lines.push(`    ${d}`);
  }
  for (const n of r.notes) lines.push(`next: ${n}`);
  return lines.join('\n');
}
