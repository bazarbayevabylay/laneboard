// Ops that change an active task: update, claim, comment, finish (task_update, task_claim, task_comment, task_finish).
import path from 'node:path';
import { z } from 'zod';
import { LaneboardError } from '../errors.ts';
import { isDirectory, readCheckout, readCommit, readWorktrees } from '../git.ts';
import { shellQuote } from '../shell.ts';
import type { CheckoutState } from '../git.ts';
import { samePath } from '../store.ts';
import type { ActorSource } from '../agent-name.ts';
import type { ConfigT, LinkT, StoreFileT, TaskT } from '../schema.ts';
import { transact } from '../transact.ts';
import {
  actorSourceOf,
  addEvent,
  assignmentEvent,
  byEarlierSession,
  checkActor,
  checkExpectedRev,
  checkFields,
  checkLabel,
  checkParent,
  checkStatus,
  checkTaskLinks,
  DescriptionInput,
  EARLIER_SESSION_SILENT_MS,
  finalStatuses,
  heldByEarlierSession,
  IdInput,
  lastComment,
  LinkInput,
  linkKey,
  MAX_COMMENT_CHARS,
  minutesText,
  normalizeId,
  openChildrenWarning,
  parseFieldArgs,
  parseInput,
  requireActiveTask,
  requireActor,
  reviewers,
  reviewStatuses,
  RevInput,
  silentFor,
  TitleInput,
  toTaskView,
  touch,
  txOptions,
  unique,
  workStartedAt,
} from './common.ts';
import type { LastComment, OpContext, OpResult, TaskView, WriteFacts } from './common.ts';
import { checkForeignTaskLinks, missingTask } from './links.ts';

// Longest replaced description an `updated` event keeps (code points): a replace must not lose the text, but an event stays small.
export const PREVIOUS_DESCRIPTION_MAX = 10000;

// The replaced text for the event (ADR §24): `previous`, cut to PREVIOUS_DESCRIPTION_MAX code points with `previous_cut: true`;
// nothing for an empty description (`chars` [0, n] already says no text was replaced).
function previousDescription(text: string): { previous?: string; previous_cut?: true } {
  if (text === '') return {};
  const chars = [...text];
  if (chars.length <= PREVIOUS_DESCRIPTION_MAX) return { previous: text };
  return { previous: chars.slice(0, PREVIOUS_DESCRIPTION_MAX).join(''), previous_cut: true };
}

export const UpdateInput = z.strictObject({
  id: IdInput,
  title: TitleInput.optional(),
  description: DescriptionInput.optional(),
  // Text added to the end of the description (after a blank line), computed under the lock: no expected_rev needed (ADR §26).
  append_description: z.string().min(1).max(100000).regex(/\S/, 'must not be blank').optional(),
  status: z.string().min(1).optional(),
  // null unassigns.
  assignee: z.string().nullable().optional(),
  // Id of the parent task on this board (a subtask, ADR §25); null makes it a top-level task.
  parent: IdInput.nullable().optional(),
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

const CHANGE_KEYS = ['title', 'description', 'append_description', 'status', 'assignee', 'parent', 'add_labels', 'remove_labels', 'add_links', 'remove_links', 'fields', 'field_args', 'unset_fields'] as const;

// Same values, same order?
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Change fields of an active task; one `updated` event plus `status`/`assigned` events; no-op when values are equal.
export async function updateTask(ctx: OpContext, input: UpdateInputT): Promise<OpResult<TaskView>> {
  const actor = requireActor(ctx.actor);
  const p = parseInput(UpdateInput, input);
  if (!CHANGE_KEYS.some((k) => p[k] !== undefined)) {
    throw new LaneboardError('USAGE', 'nothing to change: pass at least one of title, description, append_description, status, assignee, parent, labels, links, fields', {
      edit: { add: [{ name: 'status', value: '<status>' }] },
    });
  }
  if (p.description !== undefined && p.append_description !== undefined) {
    throw new LaneboardError('USAGE', 'description and append_description cannot be combined: description replaces the whole text, append_description adds to it', {
      edit: { drop: [{ name: 'append_description' }] },
    });
  }
  if (typeof p.assignee === 'string') checkActor(p.assignee, 'assignee');
  const addLabels = unique(p.add_labels ?? []);
  const removeLabels = unique(p.remove_labels ?? []);
  [...addLabels, ...removeLabels].forEach(checkLabel);
  const both = addLabels.find((l) => removeLabels.includes(l));
  if (both) throw new LaneboardError('USAGE', `label "${both}" is both added and removed`, { edit: { drop: [{ name: 'remove_labels', value: both }] } });
  const addLinks = unique(p.add_links ?? [], linkKey);
  const removeKeys = new Set((p.remove_links ?? []).map(linkKey));
  const warnings: string[] = [];
  // Links to other boards: checked there before this board's lock is taken (ADR §30).
  const checked = await checkForeignTaskLinks(ctx, addLinks, warnings);
  let returned: WriteFacts['returned'];
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
      if (clash) throw new LaneboardError('USAGE', `field "${clash}" is both set and unset`, { edit: { drop: [{ name: 'unset_fields', value: clash }] } });
      const task = requireActiveTask(s, id, (missing) => missingTask(ctx, missing, s.config.prefix, 'write'));
      checkExpectedRev(task, false, p.expected_rev);
      checkTaskLinks(addLinks, [s.active, s.archive], s.config.prefix, checked);
      const parent = typeof p.parent === 'string' ? checkParent(s, p.parent, s.config.prefix, id, 'add_links') : p.parent;
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
        diff.description = { chars: [task.description.length, p.description.length], ...previousDescription(task.description) };
        task.description = p.description;
      }
      if (p.append_description !== undefined) {
        const text = task.description === '' ? p.append_description : `${task.description}\n\n${p.append_description}`;
        if (text.length > 100000) {
          throw new LaneboardError('INVALID_VALUE', `description would be ${text.length} characters, over 100000`, {
            fix: `laneboard attach ${id} <path of a file with the text> --json`,
          });
        }
        diff.description = { chars: [task.description.length, text.length], appended: true };
        task.description = text;
      }
      if (parent !== undefined && parent !== (task.parent ?? null)) {
        diff.parent = [task.parent ?? null, parent];
        if (parent === null) delete task.parent;
        else task.parent = parent;
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
      // A name that may not check a task waiting for a check never takes it by update --assignee itself (LB-63.6): claim never does.
      if (assignChange?.to === actor && waitsInCheck(s.config, task) && !workedOn(task, actor, ctx.sessionBase) && !mayCheck(s.config, task, actor, ctx.sessionBase)) {
        throw waitingTakeRefusal(s.config, task, actor);
      }
      const handInLost = statusChange ? checkReviewMove(s.config, task, actor, statusChange.to, assignChange?.to === actor, assignee, ctx.sessionBase) : undefined;
      // The A17 warning keeps its place among the warnings; it is added after the write, unless this write is a return for rework (U6).
      const lostAt = warnings.length;
      // A checker that gets a task waiting for its check stops being one (S6x B-U2): told after the write (checkerHoldsWarning).
      const checkerTakes = assignChange?.to != null && mayCheck(s.config, task, assignChange.to, assignChange.to === actor ? ctx.sessionBase : undefined);

      if (!Object.keys(diff).length && !statusChange && !assignChange) {
        warnings.push(`no changes: ${id} already has these values`);
        return toTaskView(task, false);
      }
      touch(task, s.now, actor);
      if (Object.keys(diff).length) addEvent(task, s.config, s.now, actor, 'updated', diff, actorSourceOf(ctx));
      if (statusChange) {
        task.status = statusChange.to;
        addEvent(task, s.config, s.now, actor, 'status', statusChange, actorSourceOf(ctx));
        const open = finalStatuses(s.config.statuses).includes(task.status) ? openChildrenWarning(s.active, id, finalStatuses(s.config.statuses)) : undefined;
        if (open) warnings.push(open);
      }
      if (assignChange) {
        task.assignee = assignChange.to;
        addEvent(task, s.config, s.now, actor, 'assigned', assignChange, actorSourceOf(ctx));
        if (checkerTakes) checkerHoldsWarning(s.config, task, actor, warnings);
      }
      // After the assignee is set, so the reply and the warning name who reads the reason. A return for rework (the documented comment,
      // then update into work; S7a U6 run 8) is confirmed in the reply (`returned`), not by A17, whose hand-in is the holder's command.
      const back = statusChange ? returnByThisWrite(s.config, task, actor, s.now) : undefined;
      if (back !== undefined) returned = { to: task.assignee, reason: back.reason?.text ?? null };
      else if (handInLost !== undefined) warnings.splice(lostAt, 0, handInLost);
      const noReason = back === undefined ? undefined : noReasonWarning(task, actor, back);
      if (noReason) warnings.push(noReason);
      return toTaskView(task, false);
    },
    txOptions(ctx, warnings),
  );
  return returned === undefined ? { data, warnings } : { data, warnings, reply: { returned } };
}

export const ClaimInput = z.strictObject({
  id: IdInput,
  status: z.string().min(1).optional(),
  expected_rev: RevInput.optional(),
  // Take the task over from another session of the same default name base (your own work before a /clear or a restart).
  resume: z.boolean().optional(),
});
export type ClaimInputT = z.infer<typeof ClaimInput>;

// ALREADY_CLAIMED for a task held by `holder`, not an earlier session of the actor's default name (earlierSessionClaimed is for
// those): its fix may be run blindly, so neither the fix nor the message names a takeover command.
function claimedBy(ctx: OpContext, id: string, holder: string, actor: string, resumeAsked: boolean): LaneboardError {
  let why = 'do not take it over: reassignment is the orchestrator\'s decision';
  if (resumeAsked) {
    why =
      ctx.sessionBase === undefined
        ? `--resume takes over only a task of an earlier session of the session default name, and you write as ${actor}; ${why}`
        : `--resume takes over only a task that another session of yours took under its default name ${ctx.sessionBase}:<other session>, and ${holder} did not; ${why}`;
  }
  return new LaneboardError('ALREADY_CLAIMED', `task ${id} is already claimed by ${holder}; ${why}`, {
    details: { assignee: holder },
    fix: `laneboard comment ${id} "<note for ${holder}>" --as ${actor} --json`,
  });
}

// ALREADY_CLAIMED for a task of another session of the actor's default name (heldByEarlierSession), by how long that session has not
// written on the board (P5, S6l): EARLIER_SESSION_SILENT_MS or more, it is taken for closed by a /clear or a restart, so the fix takes
// the task back (claim --resume); a younger one may be a parallel session at work: the fix is the comment, and the message names
// --resume for a session that is closed. `then`: what the refused command does after the resume (finish: run it again).
function earlierSessionClaimed(id: string, holder: string, actor: string, silentMs: number, then: string): LaneboardError {
  const details = { assignee: holder };
  if (silentMs >= EARLIER_SESSION_SILENT_MS) {
    // heldByEarlierSession needs the holder's own assignment event on the task, so silentMs is finite here.
    return new LaneboardError(
      'ALREADY_CLAIMED',
      `task ${id} is held by ${holder}, an earlier session of your default name (no write for ${minutesText(silentMs)}: closed by /clear or a restart); if it is your own work, take it back: laneboard claim ${id} --resume${then}`,
      { details, fix: `laneboard claim ${id} --resume --json` },
    );
  }
  return new LaneboardError(
    'ALREADY_CLAIMED',
    `task ${id} is held by ${holder}, another session of your default name that wrote ${minutesText(silentMs)} ago: it may be a parallel session at work, so do not take it over; if that session is closed: laneboard claim ${id} --resume${then}`,
    { details, fix: `laneboard comment ${id} "<note for ${holder}>" --as ${actor} --json` },
  );
}

