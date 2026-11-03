// Ops that change an active task: update, claim, comment (task_update, task_claim, task_comment).
import { z } from 'zod';
import { LaneboardError } from '../errors.ts';
import type { LinkT } from '../schema.ts';
import { transact } from '../transact.ts';
import {
  addEvent,
  checkActor,
  checkExpectedRev,
  checkFields,
  checkLabel,
  checkStatus,
  checkTaskLinks,
  DescriptionInput,
  IdInput,
  LinkInput,
  linkKey,
  MAX_COMMENT_CHARS,
  normalizeId,
  parseFieldArgs,
  parseInput,
  requireActiveTask,
  requireActor,
  RevInput,
  TitleInput,
  toTaskView,
  touch,
  txOptions,
  unique,
} from './common.ts';
import type { OpContext, OpResult, TaskView } from './common.ts';

export const UpdateInput = z.strictObject({
  id: IdInput,
  title: TitleInput.optional(),
  description: DescriptionInput.optional(),
  status: z.string().min(1).optional(),
  // null unassigns.
  assignee: z.string().nullable().optional(),
  add_labels: z.array(z.string()).optional(),
  remove_labels: z.array(z.string()).optional(),
  add_links: z.array(LinkInput).optional(),
  remove_links: z.array(LinkInput).optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  // CLI form `key=value`, converted with the declared field types.
  field_args: z.array(z.string()).optional(),
  unset_fields: z.array(z.string()).optional(),
  expected_rev: RevInput.optional(),
});
export type UpdateInputT = z.infer<typeof UpdateInput>;

const CHANGE_KEYS = ['title', 'description', 'status', 'assignee', 'add_labels', 'remove_labels', 'add_links', 'remove_links', 'fields', 'field_args', 'unset_fields'] as const;

// Same values, same order?
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Change fields of an active task; one `updated` event plus `status`/`assigned` events; no-op when values are equal.
export async function updateTask(ctx: OpContext, input: UpdateInputT): Promise<OpResult<TaskView>> {
  const actor = requireActor(ctx.actor);
  const p = parseInput(UpdateInput, input);
  if (!CHANGE_KEYS.some((k) => p[k] !== undefined)) {
    throw new LaneboardError('USAGE', 'nothing to change: pass at least one of title, description, status, assignee, labels, links, fields');
  }
  if (typeof p.assignee === 'string') checkActor(p.assignee, 'assignee');
  const addLabels = unique(p.add_labels ?? []);
  const removeLabels = unique(p.remove_labels ?? []);
  [...addLabels, ...removeLabels].forEach(checkLabel);
  const both = addLabels.find((l) => removeLabels.includes(l));
  if (both) throw new LaneboardError('USAGE', `label "${both}" is both added and removed`);
  const addLinks = unique(p.add_links ?? [], linkKey);
  const removeKeys = new Set((p.remove_links ?? []).map(linkKey));
  const warnings: string[] = [];
  const data = await transact(
    ctx.store,
    { files: ['active', 'archive'] },
    (s) => {
      const id = normalizeId(p.id, s.config.prefix);
      if (p.status !== undefined) checkStatus(s.config, p.status);
      const setFields = { ...(p.fields ?? {}), ...parseFieldArgs(s.config, p.field_args ?? []) };
      checkFields(s.config, setFields);
      const unset = unique(p.unset_fields ?? []);
      const clash = unset.find((k) => Object.hasOwn(setFields, k));
      if (clash) throw new LaneboardError('USAGE', `field "${clash}" is both set and unset`);
      const task = requireActiveTask(s, id);
      checkExpectedRev(task, false, p.expected_rev);
      checkTaskLinks(addLinks, [s.active, s.archive], s.config.prefix);
      for (const key of unset) {
        if (!Object.hasOwn(s.config.fields, key) && !Object.hasOwn(task.fields, key)) {
          throw new LaneboardError('UNKNOWN_FIELD', `field "${key}" is neither declared nor set on ${id}`, {
            allowed: [...new Set([...Object.keys(s.config.fields), ...Object.keys(task.fields)])],
            input: { field: 'field', value: key },
          });
        }
      }

      const diff: Record<string, unknown> = {};
      if (p.title !== undefined && p.title !== task.title) {
        diff.title = [task.title, p.title];
        task.title = p.title;
      }
      if (p.description !== undefined && p.description !== task.description) {
        diff.description = { chars: [task.description.length, p.description.length] };
        task.description = p.description;
      }
      const labels = [...task.labels.filter((l) => !removeLabels.includes(l)), ...addLabels.filter((l) => !task.labels.includes(l))];
      if (!sameJson(labels, task.labels)) {
        diff.labels = [task.labels, labels];
        task.labels = labels;
      }
      const kept: LinkT[] = task.links.filter((l) => !removeKeys.has(linkKey(l)));
      const links = [...kept, ...addLinks.filter((l) => !kept.some((k) => linkKey(k) === linkKey(l)))];
      if (!sameJson(links, task.links)) {
        diff.links = [task.links, links];
        task.links = links;
      }
      for (const [key, value] of Object.entries(setFields)) {
        const before = Object.hasOwn(task.fields, key) ? task.fields[key] : null;
        if (sameJson(before, value)) continue;
        diff[`fields.${key}`] = [before, value];
        task.fields[key] = value;
      }
      for (const key of unset) {
        if (!Object.hasOwn(task.fields, key)) continue;
        diff[`fields.${key}`] = [task.fields[key], null];
        delete task.fields[key];
      }
      const statusChange = p.status !== undefined && p.status !== task.status ? { from: task.status, to: p.status } : undefined;
      const assignee = p.assignee === undefined ? task.assignee : p.assignee;
      const assignChange = assignee !== task.assignee ? { from: task.assignee, to: assignee } : undefined;

      if (!Object.keys(diff).length && !statusChange && !assignChange) {
        warnings.push(`no changes: ${id} already has these values`);
        return toTaskView(task, false);
      }
      touch(task, s.now, actor);
      if (Object.keys(diff).length) addEvent(task, s.config, s.now, actor, 'updated', diff);
      if (statusChange) {
        task.status = statusChange.to;
        addEvent(task, s.config, s.now, actor, 'status', statusChange);
      }
      if (assignChange) {
        task.assignee = assignChange.to;
        addEvent(task, s.config, s.now, actor, 'assigned', assignChange);
      }
      return toTaskView(task, false);
    },
    txOptions(ctx, warnings),
  );
  return { data, warnings };
}

