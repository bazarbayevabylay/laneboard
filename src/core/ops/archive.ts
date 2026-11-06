// Ops that move or remove tasks: archive, restore (task_archive, task_restore), delete (CLI only: people delete, agents do not).
import { z } from 'zod';
import { LaneboardError } from '../errors.ts';
import { removeDir } from '../fsio.ts';
import type { ActorSource } from '../agent-name.ts';
import type { StoreFileT, TaskEventT, TaskT } from '../schema.ts';
import { readBoth, transact } from '../transact.ts';
import { attachmentDir } from './attach.ts';
import {
  actorSourceOf,
  addEvent,
  checkExpectedRev,
  checkStatus,
  deletedMark,
  finalStatuses,
  IdInput,
  locate,
  normalizeId,
  openChildrenWarning,
  parseInput,
  requireActor,
  RevInput,
  toTaskView,
  touch,
  txOptions,
  unique,
} from './common.ts';
import type { DeletedMark, OpContext, OpResult, TaskView } from './common.ts';
import { missingTask } from './links.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export const ArchiveInput = z.strictObject({
  ids: z.array(IdInput).min(1).optional(),
  expected_rev: RevInput.optional(),
  // Bulk form: active tasks with this status ...
  status: z.string().min(1).optional(),
  // ... last updated more than N days ago (`14d`).
  updated_before: z.string().optional(),
  dry_run: z.boolean().optional(),
});
export type ArchiveInputT = z.infer<typeof ArchiveInput>;

export interface ArchiveResult {
  archived: Array<{ id: string; rev: number }>;
  dry_run: boolean;
}

// Move a task object between files.
function move(from: StoreFileT, to: StoreFileT, task: TaskT): void {
  from.tasks = from.tasks.filter((t) => t.id !== task.id);
  to.tasks.push(task);
}

// Parse `Nd` into a cutoff timestamp.
function cutoff(updatedBefore: string, now: Date): string {
  const m = /^([1-9][0-9]*)d$/.exec(updatedBefore);
  if (!m) {
    throw new LaneboardError('INVALID_VALUE', `updated_before "${updatedBefore}" must be a number of days like 14d`, {
      input: { field: 'updated_before', value: updatedBefore, format: '<days like 14d>' },
      fix: 'pass a whole number of days followed by d, e.g. 14d',
    });
  }
  return new Date(now.getTime() - Number(m[1]) * DAY_MS).toISOString();
}

// Warning for an archived task that is not finished and has an assignee: the work may still be going on.
function openTaskWarning(task: TaskT): string {
  return `${task.id} is ${task.status} (not a final status) and assigned to ${task.assignee}: archived anyway; to bring it back: laneboard restore ${task.id} --json`;
}

