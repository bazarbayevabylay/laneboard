// Read ops: get one task, list tasks, list events (task_get, task_list, task_events).
import { z } from 'zod';
import { LaneboardError, toLaneboardError } from '../errors.ts';
import { liveBoards, readRegistry } from '../boards.ts';
import { SCOPES, Timestamp } from '../schema.ts';
import type { ConfigT, EventType, Scope, StoreFileT, TaskT } from '../schema.ts';
import { canonicalPath, idNumber } from '../store.ts';
import { readActive, readBoth } from '../transact.ts';
import { checkActor, checkLabel, checkStatus, DEFAULT_LIST_LIMIT, deletedField, fieldInfo, finalStatuses, heldByEarlierSession, IdInput, lastComment, locate, normalizeId, parseInput, reviewers, reviewStatuses, suggestClosest, toTaskView, unique } from './common.ts';
import type { DeletedMark, FieldInfo, LastComment, OpContext, OpResult, TaskView } from './common.ts';
import { foreignTask, linkedTasks, missingTask } from './links.ts';
import type { LinkedTask } from './links.ts';
import { handedIn, nextAfterCheck, waitsForCheck, workStatusBeforeChecks } from './update.ts';
import type { ActorSource } from '../agent-name.ts';
import type { StoreRef } from '../store.ts';

export const GetInput = z.strictObject({
  id: IdInput,
  // Keep only the newest N events in the result.
  events: z.int().min(0).optional(),
});
export type GetInputT = z.infer<typeof GetInput>;

// Another task of the board as `get` names it: its parent and its children (ADR §25).
export interface TaskRef {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  archived: boolean;
}

// `get` result: the task, its parent (null: none, or the id names no task), its children in id order, from both files, and where each
// task link stands, on this board or another one (ADR §30). Write replies and --full have none of them (they map the task alone).
export interface TaskDetail extends TaskView {
  parent_task: TaskRef | null;
  children: TaskRef[];
  linked_tasks: LinkedTask[];
}

// Explicit mapping of a task to a TaskRef.
function toTaskRef(task: TaskT, archived: boolean): TaskRef {
  return { id: task.id, title: task.title, status: task.status, assignee: task.assignee, archived };
}

// Get one task from active or archive (both files, read under the lock), with its parent and children; the boards of its links to other
// boards are read after this board's lock is released (one lock at a time).
export async function getTask(ctx: OpContext, input: GetInputT): Promise<OpResult<TaskDetail>> {
  const p = parseInput(GetInput, input);
  const warnings: string[] = [];
  const view = await readBoth(ctx.store, { lockWaitMs: ctx.lockWaitMs, onLockWait: ctx.onLockWait, warnings });
  const id = normalizeId(p.id, view.config.prefix);
  const found = locate(view, id);
  if (!found) throw missingTask(ctx, id, view.config.prefix, 'read');
  const parent = found.task.parent === undefined ? undefined : locate(view, found.task.parent);
  const children = [...view.active.tasks.map((t) => ({ t, archived: false })), ...view.archive.tasks.map((t) => ({ t, archived: true }))]
    .filter(({ t }) => t.parent === id)
    .sort((a, b) => idNumber(a.t.id) - idNumber(b.t.id))
    .map(({ t, archived }) => toTaskRef(t, archived));
  const linked = await linkedTasks(ctx, found.task, view);
  const data: TaskDetail = { ...toTaskView(found.task, found.archived, p.events), parent_task: parent ? toTaskRef(parent.task, parent.archived) : null, children, linked_tasks: linked };
  return { data, warnings };
}

export const ListInput = z.strictObject({
  status: z.array(z.string()).optional(),
  assignee: z.string().optional(),
  unassigned: z.boolean().optional(),
  labels: z.array(z.string()).optional(),
  text: z.string().min(1).optional(),
  // Direct children of this task (ADR §25); with all_boards the id's prefix picks the board (a parent is always on its child's board).
  parent: IdInput.optional(),
  // Every board of this machine (the registry under HOME), the current one first; not with --board (ADR §29).
  all_boards: z.boolean().optional(),
  // Only tasks not in the final status of their board.
  open: z.boolean().optional(),
  scope: z.enum(SCOPES).optional(),
  limit: z.int().min(1).optional(),
  offset: z.int().min(0).optional(),
});
export type ListInputT = z.infer<typeof ListInput>;

export interface ListItem {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  labels: string[];
  // Id of the parent task; null for a top-level task.
  parent: string | null;
  // The newest comment as one line (ADR §28); null without comments.
  last_comment: LastComment | null;
  updated_at: string;
  // Who changed the task last (the assignee may be empty or someone else).
  updated_by: string;
  rev: number;
  archived: boolean;
  // Only on a tombstone: when and by whom the task was deleted.
  deleted?: DeletedMark;
}