export const ClaimInput = z.strictObject({
  id: IdInput,
  status: z.string().min(1).optional(),
  expected_rev: RevInput.optional(),
});
export type ClaimInputT = z.infer<typeof ClaimInput>;

// Take a task: assignee := actor; a task held by someone else fails with ALREADY_CLAIMED.
export async function claimTask(ctx: OpContext, input: ClaimInputT): Promise<OpResult<TaskView>> {
  const actor = requireActor(ctx.actor);
  const p = parseInput(ClaimInput, input);
  const warnings: string[] = [];
  const data = await transact(
    ctx.store,
    { files: ['active', 'archive'] },
    (s) => {
      const id = normalizeId(p.id, s.config.prefix);
      if (p.status !== undefined) checkStatus(s.config, p.status);
      const task = requireActiveTask(s, id);
      checkExpectedRev(task, false, p.expected_rev);
      if (task.assignee !== null && task.assignee !== actor) {
        // The fix may be run blindly, so it never takes the task over; reassignment is only named in the message.
        throw new LaneboardError(
          'ALREADY_CLAIMED',
          `task ${id} is already claimed by ${task.assignee}; do not take it over. Only if reassignment is intentional and agreed: laneboard update ${id} --assignee ${actor}`,
          {
            details: { assignee: task.assignee },
            fix: `laneboard comment ${id} "<note for ${task.assignee}>" --as ${actor}`,
          },
        );
      }
      const assignChange = task.assignee !== actor ? { from: task.assignee, to: actor } : undefined;
      const statusChange = p.status !== undefined && p.status !== task.status ? { from: task.status, to: p.status } : undefined;
      if (!assignChange && !statusChange) {
        warnings.push(`no changes: ${id} is already claimed by ${actor}`);
        return toTaskView(task, false);
      }
      touch(task, s.now, actor);
      if (assignChange) {
        task.assignee = actor;
        addEvent(task, s.config, s.now, actor, 'assigned', assignChange);
      }
      if (statusChange) {
        task.status = statusChange.to;
        addEvent(task, s.config, s.now, actor, 'status', statusChange);
      }
      return toTaskView(task, false);
    },
    txOptions(ctx, warnings),
  );
  return { data, warnings };
}

export const CommentInput = z.strictObject({
  id: IdInput,
  text: z.string().min(1).max(MAX_COMMENT_CHARS).regex(/\S/, 'comment must not be blank'),
});
export type CommentInputT = z.infer<typeof CommentInput>;

// Add a comment (a `commented` event).
export async function commentTask(ctx: OpContext, input: CommentInputT): Promise<OpResult<TaskView>> {
  const actor = requireActor(ctx.actor);
  const p = parseInput(CommentInput, input);
  const warnings: string[] = [];
  const data = await transact(
    ctx.store,
    { files: ['active', 'archive'] },
    (s) => {
      const id = normalizeId(p.id, s.config.prefix);
      const task = requireActiveTask(s, id);
      touch(task, s.now, actor);
      addEvent(task, s.config, s.now, actor, 'commented', { text: p.text });
      return toTaskView(task, false);
    },
    txOptions(ctx, warnings),
  );
  return { data, warnings };
}
