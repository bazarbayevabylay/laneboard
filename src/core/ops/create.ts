// Op: create a task (task_create).
import { z } from 'zod';
import { loadConfig } from '../config.ts';
import { LaneboardError } from '../errors.ts';
import type { TaskT } from '../schema.ts';
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
  IdInput,
  LinkInput,
  linkKey,
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
  // Links to other boards: checked there before this board's lock is taken (ADR §30).
  const checked = await checkForeignTaskLinks(ctx, links, warnings);
  const data = await transact(
    ctx.store,
    { files: ['active', 'archive'] },
    (s) => {
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
      s.active.tasks.push(task);
      return toTaskView(task, false);
    },
    txOptions(ctx, warnings),
  );
  if (data.assignee !== null && data.assignee !== actor) warnings.push(otherAssignee(data, actor));
  return { data, warnings };
}

// Warning for a task created for an assignee other than the writer: right for an orchestrator handing work out, but an agent
// that made up a name for itself (--assignee backend-developer without --as) would not find the task as its own in prime.
function otherAssignee(task: TaskView, actor: string): string {
  const assignee = task.assignee ?? '';
  return (
    `${task.id} is assigned to ${assignee}, not to you (${actor}): fine when you create it for someone else, but prime will not list it as yours. ` +
    `If it is your task: laneboard update ${task.id} --assignee ${shellQuote(actor)} --expected-rev ${task.rev} --as ${shellQuote(actor)} --json; ` +
    `if ${assignee} is your name: pass --as ${shellQuote(assignee)} on every command`
  );
}
