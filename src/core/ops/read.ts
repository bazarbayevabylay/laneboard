// Read ops: get one task, list tasks, list events (task_get, task_list, task_events).
import { z } from 'zod';
import { LaneboardError } from '../errors.ts';
import { SCOPES, Timestamp } from '../schema.ts';
import type { ConfigT, EventType, Scope, StoreFileT, TaskT } from '../schema.ts';
import { idNumber } from '../store.ts';
import { readActive, readBoth } from '../transact.ts';
import { checkActor, checkLabel, checkStatus, DEFAULT_LIST_LIMIT, fieldInfo, finalStatuses, heldByEarlierSession, IdInput, locate, normalizeId, notFound, parseInput, toTaskView, unique } from './common.ts';
import type { FieldInfo, OpContext, OpResult, TaskView } from './common.ts';
import type { ActorSource } from '../agent-name.ts';

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

// `get` result: the task, its parent (null: none, or the id names no task) and its children in id order, from both files.
// Write replies and --full have neither (they map the task alone).
export interface TaskDetail extends TaskView {
  parent_task: TaskRef | null;
  children: TaskRef[];
}

// Explicit mapping of a task to a TaskRef.
function toTaskRef(task: TaskT, archived: boolean): TaskRef {
  return { id: task.id, title: task.title, status: task.status, assignee: task.assignee, archived };
}

// Get one task from active or archive (both files, read under the lock), with its parent and children.
export async function getTask(ctx: OpContext, input: GetInputT): Promise<OpResult<TaskDetail>> {
  const p = parseInput(GetInput, input);
  const warnings: string[] = [];
  const view = await readBoth(ctx.store, { lockWaitMs: ctx.lockWaitMs, warnings });
  const id = normalizeId(p.id, view.config.prefix);
  const found = locate(view, id);
  if (!found) throw notFound(id);
  const parent = found.task.parent === undefined ? undefined : locate(view, found.task.parent);
  const children = [...view.active.tasks.map((t) => ({ t, archived: false })), ...view.archive.tasks.map((t) => ({ t, archived: true }))]
    .filter(({ t }) => t.parent === id)
    .sort((a, b) => idNumber(a.t.id) - idNumber(b.t.id))
    .map(({ t, archived }) => toTaskRef(t, archived));
  const data: TaskDetail = { ...toTaskView(found.task, found.archived, p.events), parent_task: parent ? toTaskRef(parent.task, parent.archived) : null, children };
  return { data, warnings };
}

