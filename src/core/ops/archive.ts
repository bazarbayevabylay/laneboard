// Ops that move or remove tasks: archive, restore, delete (task_archive, task_restore, task_delete).
import { z } from 'zod';
import { LaneboardError } from '../errors.ts';
import { removeDir } from '../fsio.ts';
import type { StoreFileT, TaskT } from '../schema.ts';
import { readBoth, transact } from '../transact.ts';
import { attachmentDir } from './attach.ts';
import { actorSourceOf, addEvent, checkExpectedRev, checkStatus, IdInput, locate, normalizeId, notFound, parseInput, requireActor, RevInput, toTaskView, touch, txOptions, unique } from './common.ts';
import type { OpContext, OpResult, TaskView } from './common.ts';

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
    const view = await readBoth(ctx.store, { lockWaitMs: ctx.lockWaitMs, warnings });
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
          if (!found) throw notFound(id);
          if (found.archived) {
            throw new LaneboardError('TASK_ARCHIVED', `task ${id} is already archived`, { fix: `nothing to do; to see it: laneboard get ${id}` });
          }
          checkExpectedRev(found.task, false, p.expected_rev);
          return found.task;
        });
      } else {
        checkStatus(s.config, p.status ?? '');
        const before = cutoff(p.updated_before ?? '', new Date(s.now));
        tasks = s.active.tasks.filter((t) => t.status === p.status && t.updated_at < before);
      }
      for (const task of tasks) {
        touch(task, s.now, actor);
        task.archived_at = s.now;
        addEvent(task, s.config, s.now, actor, 'archived', {}, actorSourceOf(ctx));
        move(s.active, s.archive, task);
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
      if (!found) throw notFound(id);
      if (!found.archived) throw new LaneboardError('INVALID_VALUE', `task ${id} is not archived`, { input: { field: 'id', value: id }, fix: `nothing to do; to see it: laneboard get ${id}` });
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

// Hard delete from active or archive: the record, then its attachment directory; next_id is untouched (W9).
export async function deleteTask(ctx: OpContext, input: DeleteInputT): Promise<OpResult<{ id: string; deleted: true }>> {
  // A delete is a write and needs an actor, even though no event survives it.
  requireActor(ctx.actor);
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
      if (!found) throw notFound(id);
      checkExpectedRev(found.task, found.archived, p.expected_rev);
      found.file.tasks = found.file.tasks.filter((t) => t.id !== id);
      s.onCommit(() => removeDir(attachmentDir(ctx.store.dir, id)));
      return { id, deleted: true as const };
    },
    txOptions(ctx, warnings),
  );
  return { data, warnings };
}
