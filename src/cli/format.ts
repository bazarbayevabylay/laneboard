// Output for the CLI: JSON envelopes, human text and error blocks (the fixes themselves are built in argv.ts).
import { fieldsLine, LaneboardError, shellQuote, shortRuleForms, toErrorObject } from '../core/index.ts';
import type { DoctorResult, EventsResult, FieldInfo, ListItem, ListResult, TaskDetail, TaskRef, TaskView } from '../core/index.ts';
import type { ImportData } from '../import/index.ts';
import { age } from './board-view.ts';
import type { SetupResult } from '../setup/index.ts';

export { shellQuote };


// The message a CLI user sees: ACTOR_REQUIRED also names the environment variable (the fix holds only the command).
export function cliMessage(err: LaneboardError): LaneboardError {
  if (err.code !== 'ACTOR_REQUIRED') return err;
  return new LaneboardError(err.code, `${err.message}: pass --as <your-name>, or export LANEBOARD_AGENT=<your-name> once for the session`, { fix: err.fix });
}

// Success envelope (one JSON document on stdout): the store and its id prefix say whose store was used.
export function okEnvelope(store: string | null, prefix: string | null, data: unknown, warnings: string[]): string {
  return `${JSON.stringify({ ok: true, store, prefix, data, warnings })}\n`;
}

