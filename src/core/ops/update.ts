// Ops that change an active task: update, claim, comment, finish (task_update, task_claim, task_comment, task_finish).
import { z } from 'zod';
import { LaneboardError } from '../errors.ts';
import { readCheckout } from '../git.ts';
import type { CheckoutState } from '../git.ts';
import type { LinkT, TaskT } from '../schema.ts';
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
    const quiet = Number.isFinite(silentMs) ? `no write for ${minutesText(silentMs)}` : 'no write of it left on the board';
    return new LaneboardError(
      'ALREADY_CLAIMED',
      `task ${id} is held by ${holder}, an earlier session of your default name (${quiet}: closed by /clear or a restart); if it is your own work, take it back: laneboard claim ${id} --resume${then}`,
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
});
export type FinishInputT = z.infer<typeof FinishInput>;

// Statuses finish may set: all but the first one (where new tasks start), the final one always.
function finishStatuses(statuses: readonly string[]): string[] {
  const finals = finalStatuses(statuses);
  return statuses.filter((st, i) => i > 0 || finals.includes(st));
}

// Was the task handed in by its assignee: the newest `status` event into its current status is the assignee's finish, which marks
// it `handed_in: true` (S4b, by the data: no meaning is read from the names or the order of statuses). False without such an event
// (set by update or claim, created in this status, handed in before the marker, or the event was dropped by the events limit).
export function handedIn(task: TaskT): boolean {
  for (let i = task.events.length - 1; i >= 0; i--) {
    const e = task.events[i];
    if (e?.type === 'status' && e.data.to === task.status) return e.actor === task.assignee && e.data.handed_in === true;
  }
  return false;
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

// Warnings that the linked commit may not hold the agent's work (owner's decision, S3b): uncommitted changes (staged or not), or
// HEAD was committed before the actor's work on the task began (`workStart`, unknown for a task it did not hold); and that git could
// not be asked (S3c: finish still works, unknown parts give no other warning).
function checkoutWarnings(id: string, git: CheckoutState, workStart: string | undefined): string[] {
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
    out.push(`the linked commit ${sha} is from before your work: HEAD has not moved since you claimed ${id}; ${again}`);
  }
  return out;
}

// Close a task in one write: the result comment, the commit of the git checkout (kind=commit; not with no_commit, outside git
// or before the first commit), the actor as assignee of an unassigned task, then the status (default: the final one), in this event order.
// The assignee (or anybody for an unassigned task) finishes; into a status that is not final it hands the task in (the status event says
// `handed_in: true`, also when the task is already there but was not handed in). Somebody else only accepts: a task its assignee
// handed in (handedIn) into the final status, with the result comment and no commit link (the assignee linked its commit when handing
// in); the assignee stays, the status event says `accepted: true` and its actor is who accepted (LB-9, S4b). A task already in that
// status (handed in) or in a final status keeps its status and gets no second result (a warning); for the assignee only a commit that
// is not linked yet is added, so "commit, then finish again" links it; somebody else's finish of a closed task changes nothing.
export async function finishTask(ctx: OpContext, input: FinishInputT): Promise<OpResult<TaskView>> {
  const actor = requireActor(ctx.actor);
  const p = parseInput(FinishInput, input);
  // Asked before the lock: the checkout does not change because of this write.
  const git: CheckoutState = p.no_commit === true || ctx.cwd === undefined ? {} : await readCheckout(ctx.cwd);
  const commit = git.head;
  const warnings: string[] = [];
  let finished = false;
  // The assignee's finish into a status that is not final (hands the task in).
  let handedInNow = false;
  let byOther = false;
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
      const status = p.status ?? finals[0] ?? '';
      if (p.status !== undefined) checkStatus(s.config, p.status);
      if (!allowed.includes(status)) {
        throw new LaneboardError('INVALID_VALUE', `"${status}" is the starting status; finish sets one of ${allowed.join(', ')} (default ${finals.join('')}; back to the start: laneboard update ${id} --status ${status})`, {
          allowed,
          input: finals.length === 1 ? { field: 'status', value: status, suggestion: finals[0] ?? '' } : { field: 'status', value: status },
        });
      }
      const task = requireActiveTask(s, id, (missing) => missingTask(ctx, missing, s.config.prefix, 'write'));
      const notRecorded = `the result was not recorded (add it with laneboard comment ${id} "<text>")`;
      // The owner first: somebody else's task is ALREADY_CLAIMED (review S3 NIT), unless this is an acceptance or the task is closed.
      const holder = task.assignee;
      byOther = holder !== null && holder !== actor;
      if (holder !== null && byOther) {
        // A task of an earlier session of the actor's default name: take it back first, then finish (P5, S6l); its acceptance stays.
        const refused = (other: LaneboardError): LaneboardError =>
          heldByEarlierSession(task, ctx.sessionBase, actor) ? earlierSessionClaimed(id, holder, actor, silentFor(s.active.tasks, holder, s.now), ', then finish it again') : other;
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
      // When the actor's work began (across claim --resume, its earlier sessions' too): a commit older than that is not its work.
      workStart = holder === actor ? workStartedAt(task) : undefined;
      const newCommit = commit !== undefined && !task.links.some((l) => l.kind === 'commit' && l.ref === commit) ? commit : undefined;
      const handIn = !finals.includes(status);
      // Already there: final, or handed in to this status (a task moved there by update is handed in now).
      const again = finals.includes(task.status) || (task.status === status && (!handIn || handedIn(task)));
      if (again && newCommit === undefined) warnings.push(`no changes: ${id} is already ${task.status}; ${notRecorded}`);
      if (again && newCommit !== undefined) warnings.push(`status and result unchanged: ${id} is already ${task.status}; ${notRecorded}; commit ${newCommit.slice(0, 12)} linked`);
      if (again && newCommit === undefined) return toTaskView(task, false);
      // One write, one rev, whatever events follow.
      touch(task, s.now, actor);
      if (!again) addEvent(task, s.config, s.now, actor, 'commented', { text: p.result, result: true }, actorSourceOf(ctx));
      if (newCommit !== undefined) {
        const links: LinkT[] = [...task.links, { kind: 'commit', ref: newCommit }];
        addEvent(task, s.config, s.now, actor, 'updated', { links: [task.links, links] }, actorSourceOf(ctx));
        task.links = links;
        linked = true;
      }
      if (again) return toTaskView(task, false);
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
  if (!byOther) warnings.push(...checkoutWarnings(taskId, git, workStart));
  if (finished && byOther) return { data, warnings, reply: { commit: null, accepted: true } };
  if (finished) return { data, warnings, reply: { commit: commit ?? null }, ...(handedInNow ? { handed_in: true } : {}) };
  return linked && commit !== undefined ? { data, warnings, reply: { commit }, unchanged: true } : { data, warnings };
}