// ALREADY_CLAIMED for a task in a final status held by another session of the actor's default name (LB-54.1): --resume takes back
// only unfinished work (the rule of prime's earlier-session list, read.ts heldBySessionsOf), so neither the message nor the fix names
// --resume for it; the fix is the new task, the message names the reopen for a task closed by mistake.
function closedEarlierSessionTask(config: ConfigT, id: string, holder: string, status: string, actor: string): LaneboardError {
  return new LaneboardError(
    'ALREADY_CLAIMED',
    `task ${id} is ${status}: closed by ${holder}, an earlier session of your default name; --resume takes back only unfinished work, so there is nothing to resume; ` +
      `new work is a new task, and a task closed by mistake is reopened first: laneboard update ${id} --status ${reworkStatus(config)}, then laneboard claim ${id} --resume`,
    { details: { assignee: holder }, fix: `laneboard create "<short title of your work>" --status ${config.statuses[0] ?? '<status>'} --assignee ${actor} --json` },
  );
}

// Milliseconds since `holder` took `task` back with claim --resume itself (the event that gave it the task is its `assigned` event
// with `resumed: true`); undefined when it holds the task by another event (its own claim, create, a reassignment).
function resumedByHolderAgo(task: TaskT, holder: string, now: string): number | undefined {
  const e = assignmentEvent(task);
  if (e === undefined || e.type !== 'assigned' || e.actor !== holder || e.data.resumed !== true) return undefined;
  return Math.max(0, Date.parse(now) - Date.parse(e.at));
}

// ALREADY_CLAIMED for a task another session of the actor's default name took back with claim --resume less than
// EARLIER_SESSION_SILENT_MS ago (LB-54.4): two sessions resume the same task one right after the other (two tabs after one restart),
// and it stays with the first. An older resume is the next /clear of a long task: that one takes the usual path (exit 0, the warning
// of resumeWarnings), review A1 r1. The fix is the comment; the message names when it may be resumed.
function resumedByLiveSession(id: string, holder: string, actor: string, resumedAgo: number): LaneboardError {
  return new LaneboardError(
    'ALREADY_CLAIMED',
    `task ${id} was taken back with claim --resume by ${holder}, another session of your default name, ${minutesText(resumedAgo)} ago: ` +
      `a task resumed within ${minutesText(EARLIER_SESSION_SILENT_MS)} stays with the session that took it, as another one may be a parallel session at work, so do not take it over; ` +
      `if that session is closed, the task can be resumed once its resume is ${minutesText(EARLIER_SESSION_SILENT_MS)} old: laneboard claim ${id} --resume`,
    { details: { assignee: holder }, fix: `laneboard comment ${id} "<note for ${holder}>" --as ${actor} --json` },
  );
}

// The status a claim without --status moves a task in the first status to when the actor holds it already or takes it back with
// --resume (LB-57.4, LB-54.2: such a claim starts the work, it is no "no changes" in the first status): on a board with checks the one
// before the first check (config names it: claims go there), else the second status unless it is the final one. The status prime's
// claim command names (format.ts workStatus). undefined: the task stays where it is.
function claimWorkStatus(config: ConfigT): string | undefined {
  if (reviewStatuses(config).length > 0) return workStatusBeforeChecks(config);
  const second = config.statuses[1];
  return second === undefined || finalStatuses(config.statuses).includes(second) ? undefined : second;
}

// Take a task: assignee := actor; a task held by someone else fails with ALREADY_CLAIMED, unless `resume` takes it over from
// another session of the same default name base (an `assigned` event with `resumed: true`). A resume warns when that session wrote
// less than EARLIER_SESSION_SILENT_MS ago (a parallel session may still be at work: two tabs after a restart, A-U6) and names the
// parent task held by the same session (finish of the parent needs it back too, A-U2). On a board with checks a task that waits for a check
// is claimed by nobody (S6w r2, waitingClaimRefusal): a checker checks it with finish, and a claim would make the checker its author.
// LB-54: a closed task of an earlier session is not resumed (closedEarlierSessionTask), nor one another session resumed less than
// EARLIER_SESSION_SILENT_MS ago (resumedByLiveSession); --resume of a free task warns that it was a plain claim. Without --status
// an own or resumed task in the first status moves into the work status (claimWorkStatus, LB-54.2, LB-57.4).
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
      const task = requireActiveTask(s, id, (missing) => missingTask(ctx, missing, s.config.prefix, 'write'));
      checkExpectedRev(task, false, p.expected_rev);
      // A task that waits for a check is taken by nobody (S6w r2): a check needs no claim, and the claim would make a checker an author.
      if (waitsInCheck(s.config, task)) throw waitingClaimRefusal(s.config, task, actor, ctx.sessionBase);
      const holder = task.assignee;
      const earlier = heldByEarlierSession(task, ctx.sessionBase, actor);
      if (earlier && holder !== null) {
        if (finalStatuses(s.config.statuses).includes(task.status)) throw closedEarlierSessionTask(s.config, id, holder, task.status, actor);
        const resumedAgo = resumedByHolderAgo(task, holder, s.now);
        if (resumedAgo !== undefined && resumedAgo < EARLIER_SESSION_SILENT_MS) throw resumedByLiveSession(id, holder, actor, resumedAgo);
      }
      const resumed = p.resume === true && earlier;
      if (holder !== null && holder !== actor && !resumed) {
        throw earlier ? earlierSessionClaimed(id, holder, actor, silentFor(s.active.tasks, holder, s.now), '') : claimedBy(ctx, id, holder, actor, p.resume === true);
      }
      if (resumed && holder !== null) resumeWarnings(s.active.tasks, task, holder, ctx.sessionBase, actor, s.now, finalStatuses(s.config.statuses), warnings);
      if (p.resume === true && holder === null) {
        warnings.push(`${id} had no assignee, so --resume took it as a plain claim: it is no task of an earlier session of yours; make sure it is the work you were asked to do`);
      }
      const assignChange = holder !== actor ? { from: holder, to: actor, ...(resumed ? { resumed: true } : {}) } : undefined;
      // Only a task the actor holds or takes back (LB-57.4, LB-54.2): a plain claim of a free task keeps its status (assignee := you).
      const startsWork = (holder === actor || resumed) && task.status === s.config.statuses[0];
      const target = p.status ?? (startsWork ? claimWorkStatus(s.config) : undefined);
      const statusChange = target !== undefined && target !== task.status ? { from: task.status, to: target } : undefined;
      // The same checks as update (review r1): claim --status is no way around them; the actor holds the task after the claim.
      const handInLost = statusChange ? checkReviewMove(s.config, task, actor, statusChange.to, true, actor, ctx.sessionBase) : undefined;
      if (handInLost !== undefined) warnings.push(handInLost);
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
      if (resumed && holder !== null) resumedFrom = holder;
      return toTaskView(task, false);
    },
    txOptions(ctx, warnings),
  );
  return resumedFrom === undefined ? { data, warnings } : { data, warnings, reply: { resumed_from: resumedFrom } };
}

// Warnings of a claim --resume of `task` from `holder` (read before the write): the holder wrote recently, so it may be a parallel
// session at work and not the actor's closed one; the parent task is held by the same session (resume it too to finish it).
function resumeWarnings(tasks: readonly TaskT[], task: TaskT, holder: string, sessionBase: string | undefined, actor: string, now: string, finals: readonly string[], warnings: string[]): void {
  const silent = silentFor(tasks, holder, now);
  if (silent < EARLIER_SESSION_SILENT_MS) {
    warnings.push(`${task.id} taken from a session active ${minutesText(silent)} ago (${holder}): if it is a parallel session at work, not your own closed one, tell it: laneboard comment ${task.id} "<note for ${holder}>" --json`);
  }
  const parent = task.parent === undefined ? undefined : tasks.find((t) => t.id === task.parent);
  if (parent !== undefined && parent.assignee === holder && !finals.includes(parent.status) && heldByEarlierSession(parent, sessionBase, actor)) {
    warnings.push(`its parent ${parent.id} is held by the same session ${holder}: laneboard claim ${parent.id} --resume --json`);
  }
}

// Comment text: 1 to MAX_COMMENT_CHARS characters, not blank (comments and finish results).
const CommentText = z.string().min(1).max(MAX_COMMENT_CHARS).regex(/\S/, 'comment must not be blank');

export const CommentInput = z.strictObject({
  id: IdInput,
  text: CommentText,
});
export type CommentInputT = z.infer<typeof CommentInput>;

// The warning of a comment by a name that held `task` until somebody else took it away (LB-54.5: a session whose task another session
// took back with claim --resume, or an old holder after a reassignment): the newest `assigned` event is from the actor to another
// name (or nobody), written by somebody else. undefined when the actor holds it, never held it, or gave it away itself.
function lostTaskWarning(task: TaskT, actor: string, now: string): string | undefined {
  if (task.assignee === actor) return undefined;
  const e = task.events.findLast((ev) => ev.type === 'assigned');
  if (e === undefined || e.data.from !== actor || e.actor === actor) return undefined;
  const to = typeof e.data.to === 'string' ? e.data.to : null;
  const ago = minutesText(Math.max(0, Date.parse(now) - Date.parse(e.at)));
  const how = e.data.resumed === true ? `${e.actor} took it over with claim --resume` : to === null ? `${e.actor} unassigned it` : `${e.actor} gave it to ${to}`;
  const ask = to === null ? 'the orchestrator' : `${to} or the orchestrator`;
  return `${task.id} is no longer yours: ${how} ${ago} ago; your comment is written, but stop work on it unless it is given back (ask ${ask})`;
}

