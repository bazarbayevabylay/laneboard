// Ops that change an active task: update, claim, comment, finish (task_update, task_claim, task_comment, task_finish).
import path from 'node:path';
import { z } from 'zod';
import { LaneboardError } from '../errors.ts';
import { isDirectory, readCheckout, readCommit, readWorktrees } from '../git.ts';
import type { CheckoutState } from '../git.ts';
import { samePath } from '../store.ts';
import type { ActorSource } from '../agent-name.ts';
import type { ConfigT, LinkT, StoreFileT, TaskT } from '../schema.ts';
import { transact } from '../transact.ts';
import {
  actorSourceOf,
  addEvent,
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
import type { OpContext, OpResult, TaskView } from './common.ts';
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
            fix: `laneboard attach ${id} <path of a file with the text>`,
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
      if (statusChange) checkReviewMove(s.config, task, actor, statusChange.to, assignChange?.to === actor, warnings);

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
    fix: `laneboard comment ${id} "<note for ${holder}>" --as ${actor}`,
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
    { details, fix: `laneboard comment ${id} "<note for ${holder}>" --as ${actor}` },
  );
}

// Take a task: assignee := actor; a task held by someone else fails with ALREADY_CLAIMED, unless `resume` takes it over from
// another session of the same default name base (an `assigned` event with `resumed: true`). A resume warns when that session wrote
// less than EARLIER_SESSION_SILENT_MS ago (a parallel session may still be at work: two tabs after a restart, A-U6) and names the
// parent task held by the same session (finish of the parent needs it back too, A-U2).
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
      const holder = task.assignee;
      const earlier = heldByEarlierSession(task, ctx.sessionBase, actor);
      const resumed = p.resume === true && earlier;
      if (holder !== null && holder !== actor && !resumed) {
        throw earlier ? earlierSessionClaimed(id, holder, actor, silentFor(s.active.tasks, holder, s.now), '') : claimedBy(ctx, id, holder, actor, p.resume === true);
      }
      if (resumed && holder !== null) resumeWarnings(s.active.tasks, task, holder, ctx.sessionBase, actor, s.now, finalStatuses(s.config.statuses), warnings);
      const assignChange = holder !== actor ? { from: holder, to: actor, ...(resumed ? { resumed: true } : {}) } : undefined;
      const statusChange = p.status !== undefined && p.status !== task.status ? { from: task.status, to: p.status } : undefined;
      // The same checks as update (review r1): claim --status is no way around them; the actor holds the task after the claim.
      if (statusChange) checkReviewMove(s.config, task, actor, statusChange.to, true, warnings);
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
    warnings.push(`${task.id} taken from a session active ${minutesText(silent)} ago (${holder}): if it is a parallel session at work, not your own closed one, tell it: laneboard comment ${task.id} "<note for ${holder}>"`);
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
      const task = requireActiveTask(s, id, (missing) => missingTask(ctx, missing, s.config.prefix, 'write'));
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

// Was the task handed in by its assignee: the newest `status` event into its current status is the assignee's finish, which marks
// it `handed_in: true` (S4b, by the data: no meaning is read from the names or the order of statuses), or a checker's finish that
// passed the handed-in task on to the next check (`passed: true`, P1: the hand-in lives on through the checks). False without such an
// event (set by update or claim, created in this status, handed in before the marker, or the event was dropped by the events limit).
export function handedIn(task: TaskT): boolean {
  const e = arrivalEvent(task);
  if (e === undefined) return false;
  return (e.actor === task.assignee && e.data.handed_in === true) || (e.actor !== task.assignee && e.data.passed === true);
}

// Who passed the task on into its current status (a checker's finish, P1), or undefined.
function passedBy(task: TaskT): string | undefined {
  const e = arrivalEvent(task);
  return e !== undefined && e.data.passed === true ? e.actor : undefined;
}

// Is the task waiting in a check by its events, whoever holds it now (review r2): the newest `status` event into its status is a
// hand-in or a checker's pass. An unassigned task handed in and then unassigned by its author still waits for the check.
function waitingByEvents(task: TaskT): boolean {
  const e = arrivalEvent(task);
  return e !== undefined && (e.data.handed_in === true || e.data.passed === true);
}