// Error envelope (also on stdout; stderr stays empty in --json mode).
export function errorEnvelope(store: string | null, prefix: string | null, err: LaneboardError, fix: string): string {
  return `${JSON.stringify({ ok: false, store, prefix, error: toErrorObject(err, fix) })}\n`;
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

// Longest value an event line shows (titles, refs); a sha256 shows its first 12 characters.
const EVENT_VALUE_MAX = 60;
const SHA_SHOWN = 12;

// One event value for people: text as it is (quoted when it has spaces), null as -, a link as kind=ref, a list in [ ].
function eventValue(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') return /^[^\s"]+$/.test(value) ? cut(value) : JSON.stringify(cut(value));
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `[${value.map(eventValue).join(', ')}]`;
  const link = value as { kind?: unknown; ref?: unknown };
  if (typeof link.kind === 'string' && typeof link.ref === 'string' && Object.keys(value).length === 2) return `${link.kind}=${cut(link.ref)}`;
  return cut(JSON.stringify(value));
}

// Text cut to EVENT_VALUE_MAX code points, with an ellipsis when cut.
function cut(text: string): string {
  const chars = [...text];
  return chars.length <= EVENT_VALUE_MAX ? text : `${chars.slice(0, EVENT_VALUE_MAX - 1).join('')}…`;
}

// Event data for people: a comment as its text, other events as short key=value pairs (an update as key=before→after).
export function eventText(type: string, data: Record<string, unknown>): string {
  if (type === 'commented' && typeof data.text === 'string') return data.text;
  // claim --resume: the task came from another session of the same default name base.
  if (type === 'assigned' && data.resumed === true) return `resumed from ${eventValue(data.from)} to=${eventValue(data.to)}`;
  // finish by somebody else: the event's actor accepted a task its assignee handed in (LB-9).
  if (type === 'status' && data.accepted === true) return `accepted from=${eventValue(data.from)} to=${eventValue(data.to)}`;
  // finish by the assignee into a status that is not final: it handed the task in (S4b).
  if (type === 'status' && data.handed_in === true) return `handed in from=${eventValue(data.from)} to=${eventValue(data.to)}`;
  return Object.entries(data)
    .map(([key, value]) => {
      if (key === 'sha256' && typeof value === 'string') return `${key}=${value.slice(0, SHA_SHOWN)}…`;
      const chars = (value as { chars?: unknown } | null)?.chars;
      if (type === 'updated' && key === 'description' && Array.isArray(chars)) {
        const appended = (value as { appended?: unknown }).appended === true ? ' (appended)' : '';
        return `description=${eventValue(chars[0])}→${eventValue(chars[1])} chars${appended}`;
      }
      if (type === 'updated' && Array.isArray(value) && value.length === 2) return `${key}=${eventValue(value[0])}→${eventValue(value[1])}`;
      return `${key}=${eventValue(value)}`;
    })
    .join(' ');
}

// An event's actor for people: a default name is marked, so it is not mistaken for a name somebody chose.
function actorText(e: { actor: string; actor_source: 'explicit' | 'default' | null }): string {
  return e.actor_source === 'default' ? `${e.actor} (default name)` : e.actor;
}

// Another task named by `get` (parent, child): `LB-4 [in_progress]`, archived ones `[done, archived]`.
function refText(r: TaskRef): string {
  return `${r.id} [${r.status}${r.archived ? ', archived' : ''}]`;
}

// The parent line: with `get` its title and status (or that the id names no task), a write's --full only the id.
function parentText(t: TaskView & Partial<TaskDetail>): string {
  if (t.parent_task === undefined) return t.parent ?? '';
  return t.parent_task === null ? `${t.parent ?? ''} (no such task)` : `${t.parent_task.id} ${t.parent_task.title} [${t.parent_task.status}${t.parent_task.archived ? ', archived' : ''}]`;
}

// Human view of one task (with `get`: its parent's title and status, and its children).
export function taskText(t: TaskView & Partial<TaskDetail>): string {
  const lines = [`${t.id}  ${t.title}`];
  lines.push(`  status: ${t.status} · assignee: ${t.assignee ?? '-'} · rev: ${t.rev} · archived: ${t.archived ? `yes (${t.archived_at ?? ''})` : 'no'}`);
  if (t.labels.length) lines.push(`  labels: ${t.labels.join(', ')}`);
  if (t.links.length) lines.push(`  links: ${t.links.map((l) => `${l.kind}=${l.ref}`).join(', ')}`);
  if (t.parent !== null) lines.push(`  parent: ${parentText(t)}`);
  if (t.children?.length) lines.push(`  children: ${t.children.map(refText).join(', ')}`);
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
  // A comment of several lines continues under its first line.
  // finish's result comment says so (ADR §27).
  const typeText = (e: TaskView['events'][number]): string => (e.type === 'commented' && e.data.result === true ? 'commented (result)' : e.type);
  for (const e of t.events) lines.push(`    ${e.at}  ${actorText(e)}  ${typeText(e)}  ${eventText(e.type, e.data).split('\n').join('\n      ')}`);
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
    for (const e of r.items) rows.push([e.at, e.task_id, actorText(e), e.type, inline(e.data)]);
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
  // Where the name came from: explicit (--as, LANEBOARD_AGENT) or the session's default name; null without a name.
  agent_source: 'explicit' | 'default' | null;
  // Board name and description from config (null without a store or for older stores).
  name: string | null;
  description: string | null;
  // The store in use and its id prefix (null without a store).
  store: string | null;
  prefix: string | null;
  // Set when the store was found in a parent directory (it may be another project's).
  store_warning: string | null;
  store_problem: string | null;
  statuses: Array<{ status: string; count: number }>;
  // The first configured status (new tasks start there); null without a store.
  first_status: string | null;
  // The last configured status (work there is done); null without a store.
  final_status: string | null;
  // Configured statuses that are not final (the free-task footer lists them); empty without a store.
  open_statuses: string[];
  fields: Record<string, FieldInfo>;
  tasks: ListItem[];
  // The agent's tasks not in the final status (without a name: anybody's assigned ones, used by the edit hook).
  in_progress: number;
  // Free work: active tasks without an assignee, not in the final status (at most 10, by priority), and how many there are.
  unassigned: ListItem[];
  unassigned_total: number;
  // The session default name without its session part (null for other names); its other sessions' unfinished tasks are `resumable`.
  session_base: string | null;
  resumable: ListItem[];
}

// Always under the session default name: the parent session, its subagents and parallel workers share it (LB-8, review S2g),
// so it comes before every command prime prints.
function sessionLine(agent: string): string {
  return (
    `Your name: session default ${agent} (no --as needed). Subagent or parallel worker? It is your parent's name: ` +
    'run laneboard prime --as <your-own-name> and pass that --as on every command.'
  );
}

// `line` cut to `room` characters, marked with an ellipsis when cut.
function fit(line: string, room: number): string {
  return line.length <= room ? line : `${line.slice(0, Math.max(0, room - 1))}…`;
}

// Task counts of the status line: the active ones (not final) per status, then the finished ones that wait for archive (LB-10).
function statusCounts(d: PrimeData): string {
  const active = d.statuses.filter((x) => x.status !== d.final_status).map((x) => `${x.status} ${x.count}`);
  const done = d.statuses.find((x) => x.status === d.final_status);
  return `active tasks: ${active.join(', ') || 'none'}${done === undefined ? '' : `; ${done.status} ${done.count}`}`;
}

// `--as` for a printed command: the agent's own name, none for the default name (writes use it anyway), a placeholder without one.
function asOption(d: PrimeData): string {
  if (d.agent === null) return ' --as <your-name>';
  return d.agent_source === 'default' ? '' : ` --as ${shellQuote(d.agent)}`;
}

// A task line of prime: id, status, rev, title.
function taskLine(t: ListItem, titleMax = Infinity): string {
  return `\n  ${t.id}  [${t.status}]  rev ${t.rev}  ${fit(t.title, titleMax)}`;
}

// `text` plus the first `keep` task lines (their room is counted in advance, see sectionMin), then one line per task while the whole
// stays under PRIME_MAX_CHARS with `reserve` characters left for what follows; tasks that do not fit (or that `total` counts beyond
// `items`) end in the `more` footer.
function withTasks(text: string, items: readonly ListItem[], total: number, more: (n: number) => string, reserve: number, keep: number, line: (t: ListItem) => string): string {
  let out = text;
  for (const [i, t] of items.entries()) {
    const next = line(t);
    const left = total - i - 1;
    if (i >= keep && out.length + next.length + (left ? more(left).length : 0) + reserve > PRIME_MAX_CHARS) return out + more(total - i);
    out += next;
  }
  return total > items.length ? out + more(total - items.length) : out;
}

// What else prime lists for an agent without a task in progress: tasks of its earlier sessions, free tasks.
interface Choices {
  resume: boolean;
  free: boolean;
}

// What to do when the agent has no task in progress: the exact create command (and how to keep a name without one); `dir` is
// passed on as --dir. With earlier-session or free tasks listed, one numbered order of ways (an id from the request, resume, a free
// task, create), so a weak model neither duplicates a free task nor takes work that is not its own. Under a warning that the store
// looks like another project's, no command for that store (as the edit hook).
function noTaskText(d: PrimeData, dir: string, choices: Choices): string {
  if (d.store_warning !== null) {
    return "You have no task in progress. The store above looks like another project's: create your task on this folder's own board (see the warning).";
  }
  const name = d.agent === null ? '<your-name>' : shellQuote(d.agent);
  // The default name is used without --as, so commands copied from here stay "default" in the task events.
  const as = d.agent_source === 'default' ? '' : ` --as ${name}`;
  const create = `  laneboard create "<short title of your work>" --status ${shellQuote(d.first_status ?? '<status>')} --assignee ${name}${as}${dir} --json`;
  const claim = `laneboard claim <ID>${asOption(d)}${dir} --json`;
  const keepName = 'Then pass the same --as <your-name> on every command (or export LANEBOARD_AGENT=<your-name>).';
  if (!choices.resume && !choices.free) {
    if (d.agent === null) return ['You have no task in progress (your name is not set). Create one now, with a name you keep for the whole session:', create, keepName].join('\n');
    return ['You have no task in progress. Create one now:', create, `Given a task id instead: ${claim}`].join('\n');
  }
  const ways = [`The request names a task id: ${claim}`];
  if (choices.resume) ways.push(`Your own task from before /clear (below) fits the request: laneboard claim <ID> --resume${dir} --json`);
  if (choices.free) ways.push(`A free task below fits the request: ${claim}`);
  ways.push('Otherwise create one:');
  const intro =
    d.agent === null
      ? 'You have no task in progress (your name is not set). Start one the first way that fits, with a name you keep for the whole session:'
      : 'You have no task in progress. Start one the first way that fits:';
  return [intro, ...ways.map((w, i) => `${i + 1}. ${w}`), create, ...(d.agent === null ? [keepName] : [])].join('\n');
}

// Free tasks prime always lists (when there are that many), with the footer command for the rest.
export const PRIME_MIN_FREE = 3;

// What prime gives up, step by step, to stay under PRIME_MAX_CHARS: short forms of the rules (agent-rules.md), the board's name and
// description, long task titles, then the --dir of each printed command (the Store line names it as `--dir <path>`, a line says to
// add it; the path is printed once). Never a command,
// the session line, the first own task, the newest earlier-session task or the first PRIME_MIN_FREE free tasks (review S3). The status and field
// lines are cut last: for a config with very many statuses or fields, or a very long store path named by --dir (the --dir line
// then takes their room; review S3b MINOR).
interface Squeeze {
  shortRules: boolean;
  cutBoard: boolean;
  shortTitles: boolean;
  dirOnce: boolean;
  cutLines: boolean;
}
const SQUEEZES: readonly Squeeze[] = [
  { shortRules: false, cutBoard: false, shortTitles: false, dirOnce: false, cutLines: false },
  { shortRules: true, cutBoard: false, shortTitles: false, dirOnce: false, cutLines: false },
  { shortRules: true, cutBoard: true, shortTitles: false, dirOnce: false, cutLines: false },
  { shortRules: true, cutBoard: true, shortTitles: true, dirOnce: false, cutLines: false },
  { shortRules: true, cutBoard: true, shortTitles: true, dirOnce: true, cutLines: false },
  { shortRules: true, cutBoard: true, shortTitles: true, dirOnce: true, cutLines: true },
];

// Characters of a task title in prime once long titles give way (the id is what the commands need).
const SHORT_TITLE = 60;

// The rules with their short forms (agent-rules.md, below the rules) in place of the full lines.
function shortRules(rules: string): string {
  const short = new Map(shortRuleForms().map((r) => [r.n, `${r.n}. ${r.text}`]));
  return rules
    .split('\n')
    .map((line) => short.get(/^(\d+)\. /.exec(line)?.[1] ?? '') ?? line)
    .join('\n');
}

// Characters of the first `n` task lines plus the footer for the rest: what a list section always keeps.
function sectionMin(items: readonly ListItem[], total: number, more: (n: number) => string, n: number, line: (t: ListItem) => string): number {
  const shown = items.slice(0, n);
  return shown.reduce((sum, t) => sum + line(t).length, 0) + (total > shown.length ? more(total - shown.length).length : 0);
}

// Rules, store, statuses (final one named), fields, the session-name line, then the agent's tasks or the ways to start one, the tasks of
// its earlier sessions (resume), then the free tasks with the claim command; at most PRIME_MAX_CHARS characters (SQUEEZES says what
// gives way). `storeDir`: the store was named by --dir, so the printed commands carry it; `now`: for the age of earlier-session tasks.
export function primeText(d: PrimeData, storeDir?: string, now = new Date()): string {
  if (d.store_problem !== null) return fit(`${d.rules}\n\nlaneboard store: ${d.store_problem}`, PRIME_MAX_CHARS);
  let text = '';
  for (const squeeze of SQUEEZES) {
    const out = primeLayout(d, storeDir, now, squeeze);
    text = out.text;
    if (out.fits) return text;
  }
  // Not even the last step keeps every required part (an unusually long config): the tail is cut.
  return fit(text, PRIME_MAX_CHARS);
}

// Longest `--status <open>...` a footer command of prime carries; a config with more or longer statuses gets the short command and a note.
const OPEN_OPTIONS_MAX = 300;

// The footer commands list the same tasks as prime's lists (own or free ones in a configured status that is not final), so the
// "N more" they count is what the command prints (review S4 MINOR): `--status` per open status. Past OPEN_OPTIONS_MAX characters
// (a config with very many statuses) the command goes without them and a note before it says it lists the final status too
// (LB-11 b: not after it, so the copied command line stays valid in a shell).
function openStatusOptions(d: PrimeData): { options: string; note: string } {
  const options = d.open_statuses.map((st) => ` --status ${shellQuote(st)}`).join('');
  if (options.length <= OPEN_OPTIONS_MAX) return { options, note: '' };
  return { options: '', note: `(lists ${d.final_status ?? 'final'} tasks too) ` };
}

// primeText with one squeeze step; `fits`: every required part is there and the whole stays under PRIME_MAX_CHARS.
function primeLayout(d: PrimeData, storeDir: string | undefined, now: Date, squeeze: Squeeze): { text: string; fits: boolean } {
  const head = `${squeeze.shortRules ? shortRules(d.rules) : d.rules}\n`;
  const named = storeDir === undefined ? '' : shellQuote(storeDir);
  const dir = storeDir === undefined || squeeze.dirOnce ? '' : ` --dir ${named}`;
  // dirOnce: the path is printed once, as the whole `--dir <path>` option in the Store line (review S4: not a second time here).
  const dirLine = storeDir !== undefined && squeeze.dirOnce ? 'This board was named by --dir: add the --dir option of the Store line to every laneboard command below.' : '';
  const open = openStatusOptions(d);
  const more = (n: number): string => `\n... ${n} more: ${open.note}laneboard list --assignee ${d.agent ?? '<you>'}${open.options}${dir} --json`;
  const freeMore = (n: number): string => `\n... ${n} more: laneboard list --unassigned${open.options}${dir} --json${open.note}`;
  const resumeMore = (n: number): string => `\n... ${n} more not shown`;
  const listed = d.agent !== null && d.tasks.length > 0;
  const noTask = d.agent === null || d.in_progress === 0;
  // Under a warning that the store looks like another project's, no claim command for it (as noTaskText).
  const resume = noTask && d.store_warning === null && d.session_base !== null && d.resumable.length > 0;
  const free = d.store_warning === null && d.unassigned_total > 0;
  // Without a name the agent's own tasks are unknown, so the ways to start one are always shown.
  const closing = [
    d.agent !== null && d.agent_source === 'default' ? sessionLine(d.agent) : '',
    dirLine,
    noTask ? noTaskText(d, dir, { resume, free }) : '',
    listed ? `Your active tasks (${d.agent}), newest update first:` : '',
  ]
    .filter(Boolean)
    .join('\n');
  // A parallel session of the same user has the same base: the header says so next to the list (the command is in the ways above).
  const resumeHead = resume
    ? '\nYour earlier sessions, unfinished (a parallel session of yours has the same name: resume only your own):'
    : '';
  const titleMax = squeeze.shortTitles ? SHORT_TITLE : Infinity;
  const line = (t: ListItem): string => taskLine(t, titleMax);
  // The holder differs only in its session part: `<base>:<session>`.
  const resumeLine = (t: ListItem): string => `\n  ${t.id}  [${t.status}]  ${age(t.updated_at, now)} ago  session ${(t.assignee ?? '').slice((d.session_base ?? '').length + 1)}  ${fit(t.title, titleMax)}`;
  // Without a task in progress the numbered ways above carry the claim command, so the header gives no second order.
  const freeHead = !free ? '' : noTask ? '\nFree tasks (no assignee):' : `\nFree tasks (no assignee); take one: laneboard claim <ID>${asOption(d)}${dir} --json`;
  const storeHead = storeDir !== undefined && squeeze.dirOnce ? `Store: --dir ${named} (prefix ${d.prefix ?? '-'})` : `Store: ${d.store ?? '-'} (prefix ${d.prefix ?? '-'})`;
  const warning = d.store_warning ? `\nwarning: ${d.store_warning}` : '';
  let status = `Statuses in order (final: ${d.final_status ?? '-'}), ${statusCounts(d)}`;
  let fields = `Fields (--field key=value): ${fieldsLine(d.fields) || 'none declared'}`;
  // What each list keeps whatever comes before it: the first own task, the newest earlier-session task (the one a session after
  // /clear most likely resumes), the first free tasks; each with its footer.
  const freeKeep = free ? freeHead.length + sectionMin(d.unassigned, d.unassigned_total, freeMore, PRIME_MIN_FREE, line) : 0;
  const resumeKeep = resume ? resumeHead.length + sectionMin(d.resumable, d.resumable.length, resumeMore, 1, resumeLine) : 0;
  const ownKeep = listed ? sectionMin(d.tasks, d.tasks.length, more, 1, line) : 0;
  // Four newlines join the five blocks below.
  const others = head.length + storeHead.length + warning.length + closing.length + 4 + ownKeep + resumeKeep + freeKeep;
  if (squeeze.cutLines && others + status.length + fields.length > PRIME_MAX_CHARS) {
    // The board goes first here (cutBoard is on); the field line gets at most a third of the room, the status line the rest.
    const left = Math.max(0, PRIME_MAX_CHARS - others - 1);
    fields = fit(fields, Math.floor(left / 3));
    status = fit(status, left - 1 - fields.length);
  }
  const required = others + status.length + fields.length;
  let board = d.name || d.description ? ` - ${[d.name, d.description].filter(Boolean).join(': ')}` : '';
  const boardRoom = PRIME_MAX_CHARS - required;
  // A board line cut below a few words says nothing: then it goes.
  if (squeeze.cutBoard && board.length > boardRoom) board = boardRoom >= 12 ? fit(board, boardRoom) : '';
  let text = [head, `${storeHead}${board}${warning}`, status, fields, closing].join('\n');
  // The agent's own tasks first; the later sections keep their room.
  if (listed) text = withTasks(text, d.tasks, d.tasks.length, more, resumeKeep + freeKeep, 1, line);
  if (resume) text = withTasks(text + resumeHead, d.resumable, d.resumable.length, resumeMore, freeKeep, 1, resumeLine);
  if (free) text = withTasks(text + freeHead, d.unassigned, d.unassigned_total, freeMore, 0, PRIME_MIN_FREE, line);
  return { text, fits: required + board.length <= PRIME_MAX_CHARS };
}

// Human setup report: one line per file, diffs of replaced values, notes.
export function setupText(r: SetupResult): string {
  const lines: string[] = [];
  if (r.dry_run) lines.push('dry run: nothing was written');
  if (r.mode === 'install') lines.push(`store: ${r.store}`);
  for (const f of r.files) {
    lines.push(`${f.result} ${f.path}${f.scope === 'global' ? ' (global file)' : ''}`);
    for (const d of f.diff ?? []) lines.push(`    ${d}`);
  }
  for (const n of r.notes) lines.push(`next: ${n}`);
  return lines.join('\n');
}

// Human result of an import: counts, then one line per created and skipped file.
export function importText(d: ImportData): string {
  const verb = d.dry_run ? 'would create' : 'created';
  const lines = [`import ${d.format}${d.dry_run ? ' (dry run, nothing written)' : ''}: ${verb} ${d.created.length}, skipped ${d.skipped.length} (imported before)`];
  for (const c of d.created) lines.push(`  ${(c.id ?? 'new').padEnd(10)}  ${c.source}  ${c.title}`);
  for (const s of d.skipped) lines.push(`  ${s.id.padEnd(10)}  ${s.source}  (skipped: imported before)`);
  return lines.join('\n');
}
