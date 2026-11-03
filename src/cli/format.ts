// Output for the CLI: JSON envelopes, human text, and error fixes rebuilt from argv.
import { ERRORS, toErrorObject } from '../core/index.ts';
import type { DoctorResult, EventsResult, LaneboardError, ListResult, TaskView } from '../core/index.ts';

// Quote one argv token for a copy-pasteable shell command.
export function shellQuote(token: string): string {
  if (/^[A-Za-z0-9_\-.,:/=@+%]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

// `laneboard <argv...>` with each token quoted, except placeholder tokens like `<name>`.
export function commandLine(argv: readonly string[], placeholders: ReadonlySet<number> = new Set()): string {
  return ['laneboard', ...argv.map((t, i) => (placeholders.has(i) ? t : shellQuote(t)))].join(' ');
}

// Replace the offending value in argv with the suggestion (or a placeholder when only `allowed` is known).
function replaceValue(argv: readonly string[], err: LaneboardError): string | undefined {
  const input = err.input;
  if (!input) return undefined;
  const replacement = input.suggestion ?? (err.allowed?.length ? `<${input.field} from allowed>` : undefined);
  if (replacement === undefined) return undefined;
  const flag = `--${input.field.replace(/_/g, '-')}`;
  const hits: number[] = [];
  argv.forEach((token, i) => {
    if (token === input.value || token.endsWith(`=${input.value}`)) hits.push(i);
  });
  const index = hits.length === 1 ? hits[0] : hits.find((i) => argv[i - 1] === flag || argv[i]?.startsWith(`${flag}=`));
  if (index === undefined) return undefined;
  const out = [...argv];
  const token = out[index] ?? '';
  out[index] = token === input.value ? replacement : `${token.slice(0, token.length - input.value.length)}${replacement}`;
  const placeholders = input.suggestion === undefined ? new Set([index]) : new Set<number>();
  return commandLine(out, placeholders);
}

// The fix shown to a CLI user: a corrected command when one can be built, else the core fix.
export function cliFix(err: LaneboardError, argv: readonly string[], command: string | undefined): string {
  const rebuilt = replaceValue(argv, err);
  if (rebuilt) return rebuilt;
  if (err.code === 'ACTOR_REQUIRED') return `${commandLine(argv)} --as <your-name>   (or export LANEBOARD_AGENT=<your-name>)`;
  if ((err.code === 'USAGE' || err.code === 'UNKNOWN_OPTION') && err.fix === ERRORS[err.code].fix) {
    return command ? `laneboard ${command} --help` : 'laneboard --help';
  }
  return command ? err.fix.replace('<command>', command) : err.fix;
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