// Did `actor` do the work on `task` (the author of the work, P1, review r1): its assignee, or a name that held it or handed it in by
// the events kept (an `assigned` event from or to the actor, `created` with it as the assignee, its hand-in). So unassigning the task
// or handing it to another name first does not let its author pass it on or close it, by update, claim or finish (review r2). A
// checker's pass or acceptance is none of these events, so a check never makes the checker an author. No store field records it:
// events dropped by the events limit are not seen (a guard against mistakes, not a hostile agent: actors are self-named).
function workedOn(task: TaskT, actor: string): boolean {
  if (task.assignee === actor) return true;
  return task.events.some(
    (e) =>
      (e.type === 'assigned' && (e.data.from === actor || e.data.to === actor)) ||
      (e.type === 'created' && e.data.assignee === actor) ||
      (e.type === 'status' && e.actor === actor && e.data.handed_in === true),
  );
}

// One rule for a status move by update or claim on a board with checks (P1, review r1): the author of the work (workedOn) never sets
// a later check or the final status, nor another check while the task waits in one (checkAuthorMove, shared with a checker's finish), only review.by (when set) set the final one,
// and an actor that holds the task after this write (`takes`: claim, or update with --assignee itself) does not close it either; a move of a handed-in task warns that the hand-in is lost (A17). Without checks
// nothing here applies (0.3.1, ADR §22).
function checkReviewMove(config: ConfigT, task: TaskT, actor: string, to: string, takes: boolean, warnings: string[]): void {
  const review = reviewStatuses(config);
  if (review.length === 0) return;
  const final = finalStatuses(config.statuses)[0] ?? '';
  const refusal = reviewMoveRefusal(config, task, actor, to, takes);
  if (refusal === 'author') throw authorRefusal(config, task, to, actor, 'update');
  if (refusal === 'not-checker') throw notChecker(task.id, task.assignee, actor, reviewers(config));
  if (refusal === 'holder') throw handInToFirstCheck(task.id, final, handInStatus(review, task), review, final, actor, 'update');
  if (handedIn(task)) warnings.push(handInLostWarning(task.id));
}

// Why a board with checks refuses to put `task` into `to` by `actor` (P1, P2): 'author' - the author of the work (authorMoves);
// 'not-checker' - the final status by a name not in review.by (when set); 'holder' - the final status by the actor that holds the
// task after the write (`takes`). undefined: allowed, and always without checks (0.3.1, ADR §22). One rule for update, claim (each
// with its error, checkReviewMove) and create and import of a task right into a later check or the final status (S6m).
export type ReviewRefusal = 'author' | 'not-checker' | 'holder';

// The refusal of the move, or undefined (see ReviewRefusal).
export function reviewMoveRefusal(config: ConfigT, task: TaskT, actor: string, to: string, takes: boolean): ReviewRefusal | undefined {
  if (reviewStatuses(config).length === 0) return undefined;
  if (authorMoves(config, task, actor, to)) return 'author';
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
  const checks = `on this board ${to} is set by a check (${checksLine(review, final)})`;
  if (refusal === 'not-checker') return `${checks}, only by ${reviewers(config).join(', ')} (config review.by)`;
  return `${checks}: the author of the work hands it in to ${review[0] ?? ''} with finish, a checker passes it on and accepts it`;
}

// Is `task` waiting for a check: handed in or passed on, or unassigned and waiting by its events (the author handed it in, then
// unassigned it: review r2). One condition for checkerFinish and prime's queue (waitsForCheck).
function awaitsCheck(task: TaskT): boolean {
  return handedIn(task) || (task.assignee === null && waitingByEvents(task));
}