// Archive tasks by id (atomically, all or none) or in bulk by status and age; archive.json is written first (W6).
export async function archiveTasks(ctx: OpContext, input: ArchiveInputT): Promise<OpResult<ArchiveResult>> {
  const p = parseInput(ArchiveInput, input);
  const bulk = p.status !== undefined || p.updated_before !== undefined;
  // Each usage error says how to rebuild the caller's command (`edit`): the ids form keeps the ids, the bulk form gets its missing half.
  if (p.ids && bulk) {
    throw new LaneboardError('USAGE', 'pass task ids, or status with updated_before, not both', {
      edit: { drop: [{ name: 'status' }, { name: 'updated_before' }, { name: 'dry_run' }] },
    });
  }
  if (!p.ids && !bulk) throw new LaneboardError('USAGE', 'pass task ids, or status with updated_before', { edit: { args: ['<id>'] } });
  if (p.ids && p.dry_run) throw new LaneboardError('USAGE', 'dry_run is only for the bulk form (status + updated_before)', { edit: { drop: [{ name: 'dry_run' }] } });
  if (p.expected_rev !== undefined && p.ids?.length !== 1) {
    throw new LaneboardError('USAGE', 'expected_rev needs exactly one task id', { edit: { drop: [{ name: 'expected_rev' }] } });
  }
  if (bulk && (p.status === undefined || p.updated_before === undefined)) {
    const missing = p.status === undefined ? { name: 'status', value: '<status>' } : { name: 'updated_before', value: '<days like 14d>' };
    throw new LaneboardError('USAGE', 'the bulk form needs both status and updated_before', { edit: { add: [missing] } });
  }
  const warnings: string[] = [];

  if (p.dry_run) {
    const view = await readBoth(ctx.store, { lockWaitMs: ctx.lockWaitMs, onLockWait: ctx.onLockWait, warnings });
    checkStatus(view.config, p.status ?? '');
    const before = cutoff(p.updated_before ?? '', new Date());
    const archived = view.active.tasks.filter((t) => t.status === p.status && t.updated_at < before).map((t) => ({ id: t.id, rev: t.rev }));
    return { data: { archived, dry_run: true }, warnings };
  }

  const actor = requireActor(ctx.actor);
  const data = await transact(
    ctx.store,
    { files: ['active', 'archive'] },
    (s) => {
      let tasks: TaskT[];
      if (p.ids) {
        const ids = unique(p.ids.map((raw) => normalizeId(raw, s.config.prefix)));
        tasks = ids.map((id) => {
          const found = locate(s, id);
          if (!found) throw missingTask(ctx, id, s.config.prefix, 'write');
          if (found.archived) {
            throw new LaneboardError('TASK_ARCHIVED', `task ${id} is already archived`, { fix: `nothing to do; to see it: laneboard get ${id} --json` });
          }
          checkExpectedRev(found.task, false, p.expected_rev);
          return found.task;
        });
      } else {
        checkStatus(s.config, p.status ?? '');
        const before = cutoff(p.updated_before ?? '', new Date(s.now));
        tasks = s.active.tasks.filter((t) => t.status === p.status && t.updated_at < before);
      }
      // A task still open and held by someone, archived by id: archived as asked, with a word that names who holds it (LB-64.4).
      const finals = finalStatuses(s.config.statuses);
      if (p.ids) for (const task of tasks) if (task.assignee !== null && !finals.includes(task.status)) warnings.push(openTaskWarning(task));
      for (const task of tasks) {
        touch(task, s.now, actor);
        task.archived_at = s.now;
        // A deleted mark left on an active task (restored by 0.3.1, which keeps unknown keys) would turn it into a tombstone here (LB-64.5).
        delete (task as { deleted?: unknown }).deleted;
        addEvent(task, s.config, s.now, actor, 'archived', {}, actorSourceOf(ctx));
        move(s.active, s.archive, task);
      }
      // A parent archived while its children are still open: a warning, the children keep their parent (ADR §25, Q2).
      for (const task of tasks) {
        const open = openChildrenWarning(s.active, task.id, finalStatuses(s.config.statuses));
        if (open) warnings.push(open);
      }
      return { archived: tasks.map((t) => ({ id: t.id, rev: t.rev })), dry_run: false };
    },
    txOptions(ctx, warnings),
  );
  return { data, warnings };
}

export const RestoreInput = z.strictObject({ id: IdInput });
export type RestoreInputT = z.infer<typeof RestoreInput>;

// Move an archived task back to active; active.json is written first (W6).
export async function restoreTask(ctx: OpContext, input: RestoreInputT): Promise<OpResult<TaskView>> {
  const actor = requireActor(ctx.actor);
  const p = parseInput(RestoreInput, input);
  const warnings: string[] = [];
  const data = await transact(
    ctx.store,
    { files: ['active', 'archive'] },
    (s) => {
      const id = normalizeId(p.id, s.config.prefix);
      const found = locate(s, id);
      if (!found) throw missingTask(ctx, id, s.config.prefix, 'write');
      if (!found.archived) throw new LaneboardError('INVALID_VALUE', `task ${id} is not archived`, { input: { field: 'id', value: id }, fix: `nothing to do; to see it: laneboard get ${id} --json` });
      refuseDeleted(found.task);
      const task = found.task;
      touch(task, s.now, actor);
      delete task.archived_at;
      addEvent(task, s.config, s.now, actor, 'restored', {}, actorSourceOf(ctx));
      move(s.archive, s.active, task);
      return toTaskView(task, false);
    },
    txOptions(ctx, warnings),
  );
  return { data, warnings };
}

