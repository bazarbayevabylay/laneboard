// Ops that change an active task: update, claim, comment, finish (task_update, task_claim, task_comment, task_finish).
import { z } from 'zod';
import { isEarlierSessionName } from '../agent-name.ts';
import { LaneboardError } from '../errors.ts';
import { gitHead } from '../git.ts';
import type { LinkT } from '../schema.ts';
import { transact } from '../transact.ts';
import {
  actorSourceOf,
  addEvent,
  checkActor,
  checkExpectedRev,
  checkFields,
  checkLabel,
  checkStatus,
  checkTaskLinks,
  DescriptionInput,
  finalStatuses,
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
      if (Object.keys(diff).length) addEvent(task, s.config, s.now, actor, 'updated', diff, actorSourceOf(ctx));
      if (statusChange) {
        task.status = statusChange.to;
        addEvent(task, s.config, s.now, actor, 'status', statusChange, actorSourceOf(ctx));
      }
      if (assignChange) {
        task.assignee = assignChange.to;
        addEvent(task, s.config, s.now, actor, 'assigned', assignChange, actorSourceOf(ctx));
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
  // Take the task over from another session of the same default name base (your own work before /clear).
  resume: z.boolean().optional(),
});
export type ClaimInputT = z.infer<typeof ClaimInput>;

// ALREADY_CLAIMED for a task held by `holder`. The fix may be run blindly, so it names no takeover command; only when the holder is
// a default name of another session of this user and harness does the message name `claim --resume` (for the agent's own earlier work).
function claimedBy(ctx: OpContext, id: string, holder: string, actor: string, resumeAsked: boolean): LaneboardError {
  let why = 'do not take it over: reassignment is the orchestrator\'s decision';
  if (resumeAsked) {
    why =
      ctx.sessionBase === undefined
        ? `--resume takes over only a task of an earlier session of the session default name, and you write as ${actor}; ${why}`
        : `--resume takes over only a default name ${ctx.sessionBase}:<other session>, and ${holder} is not one; ${why}`;
  } else if (isEarlierSessionName(holder, ctx.sessionBase, actor)) {
    why = `${holder} is your default name in another session (before /clear, or a parallel session). Only if you did this task yourself and it matches your current request: laneboard claim ${id} --resume; otherwise leave it`;
  }
  return new LaneboardError('ALREADY_CLAIMED', `task ${id} is already claimed by ${holder}; ${why}`, {
    details: { assignee: holder },
    fix: `laneboard comment ${id} "<note for ${holder}>" --as ${actor}`,
  });
}

// Take a task: assignee := actor; a task held by someone else fails with ALREADY_CLAIMED, unless `resume` takes it over from
// another session of the same default name base (an `assigned` event with `resumed: true`).
export async function claimTask(ctx: OpContext, input: ClaimInputT): Promise<OpResult<TaskView>> {
  const actor = requireActor(ctx.actor);
  const p = parseInput(ClaimInput, input);
  const warnings: string[] = [];
  let resumedFrom: string | undefined;
  const data = await transact(
    ctx.store,
    { files: ['active', 'archive'] },
    (s) => {
      const id = normalizeId(p.id, s.config.prefix);
      if (p.status !== undefined) checkStatus(s.config, p.status);
      const task = requireActiveTask(s, id);
      checkExpectedRev(task, false, p.expected_rev);
      const holder = task.assignee;
      const resumed = holder !== null && p.resume === true && isEarlierSessionName(holder, ctx.sessionBase, actor);
      if (holder !== null && holder !== actor && !resumed) throw claimedBy(ctx, id, holder, actor, p.resume === true);
      const assignChange = holder !== actor ? { from: holder, to: actor, ...(resumed ? { resumed: true } : {}) } : undefined;
      const statusChange = p.status !== undefined && p.status !== task.status ? { from: task.status, to: p.status } : undefined;
      if (!assignChange && !statusChange) {
        warnings.push(`no changes: ${id} is already claimed by ${actor}`);
        return toTaskView(task, false);
      }
      touch(task, s.now, actor);
      if (assignChange) {
        task.assignee = actor;
        addEvent(task, s.config, s.now, actor, 'assigned', assignChange, actorSourceOf(ctx));
      }
      if (statusChange) {
        task.status = statusChange.to;
        addEvent(task, s.config, s.now, actor, 'status', statusChange, actorSourceOf(ctx));
      }
      if (resumed) resumedFrom = holder;
      return toTaskView(task, false);
    },
    txOptions(ctx, warnings),
  );
  return resumedFrom === undefined ? { data, warnings } : { data, warnings, reply: { resumed_from: resumedFrom } };
}