// Add a comment (a `commented` event); a comment of a name that lost the task warns (lostTaskWarning, LB-54.5).
export async function commentTask(ctx: OpContext, input: CommentInputT): Promise<OpResult<TaskView>> {
  const actor = requireActor(ctx.actor);
  const p = parseInput(CommentInput, input);
  const warnings: string[] = [];
  const data = await transact(
    ctx.store,
    { files: ['active', 'archive'] },
    (s) => {
      const id = normalizeId(p.id, s.config.prefix);
      const task = requireActiveTask(s, id, (missing) => missingTask(ctx, missing, s.config.prefix, 'write'));
      const lost = lostTaskWarning(task, actor, s.now);
      if (lost !== undefined) warnings.push(lost);
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
  // Any status but the first one (e.g. review: the agent hands in, the orchestrator sets the final one); default: the final status.
  status: z.string().min(1).optional(),
  // true: no commit link even inside a git repository.
  no_commit: z.boolean().optional(),
  // The commit to link instead of HEAD, 7 to 64 hex digits (linked as the full sha git names): work committed in another git
  // worktree than the folder finish runs in (A18).
  commit: z.string().regex(/^[0-9a-fA-F]{7,64}$/, 'must be a commit sha of 7 to 64 hex digits').optional(),
  // Absolute path of the folder whose git HEAD is linked instead of the command's own (MCP: the agent's worktree, as the server
  // runs in the main checkout); with commit: the folder git is asked in.
  cwd: z.string().refine((v) => path.isAbsolute(v), 'must be an absolute path').optional(),
});
export type FinishInputT = z.infer<typeof FinishInput>;

// Statuses finish may set: all but the first one (where new tasks start), the final one always.
function finishStatuses(statuses: readonly string[]): string[] {
  const finals = finalStatuses(statuses);
  return statuses.filter((st, i) => i > 0 || finals.includes(st));
}

// The newest `status` event into the task's current status, if the events limit kept it.
function arrivalEvent(task: TaskT): TaskT['events'][number] | undefined {
  for (let i = task.events.length - 1; i >= 0; i--) {
    const e = task.events[i];
    if (e?.type === 'status' && e.data.to === task.status) return e;
  }
  return undefined;
}

// Was the task handed in: the newest `status` event into its current status is a finish that handed it in (`handed_in: true`, S4b, by
// the data: no meaning is read from the names or the order of statuses) or a checker's finish that passed it on (`passed: true`, P1: the
// hand-in lives on through the checks). On a board with checks it holds for the task, whoever holds it now (S6w r1): a new assignee
// (update --assignee, claim, unassign) keeps it handed in, so a task waiting in a check stays in the checkers' queue, and the new holder
// is an author of the work all the same (workedOn). Without checks the hand-in is its assignee's (LB-9): somebody else accepts only a
// task its assignee handed in, so a task given to another name is handed in again. False without such an event (set by update or claim,
// created in this status, handed in before the marker, or the event was dropped by the events limit).
export function handedIn(task: TaskT, config: ConfigT): boolean {
  const e = arrivalEvent(task);
  if (e === undefined) return false;
  if (reviewStatuses(config).length > 0) return e.data.handed_in === true || e.data.passed === true;
  return (e.actor === task.assignee && e.data.handed_in === true) || (e.actor !== task.assignee && e.data.passed === true);
}

// Who passed the task on into its current status (a checker's finish, P1), or undefined.
function passedBy(task: TaskT): string | undefined {
  const e = arrivalEvent(task);
  return e !== undefined && e.data.passed === true ? e.actor : undefined;
}

// Did `actor` do the work on `task` (the author of the work, P1, review r1): its assignee, or a name that held it or handed it in by
// the events kept (an `assigned` event from or to the actor, `created` with it as the assignee, its hand-in). So unassigning the task
// or handing it to another name first does not let its author pass it on or close it, by update, claim or finish (review r2). A
// checker's pass or acceptance is none of these events, so a check never makes the checker an author. No store field records it:
// events dropped by the events limit are not seen (a guard against mistakes, not a hostile agent: actors are self-named).
// `sessionBase` (the actor writes under its session default name, ctx.sessionBase): another session of that name that wrote on the
// task under its default name (byEarlierSession, the test of claim --resume) and worked on it is the same author (S6w r3: a new
// session after /clear neither checks its own work nor is invited to).
function workedOn(task: TaskT, actor: string, sessionBase?: string): boolean {
  if (workedOnAs(task, actor)) return true;
  return sessionBase !== undefined && task.events.some((e) => byEarlierSession(e, sessionBase, actor) && workedOnAs(task, e.actor));
}

// workedOn for exactly the name `name` (no other session counts).
function workedOnAs(task: TaskT, name: string): boolean {
  if (task.assignee === name) return true;
  return task.events.some(
    (e) =>
      (e.type === 'assigned' && (e.data.from === name || e.data.to === name)) ||
      (e.type === 'created' && e.data.assignee === name) ||
      (e.type === 'status' && e.actor === name && e.data.handed_in === true),
  );
}

// One rule for a status move by update or claim on a board with checks (P1, review r1): the author of the work (workedOn) never sets
// a later check or the final status, nor another check while the task waits in one (checkAuthorMove, shared with a checker's finish), only review.by (when set) set the final one,
// and an actor that holds the task after this write (`takes`: claim, or update with --assignee itself) does not close it either; a move of a handed-in task returns the warning that the hand-in is lost (A17;
// `holder`: who holds the task after the write, named in the warning's hand-in), which the caller adds unless the write is a return for rework (S7a U6). Without checks nothing here applies (0.3.1, ADR §22).
function checkReviewMove(config: ConfigT, task: TaskT, actor: string, to: string, takes: boolean, holder: string | null, sessionBase: string | undefined): string | undefined {
  const review = reviewStatuses(config);
  if (review.length === 0) return undefined;
  const final = finalStatuses(config.statuses)[0] ?? '';
  const refusal = reviewMoveRefusal(config, task, actor, to, takes, sessionBase);
  if (refusal === 'author') throw authorRefusal(config, task, to, actor, 'update');
  if (refusal === 'check') throw checkEntryRefusal(config, task, actor, to, sessionBase);
  if (refusal === 'not-checker') throw notChecker(task.id, task.assignee, actor, reviewers(config));
  if (refusal === 'holder') throw handInToFirstCheck(config, task, final, actor, 'update');
  // LB-63.6: a name that may not check a task waiting for a check never moves it out of the check either (a return for rework is the
  // checkers'), so it never takes the task in two steps (update --status, then update --assignee itself). Its author keeps the move.
  if (waitsInCheck(config, task) && !workedOn(task, actor, sessionBase) && !mayCheck(config, task, actor, sessionBase)) throw waitingMoveRefusal(config, task, actor);
  // The check is never bypassed (LB triage, A2): update closes only a task that waits in the last check (the acceptance by a move, A17).
  if (to === final && !finalStatuses(config.statuses).includes(task.status)) {
    const unchecked = uncheckedClose(config, task, actor);
    if (unchecked !== undefined) throw unchecked;
  }
  return handedIn(task, config) ? handInLostWarning(config, task, to, holder) : undefined;
}

// The refusal of update --status <final> by a checker (or anybody, when review.by is not set) of a task that did not get through the
// checks before the last one (A2, the check bypass): a task waiting in an earlier check is passed on with finish (unclearCheck: its fix
// reads the task); a task not handed in is handed in first, by its holder (notHandedInForCheck), by whoever did its work when it is
// unassigned (handInToFirstCheck), and a task returned for rework comes back by its holder's hand-in (returnedForRework). undefined:
// the task waits in the last check, so the move is the acceptance (the A17 warning says it has no result of a check).
function uncheckedClose(config: ConfigT, task: TaskT, actor: string): LaneboardError | undefined {
  const review = reviewStatuses(config);
  const final = finalStatuses(config.statuses)[0] ?? '';
  if (waitsInCheck(config, task)) {
    const next = nextAfterCheck(config, task.status);
    if (next === final) return undefined;
    const left = review.slice(review.indexOf(task.status) + 1);
    return unclearCheck(config, task, actor, `update never closes it: ${left.join(', ')} ${left.length === 1 ? 'is' : 'are'} still to check, and a check passes it on with finish`);
  }
  if (task.assignee === null) return handInToFirstCheck(config, task, final, actor, 'update');
  const back = reworkReturn(config, task);
  if (back !== undefined) return returnedForRework(task, back, actor);
  return notHandedInForCheck(task.id, task.assignee, task.status, actor, handInStatus(review, task));
}

// Why a board with checks refuses to put `task` into `to` by `actor` (P1, P2): 'author' - the author of the work (authorMoves);
// 'check' - any check by anybody (S6w I1: a task enters a check only by finish, handed in or passed on, so it never sits in a check
// that no checker sees); 'not-checker' - the final status by a name not in review.by (when set); 'holder' - the final status by the
// actor that holds the task after the write (`takes`). undefined: allowed, and always without checks (0.3.1, ADR §22). One rule for
// update, claim (each with its error, checkReviewMove) and create and import of a task right into a check or the final status (S6m).
export type ReviewRefusal = 'author' | 'check' | 'not-checker' | 'holder';

// The refusal of the move, or undefined (see ReviewRefusal).
export function reviewMoveRefusal(config: ConfigT, task: TaskT, actor: string, to: string, takes: boolean, sessionBase?: string): ReviewRefusal | undefined {
  if (reviewStatuses(config).length === 0) return undefined;
  if (authorMoves(config, task, actor, to, sessionBase)) return 'author';
  if (reviewStatuses(config).includes(to)) return 'check';
  const final = finalStatuses(config.statuses)[0] ?? '';
  const by = reviewers(config);
  if (to === final && by.length > 0 && !by.includes(actor)) return 'not-checker';
  if (to === final && takes) return 'holder';
  return undefined;
}

// Why a refusal of reviewMoveRefusal, for the messages of create and import (S6m): the checks of the board, who sets `to`.
export function reviewRefusalText(config: ConfigT, refusal: ReviewRefusal, to: string): string {
  const review = reviewStatuses(config);
  const final = finalStatuses(config.statuses)[0] ?? '';
  if (refusal === 'check') return `on this board ${to} is a check (${checksLine(review, final)}): a task enters it only handed in by its assignee with finish, or passed on by the check before it`;
  const checks = `on this board ${to} is set by a check (${checksLine(review, final)})`;
  if (refusal === 'not-checker') return `${checks}, only by ${reviewers(config).join(', ')} (config review.by)`;
  return `${checks}: the author of the work hands it in to ${review[0] ?? ''} with finish, a checker passes it on and accepts it`;
}

// Does `task` wait in a check that `actor` may make (prime's queue for checkers, B-U6): it is in a check status, handed in or passed
// on (handedIn, whoever holds it now: S6w r1), `actor` is in review.by (when set), is not the author of the work (workedOn, with its
// other sessions when `sessionBase` is given: S6w r3) and did not pass it on into this status itself, unless no other checker may make
// this check (S6w r2: review.by holds no other name that is no author, so the one who passed the previous check makes this one too, or
// the task would show in nobody's queue).
export function waitsForCheck(config: ConfigT, task: TaskT, actor: string, sessionBase?: string): boolean {
  if (!reviewStatuses(config).includes(task.status)) return false;
  if (!handedIn(task, config)) return false;
  const by = reviewers(config);
  if (!((by.length === 0 || by.includes(actor)) && !workedOn(task, actor, sessionBase))) return false;
  if (passedBy(task) !== actor) return true;
  return by.length > 0 && !by.some((name) => name !== actor && !workedOn(task, name));
}

// Did `actor` pass `task` on into the check it is in now (prime marks such a waiting task, S6w r2)?
export function passedOnBy(task: TaskT, actor: string): boolean {
  return passedBy(task) === actor;
}

// The status work goes on in before the checks (P1, A-U3): the one before the first check; undefined without checks or when the
// first check follows the first status (new tasks start there).
export function workStatusBeforeChecks(config: ConfigT): string | undefined {
  const at = config.statuses.indexOf(reviewStatuses(config)[0] ?? '');
  return at > 1 ? config.statuses[at - 1] : undefined;
}

// Is this the move the author of the work never makes on a board with checks (review r2): `actor` worked on the task (workedOn) and
// `to` is a later check or the final status, or any other check while the task waits in one (S6u r1: qa -> code_review would undo the
// check it passed). A move back to a work status stays allowed (A17 warning). False without checks (0.3.1, ADR §22).
function authorMoves(config: ConfigT, task: TaskT, actor: string, to: string, sessionBase: string | undefined): boolean {
  const review = reviewStatuses(config);
  if (review.length === 0) return false;
  if (!workedOn(task, actor, sessionBase)) return false;
  const final = finalStatuses(config.statuses)[0] ?? '';
  if (to === final || review.indexOf(to) > 0) return true;
  return review.includes(to) && to !== task.status && review.includes(task.status) && handedIn(task, config);
}

// The one author rule of a board with checks (review r2), for update, claim and a checker's finish alike: the author of the work
// (workedOn) neither passes the task on to a later check nor sets the final status, nor moves a task waiting in a check to another
// check; it hands in with finish (handInStatus).
// INVALID_VALUE (authorRefusal), through `refused` (a task its earlier session holds: take it back first, P5). Without checks nothing
// applies (0.3.1, ADR §22).
function checkAuthorMove(config: ConfigT, task: TaskT, actor: string, to: string, sessionBase: string | undefined, refused: (err: LaneboardError) => LaneboardError): void {
  if (!authorMoves(config, task, actor, to, sessionBase)) return;
  throw refused(authorRefusal(config, task, to, actor, 'update'));
}

// The status the author of the work hands `task` in to with finish on a board with checks (B-U1 run 2): the check the task is in,
// else the first check. Never a check before the current one: that would undo the checks the task passed.
function handInStatus(review: readonly string[], task: TaskT): string {
  return review.includes(task.status) ? task.status : (review[0] ?? '');
}

// The refusal of the author's move into `target` on a board with checks (review r2, B-U1 run 2): a task that waits in a check (handed
// in or passed on) is handed in already, nothing to do (alreadyHandedIn); else the hand-in with finish (handInToFirstCheck).
function authorRefusal(config: ConfigT, task: TaskT, target: string, actor: string, via: 'finish' | 'update'): LaneboardError {
  const review = reviewStatuses(config);
  if (review.includes(task.status) && handedIn(task, config)) return alreadyHandedIn(config, task, actor);
  return handInToFirstCheck(config, task, target, actor, via);
}

// INVALID_VALUE of the author's finish, update or claim of a task that waits in a check (B-U1 run 2): it is handed in, the checkers
// move it on. The fix is a comment (rule 13: it may be run blindly), never a hand-in again into an earlier check.
function alreadyHandedIn(config: ConfigT, task: TaskT, actor: string): LaneboardError {
  const final = finalStatuses(config.statuses)[0] ?? '';
  return new LaneboardError(
    'INVALID_VALUE',
    `${task.id} is handed in already and waits in ${task.status} for the check of ${checkersOf(config, task)} (${checksLine(reviewStatuses(config), final)}): nothing to do; the author never moves it to another check or into ${final}, and a note for the checkers is a comment${noCheckerExit(config, task)}`,
    { fix: `laneboard comment ${task.id} "<note for the check>" --as ${actor} --json` },
  );
}

// Does `task` wait for a check (S6w r2): it is in a check status, handed in or passed on (handedIn, whoever holds it now). Nobody
// claims such a task, and prime lists it among no free tasks: a checker checks it with finish, its author never moves it (S6u).
export function waitsInCheck(config: ConfigT, task: TaskT): boolean {
  return reviewStatuses(config).includes(task.status) && handedIn(task, config);
}

// The names of config review.by that may check `task`: not an author of the work (workedOn). Empty when review.by is not set.
function checkersLeft(config: ConfigT, task: TaskT): string[] {
  return reviewers(config).filter((name) => !workedOn(task, name));
}

// Is no checker left for a task that waits in a check (S6w r2): review.by is set and every name in it worked on the task (an author,
// say a checker the orchestrator gave the task to), so nobody may pass it on or accept it; only the owner adds a checker.
export function noCheckerLeft(config: ConfigT, task: TaskT): boolean {
  return reviewers(config).length > 0 && checkersLeft(config, task).length === 0 && waitsInCheck(config, task);
}

// The owner's command that adds a checker to config review.by, keeping the ones there (config --reviewers replaces the list).
export function addCheckerCommand(config: ConfigT): string {
  return `laneboard config --reviewers "${[...reviewers(config), '<another checker>'].join(',')}"`;
}

// Who checks `task` in a message: the names of review.by that are no authors of it, anybody but the author when review.by is not set.
function checkersOf(config: ConfigT, task: TaskT): string {
  if (reviewers(config).length === 0) return 'a checker (anybody but the author of the work)';
  const left = checkersLeft(config, task);
  return left.length > 0 ? left.join(', ') : 'nobody: every checker in config review.by worked on it';
}

// The way out a refusal names when no checker is left for `task` (noCheckerLeft): the owner adds one; '' otherwise.
function noCheckerExit(config: ConfigT, task: TaskT): string {
  return noCheckerLeft(config, task) ? `; no checker is left for it, so the owner adds one: ${addCheckerCommand(config)}` : '';
}

// Tasks that wait in a check with no checker left (noCheckerLeft), with the owner's command that adds one; undefined when there is none.
// One text for the doctor check `checks`, the config warning and the hand-in warning (noCheckerWarning, S6w r3).
export function stuckInChecks(config: ConfigT, tasks: readonly TaskT[]): string | undefined {
  const stuck = tasks.filter((t) => noCheckerLeft(config, t)).map((t) => `${t.id} (${t.status})`);
  if (stuck.length === 0) return undefined;
  return `tasks waiting in a check that no checker may check (every name in config review.by worked on them): ${stuck.join(', ')}; the owner adds a checker: ${addCheckerCommand(config)}`;
}

// The warning of a hand-in that leaves `task` with no checker (S6w r3: review.by names only its authors, e.g. only the one that handed it
// in): the hand-in is written, and the owner's config --reviewers is the way out (stuckInChecks).
function noCheckerWarning(config: ConfigT, task: TaskT, warnings: string[]): void {
  const stuck = stuckInChecks(config, [task]);
  if (stuck !== undefined) warnings.push(stuck);
}

// May `name` check `task` now (S6x B-U2): the task waits in a check, `name` is no author of the work (workedOn; `sessionBase` when it
// is the actor's own name) and is a checker (in review.by, or anybody when review.by is not set). False without checks.
function mayCheck(config: ConfigT, task: TaskT, name: string, sessionBase: string | undefined): boolean {
  if (!waitsInCheck(config, task) || workedOn(task, name, sessionBase)) return false;
  const by = reviewers(config);
  return by.length === 0 || by.includes(name);
}

// The warning of an update that gave a task waiting for a check to a name that could check it (mayCheck before the write, S6x B-U2): the
// holder is an author of the work from now on (workedOn), so it never checks it, and giving the task to another name later does not
// change that. The way out, as stuckInChecks: the checkers left, else the owner's config --reviewers. Nothing once it waits no more.
function checkerHoldsWarning(config: ConfigT, task: TaskT, actor: string, warnings: string[]): void {
  if (!waitsInCheck(config, task) || task.assignee === null) return;
  const who = task.assignee === actor ? 'you hold it' : `${task.assignee} holds it`;
  const left = checkersLeft(config, task);
  const exit =
    reviewers(config).length === 0
      ? 'anybody else but its authors checks it'
      : left.length > 0
        ? `the check stays with ${left.join(', ')}`
        : `no checker is left for it, so the owner adds one: ${addCheckerCommand(config)}`;
  const next = nextAfterCheck(config, task.status);
  warnings.push(
    `${task.id} waits in ${task.status} for a check, and ${who} now: a holder is an author of the work and never checks it (giving it to another name later does not change that); ${exit}. ` +
      `A check needs no claim or assignment: a checker runs laneboard finish ${task.id} --status ${next} --result "<result of your check>" --json`,
  );
}

// The refusal of a claim of a task that waits for a check (waitsInCheck, S6w r2), for everybody. Its author gets the S6u refusal
// (alreadyHandedIn: nothing to do, a comment). A checker that may check it (in review.by when set, not an author) gets unclearCheck: the
// fix reads the task, the message names the pass and the return. Anybody else a comment (ALREADY_CLAIMED when somebody else holds it).
// When no checker is left, the message names the owner's way out (noCheckerExit).
function waitingClaimRefusal(config: ConfigT, task: TaskT, actor: string, sessionBase: string | undefined): LaneboardError {
  if (workedOn(task, actor, sessionBase)) return alreadyHandedIn(config, task, actor);
  const by = reviewers(config);
  if (by.length === 0 || by.includes(actor)) {
    return unclearCheck(config, task, actor, 'claim never takes a task that waits for a check: a check needs no claim, and holding the task would make you an author of the work, who never checks it');
  }
  const final = finalStatuses(config.statuses)[0] ?? '';
  const message =
    `${task.id} is handed in and waits in ${task.status} for the check of ${checkersOf(config, task)} (${checksLine(reviewStatuses(config), final)}): claim never takes a task that waits for a check ` +
    `(a checker passes it on with finish, no claim needed; the author never moves it), and a note for the checkers is a comment${noCheckerExit(config, task)}`;
  const fix = `laneboard comment ${task.id} "<note for the check>" --as ${actor} --json`;
  const holder = task.assignee;
  if (holder !== null && holder !== actor) return new LaneboardError('ALREADY_CLAIMED', message, { details: { assignee: holder }, fix });
  return new LaneboardError('INVALID_VALUE', message, { fix });
}

// The refusal of update --assignee <actor> of a task that waits for a check by a name that may not check it and did not work on it
// (LB-63.6: no way around waitingClaimRefusal; a checker gets the S6x B-U2 warning instead, its author keeps the move). ALREADY_CLAIMED
// when somebody holds it, else INVALID_VALUE, as claim; the fix is a comment.
function waitingTakeRefusal(config: ConfigT, task: TaskT, actor: string): LaneboardError {
  const final = finalStatuses(config.statuses)[0] ?? '';
  const message =
    `${task.id} is handed in and waits in ${task.status} for the check of ${checkersOf(config, task)} (${checksLine(reviewStatuses(config), final)}): ` +
    `you may not check it (config review.by: ${reviewers(config).join(', ')}), so you never take it: update --assignee takes no task that waits for a check, as claim does not; ` +
    `a note for the checkers is a comment${noCheckerExit(config, task)}`;
  const fix = `laneboard comment ${task.id} "<note for the check>" --as ${actor} --json`;
  if (task.assignee !== null) return new LaneboardError('ALREADY_CLAIMED', message, { details: { assignee: task.assignee }, fix });
  return new LaneboardError('INVALID_VALUE', message, { fix });
}

// The refusal of update --status <a work status> of a task that waits for a check by a name that may not check it and did not work on
// it (LB-63.6, the other order of waitingTakeRefusal: a return for rework by another hand, then update --assignee itself). The same
// codes and fix as waitingTakeRefusal; the message names who returns it for rework.
function waitingMoveRefusal(config: ConfigT, task: TaskT, actor: string): LaneboardError {
  const final = finalStatuses(config.statuses)[0] ?? '';
  const message =
    `${task.id} is handed in and waits in ${task.status} for the check of ${checkersOf(config, task)} (${checksLine(reviewStatuses(config), final)}): ` +
    `you may not check it (config review.by: ${reviewers(config).join(', ')}), so you never move it out of the check: a checker passes it on with finish or returns it for rework; ` +
    `a note for the checkers is a comment${noCheckerExit(config, task)}`;
  const fix = `laneboard comment ${task.id} "<note for the check>" --as ${actor} --json`;
  if (task.assignee !== null) return new LaneboardError('ALREADY_CLAIMED', message, { details: { assignee: task.assignee }, fix });
  return new LaneboardError('INVALID_VALUE', message, { fix });
}

// The checks of a board as one line for messages: `code_review -> qa -> done`.
function checksLine(review: readonly string[], final: string): string {
  return [...review, final].join(' -> ');
}

// INVALID_VALUE of the assignee's finish or update into the final status or a later check, on a board with checks: the assignee hands
// in to the first check (handInStatus, the check the task is in when it is in one), the checks set the rest (P1). finish: the CLI fix is
// the caller's own command with that check (input); update: the finish that hands in, after the reopen of a closed task (handInLine).
function handInToFirstCheck(config: ConfigT, task: TaskT, target: string, actor: string, via: 'finish' | 'update'): LaneboardError {
  const review = reviewStatuses(config);
  const first = handInStatus(review, task);
  const fix = handInLine(config, task, first, actor, true);
  const closed = finalStatuses(config.statuses).includes(task.status) ? ` (it is ${task.status}: reopen it into ${reworkStatus(config)} first)` : '';
  const message = `on this board ${target} is set by a check (${checksLine(review, finalStatuses(config.statuses)[0] ?? '')}): hand ${task.id} in to ${first} with finish${closed}, a checker passes it on and accepts it`;
  return via === 'finish'
    ? new LaneboardError('INVALID_VALUE', message, { allowed: [first], input: { field: 'status', value: target, suggestion: first }, fix })
    : new LaneboardError('INVALID_VALUE', message, { fix });
}

// The hand-in of `task` into the check `check` as one command line, run as printed (rule 13), by `actor` (no --as when undefined: who did
// the work runs it). A task in a final status is reopened first into the work status (reworkStatus): finish never reopens a closed task
// (ADR §20), so a bare finish there would change nothing (S6w r1). `json`: each command with --json, as a fix (rule 3, LB-63.2).
function handInLine(config: ConfigT, task: TaskT, check: string, actor: string | undefined, json = false): string {
  const as = `${actor === undefined ? '' : ` --as ${actor}`}${json ? ' --json' : ''}`;
  const handIn = `laneboard finish ${task.id} --status ${check} --result "<what you did, how you checked it>"${as}`;
  if (!finalStatuses(config.statuses).includes(task.status)) return handIn;
  return `laneboard update ${task.id} --status ${reworkStatus(config)}${as} && ${handIn}`;
}

// Tasks that sit in a check but are not handed in (S6w r1: config turned their status into a check while they were in work there, or a
// board from before the checks): no checker sees them. The text names each task with the hand-in its holder runs (handInLine); undefined
// when there is none or the board has no checks. One text for the config warning and the doctor check.
export function unseenInChecks(config: ConfigT, tasks: readonly TaskT[]): string | undefined {
  const review = reviewStatuses(config);
  const lines = tasks
    .filter((t) => review.includes(t.status) && !handedIn(t, config))
    .map((t) => `${t.id} (${t.status}, ${t.assignee === null ? 'unassigned' : `held by ${t.assignee}`}): ${handInLine(config, t, t.status, t.assignee ?? undefined)}`);
  if (lines.length === 0) return undefined;
  return `tasks in a check that are not handed in, so no checker sees them; the holder of each hands it in (an unassigned one: who did its work): ${lines.join('; ')}`;
}

// Tasks handed in to a status that is no check on a board with checks (S6y U1 run 6: a finish into a work status before 0.4.0's refusal,
// handInOutsideCheck, or a board that turned checks on later): no checker sees them. The text names each task with the hand-in its
// holder runs into the first check (handInLine); undefined when there is none or the board has no checks. One text for doctor and config.
export function handedInOutsideChecks(config: ConfigT, tasks: readonly TaskT[]): string | undefined {
  const review = reviewStatuses(config);
  if (review.length === 0) return undefined;
  const finals = finalStatuses(config.statuses);
  const lines = tasks
    .filter((t) => !review.includes(t.status) && !finals.includes(t.status) && handedIn(t, config))
    .map((t) => `${t.id} (${t.status}, ${t.assignee === null ? 'unassigned' : `held by ${t.assignee}`}): ${handInLine(config, t, handInStatus(review, t), t.assignee ?? undefined)}`);
  if (lines.length === 0) return undefined;
  return `tasks handed in to a status that is no check, so no checker sees them; the holder of each hands it in to a check (an unassigned one: who did its work): ${lines.join('; ')}`;
}

// INVALID_VALUE of the holder's finish into a status that is neither a check nor final on a board with checks (S6y U1 run 6, I1: a
// hand-in lives only in a check, there the checkers see it). The fix keeps what the command meant, the task in `target` with the result
// and no hand-in (reworkFix: the comment, then update); the message names the hand-in, finish --status <the check it is in, else the first>, or, for a
// task that waits in a check, says it is handed in already (alreadyHandedIn's words, review r1).
function handInOutsideCheck(config: ConfigT, task: TaskT, target: string, text: string, actor: string): LaneboardError {
  const review = reviewStatuses(config);
  const check = handInStatus(review, task);
  const checks = checksLine(review, finalStatuses(config.statuses)[0] ?? '');
  const fix = reworkFix(task.id, text, target, actor);
  // A task that waits in a check is handed in already (review r1): no hand-in to name, as in alreadyHandedIn; the move takes it out.
  if (waitsInCheck(config, task)) {
    return new LaneboardError(
      'INVALID_VALUE',
      `${task.id} is handed in already and waits in ${task.status} for the check of ${checkersOf(config, task)} (${checks}): nothing to hand in, and ${target} is no check (a hand-in goes only to a check); ` +
        `to put it into ${target} with your result, out of the checkers' queue (the hand-in is gone): comment, then laneboard update ${task.id} --status ${target}${noCheckerExit(config, task)}`,
      { fix },
    );
  }
  return new LaneboardError(
    'INVALID_VALUE',
    `on this board ${target} is no check (${checks}): finish hands a task in, and a hand-in goes only to a check, where the checkers see it; ` +
      `to hand ${task.id} in: laneboard finish ${task.id} --status ${check} --result "<what you did, how you checked it>"; to put it into ${target} with your result, not handed in: comment, then laneboard update ${task.id} --status ${target}`,
    { fix },
  );
}

// The return for rework of `task` since its last hand-in (S6y U2 run 6, review r1, r2): the newest status event that handed the task in
// or passed it on (handed_in, passed), and the first status event after it is a move (update or claim, no mark) by a name that is no
// author of the work (workedOn: a checker or a third party; the author's own move out of the check is no return). Later moves by the
// author (update to blocked, back to work) keep it, and so do later moves by another name into a work status or the first status while
// the return has a reason; a new hand-in or pass, an acceptance, or a later move by another name back into a check (without checks: into
// the status it was handed in to) or with no reason ends it. Who returned it, when, from where to where, and the reason: the first line
// of the returner's newest comment after the hand-in (before or after the move, as lastComment shows it). undefined when it ended, the
// task is closed, never was handed in, its first move after the hand-in is the author's, or the events limit dropped the hand-in.
// One definition for the refusals of a stale check (returnedForRework), the returner's warning (noReasonWarning) and the author's
// feedback in prime and task_prime (S6z U1 run 7: a comment from before the last hand-in is never shown as the reason).
interface ReworkReturn {
  actor: string;
  at: string;
  from: string;
  to: string;
  // The returner's newest comment since the hand-in, as lastComment shows it; undefined: returned with no reason.
  reason: LastComment | undefined;
}

// The index in `task.events` of its newest status event that handed it in or passed it on (handed_in, passed); -1 without one.
// Exported for prime's feedback: comments before it belong to an earlier round (S6z U1).
export function lastHandInIndex(task: TaskT): number {
  return task.events.findLastIndex((e) => e.type === 'status' && (e.data.handed_in === true || e.data.passed === true));
}

// The ReworkReturn of `task`, or undefined (see ReworkReturn). Exported for prime's feedback (summaryRoles).
export function reworkReturn(config: ConfigT, task: TaskT): ReworkReturn | undefined {
  if (finalStatuses(config.statuses).includes(task.status)) return undefined;
  const events = task.events;
  const handIn = lastHandInIndex(task);
  if (handIn < 0) return undefined;
  const since = events.slice(handIn + 1);
  const moves = since.filter((e) => e.type === 'status');
  if (moves.some((e) => e.data.accepted === true)) return undefined;
  const move = moves[0];
  if (move === undefined || workedOn(task, move.actor)) return undefined;
  const comments = since.filter((e) => e.type === 'commented' && e.actor === move.actor);
  const reason = lastComment({ ...task, events: comments }) ?? undefined;
  // A later move by a name that is no author ends the return only when it put the task back into a check (or, without checks, into the
  // status it was handed in to: ADR §43 A14, s4 LB-9) or the return has no reason (review r2); a move into work or the first status by
  // the orchestrator keeps it, so a stale check still gets the refusal that names the reason, never a "hand it in" comment (§54 r1).
  const handedTo = events[handIn]?.data.to;
  const intoCheck = (to: unknown): boolean => reviewStatuses(config).includes(String(to)) || to === handedTo;
  const later = moves.slice(1).filter((e) => !workedOn(task, e.actor));
  if (later.length > 0 && (reason === undefined || later.some((e) => intoCheck(e.data.to)))) return undefined;
  return { actor: move.actor, at: move.at, from: String(move.data.from), to: String(move.data.to), reason };
}

// The refusal of somebody else's check, acceptance or move into a check of a task returned for rework (reworkReturn, S6y U2 run 6): its
// holder works on it, nothing is to check. The fix only reads the task (I3), never a comment asking to hand it in: the rework is not
// done, and under a returned task the holder's prime shows only the returner's comment since the hand-in (S6z, feedbackOf), so a note of
// another name never reaches it there and one of the returner itself would become the reason (ADR §54 r1). ALREADY_CLAIMED whether it
// came by finish or by update (LB-63.1: one situation, one code; its holder works on it).
function returnedForRework(task: TaskT, r: ReworkReturn, actor: string): LaneboardError {
  const holder = task.assignee ?? 'its next holder';
  const why = r.reason === undefined ? 'with no comment' : `reason: ${JSON.stringify(r.reason.text)}`;
  const mover = r.actor === actor ? 'you' : r.actor;
  const note = r.actor === actor ? `a comment from you now would become the reason in ${holder}'s prime` : `under it ${holder}'s prime shows only what ${r.actor} commented since the hand-in, never a note from you`;
  return new LaneboardError(
    'ALREADY_CLAIMED',
    `${task.id} was returned for rework by ${mover} at ${r.at} (${r.from} -> ${r.to}), ${why}; it is ${task.status} with ${holder} and not handed in, so there is nothing to check: ` +
      `it comes back to the checkers' queue (laneboard prime) when ${holder} hands it in again; ${note}, so the fix only reads the task`,
    { details: { assignee: task.assignee }, fix: `laneboard get ${task.id} --json` },
  );
}

// The return for rework this write made (reworkReturn by `actor` at `now`), on a board with checks: `actor` just moved the handed-in
// task out of its check and is no author of the work. One test for the reply's confirmation (S7a U6 run 8) and noReasonWarning.
function returnByThisWrite(config: ConfigT, task: TaskT, actor: string, now: string): ReworkReturn | undefined {
  if (reviewStatuses(config).length === 0) return undefined;
  const back = reworkReturn(config, task);
  return back !== undefined && back.actor === actor && back.at === now ? back : undefined;
}

// The warning of a return for rework with no reason (S6z U1 run 7): `back` is the return this write made (returnByThisWrite) and
// `actor` wrote no comment since the hand-in, so the holder's prime says "returned with no reason". Only the warning names a
// placeholder; a comment written now becomes the reason (reworkReturn reads the returner's comments since the hand-in, before or after
// the move). undefined: the return has a reason.
function noReasonWarning(task: TaskT, actor: string, back: ReworkReturn): string | undefined {
  if (back.reason !== undefined) return undefined;
  const holder = task.assignee ?? 'its next holder';
  return `${task.id} went back for rework with no reason from you: ${holder}'s prime says it was returned with no reason; add the reason (shown to ${holder} until the next hand-in): laneboard comment ${task.id} --as ${actor} --json -- '<why it goes back>'`;
}

// The return for rework as one command line, run as printed (rule 13): the comment with the caller's text, then the move into `to`.
// No `input` goes with it, so the CLI keeps it as is and never rebuilds the caller's finish with another status (B-U1 run 3). The text
// goes after `--`, as the CLI asks for text that starts with "-" ("- missing test", "--broken"): it is never read as an option; so --json
// (rule 3, LB-63.2) goes before it.
function reworkFix(id: string, text: string, to: string, actor: string): string {
  return `laneboard comment ${id} --as ${actor} --json -- ${shellQuote(text)} && laneboard update ${id} --status ${to} --as ${actor} --json`;
}

// Does a checker's finish into `target` (not a later check, not the first final status) of a task in `current` mean a return for
// rework (B-U1 run 3, review r1): `target` is a work status (not a check, not final), wherever it lies, or a check before `current`.
function isReworkTarget(config: ConfigT, current: string, target: string): boolean {
  if (finalStatuses(config.statuses).includes(target)) return false;
  if (!reviewStatuses(config).includes(target)) return true;
  return config.statuses.indexOf(target) < config.statuses.indexOf(current);
}

// INVALID_VALUE of a checker's finish into a work status (any status that is neither a check nor final, wherever it lies: also one
// between two checks) or into an earlier check (B-U1 run 3, review r1): that is a return for rework, so the fix is the documented one
// (README "Return for rework"): the comment, then update into `target` when it is a work status, or into the work status before the
// checks when it is an earlier check (the first status when none lies between). A fix of a refusal never changes what the caller
// meant: never a finish that passes the task on or accepts it.
function returnForRework(config: ConfigT, id: string, current: string, target: string, text: string, actor: string): LaneboardError {
  const review = reviewStatuses(config);
  const work = review.includes(target) ? reworkStatus(config) || target : target;
  return new LaneboardError(
    'INVALID_VALUE',
    `${id} is handed in and ${current}: a check passes it on to a later check or accepts it into ${finalStatuses(config.statuses)[0] ?? ''} (${checksLine(review, finalStatuses(config.statuses)[0] ?? '')}), never into ${target}; to return it for rework, comment why, then laneboard update ${id} --status ${work} (the assignee hands it in again with finish)`,
    { fix: reworkFix(id, text, work, actor) },
  );
}

// The status a checker's finish names to pass a task in `status` on (S6w I2): the next check after it, from the last check the final
// status; a task handed in to a status outside the checks goes to the first check. Exported for prime's queue (the ready command).
export function nextAfterCheck(config: ConfigT, status: string): string {
  const review = reviewStatuses(config);
  const final = finalStatuses(config.statuses)[0] ?? '';
  return [...review.slice(review.indexOf(status) + 1), final][0] ?? final;
}

// The work status a return for rework from a check goes to (README "Return for rework"): the one before the checks, else the first.
// Exported for config, which names it (S6x B-U1: claims and returns go there, set by the order of the statuses).
export function reworkStatus(config: ConfigT): string {
  return workStatusBeforeChecks(config) ?? config.statuses[0] ?? '';
}

// INVALID_VALUE of a checker's write whose meaning is not clear (S6w I2, I3): finish without --status, or naming the check the task is
// in, or a later status than the next one (a stale read: the task moved on since), and update or claim of a waiting task into a check.
// The fix is a read (`laneboard get`), which changes nothing: run blindly it never passes the task on, accepts it or returns it. The
// message names both exact commands, to pass the check (finish --status <next>) and to return the task for rework (comment && update).
// The return carries a placeholder for its reason, never the caller's result (S6z U2 run 7: a stale "Code ok" copied from the message
// became the reason the author read); the caller's result goes into neither command.
function unclearCheck(config: ConfigT, task: TaskT, actor: string, why: string): LaneboardError {
  const final = finalStatuses(config.statuses)[0] ?? '';
  const next = nextAfterCheck(config, task.status);
  const pass = `laneboard finish ${task.id} --status ${next} --result "<result of your check>" --as ${actor}`;
  const back = reworkFix(task.id, '<why it goes back>', reworkStatus(config), actor);
  const passWhat = next === final ? `accept it into ${final}` : `pass it on to ${next}`;
  return new LaneboardError(
    'INVALID_VALUE',
    `${task.id} is handed in and waits in ${task.status} (${checksLine(reviewStatuses(config), final)}); ${why}. Read it first (laneboard get ${task.id}), then either ${passWhat}: ${pass}; or return it for rework: ${back}`,
    { fix: `laneboard get ${task.id} --json` },
  );
}

// The refusal of update or claim into a check (S6w I1, reviewMoveRefusal 'check'): a task enters a check only by finish. A checker of a
// task that waits in a check gets unclearCheck (pass with finish --status, or return), a name not in review.by notChecker (a comment);
// its holder or author (or anybody, for an unassigned task) the hand-in with finish into the check it is in, else the first check;
// anybody else the comment that asks the holder to hand it in (ALREADY_CLAIMED, LB-63.1), unless a checker returned it for rework
// (returnedForRework: a read, S6y U2). No refusal's fix moves the task.
function checkEntryRefusal(config: ConfigT, task: TaskT, actor: string, to: string, sessionBase: string | undefined): LaneboardError {
  const review = reviewStatuses(config);
  const final = finalStatuses(config.statuses)[0] ?? '';
  const first = handInStatus(review, task);
  if (review.includes(task.status) && handedIn(task, config) && !workedOn(task, actor, sessionBase)) {
    const by = reviewers(config);
    if (by.length > 0 && !by.includes(actor)) return notChecker(task.id, task.assignee, actor, by);
    return unclearCheck(config, task, actor, `update or claim never moves it to ${to}: a check passes it on with finish`);
  }
  const message = `on this board ${to} is a check (${checksLine(review, final)}): a task enters it only handed in with finish (the result, the commit), so the checkers see it`;
  // A closed task is reopened into the work status first: finish never reopens it (S6w r1).
  const reopen = finalStatuses(config.statuses).includes(task.status) ? `laneboard update ${task.id} --status ${reworkStatus(config)} && ` : '';
  const closed = reopen === '' ? '' : `${task.id} is ${task.status} (closed): reopen it, then `;
  if (task.assignee === null || task.assignee === actor || workedOn(task, actor, sessionBase)) {
    return new LaneboardError('INVALID_VALUE', `${message}; ${closed}hand ${task.id} in: ${reopen}laneboard finish ${task.id} --status ${first}`, {
      fix: handInLine(config, task, first, actor, true),
    });
  }
  const back = reworkReturn(config, task);
  if (back !== undefined) return returnedForRework(task, back, actor);
  // ALREADY_CLAIMED, as a checker's finish of that task (notHandedInForCheck, LB-63.1): somebody else holds it and has not handed it in.
  return new LaneboardError('ALREADY_CLAIMED', `${message}; ${task.id} is held by ${task.assignee}: ask it to ${reopen === '' ? '' : 'reopen and '}hand the task in (${reopen}laneboard finish ${task.id} --status ${first})`, {
    details: { assignee: task.assignee },
    fix: `laneboard comment ${task.id} "hand it in: ${reopen}laneboard finish ${task.id} --status ${first} --result <result>" --as ${actor} --json`,
  });
}

// ALREADY_CLAIMED of somebody not in review.by passing on, accepting or closing a task: the fix is the comment (it may be run blindly).
function notChecker(id: string, holder: string | null, actor: string, by: readonly string[]): LaneboardError {
  const owner = holder ?? 'its assignee';
  return new LaneboardError(
    'ALREADY_CLAIMED',
    `on this board only ${by.join(', ')} pass ${id} on to the next check or close it (config review.by), and you write as ${actor}; do not take it over: comment or ask the orchestrator`,
    { details: { assignee: holder }, fix: `laneboard comment ${id} "<note for ${owner}>" --as ${actor} --json` },
  );
}

// ALREADY_CLAIMED of a check of a task that is not handed in, on a board with checks (whoever holds it: the hand-in is the task's, S6w r1): no command that closes it around the
// check is named (A14); the fix asks the holder to hand it in. A task returned for rework gets returnedForRework instead (S6y U2).
function notHandedInForCheck(id: string, holder: string, current: string, actor: string, first: string): LaneboardError {
  return new LaneboardError(
    'ALREADY_CLAIMED',
    `task ${id} is claimed by ${holder} and is ${current}, not handed in with finish; a check passes on or accepts only a handed-in task (laneboard finish ${id} --status ${first}); do not take it over: ask ${holder} to hand it in`,
    { details: { assignee: holder }, fix: `laneboard comment ${id} "hand it in: laneboard finish ${id} --status ${first} --result <result>" --as ${actor} --json` },
  );
}

// A17 on a board with checks: an update or claim that moves a handed-in task into `to` takes the hand-in away (a return for rework does so
// on purpose). Each command it names runs on the task as it is after the move (S6w r1: no finish without --status, which a checker's
// finish refuses): into a work status the hand-in again of `holder` (who holds it after the write; none: who did the work); into the
// final status (closed by update, no acceptance mark) the comment with the result of the check. A check passes a task on or accepts it
// with finish --status <next> (nextAfterCheck), named as the way instead of such a move.
function handInLostWarning(config: ConfigT, task: TaskT, to: string, holder: string | null): string {
  const final = finalStatuses(config.statuses)[0] ?? '';
  const next = nextAfterCheck(config, task.status);
  const instead = `a check passes it on or accepts it with finish --status ${next}, not by a move`;
  if (finalStatuses(config.statuses).includes(to)) {
    return `${task.id} was handed in; closed by this move it has no result of a check and no acceptance mark (${instead}): record the result with laneboard comment ${task.id} "<result of your check>" --json`;
  }
  const first = reviewStatuses(config)[0] ?? final;
  const as = holder === null ? '' : ` --as ${holder}`;
  return `${task.id} was handed in; after this move it is not (${instead}), so no checker sees it until it is handed in again: laneboard finish ${task.id} --status ${first} --result "<what you did, how you checked it>"${as} --json`;
}

// ALREADY_CLAIMED of a finish by somebody else into a status that is not final: acceptance only closes a task.
// The fix stays the comment to the holder: it may be run blindly.
function notFinalTarget(id: string, holder: string, current: string, actor: string, final: string): LaneboardError {
  return new LaneboardError(
    'ALREADY_CLAIMED',
    `task ${id} is claimed by ${holder} and is ${current}; somebody else's finish only accepts a task its assignee handed in, into ${final}; do not take it over: comment or ask the orchestrator`,
    { details: { assignee: holder }, fix: `laneboard comment ${id} "<note for ${holder}>" --as ${actor} --json` },
  );
}

// Statuses the holder can hand a task in to with finish (LB-11 a): every finish status that is not final, with no meaning read
// from positions; the only one by name, several as `<one of: a, b>` (the current status alone would leave the task in work).
function handInStatuses(statuses: readonly string[]): string {
  const finals = finalStatuses(statuses);
  const open = finishStatuses(statuses).filter((st) => !finals.includes(st));
  return open.length === 1 ? (open[0] ?? '<status>') : open.length === 0 ? '<status>' : `<one of: ${open.join(', ')}>`;
}

// ALREADY_CLAIMED of an acceptance of a task its assignee did not hand in with finish (in work, or moved by update). The fix is one
// command run as is (rule 13): the comment asking the holder to hand it in; the message names the orchestrator's update (LB-11 d). A task
// returned for rework gets returnedForRework instead (S6y U2, ADR §54 r1: its holder reworks it, nothing to hand in yet).
function notHandedIn(id: string, holder: string, current: string, actor: string, final: string, statuses: readonly string[]): LaneboardError {
  const handIn = handInStatuses(statuses);
  return new LaneboardError(
    'ALREADY_CLAIMED',
    `task ${id} is claimed by ${holder} and is ${current}, not handed in with finish; somebody else's finish only accepts a task its assignee handed in (laneboard finish ${id} --status ${handIn}); do not take it over: ask ${holder} to hand it in, or close it as the orchestrator: laneboard update ${id} --status ${final} --as ${actor}`,
    { details: { assignee: holder }, fix: `laneboard comment ${id} "hand it in: laneboard finish ${id} --status ${handIn} --result <result>" --as ${actor} --json` },
  );
}

// The commit finish links and what git says about it: HEAD of the input's cwd, else of the command's folder; or the commit the caller
// named, checked in that folder (git not there or no repository: linked as given, with the "could not check git" warning). Nothing
// with no_commit, which goes with neither commit nor cwd.
async function finishCheckout(ctx: OpContext, p: FinishInputT): Promise<CheckoutState> {
  if (p.no_commit === true) {
    if (p.commit !== undefined || p.cwd !== undefined) {
      throw new LaneboardError('USAGE', 'no_commit links no commit, and commit or cwd names the one to link: pass one of them', { edit: { drop: [{ name: 'no_commit' }] } });
    }
    return {};
  }
  const where = p.cwd ?? ctx.cwd;
  if (where === undefined) return {};
  if (p.cwd !== undefined && !isDirectory(p.cwd)) {
    throw new LaneboardError('INVALID_VALUE', `cwd: ${p.cwd} is not a directory`, {
      input: { field: 'cwd', value: p.cwd, format: '<absolute path of your worktree>' },
      fix: 'pass cwd: the absolute path of the folder with your work (your git worktree)',
    });
  }
  if (p.commit === undefined) return readCheckout(where);
  const named = await readCommit(where, p.commit);
  if (named.unknown === true) {
    throw new LaneboardError('INVALID_VALUE', `commit: ${p.commit} is no commit of the git repository at ${where}`, {
      input: { field: 'commit', value: p.commit, format: '<sha>' },
      fix: 'in the folder with your work run git rev-parse HEAD and pass that sha as commit',
    });
  }
  return { head: named.sha ?? p.commit.toLowerCase(), committedAt: named.committedAt, problem: named.problem };
}

// The text of the newest result comment (`commented` with `result: true`, written only by finish), if any.
function lastResultText(task: TaskT): string | undefined {
  for (let i = task.events.length - 1; i >= 0; i--) {
    const e = task.events[i];
    if (e?.type === 'commented' && e.data.result === true) return typeof e.data.text === 'string' ? e.data.text : undefined;
  }
  return undefined;
}

// Most other worktrees a warning names.
const WORKTREES_SHOWN = 3;

// Warning that HEAD of the main checkout may be the wrong commit (A18, LB-1, B-U4): finish ran there (the CLI in the main folder, an MCP
// server started in the project root) without commit or cwd, and other worktrees of the repository have another HEAD committed since
// the actor's work began (any, when that is unknown). It names the folder, its HEAD and those worktrees (newest first). The fix never
// guesses (it may be run blindly, rule 13): one such worktree gets the exact relink command; with several only the agent knows which
// one holds its work, so the command links the sha of it, a placeholder (refused as is: --commit takes hex only), and only then, after
// `&&`, drops the link of this HEAD (LB-55.2: one command, never a removal run blindly). Finish from a linked worktree (also of a bare
// repository, which has no main checkout) links that worktree's HEAD and gets none. `status`: the task's status after finish, for the command.
async function worktreeWarning(cwd: string, id: string, linked: string, workStart: string | undefined, actor: string, status: string): Promise<string | undefined> {
  const trees = await readWorktrees(cwd);
  if (trees?.main === undefined || !samePath(trees.main, trees.here)) return undefined;
  const main = trees.main;
  const since = workStart === undefined ? undefined : Math.floor(Date.parse(workStart) / 1000);
  const others = trees.list
    .filter((w) => !samePath(w.path, main) && w.head !== linked && (since === undefined || (w.committedAt ?? 0) >= since))
    .sort((a, b) => (b.committedAt ?? 0) - (a.committedAt ?? 0));
  if (others.length === 0) return undefined;
  const only = others.length === 1 ? others[0] : undefined;
  const named = others.slice(0, WORKTREES_SHOWN).map((w) => `${w.path} (${w.branch ?? 'detached'}) ${w.head.slice(0, 12)}`);
  if (others.length > WORKTREES_SHOWN) named.push(`${others.length - WORKTREES_SHOWN} more: git worktree list`);
  const which = since === undefined ? 'other worktrees of this repository have another HEAD' : `other worktrees of this repository have commits since you claimed ${id}`;
  const branch = trees.list.find((w) => samePath(w.path, main))?.branch ?? 'detached';
  const fix =
    only !== undefined
      ? `if your work is in one of them, link its commit instead: laneboard update ${id} --remove-link commit=${linked} --add-link commit=${only.head} --as ${actor} --json`
      : `if your work is in one of them, link the HEAD of yours (listed above) instead of this one: laneboard finish ${id} --status ${status} --commit <HEAD of your worktree> --result "<your result>" --as ${actor} --json ` +
        `&& laneboard update ${id} --remove-link commit=${linked} --as ${actor} --json`;
  return (
    `the linked commit ${linked.slice(0, 12)} is HEAD of ${trees.here} (${branch}), the main checkout, and ${which}: ${named.join(', ')}; ${fix} ` +
    `(next time run finish in that folder or pass --commit <sha>; MCP task_finish: cwd "<that folder>" or commit "<sha>")`
  );
}

// Do two commit refs name one commit: equal, or one is a prefix of at least 7 hex digits of the other (a link added by hand may be short).
function sameCommit(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a.toLowerCase(), b.toLowerCase()] : [b.toLowerCase(), a.toLowerCase()];
  return /^[0-9a-f]{7,}$/.test(short) && long.startsWith(short);
}