export const DeleteInput = z.strictObject({
  id: IdInput,
  // Must repeat the id exactly: deletion is permanent.
  confirm_id: z.string().min(1),
  expected_rev: RevInput.optional(),
});
export type DeleteInputT = z.infer<typeof DeleteInput>;

// A deleted task cannot come back or be deleted again: what it held is gone, only its trace stays.
function refuseDeleted(task: TaskT): void {
  const mark = deletedMark(task);
  if (!mark) return;
  throw new LaneboardError('INVALID_VALUE', `${task.id} was deleted at ${mark.at} by ${mark.by}`, {
    input: { field: 'id', value: task.id },
    fix: `nothing to do: the archive keeps only its title and who deleted it; to see it: laneboard get ${task.id} --json`,
  });
}

// The trace a delete leaves in archive.json (ADR §6, Q1): id, title, status, assignee and dates stay; description, labels, links, fields,
// attachments and the history go (events_dropped counts them); one `archived {deleted: true}` event and `deleted {at, by}` say who and when.
function tombstone(task: TaskT, at: string, actor: string, source: ActorSource): TaskT & { deleted: DeletedMark } {
  const event: TaskEventT = { at, actor, actor_source: source, type: 'archived', data: { deleted: true } };
  return {
    id: task.id,
    rev: task.rev + 1,
    title: task.title,
    description: '',
    status: task.status,
    assignee: task.assignee,
    labels: [],
    links: [],
    fields: {},
    attachments: [],
    events: [event],
    events_dropped: task.events_dropped + task.events.length,
    created_at: task.created_at,
    created_by: task.created_by,
    updated_at: at,
    updated_by: actor,
    archived_at: at,
    deleted: { at, by: actor },
  };
}

// Delete from active or archive: the task is replaced by its tombstone in archive.json (one write of both files, archive.json first,
// W6), then its attachment directory is removed; next_id is untouched (W9). Its children (in either file) lose `parent` in the same
// write, each with an `updated {parent: [id, null]}` event, so a parent always names a live task (ADR §25).
export async function deleteTask(ctx: OpContext, input: DeleteInputT): Promise<OpResult<{ id: string; deleted: true }>> {
  // A delete is a write and needs an actor: the tombstone records who deleted the task.
  const actor = requireActor(ctx.actor);
  const p = parseInput(DeleteInput, input);
  const warnings: string[] = [];
  const data = await transact(
    ctx.store,
    { files: ['active', 'archive'] },
    (s) => {
      const id = normalizeId(p.id, s.config.prefix);
      if (p.confirm_id !== id) {
        throw new LaneboardError('INVALID_VALUE', `confirm_id "${p.confirm_id}" must repeat the id exactly: ${id}`, {
          input: { field: 'confirm_id', value: p.confirm_id, suggestion: id },
          fix: `confirm with the exact id: ${id}`,
        });
      }
      const found = locate(s, id);
      if (!found) throw missingTask(ctx, id, s.config.prefix, 'write');
      // A tombstone is archived; an active task with the mark (restored by 0.3.1, which keeps unknown keys) is deleted as usual.
      if (found.archived) refuseDeleted(found.task);
      checkExpectedRev(found.task, found.archived, p.expected_rev);
      found.file.tasks = found.file.tasks.filter((t) => t.id !== id);
      s.archive.tasks.push(tombstone(found.task, s.now, actor, actorSourceOf(ctx)));
      for (const child of [...s.active.tasks, ...s.archive.tasks].filter((t) => t.parent === id)) {
        touch(child, s.now, actor);
        delete child.parent;
        addEvent(child, s.config, s.now, actor, 'updated', { parent: [id, null] }, actorSourceOf(ctx));
      }
      s.onCommit(() => removeDir(attachmentDir(ctx.store.dir, id)));
      return { id, deleted: true as const };
    },
    txOptions(ctx, warnings),
  );
  return { data, warnings };
}
