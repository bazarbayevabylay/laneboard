// Op: create a task (task_create).
import { z } from 'zod';
import { LaneboardError } from '../errors.ts';
import type { TaskT } from '../schema.ts';
import { maxIdNumber } from '../store.ts';
import { transact } from '../transact.ts';
import {
  addEvent,
  checkActor,
  checkFields,
  checkLabel,
  checkStatus,
  checkTaskLinks,
  DescriptionInput,
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

export const CreateInput = z.strictObject({
  title: TitleInput,
  status: z.string().min(1),
  description: DescriptionInput.optional(),
  assignee: z.string().optional(),
  labels: z.array(z.string()).optional(),
  links: z.array(LinkInput).optional(),
  // Typed values; keys must be declared in config.fields.
  fields: z.record(z.string(), z.unknown()).optional(),
  // CLI form `key=value`, converted with the declared field types.
  field_args: z.array(z.string()).optional(),
});
export type CreateInputT = z.infer<typeof CreateInput>;

// Create a task with the next id; the only event is `created`.
export async function createTask(ctx: OpContext, input: CreateInputT): Promise<OpResult<TaskView>> {
  const actor = requireActor(ctx.actor);
  const p = parseInput(CreateInput, input);
  if (p.assignee !== undefined) checkActor(p.assignee, 'assignee');
  const labels = unique(p.labels ?? []);
  labels.forEach(checkLabel);
  const links = unique(p.links ?? [], linkKey);
  const warnings: string[] = [];
  const data = await transact(
    ctx.store,
    { files: ['active', 'archive'] },
    (s) => {
      checkStatus(s.config, p.status);
      const fields = { ...(p.fields ?? {}), ...parseFieldArgs(s.config, p.field_args ?? []) };
      checkFields(s.config, fields);
      checkTaskLinks(links, [s.active, s.archive], s.config.prefix);
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
        fields,
        attachments: [],
        events: [],
        events_dropped: 0,
        created_at: s.now,
        created_by: actor,
        updated_at: s.now,
        updated_by: actor,
      };
      addEvent(task, s.config, s.now, actor, 'created', { title: task.title, status: task.status, assignee: task.assignee });
      s.active.tasks.push(task);
      return toTaskView(task, false);
    },
    txOptions(ctx, warnings),
  );
  return { data, warnings };
}