// Warning that the commit finish just linked to `id` is linked to other tasks (active or archived) already (LB-55.1): HEAD of a folder
// where another agent committed and finished is not this agent's work. A warning, not a refusal: one commit may hold the work of two
// tasks. The fix links the commit of the agent's work, a placeholder (refused as is: --commit takes hex only), and only then drops this
// link (worktreeWarning's way). Tasks the actor holds itself do not count: one commit for two of its own tasks is its choice.
// undefined: no other task links it; `named`: those tasks, for the worktree warning that replaces this one (finishTask).
function commitLinkedWarning(tasks: readonly TaskT[], id: string, commit: string, status: string, actor: string): { text: string; named: string } | undefined {
  const others = tasks.filter((t) => t.id !== id && t.assignee !== actor && t.links.some((l) => l.kind === 'commit' && sameCommit(l.ref, commit)));
  if (others.length === 0) return undefined;
  const named = others.map((t) => (t.assignee === null ? t.id : `${t.id} of ${t.assignee}`)).join(', ');
  const text =
    `commit ${commit.slice(0, 12)} is already linked to ${named}: if it holds the work of both, nothing to do; if it is not your work (HEAD of a folder where another agent committed), ` +
    `link the commit of yours instead: laneboard finish ${id} --status ${status} --commit <sha of your work> --result "<your result>" --as ${actor} --json && laneboard update ${id} --remove-link commit=${commit} --as ${actor} --json`;
  return { text, named };
}