// A row of list (CLI list --json, MCP task_list): the list item plus the marks of a view card (ADR §28, workMarks), so an orchestrator
// reads its queue (handed in, stale) from list and MCP, not only from the text of prime (review orchestrator F5). Archived: all false.
export interface ListEntry extends ListItem {
  handed_in: boolean;
  in_work: boolean;
  stale: boolean;
}

// A board an all-boards list read, or could not read (`problem`: why; its tasks are not in the list).
export interface ListBoard {
  prefix: string;
  name: string | null;
  path: string;
  problem: string | null;
}

export interface ListResult {
  items: ListEntry[];
  scope: Scope;
  limit: number;
  offset: number;
  total: number;
  // Only with all_boards: every board of the machine, the current one first.
  boards?: ListBoard[];
}

// The page size of list and events: the given limit, else DEFAULT_LIST_LIMIT lowered to the board's limits.list_limit_max (a board
// whose maximum is under 20 still lists without --limit; review lifecycle F13).
function pageLimit(config: ConfigT, given: number | undefined): number {
  return given ?? Math.min(DEFAULT_LIST_LIMIT, config.limits.list_limit_max);
}

// limit must not exceed config.limits.list_limit_max.
function checkLimit(config: ConfigT, limit: number): void {
  const max = config.limits.list_limit_max;
  if (limit > max) {
    throw new LaneboardError('INVALID_VALUE', `limit ${limit} is over limits.list_limit_max (${max})`, {
      input: { field: 'limit', value: String(limit), suggestion: String(max) },
    });
  }
}

// Tasks of the requested scope, each tagged with `archived`.
async function scopedTasks(ctx: OpContext, scope: Scope, warnings: string[]): Promise<{ config: ConfigT; tasks: Array<{ task: TaskT; archived: boolean }> }> {
  const tag = (file: StoreFileT, archived: boolean) => file.tasks.map((task) => ({ task, archived }));
  if (scope === 'active') {
    // Single-file read: lock-free (W7).
    const { config, active } = readActive(ctx.store, { warnings });
    return { config, tasks: tag(active, false) };
  }
  const view = await readBoth(ctx.store, { lockWaitMs: ctx.lockWaitMs, onLockWait: ctx.onLockWait, warnings });
  const tasks = scope === 'archive' ? tag(view.archive, true) : [...tag(view.active, false), ...tag(view.archive, true)];
  return { config: view.config, tasks };
}

