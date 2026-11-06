// Op: create a task (task_create).
import { z } from 'zod';
import { loadConfig } from '../config.ts';
import { LaneboardError } from '../errors.ts';
import type { ConfigT, StoreFileT, TaskT } from '../schema.ts';
import { shellQuote } from '../shell.ts';
import { maxIdNumber } from '../store.ts';
import { transact } from '../transact.ts';
import {
  actorSourceOf,
  addEvent,
  checkActor,
  checkFields,
  checkLabel,
  checkParent,
  checkStatus,
  checkTaskLinks,
  DescriptionInput,
  finalStatuses,
  IdInput,
  LinkInput,
  linkKey,
  normalizeId,
  parseFieldArgs,
  parseInput,
  requireActor,
  TitleInput,
  toTaskView,
  txOptions,
  unique,
} from './common.ts';
import type { OpContext, OpResult, TaskView } from './common.ts';
import { checkForeignTaskLinks } from './links.ts';
import { reviewMoveRefusal, reviewRefusalText, workStatusBeforeChecks } from './update.ts';
import type { ReviewRefusal as ReviewRefusalT } from './update.ts';

export const CreateInput = z.strictObject({
  title: TitleInput,
  status: z.string().min(1),
  description: DescriptionInput.optional(),
  assignee: z.string().optional(),
  labels: z.array(z.string()).optional(),
  links: z.array(LinkInput).optional(),
  // A subtask: id of the parent task on this board (ADR §25).
  parent: IdInput.optional(),
  // Typed values; keys must be declared in config.fields.
  fields: z.record(z.string(), z.unknown()).optional(),
  // CLI form `key=value`, converted with the declared field types.
  field_args: z.array(z.string()).optional(),
});
export type CreateInputT = z.infer<typeof CreateInput>;

// No status given: the status stays an explicit choice (ADR-0001 §0 "no magic defaults", §23); the fix names the first configured one.
function statusRequired(storeDir: string): LaneboardError {
  const statuses = loadConfig(storeDir).statuses;
  const first = statuses[0] ?? '<status>';
  return new LaneboardError('USAGE', 'status is required', {
    allowed: [...statuses],
    fix: `pass status ${first} (the first status: where new work starts), or another status from \`allowed\``,
    edit: { add: [{ name: 'status', value: first }] },
  });
}

// Who may create tasks on this board (config@2 create_by, P2): INVALID_VALUE for anybody else, for create, its subtasks and import alike.
// No create_by: everybody (0.3.1). The fix asks for the task where the creators read: a comment on `parent`, else on the actor's newest
// task in work; without one, the actor reports to whoever started it. Self-named actors: a guard against mistakes, not a hostile agent.
export function checkCreator(config: ConfigT, active: StoreFileT, actor: string, parent?: string): void {
  const creators = config.create_by;
  if (creators === undefined || creators.includes(actor)) return;
  const who = creators.join(', ');
  const finals = finalStatuses(config.statuses);
  const own = active.tasks.filter((t) => t.assignee === actor && !finals.includes(t.status)).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0]?.id;
  const on = parent ?? own;
  const fix =
    on === undefined
      ? `report the task you need to whoever started you (${who} create tasks here), then wait for its id: laneboard claim <ID> --as ${shellQuote(actor)} --json`
      : `laneboard comment ${on} "<task you need, for ${who} to create>" --as ${shellQuote(actor)} --json`;
  throw new LaneboardError('INVALID_VALUE', `on this board only ${who} create tasks (config create_by), and you write as ${actor}; do not create it under another name: ask them`, {
    details: { create_by: [...creators] },
    fix,
  });
}

