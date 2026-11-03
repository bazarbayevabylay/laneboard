// Read ops: get one task, list tasks, list events (task_get, task_list, task_events).
import { z } from 'zod';
import { LaneboardError } from '../errors.ts';
import { SCOPES, Timestamp } from '../schema.ts';
import type { ConfigT, EventType, Scope, StoreFileT, TaskT } from '../schema.ts';
import { idNumber } from '../store.ts';
import { readActive, readBoth } from '../transact.ts';
import { checkActor, checkLabel, checkStatus, DEFAULT_LIST_LIMIT, IdInput, locate, normalizeId, notFound, parseInput, toTaskView } from './common.ts';
import type { OpContext, OpResult, TaskView } from './common.ts';

export const GetInput = z.strictObject({
  id: IdInput,
  // Keep only the newest N events in the result.
  events: z.int().min(0).optional(),
});
export type GetInputT = z.infer<typeof GetInput>;

// Get one task from active or archive (both files, read under the lock).
export async function getTask(ctx: OpContext, input: GetInputT): Promise<OpResult<TaskView>> {
  const p = parseInput(GetInput, input);
  const warnings: string[] = [];
  const view = await readBoth(ctx.store, { lockWaitMs: ctx.lockWaitMs, warnings });
  const id = normalizeId(p.id, view.config.prefix);
  const found = locate(view, id);
  if (!found) throw notFound(id);
  return { data: toTaskView(found.task, found.archived, p.events), warnings };
}

export const ListInput = z.strictObject({
  status: z.array(z.string()).optional(),
  assignee: z.string().optional(),
  unassigned: z.boolean().optional(),
  labels: z.array(z.string()).optional(),
  text: z.string().min(1).optional(),
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
  updated_at: string;
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

// List tasks with filters; the envelope always states scope, limit, offset and total.
export async function listTasks(ctx: OpContext, input: ListInputT): Promise<OpResult<ListResult>> {
  const p = parseInput(ListInput, input);
  if (p.assignee !== undefined && p.unassigned) throw new LaneboardError('USAGE', 'assignee and unassigned cannot be combined');
  if (p.assignee !== undefined) checkActor(p.assignee, 'assignee');
  (p.labels ?? []).forEach(checkLabel);
  const scope = p.scope ?? 'active';
  const limit = p.limit ?? DEFAULT_LIST_LIMIT;
  const offset = p.offset ?? 0;
  const warnings: string[] = [];
  const { config, tasks } = await scopedTasks(ctx, scope, warnings);
  (p.status ?? []).forEach((s) => checkStatus(config, s));
  checkLimit(config, limit);
  const text = p.text?.toLowerCase();
  const matches = tasks.filter(({ task }) => {
    if (p.status?.length && !p.status.includes(task.status)) return false;
    if (p.assignee !== undefined && task.assignee !== p.assignee) return false;
    if (p.unassigned && task.assignee !== null) return false;
    if (p.labels?.length && !p.labels.every((l) => task.labels.includes(l))) return false;
    if (text !== undefined) {
      const haystack = [task.id, task.title, task.description, ...task.labels].join('\n').toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  });
  matches.sort((a, b) => byUpdatedDesc(a.task, b.task));
  const items = matches.slice(offset, offset + limit).map(({ task, archived }) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    assignee: task.assignee,
    labels: [...task.labels],
    updated_at: task.updated_at,
    rev: task.rev,
    archived,
  }));
  return { data: { items, scope, limit, offset, total: matches.length }, warnings };
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
      all.push({ task_id: task.id, at: e.at, actor: e.actor, type: e.type, data: e.data, seq: seq++ });
    }
  }
  all.sort((a, b) => (a.at !== b.at ? (a.at < b.at ? 1 : -1) : b.seq - a.seq));
  const items = all.slice(0, limit).map((e) => ({ task_id: e.task_id, at: e.at, actor: e.actor, type: e.type, data: e.data }));
  return { data: { items, scope, limit, total: all.length }, warnings };
}