// Does `task` wait in a check that `actor` may make (prime's queue for checkers, B-U6): it is in a check status, handed in or passed
// on (an unassigned one by its events, as checkerFinish), `actor` is in review.by (when set), is not the author of the work (workedOn)
// and did not pass it on into this status itself (its finish there changes nothing).
export function waitsForCheck(config: ConfigT, task: TaskT, actor: string): boolean {
  if (!reviewStatuses(config).includes(task.status)) return false;
  if (!awaitsCheck(task)) return false;
  const by = reviewers(config);
  return (by.length === 0 || by.includes(actor)) && !workedOn(task, actor) && passedBy(task) !== actor;
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
function authorMoves(config: ConfigT, task: TaskT, actor: string, to: string): boolean {
  const review = reviewStatuses(config);
  if (review.length === 0) return false;
  if (!workedOn(task, actor)) return false;
  const final = finalStatuses(config.statuses)[0] ?? '';
  if (to === final || review.indexOf(to) > 0) return true;
  return review.includes(to) && to !== task.status && review.includes(task.status) && awaitsCheck(task);
}

// The one author rule of a board with checks (review r2), for update, claim and a checker's finish alike: the author of the work
// (workedOn) neither passes the task on to a later check nor sets the final status, nor moves a task waiting in a check to another
// check; it hands in with finish (handInStatus).
// INVALID_VALUE (authorRefusal). Without checks nothing applies (0.3.1, ADR §22).
function checkAuthorMove(config: ConfigT, task: TaskT, actor: string, to: string): void {
  if (!authorMoves(config, task, actor, to)) return;
  throw authorRefusal(config, task, to, actor, 'update');
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
  if (review.includes(task.status) && awaitsCheck(task)) return alreadyHandedIn(config, task, actor);
  return handInToFirstCheck(task.id, target, handInStatus(review, task), review, finalStatuses(config.statuses)[0] ?? '', actor, via);
}

// INVALID_VALUE of the author's finish, update or claim of a task that waits in a check (B-U1 run 2): it is handed in, the checkers
// move it on. The fix is a comment (rule 13: it may be run blindly), never a hand-in again into an earlier check.
function alreadyHandedIn(config: ConfigT, task: TaskT, actor: string): LaneboardError {
  const by = reviewers(config).filter((name) => name !== actor);
  const checkers = by.length > 0 ? by.join(', ') : 'a checker (anybody but the author of the work)';
  const final = finalStatuses(config.statuses)[0] ?? '';
  return new LaneboardError(
    'INVALID_VALUE',
    `${task.id} is handed in already and waits in ${task.status} for the check of ${checkers} (${checksLine(reviewStatuses(config), final)}): nothing to do; the author never moves it to another check or into ${final}, and a note for the checkers is a comment`,
    { fix: `laneboard comment ${task.id} "<note for the check>" --as ${actor}` },
  );
}

// The checks of a board as one line for messages: `code_review -> qa -> done`.
function checksLine(review: readonly string[], final: string): string {
  return [...review, final].join(' -> ');
}

// INVALID_VALUE of the assignee's finish or update into the final status or a later check, on a board with checks: the assignee hands
// in to the first check (`first`: handInStatus, the check the task is in when it is in one), the checks set the rest (P1). finish: the
// CLI fix is the caller's own command with that check (input); update: the finish that hands in.
function handInToFirstCheck(id: string, target: string, first: string, review: readonly string[], final: string, actor: string, via: 'finish' | 'update'): LaneboardError {
  const fix = `laneboard finish ${id} --status ${first} --result "<what you did, how you checked it>" --as ${actor}`;
  const message = `on this board ${target} is set by a check (${checksLine(review, final)}): hand ${id} in to ${first} with finish, a checker passes it on and accepts it`;
  return via === 'finish'
    ? new LaneboardError('INVALID_VALUE', message, { allowed: [first], input: { field: 'status', value: target, suggestion: first }, fix })
    : new LaneboardError('INVALID_VALUE', message, { fix });
}

// ALREADY_CLAIMED of somebody not in review.by passing on, accepting or closing a task: the fix is the comment (it may be run blindly).
function notChecker(id: string, holder: string | null, actor: string, by: readonly string[]): LaneboardError {
  const owner = holder ?? 'its assignee';
  return new LaneboardError(
    'ALREADY_CLAIMED',
    `on this board only ${by.join(', ')} pass ${id} on to the next check or close it (config review.by), and you write as ${actor}; do not take it over: comment or ask the orchestrator`,
    { details: { assignee: holder }, fix: `laneboard comment ${id} "<note for ${owner}>" --as ${actor}` },
  );
}

// ALREADY_CLAIMED of a check of a task its assignee did not hand in, on a board with checks: no command that closes it around the
// check is named (A14); the fix asks the holder to hand it in.
function notHandedInForCheck(id: string, holder: string, current: string, actor: string, first: string): LaneboardError {
  return new LaneboardError(
    'ALREADY_CLAIMED',
    `task ${id} is claimed by ${holder} and is ${current}, not handed in with finish; a check passes on or accepts only a task its assignee handed in (laneboard finish ${id} --status ${first}); do not take it over: ask ${holder} to hand it in`,
    { details: { assignee: holder }, fix: `laneboard comment ${id} "hand it in: laneboard finish ${id} --status ${first} --result <result>" --as ${actor}` },
  );
}

// A17 on a board with checks: an update that moves a handed-in task takes the hand-in away (a return for rework does so on purpose).
function handInLostWarning(id: string): string {
  return `${id} was handed in; after this move it is not: pass it on or accept it with laneboard finish ${id} --result "<result>" instead, or the assignee hands it in again with finish`;
}

// ALREADY_CLAIMED of a finish by somebody else into a status that is not final: acceptance only closes a task.
// The fix stays the comment to the holder: it may be run blindly.
function notFinalTarget(id: string, holder: string, current: string, actor: string, final: string): LaneboardError {
  return new LaneboardError(
    'ALREADY_CLAIMED',
    `task ${id} is claimed by ${holder} and is ${current}; somebody else's finish only accepts a task its assignee handed in, into ${final}; do not take it over: comment or ask the orchestrator`,
    { details: { assignee: holder }, fix: `laneboard comment ${id} "<note for ${holder}>" --as ${actor}` },
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
// command run as is (rule 13): the comment asking the holder to hand it in; the message names the orchestrator's update (LB-11 d).
function notHandedIn(id: string, holder: string, current: string, actor: string, final: string, statuses: readonly string[]): LaneboardError {
  const handIn = handInStatuses(statuses);
  return new LaneboardError(
    'ALREADY_CLAIMED',
    `task ${id} is claimed by ${holder} and is ${current}, not handed in with finish; somebody else's finish only accepts a task its assignee handed in (laneboard finish ${id} --status ${handIn}); do not take it over: ask ${holder} to hand it in, or close it as the orchestrator: laneboard update ${id} --status ${final} --as ${actor}`,
    { details: { assignee: holder }, fix: `laneboard comment ${id} "hand it in: laneboard finish ${id} --status ${handIn} --result <result>" --as ${actor}` },
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
// one holds its work, so the command takes the sha of it as a placeholder (refused as is: --commit takes hex only), and
// the link of this HEAD stays: the fix never removes a link (the owner or the agent drops it by hand after checking). Finish from a linked worktree (also of a bare repository, which has no
// main checkout) links that worktree's HEAD and gets none. `status`: the task's status after finish, for the command.
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
      ? `if your work is in one of them, link its commit instead: laneboard update ${id} --remove-link commit=${linked} --add-link commit=${only.head} --as ${actor}`
      : `if your work is in one of them, link the HEAD of yours (listed above): laneboard finish ${id} --status ${status} --commit <HEAD of your worktree> --result "<your result>" --as ${actor}; ` +
        `the link of this one stays: drop it by hand once you have checked which commit holds your work`;
  return (
    `the linked commit ${linked.slice(0, 12)} is HEAD of ${trees.here} (${branch}), the main checkout, and ${which}: ${named.join(', ')}; ${fix} ` +
    `(next time run finish in that folder or pass --commit <sha>; MCP task_finish: cwd "<that folder>" or commit "<sha>")`
  );
}

// Warnings that the linked commit may not hold the agent's work (owner's decision, S3b): uncommitted changes (staged or not), or
// HEAD was committed before the actor's work on the task began (`workStart`, unknown for a task it did not hold); and that git could
// not be asked (S3c: finish still works, unknown parts give no other warning). `named`: the caller named the commit (commit), so
// the folder's changes say nothing about it.
function checkoutWarnings(id: string, git: CheckoutState, workStart: string | undefined, named: boolean): string[] {
  const again = `commit your work and run laneboard finish ${id} again to link the new commit (work without a commit: --no-commit)`;
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
// (when set) check; the task must be handed in (handedIn: by its assignee, or passed on by an earlier check). Without --status it
// goes to the next check, from the last one into the final status (accepted); --status names a later check or the final one. The
// actor's own pass repeated (a lost reply) changes nothing, so it never skips the next check. `refused` turns a refusal into the
// claim --resume one for a task of an earlier session of the actor (P5). Returns whether it wrote, passed on, and the status it left.
function checkerFinish(
  s: { config: ConfigT; now: string; active: StoreFileT },
  task: TaskT,
  p: FinishInputT,
  actor: string,
  refused: (err: LaneboardError) => LaneboardError,
  warnings: string[],
  notRecorded: string,
  source: ActorSource,
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
  const next = later[0] ?? final;
  // The author of the work never checks its own task (review r2): the same rule and error as update and claim. A task that waits in
  // a check is handed in already, whichever status the author names (an earlier check too: B-U1 run 2).
  if (workedOn(task, actor) && review.includes(task.status) && awaitsCheck(task)) throw alreadyHandedIn(s.config, task, actor);
  checkAuthorMove(s.config, task, actor, p.status ?? next);
  const by = reviewers(s.config);
  if (by.length > 0 && !by.includes(actor)) throw refused(notChecker(id, task.assignee, actor, by));
  // An unassigned task waits for the check by its events (the author handed it in, then unassigned it: review r2).
  if (!awaitsCheck(task)) throw refused(notHandedInForCheck(id, holder, task.status, actor, handInStatus(review, task)));
  if (passedBy(task) === actor && (p.status === undefined || p.status === task.status)) {
    warnings.push(`no changes: ${id} is already ${task.status}, where you passed it on (finish repeated); to pass it on yourself again, name the status: laneboard finish ${id} --status ${next} --result "<result of your check>"; ${notRecorded}`);
    return { done: false, passed: false };
  }
  const target = p.status ?? next;
  if (!later.includes(target)) {
    throw new LaneboardError('INVALID_VALUE', `${id} is handed in and ${task.status}: a check passes it on to a later check or accepts it into ${final} (${checksLine(review, final)}), so the status is one of ${later.join(', ')}`, {
      allowed: later,
      input: { field: 'status', value: target, suggestion: next },
      fix: `laneboard finish ${id} --status ${next} --result "<result of your check>" --as ${actor}`,
    });
  }
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
// (review r2, checkerFinish).
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
      if (!allowed.includes(status)) {
        throw new LaneboardError('INVALID_VALUE', `"${status}" is the starting status; finish sets one of ${allowed.join(', ')} (default ${finals.join('')}; back to the start: laneboard update ${id} --status ${status})`, {
          allowed,
          input: finals.length === 1 ? { field: 'status', value: status, suggestion: finals[0] ?? '' } : { field: 'status', value: status },
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
      const unassignedAtCheck = review.length > 0 && holder === null && review.includes(task.status) && waitingByEvents(task) && !workedOn(task, actor);
      byOther = (holder !== null && holder !== actor) || unassignedAtCheck;
      // A task of an earlier session of the actor's default name: take it back first, then finish (P5, S6l); its acceptance stays.
      const refused = (other: LaneboardError): LaneboardError =>
        holder !== null && heldByEarlierSession(task, ctx.sessionBase, actor) ? earlierSessionClaimed(id, holder, actor, silentFor(s.active.tasks, holder, s.now), ', then finish it again') : other;
      if (byOther && review.length > 0) {
        const out = checkerFinish(s, task, p, actor, refused, warnings, notRecorded, actorSourceOf(ctx));
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
        if (!handedIn(task)) throw refused(notHandedIn(id, holder, task.status, actor, finals.join(''), s.config.statuses));
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
      // On a board with checks the assignee hands in to the first check (the default), never into a later one or the final status;
      // a task already in a check stays there: finish again records a new result (P1) or hands it in there, and never goes back to
      // an earlier check it passed (B-U1 run 2: authorRefusal).
      if (review.length > 0 && !finals.includes(task.status)) {
        const handInAt = handInStatus(review, task);
        if (p.status === undefined) status = handInAt;
        else if (p.status !== handInAt && (finals.includes(p.status) || review.includes(p.status))) throw authorRefusal(s.config, task, p.status, actor, 'finish');
      }
      // When the actor's work began (across claim --resume, its earlier sessions' too): a commit older than that is not its work.
      workStart = holder === actor ? workStartedAt(task) : undefined;
      const newCommit = commit !== undefined && !task.links.some((l) => l.kind === 'commit' && l.ref === commit) ? commit : undefined;
      const handIn = !finals.includes(status);
      const closed = finals.includes(task.status);
      // Already there: final, or handed in to this status (a task moved there by update is handed in now).
      const again = closed || (task.status === status && (!handIn || handedIn(task)));
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
      }
      if (again) {
        // The status event of the first hand-in stays the newest one into this status, so the task stays handed in (handedIn).
        finished = resubmit;
        handedInNow = resubmit;
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
      const open = handIn ? undefined : openChildrenWarning(s.active, id, finals);
      if (open) warnings.push(open);
      return toTaskView(task, false);
    },
    txOptions(ctx, warnings),
  );
  // An acceptance links no commit, so the checkout of who accepts says nothing about the work.
  if (!byOther) warnings.push(...checkoutWarnings(taskId, git, workStart, p.commit !== undefined));
  // Only HEAD of the command's own folder can be another worktree's wrong commit; a named commit or folder is the caller's choice.
  const where = p.commit === undefined && p.cwd === undefined ? ctx.cwd : undefined;
  if (!byOther && commit !== undefined && where !== undefined) {
    const other = await worktreeWarning(where, taskId, commit, workStart, actor, data.status);
    if (other) warnings.push(other);
  }
  if (finished && byOther) {
    const from = checkedFrom === undefined ? {} : { from: checkedFrom };
    return { data, warnings, reply: passedOn ? { commit: null, passed: true, ...from } : { commit: null, accepted: true, ...from } };
  }
  if (finished) return { data, warnings, reply: { commit: commit ?? null }, ...(handedInNow ? { handed_in: true } : {}) };
  return linked && commit !== undefined ? { data, warnings, reply: { commit }, unchanged: true } : { data, warnings };
}