export const ListInput = z.strictObject({
  status: z.array(z.string()).optional(),
  assignee: z.string().optional(),
  unassigned: z.boolean().optional(),
  labels: z.array(z.string()).optional(),
  text: z.string().min(1).optional(),
  // Direct children of this task (ADR §25).
  parent: IdInput.optional(),
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
  updated_at: string;
  // Who changed the task last (the assignee may be empty or someone else).
  updated_by: string;
  rev: number;
  archived: boolean;
}

export interface ListResult {
  items: ListItem[];
  scope: Scope;
  limit: number;
  offset: number;
  total: number;
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
  const view = await readBoth(ctx.store, { lockWaitMs: ctx.lockWaitMs, warnings });
  const tasks = scope === 'archive' ? tag(view.archive, true) : [...tag(view.active, false), ...tag(view.archive, true)];
  return { config: view.config, tasks };
}

// Newest first by updated_at, then by id number (stable pages).
function byUpdatedDesc(a: TaskT, b: TaskT): number {
  if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
  return idNumber(b.id) - idNumber(a.id);
}

// One filter for list and view: status, assignee (or none), every label, text in id/title/description/labels (any case), parent.
function taskMatches(task: TaskT, f: { status?: string[]; assignee?: string; unassigned?: boolean; labels?: string[]; text?: string; parent?: string }): boolean {
  if (f.status?.length && !f.status.includes(task.status)) return false;
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

// List tasks with filters; the envelope always states scope, limit, offset and total.
export async function listTasks(ctx: OpContext, input: ListInputT): Promise<OpResult<ListResult>> {
  const p = parseInput(ListInput, input);
  if (p.assignee !== undefined && p.unassigned) throw new LaneboardError('USAGE', 'assignee and unassigned cannot be combined', { edit: { drop: [{ name: 'unassigned' }] } });
  if (p.assignee !== undefined) checkActor(p.assignee, 'assignee');
  (p.labels ?? []).forEach(checkLabel);
  const scope = p.scope ?? 'active';
  const limit = p.limit ?? DEFAULT_LIST_LIMIT;
  const offset = p.offset ?? 0;
  const warnings: string[] = [];
  const { config, tasks } = await scopedTasks(ctx, scope, warnings);
  (p.status ?? []).forEach((s) => checkStatus(config, s));
  checkLimit(config, limit);
  const parent = p.parent === undefined ? undefined : normalizeId(p.parent, config.prefix, 'parent');
  const matches = tasks.filter(({ task }) => taskMatches(task, { ...p, parent }));
  matches.sort((a, b) => byUpdatedDesc(a.task, b.task));
  const items = matches.slice(offset, offset + limit).map(({ task, archived }) => toListItem(task, archived));
  return { data: { items, scope, limit, offset, total: matches.length }, warnings };
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
    updated_at: task.updated_at,
    updated_by: task.updated_by,
    rev: task.rev,
    archived,
  };
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
  const limit = p.limit ?? DEFAULT_LIST_LIMIT;
  const warnings: string[] = [];
  let config: ConfigT;
  let tasks: TaskT[];
  if (p.task !== undefined) {
    const view = await readBoth(ctx.store, { lockWaitMs: ctx.lockWaitMs, warnings });
    config = view.config;
    const id = normalizeId(p.task, config.prefix, 'task');
    const found = locate(view, id);
    if (!found) throw notFound(id);
    tasks = [found.task];
  } else {
    const scoped = await scopedTasks(ctx, scope, warnings);
    config = scoped.config;
    tasks = scoped.tasks.map((t) => t.task);
  }
  checkLimit(config, limit);
  const all: Array<EventItem & { seq: number }> = [];
  let seq = 0;
  for (const task of tasks) {
    for (const e of task.events) {
      if (p.since !== undefined && !(e.at > p.since)) continue;
      all.push({ task_id: task.id, at: e.at, actor: e.actor, actor_source: e.actor_source ?? null, type: e.type, data: e.data, seq: seq++ });
    }
  }
  all.sort((a, b) => (a.at !== b.at ? (a.at < b.at ? 1 : -1) : b.seq - a.seq));
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

export interface ViewCard {
  id: string;
  title: string;
  assignee: string | null;
  labels: string[];
  // When the task entered its current status (its last status event, else its creation).
  status_since: string;
  rev: number;
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
  const shown = tasks.filter(({ task }) => taskMatches(task, p)).map(({ task }) => task);
  shown.sort((a, b) => byPriority(config, a, b) || byUpdatedDesc(a, b));
  const unknown = unique(shown.map((t) => t.status).filter((st) => !config.statuses.includes(st)));
  const columns = [...config.statuses.map((status) => ({ status, known: true })), ...unknown.map((status) => ({ status, known: false }))].map((c) => {
    const inColumn = shown.filter((t) => t.status === c.status);
    // Finished work: the newest updates, by time only (priority means nothing there); the same order as list --status <final>.
    if (c.status === finalStatus) inColumn.sort(byUpdatedDesc);
    const listed = c.status === finalStatus ? inColumn.slice(0, VIEW_FINAL_MAX) : inColumn;
    const cards = listed.map((t) => ({ id: t.id, title: t.title, assignee: t.assignee, labels: [...t.labels], status_since: statusSince(t), rev: t.rev }));
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