// Comment text: 1 to MAX_COMMENT_CHARS characters, not blank (comments and finish results).
const CommentText = z.string().min(1).max(MAX_COMMENT_CHARS).regex(/\S/, 'comment must not be blank');

export const CommentInput = z.strictObject({
  id: IdInput,
  text: CommentText,
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
      addEvent(task, s.config, s.now, actor, 'commented', { text: p.text }, actorSourceOf(ctx));
      return toTaskView(task, false);
    },
    txOptions(ctx, warnings),
  );
  return { data, warnings };
}

export const FinishInput = z.strictObject({
  id: IdInput,
  // The result comment (what was done, how it was checked).
  result: CommentText,
  // One of the final statuses; default: the final status (the last one in config).
  status: z.string().min(1).optional(),
  // true: no commit link even inside a git repository.
  no_commit: z.boolean().optional(),
});
export type FinishInputT = z.infer<typeof FinishInput>;

// Close a task in one write: the result comment, the commit of the git checkout (kind=commit; not with no_commit, outside git
// or before the first commit), the actor as assignee of an unassigned task, then the final status, in this event order.
// Only the assignee (or anybody for an unassigned task) finishes; a task already in a final status is left as it is (a warning).
export async function finishTask(ctx: OpContext, input: FinishInputT): Promise<OpResult<TaskView>> {
  const actor = requireActor(ctx.actor);
  const p = parseInput(FinishInput, input);
  // Read before the lock: the checkout does not change because of this write.
  const commit = p.no_commit === true || ctx.cwd === undefined ? undefined : gitHead(ctx.cwd);
  const warnings: string[] = [];
  let finished = false;
  const data = await transact(
    ctx.store,
    { files: ['active', 'archive'] },
    (s) => {
      const id = normalizeId(p.id, s.config.prefix);
      const finals = finalStatuses(s.config.statuses);
      const status = p.status ?? finals[0] ?? '';
      if (p.status !== undefined) checkStatus(s.config, p.status);
      if (!finals.includes(status)) {
        throw new LaneboardError('INVALID_VALUE', `"${status}" is not a final status; finish sets ${finals.join(' or ')} (other statuses: laneboard update ${id} --status <status>)`, {
          allowed: finals,
          input: finals.length === 1 ? { field: 'status', value: status, suggestion: finals[0] ?? '' } : { field: 'status', value: status },
        });
      }
      const task = requireActiveTask(s, id);
      if (task.assignee !== null && task.assignee !== actor) throw claimedBy(ctx, id, task.assignee, actor, false);
      if (finals.includes(task.status)) {
        warnings.push(`no changes: ${id} is already ${task.status}; the result was not recorded (add it with laneboard comment ${id} "<text>")`);
        return toTaskView(task, false);
      }
      touch(task, s.now, actor);
      addEvent(task, s.config, s.now, actor, 'commented', { text: p.result }, actorSourceOf(ctx));
      if (commit !== undefined && !task.links.some((l) => l.kind === 'commit' && l.ref === commit)) {
        const links: LinkT[] = [...task.links, { kind: 'commit', ref: commit }];
        addEvent(task, s.config, s.now, actor, 'updated', { links: [task.links, links] }, actorSourceOf(ctx));
        task.links = links;
      }
      if (task.assignee === null) {
        task.assignee = actor;
        addEvent(task, s.config, s.now, actor, 'assigned', { from: null, to: actor }, actorSourceOf(ctx));
      }
      addEvent(task, s.config, s.now, actor, 'status', { from: task.status, to: status }, actorSourceOf(ctx));
      task.status = status;
      finished = true;
      return toTaskView(task, false);
    },
    txOptions(ctx, warnings),
  );
  return finished ? { data, warnings, reply: { commit: commit ?? null } } : { data, warnings };
}