// Newest first by updated_at, then by id number, then by id (tasks of several boards: stable pages).
function byUpdatedDesc(a: TaskT, b: TaskT): number {
  if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
  return idNumber(b.id) - idNumber(a.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

interface TaskFilter {
  status?: string[];
  assignee?: string;
  unassigned?: boolean;
  labels?: string[];
  text?: string;
  parent?: string;
  // Only tasks not in `finals` (the final status of the task's board).
  open?: boolean;
  finals?: readonly string[];
}

// One filter for list and view: status, open (not final), assignee (or none), every label, text in id/title/description/labels (any
// case), parent.
function taskMatches(task: TaskT, f: TaskFilter): boolean {
  if (f.status?.length && !f.status.includes(task.status)) return false;
  if (f.open && (f.finals ?? []).includes(task.status)) return false;
  if (f.parent !== undefined && task.parent !== f.parent) return false;
  if (f.assignee !== undefined && task.assignee !== f.assignee) return false;
  if (f.unassigned && task.assignee !== null) return false;
  if (f.labels?.length && !f.labels.every((l) => task.labels.includes(l))) return false;
  if (f.text !== undefined) {
    const haystack = [task.id, task.title, task.description, ...task.labels].join('\n').toLowerCase();
    if (!haystack.includes(f.text.toLowerCase())) return false;
  }
  return true;
}

// The context of list: all_boards also runs where no board is found (a folder outside every project: the orchestrator's root, where
// `prime --all-boards` points to it; review S5b MINOR 4), so its store is optional there.
export type ListContext = Omit<OpContext, 'store'> & { store?: StoreRef };

// List tasks with filters; the envelope always states scope, limit, offset and total.
export async function listTasks(ctx: ListContext, input: ListInputT): Promise<OpResult<ListResult>> {
  const p = parseInput(ListInput, input);
  if (p.assignee !== undefined && p.unassigned) throw new LaneboardError('USAGE', 'assignee and unassigned cannot be combined', { edit: { drop: [{ name: 'unassigned' }] } });
  if (p.assignee !== undefined) checkActor(p.assignee, 'assignee');
  (p.labels ?? []).forEach(checkLabel);
  const scope = p.scope ?? 'active';
  const offset = p.offset ?? 0;
  if (p.all_boards) return listAllBoards(ctx, p, scope, offset);
  if (ctx.store === undefined) throw new LaneboardError('STORE_NOT_FOUND', 'list reads one board, and none was given; only all_boards lists without one');
  const own: OpContext = { ...ctx, store: ctx.store };
  const warnings: string[] = [];
  const { config, tasks } = await scopedTasks(own, scope, warnings);
  (p.status ?? []).forEach((s) => checkStatus(config, s));
  const limit = pageLimit(config, p.limit);
  checkLimit(config, limit);
  const parent = p.parent === undefined ? undefined : normalizeId(p.parent, config.prefix, 'parent');
  // A parent is on its children's board: an id of another board names it, with the same list there (ADR §30; review S5b NIT).
  const elsewhere = parent === undefined ? undefined : foreignTask(own, parent, config.prefix, 'read');
  if (elsewhere) throw elsewhere;
  const finals = finalStatuses(config.statuses);
  const matches = tasks.filter(({ task }) => taskMatches(task, { ...p, parent, finals }));
  matches.sort((a, b) => byUpdatedDesc(a.task, b.task));
  const nowMs = Date.now();
  const items = matches.slice(offset, offset + limit).map(({ task, archived }) => toListEntry(task, archived, config, nowMs));
  return { data: { items, scope, limit, offset, total: matches.length }, warnings };
}

// all_boards needs the machine registry: HOME is where it lives (the CLI fix sets it before the command, ADR §23).
function needHome(ctx: ListContext): string {
  if (ctx.home !== undefined) return ctx.home;
  throw new LaneboardError('USAGE', 'all_boards reads the board registry of this machine (<HOME>/.laneboard/boards.json), and HOME is not set', {
    fix: 'set HOME to your home directory and run the same command again',
    edit: { env: 'HOME=<your home directory>' },
  });
}

// A status no board of the list knows: UNKNOWN_STATUS with the statuses of every board read as `allowed`.
function checkStatusOfBoards(statuses: readonly string[], status: string): void {
  if (statuses.includes(status)) return;
  const suggestion = suggestClosest(status, statuses);
  throw new LaneboardError('UNKNOWN_STATUS', `"${status}" is not a configured status of any board`, {
    allowed: [...statuses],
    input: suggestion ? { field: 'status', value: status, suggestion } : { field: 'status', value: status },
    fix: suggestion ? `use status ${suggestion}` : 'use a status from `allowed`',
  });
}

// list with all_boards (ADR §29): each live board read on its own, one after another (never two locks at once), filtered by the same
// taskMatches, merged newest update first and paged over the merge. A board that cannot be read is skipped with a warning (reads fail
// open); the first board read sets the limit check. Without a current store (no board where it runs) only the registry's boards are read.
async function listAllBoards(ctx: ListContext, p: ListInputT, scope: Scope, offset: number): Promise<OpResult<ListResult>> {
  if (ctx.store?.found === 'board') {
    throw new LaneboardError('USAGE', 'all_boards reads every board of this machine; --board opens one board: pass one of them', { edit: { drop: [{ name: 'board' }] } });
  }
  const home = needHome(ctx);
  const warnings: string[] = [];
  const { boards, missing } = liveBoards(home, ctx.store);
  const read: Array<{ config: ConfigT; tasks: Array<{ task: TaskT; archived: boolean }> }> = [];
  const rows: ListBoard[] = [];
  for (const b of boards) {
    try {
      const r = await scopedTasks({ ...ctx, store: b.store }, scope, warnings);
      read.push(r);
      rows.push({ prefix: r.config.prefix, name: r.config.name ?? null, path: b.store.dir, problem: null });
    } catch (err) {
      const problem = toLaneboardError(err).message;
      rows.push({ prefix: b.prefix, name: b.name, path: b.store.dir, problem });
      warnings.push(`board ${b.prefix} (${b.store.dir}) skipped: ${problem}`);
    }
  }
  rows.push(...missing.map((m) => ({ prefix: m.prefix, name: m.name, path: m.path, problem: m.problem })));
  const known = unique(read.flatMap((r) => r.config.statuses));
  (p.status ?? []).forEach((s) => checkStatusOfBoards(known, s));
  const first = read[0];
  const limit = first ? pageLimit(first.config, p.limit) : (p.limit ?? DEFAULT_LIST_LIMIT);
  if (first) checkLimit(first.config, limit);
  // A task's parent is on its own board, so the id alone picks the board.
  const parent = p.parent === undefined ? undefined : normalizeId(p.parent, first?.config.prefix ?? 'LB', 'parent');
  // Each task keeps its board's config: the marks (workMarks) read its statuses.
  const matches = read.flatMap((r) => r.tasks.filter(({ task }) => taskMatches(task, { ...p, parent, finals: finalStatuses(r.config.statuses) })).map((t) => ({ ...t, config: r.config })));
  matches.sort((a, b) => byUpdatedDesc(a.task, b.task));
  const nowMs = Date.now();
  const items = matches.slice(offset, offset + limit).map(({ task, archived, config }) => toListEntry(task, archived, config, nowMs));
  return { data: { items, scope, limit, offset, total: matches.length, boards: rows }, warnings };
}

// Explicit mapping of a task to a list item.
function toListItem(task: TaskT, archived: boolean): ListItem {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    assignee: task.assignee,
    labels: [...task.labels],
    parent: task.parent ?? null,
    last_comment: lastComment(task),
    updated_at: task.updated_at,
    updated_by: task.updated_by,
    rev: task.rev,
    archived,
    ...deletedField(task, archived),
  };
}

// Explicit mapping of a task to a list row: the list item, then its marks (an archived task is neither handed in nor in work).
function toListEntry(task: TaskT, archived: boolean, config: ConfigT, nowMs: number): ListEntry {
  const marks = archived ? { handed_in: false, in_work: false, stale: false } : workMarks(task, config, nowMs);
  return { ...toListItem(task, archived), handed_in: marks.handed_in, in_work: marks.in_work, stale: marks.stale };
}

export const EventsInput = z.strictObject({
  task: IdInput.optional(),
  // Only events strictly after this time.
  since: Timestamp.optional(),
  scope: z.enum(SCOPES).optional(),
  limit: z.int().min(1).optional(),
});
export type EventsInputT = z.infer<typeof EventsInput>;

export interface EventItem {
  task_id: string;
  at: string;
  actor: string;
  // explicit or the session's default name; null when not recorded (older events, imported history).
  actor_source: ActorSource | null;
  type: EventType;
  data: Record<string, unknown>;
}

export interface EventsResult {
  items: EventItem[];
  scope: Scope;
  limit: number;
  total: number;
}

// Event feed, newest first: one task (searched in both files) or every task of a scope.
export async function listEvents(ctx: OpContext, input: EventsInputT): Promise<OpResult<EventsResult>> {
  const p = parseInput(EventsInput, input);
  const scope = p.scope ?? 'active';
  const warnings: string[] = [];
  let config: ConfigT;
  let tasks: TaskT[];
  if (p.task !== undefined) {
    const view = await readBoth(ctx.store, { lockWaitMs: ctx.lockWaitMs, onLockWait: ctx.onLockWait, warnings });
    config = view.config;
    const id = normalizeId(p.task, config.prefix, 'task');
    const found = locate(view, id);
    if (!found) throw missingTask(ctx, id, config.prefix, 'read');
    tasks = [found.task];
  } else {
    const scoped = await scopedTasks(ctx, scope, warnings);
    config = scoped.config;
    tasks = scoped.tasks.map((t) => t.task);
  }
  const limit = pageLimit(config, p.limit);
  checkLimit(config, limit);
  // Times compare as instants, not as text: 18:52:52.215Z is after 18:52:52Z although '.' sorts before 'Z' (review failures F8).
  const since = p.since === undefined ? undefined : Date.parse(p.since);
  const all: Array<EventItem & { seq: number; ms: number }> = [];
  let seq = 0;
  for (const task of tasks) {
    for (const e of task.events) {
      const ms = Date.parse(e.at);
      if (since !== undefined && !(ms > since)) continue;
      all.push({ task_id: task.id, at: e.at, actor: e.actor, actor_source: e.actor_source ?? null, type: e.type, data: e.data, seq: seq++, ms });
    }
  }
  all.sort((a, b) => (a.ms !== b.ms ? b.ms - a.ms : b.seq - a.seq));
  const items = all.slice(0, limit).map((e) => ({ task_id: e.task_id, at: e.at, actor: e.actor, actor_source: e.actor_source, type: e.type, data: e.data }));
  return { data: { items, scope, limit, total: all.length }, warnings };
}

export const SummaryInput = z.strictObject({
  // Whose active tasks to list; without it only the counts per status.
  assignee: z.string().optional(),
  // The session default name base of `assignee` (agent-name.ts): list unfinished tasks of its other sessions too.
  session_base: z.string().optional(),
});
export type SummaryInputT = z.infer<typeof SummaryInput>;

export interface SummaryResult {
  // Id prefix of this store (shown so an agent sees whose store it writes to).
  prefix: string;
  // Board name and description from config (null for stores made before they existed).
  name: string | null;
  description: string | null;
  // Active tasks per configured status (in config order), then statuses no longer in config.
  statuses: Array<{ status: string; count: number }>;
  // The first configured status: where new tasks start.
  first_status: string;
  // The last configured status: work there is done.
  final_status: string;
  // Configured statuses that are not final (own, free and resumable tasks are in one of them).
  open_statuses: string[];
  // Declared fields with type, description and an example.
  fields: Record<string, FieldInfo>;
  assignee: string | null;
  // Active tasks of `assignee` in a configured status that is not final, newest update first (empty without an assignee); finished ones stay on the
  // board until archived, but they are no work of the agent (LB-10).
  assigned: ListItem[];
  // Active tasks not in the final status that are assigned to `assignee` (without one: to anybody) - work in progress.
  in_progress: number;
  // Free work: active tasks without an assignee, not in the final status; by priority (when declared), then newest update;
  // at most SUMMARY_UNASSIGNED_MAX of them, `unassigned_total` counts all.
  unassigned: ListItem[];
  unassigned_total: number;
  // Unfinished tasks of other sessions of `session_base` (the agent's own work before /clear, or a parallel session's) that their holder
  // took under its session default name (heldByEarlierSession), newest update first, at most SUMMARY_RESUMABLE_MAX; empty without `session_base`.
  resumable: ListItem[];
  // Is this store in the machine registry (<home>/.laneboard/boards.json, where init and setup add a board)? null without a home in the
  // context (cannot tell). A cloned repository's committed .laneboard is not: the SessionStart hook shows none of its texts (review security F4).
  registered: boolean | null;
  // Only on a board with checks or create_by (config@2, P1/P2; a board without them answers as before): who checks and who creates.
  roles?: SummaryRoles;
}

// The roles of a board for prime (S6m, P1/P2, B-U6): an agent of somebody else's flow reads from here what it may do.
export interface SummaryRoles {
  // The check statuses in order (config review.statuses); empty without checks.
  checks: string[];
  // Who checks (config review.by); empty: anybody but the author of the work.
  checkers: string[];
  // The status work goes on in before the first check (claim --status); null without checks or when it is the first status.
  work_status: string | null;
  // Who creates tasks (config create_by); null: everybody.
  creators: string[] | null;
  // May `assignee` create tasks (no create_by, or a name in it); false without a name on a board with create_by.
  can_create: boolean;
  // Tasks waiting in a check that `assignee` may make (waitsForCheck), oldest update first, at most SUMMARY_WAITING_MAX; `waiting_total` counts all.
  // `next_status`: what the checker's finish names to pass it (S6w I2: finish --status <next_status>, the next check or the final status).
  waiting: Array<ListItem & { next_status: string }>;
  waiting_total: number;
  // Each task of `assigned` with a comment by another name: the newest such comment (a checker's reason to return it, B-U6).
  feedback: Array<{ id: string; comment: LastComment }>;
}

// How many tasks waiting for the agent's check the summary lists (the rest: list --json, handed_in).
export const SUMMARY_WAITING_MAX = 5;

// The newest comment of `task` written by a name other than `actor`, as lastComment shows a comment; null without one.
function otherComment(task: TaskT, actor: string): LastComment | null {
  const others = { ...task, events: task.events.filter((e) => e.type !== 'commented' || e.actor !== actor) };
  return lastComment(others);
}

// The roles of the board (SummaryRoles) for `assignee`, or undefined on a board without checks and create_by (as before, ADR §22).
function summaryRoles(config: ConfigT, tasks: ReadonlyArray<{ task: TaskT; archived: boolean }>, assigned: readonly TaskT[], assignee: string | undefined): SummaryRoles | undefined {
  const checks = reviewStatuses(config);
  if (checks.length === 0 && config.create_by === undefined) return undefined;
  const waiting = assignee === undefined ? [] : tasks.filter(({ task }) => waitsForCheck(config, task, assignee));
  waiting.sort((a, b) => -byUpdatedDesc(a.task, b.task));
  const feedback: SummaryRoles['feedback'] = [];
  for (const task of assigned) {
    const comment = checks.length === 0 || assignee === undefined ? null : otherComment(task, assignee);
    if (comment !== null) feedback.push({ id: task.id, comment });
  }
  return {
    checks,
    checkers: reviewers(config),
    work_status: workStatusBeforeChecks(config) ?? null,
    creators: config.create_by === undefined ? null : [...config.create_by],
    can_create: config.create_by === undefined || (assignee !== undefined && config.create_by.includes(assignee)),
    waiting: waiting.slice(0, SUMMARY_WAITING_MAX).map(({ task, archived }) => ({ ...toListItem(task, archived), next_status: nextAfterCheck(config, task.status) })),
    waiting_total: waiting.length,
    feedback,
  };
}

// Is the store at `dir` in the machine registry under `home` (by canonicalPath, as liveBoards)? null without `home`. A registry that
// cannot be read counts as "not registered" (the hook then shows no board texts) with a warning that names it: prime itself still runs.
// Exported for prime --hook: a store that fails to load is checked too, since its error message may repeat its texts (review S6i MAJOR 1).
export function inRegistry(home: string | undefined, dir: string, warnings: string[]): boolean | null {
  if (home === undefined) return null;
  try {
    const own = canonicalPath(dir);
    return readRegistry(home).some((e) => canonicalPath(e.path) === own);
  } catch (raw) {
    const err = toLaneboardError(raw);
    warnings.push(`the board registry cannot be read, so this board counts as not registered: ${err.message}; fix: ${err.fix}`);
    return false;
  }
}

// How many free tasks the summary lists (prime stays short; the rest: list --unassigned).
export const SUMMARY_UNASSIGNED_MAX = 10;
// How many tasks of earlier sessions the summary lists (newest first; older ones are rarely the work a session resumes).
export const SUMMARY_RESUMABLE_MAX = 5;

// Session summary for `prime`: counts per status and the active tasks of one assignee (active.json only, lock-free).
export async function taskSummary(ctx: OpContext, input: SummaryInputT): Promise<OpResult<SummaryResult>> {
  const p = parseInput(SummaryInput, input);
  if (p.assignee !== undefined) checkActor(p.assignee, 'assignee');
  const warnings: string[] = [];
  const { config, tasks } = await scopedTasks(ctx, 'active', warnings);
  const counts = new Map<string, number>(config.statuses.map((st) => [st, 0]));
  for (const { task } of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  const finalStatus = config.statuses.at(-1) ?? '';
  // The agent's own, free and resumable work is in a configured status that is not final, so `list --assignee <name> --status
  // <open>...` and `list --unassigned --status <open>...` (the footers of prime) find the same tasks.
  const open = config.statuses.filter((st) => !finalStatuses(config.statuses).includes(st));
  const assigned = p.assignee === undefined ? [] : tasks.filter(({ task }) => task.assignee === p.assignee && open.includes(task.status));
  assigned.sort((a, b) => byUpdatedDesc(a.task, b.task));
  const inProgress = tasks.filter(({ task }) => task.status !== finalStatus && task.assignee !== null && (p.assignee === undefined || task.assignee === p.assignee));
  const free = tasks.filter(({ task }) => task.assignee === null && open.includes(task.status));
  free.sort((a, b) => byPriority(config, a.task, b.task) || byUpdatedDesc(a.task, b.task));
  const resumable =
    p.assignee === undefined
      ? []
      : tasks.filter(({ task }) => open.includes(task.status) && heldByEarlierSession(task, p.session_base, p.assignee ?? ''));
  resumable.sort((a, b) => byUpdatedDesc(a.task, b.task));
  const roles = summaryRoles(config, tasks, assigned.map(({ task }) => task), p.assignee);
  return {
    data: {
      prefix: config.prefix,
      name: config.name ?? null,
      description: config.description ?? null,
      statuses: [...counts].map(([status, count]) => ({ status, count })),
      first_status: config.statuses[0] ?? '',
      final_status: finalStatus,
      open_statuses: open,
      fields: fieldInfo(config),
      assignee: p.assignee ?? null,
      assigned: assigned.map(({ task, archived }) => toListItem(task, archived)),
      in_progress: inProgress.length,
      unassigned: free.slice(0, SUMMARY_UNASSIGNED_MAX).map(({ task, archived }) => toListItem(task, archived)),
      unassigned_total: free.length,
      resumable: resumable.slice(0, SUMMARY_RESUMABLE_MAX).map(({ task, archived }) => toListItem(task, archived)),
      registered: inRegistry(ctx.home, ctx.store.dir, warnings),
      ...(roles === undefined ? {} : { roles }),
    },
    warnings,
  };
}

export const ViewInput = z.strictObject({
  assignee: z.string().optional(),
  labels: z.array(z.string()).optional(),
  text: z.string().min(1).optional(),
});
export type ViewInputT = z.infer<typeof ViewInput>;

// A card of the board (CLI view, the web board, the all-boards overview). Every mark is decided here, not by a UI (ADR §28, §31).
export interface ViewCard {
  id: string;
  title: string;
  assignee: string | null;
  labels: string[];
  // When the task entered its current status (its last status event, else its creation).
  status_since: string;
  rev: number;
  // The newest comment as one line; null without comments.
  last_comment: LastComment | null;
  // Id of the parent task on this board; null for a top-level task.
  parent: string | null;
  // Children in active.json: how many, and how many of them are in the final status.
  children: { total: number; final: number };
  // Last change of the task (every event moves it).
  updated_at: string;
  // Awaiting acceptance: its assignee handed it in with finish (handedIn).
  handed_in: boolean;
  // Somebody works on it: assigned, neither in the first configured status nor in the final one, not handed in.
  in_work: boolean;
  // In work with no change for longer than STALE_AFTER_MS.
  stale: boolean;
}

export interface ViewResult {
  name: string | null;
  description: string | null;
  prefix: string;
  // Columns in config order, then statuses no longer in config (`known: false`); cards by priority, then newest update first (the final
  // column: the newest VIEW_FINAL_MAX updates only, `more` counts the rest; other columns: `more` 0).
  columns: Array<{ status: string; known: boolean; cards: ViewCard[]; more: number }>;
  // Active tasks (not in the final status) after the filters / in total (LB-10: finished ones wait for archive, they are not active).
  shown: number;
  total: number;
  // The final status and its tasks after the filters / in total.
  final_status: string;
  final_shown: number;
  final_total: number;
}

// How many tasks of the final status the view lists (newest update first); the rest: list --status <final> (LB-10).
export const VIEW_FINAL_MAX = 5;

// A task in work with no change for this long is stale (owner's number, ADR §28): 4 hours.
export const STALE_AFTER_MS = 4 * 60 * 60 * 1000;

// The attention marks of a task (ADR §28), one rule for view cards, the all-boards overview and list rows: handed in (handedIn); in work =
// assigned, neither in the first configured status nor in the final one, not handed in; stale = in work and unchanged for STALE_AFTER_MS.
function workMarks(task: TaskT, config: ConfigT, nowMs: number): { handed_in: boolean; in_work: boolean; stale: boolean } {
  const finals = finalStatuses(config.statuses);
  const handed = handedIn(task);
  const inWork = task.assignee !== null && task.status !== config.statuses[0] && !finals.includes(task.status) && !handed;
  return { handed_in: handed, in_work: inWork, stale: inWork && nowMs - Date.parse(task.updated_at) > STALE_AFTER_MS };
}

// Explicit mapping of a task to a card; `children`: counts per parent id in active.json, `nowMs`: the clock of this view.
function toViewCard(task: TaskT, config: ConfigT, children: ReadonlyMap<string, { total: number; final: number }>, nowMs: number): ViewCard {
  const marks = workMarks(task, config, nowMs);
  return {
    id: task.id,
    title: task.title,
    assignee: task.assignee,
    labels: [...task.labels],
    status_since: statusSince(task),
    rev: task.rev,
    last_comment: lastComment(task),
    parent: task.parent ?? null,
    children: { ...(children.get(task.id) ?? { total: 0, final: 0 }) },
    updated_at: task.updated_at,
    handed_in: marks.handed_in,
    in_work: marks.in_work,
    stale: marks.stale,
  };
}

// Children per parent id among `tasks`: how many, and how many are in a final status.
function childCounts(tasks: readonly TaskT[], finals: readonly string[]): Map<string, { total: number; final: number }> {
  const counts = new Map<string, { total: number; final: number }>();
  for (const t of tasks) {
    if (t.parent === undefined) continue;
    const c = counts.get(t.parent) ?? { total: 0, final: 0 };
    c.total += 1;
    if (finals.includes(t.status)) c.final += 1;
    counts.set(t.parent, c);
  }
  return counts;
}

// When a task entered its current status: the newest `status` event that set it, else created_at (also when older events were dropped).
function statusSince(task: TaskT): string {
  for (let i = task.events.length - 1; i >= 0; i--) {
    const e = task.events[i];
    if (e?.type === 'status' && (e.data as { to?: unknown }).to === task.status) return e.at;
  }
  return task.created_at;
}

// Order by the `priority` field (0 = highest; a task without it after those with one) when config declares it as a number, else 0.
function byPriority(config: ConfigT, a: TaskT, b: TaskT): number {
  if (config.fields.priority?.type !== 'number') return 0;
  const rank = (t: TaskT): number => (typeof t.fields.priority === 'number' ? t.fields.priority : Number.POSITIVE_INFINITY);
  const ra = rank(a);
  const rb = rank(b);
  return ra === rb ? 0 : ra < rb ? -1 : 1;
}

// Kanban view of the active tasks (CLI `laneboard view`, for people): columns by configured status, lock-free (active.json only);
// in a column by priority (when config declares it), then the latest update first.
export async function viewBoard(ctx: OpContext, input: ViewInputT): Promise<OpResult<ViewResult>> {
  const p = parseInput(ViewInput, input);
  if (p.assignee !== undefined) checkActor(p.assignee, 'assignee');
  (p.labels ?? []).forEach(checkLabel);
  const warnings: string[] = [];
  const { config, tasks } = await scopedTasks(ctx, 'active', warnings);
  const finalStatus = finalStatuses(config.statuses).join('');
  // The one clock of the view: staleness is decided here (the web board refetches, ADR §31).
  const nowMs = Date.now();
  const children = childCounts(tasks.map(({ task }) => task), finalStatuses(config.statuses));
  const shown = tasks.filter(({ task }) => taskMatches(task, p)).map(({ task }) => task);
  shown.sort((a, b) => byPriority(config, a, b) || byUpdatedDesc(a, b));
  const unknown = unique(shown.map((t) => t.status).filter((st) => !config.statuses.includes(st)));
  const columns = [...config.statuses.map((status) => ({ status, known: true })), ...unknown.map((status) => ({ status, known: false }))].map((c) => {
    const inColumn = shown.filter((t) => t.status === c.status);
    // Finished work: the newest updates, by time only (priority means nothing there); the same order as list --status <final>.
    if (c.status === finalStatus) inColumn.sort(byUpdatedDesc);
    const listed = c.status === finalStatus ? inColumn.slice(0, VIEW_FINAL_MAX) : inColumn;
    const cards = listed.map((t) => toViewCard(t, config, children, nowMs));
    return { ...c, cards, more: inColumn.length - listed.length };
  });
  const finalShown = shown.filter((t) => t.status === finalStatus).length;
  const finalTotal = tasks.filter(({ task }) => task.status === finalStatus).length;
  return {
    data: {
      name: config.name ?? null,
      description: config.description ?? null,
      prefix: config.prefix,
      columns,
      shown: shown.length - finalShown,
      total: tasks.length - finalTotal,
      final_status: finalStatus,
      final_shown: finalShown,
      final_total: finalTotal,
    },
    warnings,
  };
}

// A card of the all-boards overview: a view card with its status (the overview has no columns).
export interface OverviewCard extends ViewCard {
  status: string;
}

// One board of the all-boards overview (prime --all-boards, ADR §29): its active tasks per status and its cards not in the final
// status; `problem`: missing or unreadable (then no counts and no cards).
export interface OverviewBoard {
  prefix: string;
  name: string | null;
  path: string;
  current: boolean;
  problem: string | null;
  counts: Array<{ status: string; count: number }>;
  final_status: string;
  final_total: number;
  cards: OverviewCard[];
}

// Every board of the machine (registry under `home`) as viewBoard sees it, `current` first, read one after another (lock-free reads of
// active.json); a board that cannot be read is listed with its problem (reads fail open).
export async function boardsOverview(home: string, current?: StoreRef): Promise<OpResult<OverviewBoard[]>> {
  const warnings: string[] = [];
  const { boards, missing } = liveBoards(home, current);
  const out: OverviewBoard[] = [];
  const empty = { counts: [], final_status: '', final_total: 0, cards: [] };
  for (const b of boards) {
    try {
      const v = (await viewBoard({ store: b.store }, {})).data;
      out.push({
        prefix: v.prefix,
        name: v.name,
        path: b.store.dir,
        current: b.current,
        problem: null,
        counts: v.columns.map((c) => ({ status: c.status, count: c.cards.length + c.more })),
        final_status: v.final_status,
        final_total: v.final_total,
        cards: v.columns.filter((c) => c.status !== v.final_status).flatMap((c) => c.cards.map((card) => ({ status: c.status, ...card }))),
      });
    } catch (err) {
      out.push({ prefix: b.prefix, name: b.name, path: b.store.dir, current: b.current, problem: toLaneboardError(err).message, ...empty });
    }
  }
  out.push(...missing.map((m) => ({ prefix: m.prefix, name: m.name, path: m.path, current: false, problem: m.problem, ...empty })));
  return { data: out, warnings };
}