// Warnings that the linked commit may not hold the agent's work (owner's decision, S3b): uncommitted changes (staged or not), or
// HEAD was committed before the actor's work on the task began (`workStart`, unknown for a task it did not hold); and that git could
// not be asked (S3c: finish still works, unknown parts give no other warning). `named`: the caller named the commit (commit), so
// the folder's changes say nothing about it.
function checkoutWarnings(id: string, git: CheckoutState, workStart: string | undefined, named: boolean): string[] {
  const again = `commit your work and run laneboard finish ${id} --json again to link the new commit (work without a commit: --no-commit)`;
  const out: string[] = [];
  if (git.problem !== undefined) {
    const skipped = git.head === undefined ? 'no commit linked' : `not checked whether the linked commit ${git.head.slice(0, 12)} holds your work`;
    out.push(`could not check git (${git.problem}): ${skipped}`);
  }
  if (git.head === undefined) return out;
  const sha = git.head.slice(0, 12);
  if (git.dirty === true) out.push(`the working tree has uncommitted changes to tracked files, so the linked commit ${sha} may not hold your work; ${again}`);
  // Seconds: a commit in the same second as the claim counts as newer.
  if (git.committedAt !== undefined && workStart !== undefined && git.committedAt < Math.floor(Date.parse(workStart) / 1000)) {
    out.push(
      named
        ? `the linked commit ${sha} is from before your work: it was committed before you claimed ${id}; check the sha of your work's commit (git rev-parse HEAD in its folder)`
        : `the linked commit ${sha} is from before your work: HEAD has not moved since you claimed ${id}; ${again}`,
    );
  }
  return out;
}