// Create a task with the next id; the only event is `created`.
export async function createTask(ctx: OpContext, input: CreateInputT): Promise<OpResult<TaskView>> {
  const actor = requireActor(ctx.actor);
  if ((input as { status?: unknown }).status === undefined) throw statusRequired(ctx.store.dir);
  const p = parseInput(CreateInput, input);
  if (p.assignee !== undefined) checkActor(p.assignee, 'assignee');
  const labels = unique(p.labels ?? []);
  labels.forEach(checkLabel);
  const links = unique(p.links ?? [], linkKey);
  const warnings: string[] = [];
  // A name in create_by hands tasks out (LB-61.1): its task for another name gets no "not to you" warning.
  let handsOut = false;
  // Links to other boards: checked there before this board's lock is taken (ADR §30).
  const checked = await checkForeignTaskLinks(ctx, links, warnings);
  const data = await transact(
    ctx.store,
    { files: ['active', 'archive'] },
    (s) => {
      checkCreator(s.config, s.active, actor, parentForFix(p.parent, s.config.prefix));
      handsOut = s.config.create_by !== undefined;
      checkStatus(s.config, p.status);
      const fields = { ...(p.fields ?? {}), ...parseFieldArgs(s.config, p.field_args ?? []) };
      checkFields(s.config, fields);
      checkTaskLinks(links, [s.active, s.archive], s.config.prefix, checked);
      const parent = p.parent === undefined ? undefined : checkParent(s, p.parent, s.config.prefix, undefined, 'links');
      if (s.active.next_id === undefined) throw new LaneboardError('STORE_INVALID', 'active.json next_id is missing');
      // next_id never decreases and never reuses an id, even after a hand edit (W9).
      const max = maxIdNumber(s.active.tasks, s.archive.tasks);
      if (s.active.next_id <= max) {
        warnings.push(`active.json next_id ${s.active.next_id} was not above the highest id (${max}); continuing from ${max + 1}`);
        s.active.next_id = max + 1;
      }
      const id = `${s.config.prefix}-${s.active.next_id}`;
      s.active.next_id += 1;
      const task: TaskT = {
        id,
        rev: 1,
        title: p.title,
        description: p.description ?? '',
        status: p.status,
        assignee: p.assignee ?? null,
        labels,
        links,
        ...(parent !== undefined ? { parent } : {}),
        fields,
        attachments: [],
        events: [],
        events_dropped: 0,
        created_at: s.now,
        created_by: actor,
        updated_at: s.now,
        updated_by: actor,
      };
      const created = { title: task.title, status: task.status, assignee: task.assignee, ...(parent !== undefined ? { parent } : {}) };
      addEvent(task, s.config, s.now, actor, 'created', created, actorSourceOf(ctx));
      // A task right in a later check or the final status skips the checks: the same rule as update (S6j tail), the creator that is its
      // assignee holds it after the write.
      const refusal = reviewMoveRefusal(s.config, task, actor, p.status, task.assignee === actor);
      if (refusal !== undefined) throw createPastChecks(s.config, refusal, p.status);
      s.active.tasks.push(task);
      return toTaskView(task, false);
    },
    txOptions(ctx, warnings),
  );
  if (data.assignee !== null && data.assignee !== actor && !handsOut) warnings.push(otherAssignee(data, actor));
  return { data, warnings };
}

// Warning for a task created for an assignee other than the writer: right for an orchestrator handing work out, but an agent
// that made up a name for itself (--assignee backend-developer without --as) would not find the task as its own in prime. Not on a
// board with create_by (LB-61.1): only its named creators get this far, and handing work out is what they create tasks for.
function otherAssignee(task: TaskView, actor: string): string {
  const assignee = task.assignee ?? '';
  return (
    `${task.id} is assigned to ${assignee}, not to you (${actor}): fine when you create it for someone else, but prime will not list it as yours. ` +
    `If it is your task: laneboard update ${task.id} --assignee ${shellQuote(actor)} --expected-rev ${task.rev} --as ${shellQuote(actor)} --json; ` +
    `if ${assignee} is your name: pass --as ${shellQuote(assignee)} on every command`
  );
}

// The parent id for the fix of checkCreator; undefined when it is no valid id (checkParent names that problem to a creator).
function parentForFix(raw: string | undefined, prefix: string): string | undefined {
  if (raw === undefined) return undefined;
  try {
    return normalizeId(raw, prefix, 'parent');
  } catch {
    // A malformed id: the fix then names the actor's own task instead.
    return undefined;
  }
}

// INVALID_VALUE of a create right into a later check or the final status on a board with checks (reviewMoveRefusal): the work starts
// before the checks; the CLI rebuilds the command with that status (input), then finish hands the task in.
function createPastChecks(config: ConfigT, refusal: ReviewRefusalT, status: string): LaneboardError {
  const work = workStatusBeforeChecks(config) ?? config.statuses[0] ?? '';
  return new LaneboardError('INVALID_VALUE', `${reviewRefusalText(config, refusal, status)}; create the task in ${work}, then hand it in: laneboard finish <ID> --result "<result>"`, {
    allowed: [work],
    input: { field: 'status', value: status, suggestion: work },
    fix: `create it with status ${work}, then hand it in with laneboard finish <ID> --result "<result>"`,
  });
}