// A checker's finish of somebody else's task on a board with checks (P1), under the lock: a closed task changes nothing; only review.by
// (when set) check; the task must be handed in (handedIn: handed in or passed on, whoever holds it now). --status names where it
// goes and must be the next status (S6w I2: nextAfterCheck, the next check or from the last one the final status, accepted); without it,
// or with another later status or the current check, unclearCheck (a read as the fix); a work status or an earlier check is the return
// for rework (returnForRework). The actor's own pass repeated with the same --status (a lost reply) changes nothing. `refused` turns a refusal into the
// claim --resume one for a task of an earlier session of the actor (P5); `sessionBase`: those sessions are authors of the work too (workedOn,
// S6w r3). Returns whether it wrote, passed on, and the status it left.
function checkerFinish(
  s: { config: ConfigT; now: string; active: StoreFileT },
  task: TaskT,
  p: FinishInputT,
  actor: string,
  refused: (err: LaneboardError) => LaneboardError,
  warnings: string[],
  notRecorded: string,
  source: ActorSource,
  sessionBase: string | undefined,
): { done: boolean; passed: boolean; from?: string } {
  const id = task.id;
  const holder = task.assignee ?? '';
  const finals = finalStatuses(s.config.statuses);
  const final = finals[0] ?? '';
  const review = reviewStatuses(s.config);
  if (finals.includes(task.status)) {
    warnings.push(`no changes: ${id} is already ${task.status}; ${notRecorded}`);
    return { done: false, passed: false };
  }
  // Handed in to a status outside the checks (finish --status <other>, or before the checks were on): the next step is the first check,
  // so a check never skips the others by default (review r1).
  const at = review.indexOf(task.status);
  const later = [...review.slice(at + 1), final];
  const next = nextAfterCheck(s.config, task.status);
  // The author of the work never checks its own task (review r2): the same rule and error as update and claim. A task that waits in
  // a check is handed in already, whichever status the author names (an earlier check too: B-U1 run 2).
  if (workedOn(task, actor, sessionBase) && review.includes(task.status) && handedIn(task, s.config)) throw alreadyHandedIn(s.config, task, actor);
  checkAuthorMove(s.config, task, actor, p.status ?? next, sessionBase, refused);
  const by = reviewers(s.config);
  if (by.length > 0 && !by.includes(actor)) throw refused(notChecker(id, task.assignee, actor, by));
  // A handed-in task waits for the check whoever holds it now: unassigned or given to another name (review r2, S6w r1).
  if (!handedIn(task, s.config)) {
    const back = reworkReturn(s.config, task);
    throw refused(back === undefined ? notHandedInForCheck(id, holder, task.status, actor, handInStatus(review, task)) : returnedForRework(task, back, actor));
  }
  // The repeat of the actor's own pass into this status (a lost reply: the same --status again) changes nothing.
  if (passedBy(task) === actor && p.status === task.status) {
    warnings.push(`no changes: ${id} is already ${task.status}, where you passed it on (finish repeated); to pass it on yourself again: laneboard finish ${id} --status ${next} --result "<result of your check>" --json; ${notRecorded}`);
    return { done: false, passed: false };
  }
  // A work status (neither a check nor final, before or after the current one) or an earlier check is an explicit return for rework
  // (B-U1 run 3, review r1): its fix is the return, never a pass or an acceptance.
  if (p.status !== undefined && !later.includes(p.status) && isReworkTarget(s.config, task.status, p.status)) {
    throw returnForRework(s.config, id, task.status, p.status, p.result, actor);
  }
  // The checker names where the task goes, the next status after the check it is in (S6w I2): a finish without --status, or naming
  // the check it is in, or a status past the next one, may come from a read before another checker passed it on (two checkers on one
  // prime), so it is refused and its fix only reads the task (I3: no fix passes or accepts a task the caller did not name).
  if (p.status !== next) {
    const why =
      p.status === undefined
        ? `a checker's finish names where it goes (--status ${next}): it may have moved on since you read it`
        : p.status === task.status
          ? `--status ${p.status} is the check it is in now; a checker's finish names where it goes (--status ${next})`
          : later.includes(p.status)
            ? `--status ${p.status} skips ${later.slice(0, later.indexOf(p.status)).join(', ')}; a checker's finish names the next status (--status ${next})`
            : `--status ${p.status} is not where it goes next; a checker's finish names the next status (--status ${next})`;
    throw unclearCheck(s.config, task, actor, why);
  }
  const target = next;
  const from = task.status;
  const accept = target === final;
  touch(task, s.now, actor);
  // The result mark (ADR §27): only finish writes it, so readers tell the result of each check from other comments.
  addEvent(task, s.config, s.now, actor, 'commented', { text: p.result, result: true }, source);
  addEvent(task, s.config, s.now, actor, 'status', { from, to: target, ...(accept ? { accepted: true } : { passed: true }) }, source);
  task.status = target;
  if (accept) {
    const open = openChildrenWarning(s.active, id, finals);
    if (open) warnings.push(open);
  }
  return { done: true, passed: !accept, from };
}

// Close a task in one write: the result comment, the commit of the git checkout (kind=commit; not with no_commit, outside git
// or before the first commit; the input's commit or cwd names another one, finishCheckout), the actor as assignee of an unassigned
// task, then the status (default: the final one), in this event order.
// The assignee (or anybody for an unassigned task) finishes; into a status that is not final it hands the task in (the status event says
// `handed_in: true`, also when the task is already there but was not handed in). Somebody else only accepts: a task its assignee
// handed in (handedIn) into the final status, with the result comment and no commit link (the assignee linked its commit when handing
// in); the assignee stays, the status event says `accepted: true` and its actor is who accepted (LB-9, S4b). A task already in that
// status (handed in) or in a final status keeps its status; a task handed in again into the same status after rework gets the new
// result (a result comment, no status event), the same result text again (a retry) and a closed task get none (a warning); for the
// assignee a commit that is not linked yet is added, so "commit, then finish again" links it; somebody else's finish of a closed task
// changes nothing. On a board with checks an unassigned task waiting in a check is checked, not taken, by anybody but its author
// (review r2, checkerFinish), and the holder hands in only to a check (S6y U1: a status that is no check is refused, handInOutsideCheck).
export async function finishTask(ctx: OpContext, input: FinishInputT): Promise<OpResult<TaskView>> {
  const actor = requireActor(ctx.actor);
  const p = parseInput(FinishInput, input);
  // Asked before the lock: the checkout does not change because of this write.
  const git = await finishCheckout(ctx, p);
  const commit = git.head;
  const warnings: string[] = [];
  let finished = false;
  // The assignee's finish into a status that is not final (hands the task in).
  let handedInNow = false;
  let byOther = false;
  // A checker's finish on a board with checks (P1): it passed the task on (not accepted), and the status the task came from.
  let passedOn = false;
  let checkedFrom: string | undefined;
  let linked = false;
  let workStart: string | undefined;
  // The warning that the linked commit is linked to other names' tasks already (LB-55.1), until the worktree warning may replace it.
  let shared: { text: string; named: string } | undefined;
  let taskId = '';
  const data = await transact(
    ctx.store,
    { files: ['active', 'archive'] },
    (s) => {
      const id = normalizeId(p.id, s.config.prefix);
      taskId = id;
      const finals = finalStatuses(s.config.statuses);
      const allowed = finishStatuses(s.config.statuses);
      let status = p.status ?? finals[0] ?? '';
      if (p.status !== undefined) checkStatus(s.config, p.status);
      // Back to the start is no finish: the fix keeps that meaning (comment, then update), never the final status (B-U1 run 3).
      if (!allowed.includes(status)) {
        throw new LaneboardError('INVALID_VALUE', `"${status}" is the starting status; finish sets one of ${allowed.join(', ')} (default ${finals.join('')}; back to the start: laneboard update ${id} --status ${status})`, {
          allowed,
          fix: reworkFix(id, p.result, status, actor),
        });
      }
      const task = requireActiveTask(s, id, (missing) => missingTask(ctx, missing, s.config.prefix, 'write'));
      const notRecorded = `the result was not recorded (add it with laneboard comment ${id} "<text>")`;
      const review = reviewStatuses(s.config);
      // The owner first: somebody else's task is ALREADY_CLAIMED (review S3 NIT), unless this is an acceptance or the task is closed.
      const holder = task.assignee;
      // The path follows the status on a board with checks (review r2): finish of an unassigned task waiting in a check (handed in,
      // then unassigned) by anybody but its author is a check (review.by when set), which never makes the checker its holder or
      // author; its author takes it back and hands it in again, never past the first check (handInToFirstCheck below).
      const unassignedAtCheck = review.length > 0 && holder === null && review.includes(task.status) && handedIn(task, s.config) && !workedOn(task, actor, ctx.sessionBase);
      byOther = (holder !== null && holder !== actor) || unassignedAtCheck;
      // A task of an earlier session of the actor's default name: take it back first, then finish (P5, S6l); its acceptance stays.
      const refused = (other: LaneboardError): LaneboardError =>
        holder !== null && heldByEarlierSession(task, ctx.sessionBase, actor) ? earlierSessionClaimed(id, holder, actor, silentFor(s.active.tasks, holder, s.now), ', then finish it again') : other;
      if (byOther && review.length > 0) {
        const out = checkerFinish(s, task, p, actor, refused, warnings, notRecorded, actorSourceOf(ctx), ctx.sessionBase);
        finished = out.done;
        passedOn = out.passed;
        checkedFrom = out.from;
        return toTaskView(task, false);
      }
      if (holder !== null && byOther) {
        if (!finals.includes(status)) throw refused(notFinalTarget(id, holder, task.status, actor, finals.join('')));
        // Accepted before (or a retry after a lost lock): nothing to do.
        if (finals.includes(task.status)) {
          warnings.push(`no changes: ${id} is already ${task.status}; ${notRecorded}`);
          return toTaskView(task, false);
        }
        if (!handedIn(task, s.config)) {
          const back = reworkReturn(s.config, task);
          throw refused(back === undefined ? notHandedIn(id, holder, task.status, actor, finals.join(''), s.config.statuses) : returnedForRework(task, back, actor));
        }
        touch(task, s.now, actor);
        // The result mark (ADR §27): only finish writes it, so readers tell the result from other comments.
        addEvent(task, s.config, s.now, actor, 'commented', { text: p.result, result: true }, actorSourceOf(ctx));
        addEvent(task, s.config, s.now, actor, 'status', { from: task.status, to: status, accepted: true }, actorSourceOf(ctx));
        task.status = status;
        finished = true;
        const open = openChildrenWarning(s.active, id, finals);
        if (open) warnings.push(open);
        return toTaskView(task, false);
      }
      // On a board with checks the assignee hands in to the check the task is in, else the first check (the default), never into a
      // later one or the final status; a task already in a check stays there: finish again records a new result (P1) or hands it in
      // there, and never goes back to an earlier check it passed (B-U1 run 2: authorRefusal).
      if (review.length > 0 && !finals.includes(task.status)) {
        const handInAt = handInStatus(review, task);
        if (p.status === undefined) status = handInAt;
        else if (p.status !== handInAt && (finals.includes(p.status) || review.includes(p.status))) throw authorRefusal(s.config, task, p.status, actor, 'finish');
        // A hand-in lives only in a check (S6y U1 run 6, I1): into a work status it would be in no checker's queue.
        else if (!review.includes(p.status) && !finals.includes(p.status)) throw handInOutsideCheck(s.config, task, p.status, p.result, actor);
      }
      // When the actor's work began (across claim --resume, its earlier sessions' too): a commit older than that is not its work.
      workStart = holder === actor ? workStartedAt(task) : undefined;
      const newCommit = commit !== undefined && !task.links.some((l) => l.kind === 'commit' && l.ref === commit) ? commit : undefined;
      const handIn = !finals.includes(status);
      const closed = finals.includes(task.status);
      // Already there: final, or handed in to this status (a task moved there by update is handed in now).
      const again = closed || (task.status === status && (!handIn || handedIn(task, s.config)));
      // Handed in again after rework (CARRYOVER S6h): a result other than the newest one is recorded; the same text again is a retry
      // after a lost reply and records nothing. A closed task keeps its result: finish never reopens it (ADR §20).
      const resubmit = again && !closed && lastResultText(task) !== p.result;
      const kept = closed ? `; ${notRecorded}` : ' with this result';
      if (again && !resubmit && newCommit === undefined) warnings.push(`no changes: ${id} is already ${task.status}${kept}`);
      if (again && !resubmit && newCommit !== undefined) warnings.push(`status and result unchanged: ${id} is already ${task.status}${kept}; commit ${newCommit.slice(0, 12)} linked`);
      if (again && !resubmit && newCommit === undefined) return toTaskView(task, false);
      // One write, one rev, whatever events follow.
      touch(task, s.now, actor);
      if (!again || resubmit) addEvent(task, s.config, s.now, actor, 'commented', { text: p.result, result: true }, actorSourceOf(ctx));
      if (newCommit !== undefined) {
        const links: LinkT[] = [...task.links, { kind: 'commit', ref: newCommit }];
        addEvent(task, s.config, s.now, actor, 'updated', { links: [task.links, links] }, actorSourceOf(ctx));
        task.links = links;
        linked = true;
        shared = commitLinkedWarning([...s.active.tasks, ...s.archive.tasks], id, newCommit, status, actor);
        if (shared !== undefined) warnings.push(shared.text);
      }
      if (again) {
        // The status event of the first hand-in stays the newest one into this status, so the task stays handed in (handedIn).
        finished = resubmit;
        handedInNow = resubmit;
        if (resubmit) noCheckerWarning(s.config, task, warnings);
        return toTaskView(task, false);
      }
      if (task.assignee === null) {
        task.assignee = actor;
        addEvent(task, s.config, s.now, actor, 'assigned', { from: null, to: actor }, actorSourceOf(ctx));
      }
      addEvent(task, s.config, s.now, actor, 'status', { from: task.status, to: status, ...(handIn ? { handed_in: true } : {}) }, actorSourceOf(ctx));
      task.status = status;
      finished = true;
      handedInNow = handIn;
      if (handIn) noCheckerWarning(s.config, task, warnings);
      const open = handIn ? undefined : openChildrenWarning(s.active, id, finals);
      if (open) warnings.push(open);
      return toTaskView(task, false);
    },
    txOptions(ctx, warnings),
  );
  // Only HEAD of the command's own folder can be another worktree's wrong commit; a named commit or folder is the caller's choice.
  const where = p.commit === undefined && p.cwd === undefined ? ctx.cwd : undefined;
  const other = !byOther && commit !== undefined && where !== undefined ? await worktreeWarning(where, taskId, commit, workStart, actor, data.status) : undefined;
  // An acceptance links no commit, so the checkout of who accepts says nothing about the work. With the worktree warning the "HEAD has
  // not moved since you claimed" one says the same thing worse (LB-55.3: run finish again here would link the same HEAD), so it is left out.
  if (!byOther) warnings.push(...checkoutWarnings(taskId, git, other === undefined ? workStart : undefined, p.commit !== undefined));
  // One warning for one wrong commit (review A2 NIT): next to the worktree warning, whose command relinks the commit just as well and
  // names the worktrees, the commit-linked one only adds the tasks that link it too.
  const sharedAt = shared === undefined ? -1 : warnings.indexOf(shared.text);
  if (other !== undefined && sharedAt !== -1) warnings.splice(sharedAt, 1);
  if (other !== undefined) warnings.push(shared === undefined ? other : `${other}; commit ${commit?.slice(0, 12) ?? ''} is already linked to ${shared.named} too`);
  if (finished && byOther) {
    const from = checkedFrom === undefined ? {} : { from: checkedFrom };
    return { data, warnings, reply: passedOn ? { commit: null, passed: true, ...from } : { commit: null, accepted: true, ...from } };
  }
  if (finished) return { data, warnings, reply: { commit: commit ?? null }, ...(handedInNow ? { handed_in: true } : {}) };
  return linked && commit !== undefined ? { data, warnings, reply: { commit }, unchanged: true } : { data, warnings };
}
