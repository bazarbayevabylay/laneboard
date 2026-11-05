// Op: import tasks read from another tracker's files (CLI-only: `laneboard import markdown|json|checklist`).
// All or nothing: every problem of every new task is collected into one error before anything is written;
// a task whose source file was imported before (link file=<source>) is skipped, so a re-run creates no duplicates.
// A task may name its parent by the parent's source (a checklist item under another): the parent is new in this import or imported before.
import { z } from 'zod';
import { LaneboardError } from '../errors.ts';
import type { ErrorCode } from '../errors.ts';
import { ACTOR_RE, LABEL_RE, Timestamp } from '../schema.ts';
import type { ConfigT, StoreFileT, TaskT } from '../schema.ts';
import { maxIdNumber } from '../store.ts';
import { readBoth, transact } from '../transact.ts';
import { actorSourceOf, addEvent, DescriptionInput, fieldInfo, MAX_COMMENT_CHARS, matchesType, parseInput, requireActor, TitleInput, txOptions, unique } from './common.ts';
import type { OpContext, OpResult } from './common.ts';
import type { ActorSource } from '../agent-name.ts';
import { checkCreator } from './create.ts';
import { reviewMoveRefusal, reviewRefusalText } from './update.ts';

// One event of the source's own history, kept with its original time.
export const ImportEvent = z.strictObject({
  at: Timestamp,
  actor: z.string().min(1),
  type: z.enum(['status', 'commented']),
  data: z.record(z.string(), z.unknown()),
});

export const ImportTask = z.strictObject({
  // Path of the source file relative to the project; stored as link file=<source> (the idempotency key).
  source: z.string().min(1).max(2000),
  title: z.string(),
  status: z.string(),
  description: z.string().optional(),
  assignee: z.string().optional(),
  labels: z.array(z.string()).optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  history: z.array(ImportEvent).optional(),
  // Source of the parent task (ADR §25): another task of this import, or a task imported before (link file=<parent_source>).
  parent_source: z.string().min(1).max(2000).optional(),
});
export type ImportTaskT = z.infer<typeof ImportTask>;

export const ImportInput = z.strictObject({
  tasks: z.array(ImportTask),
  dry_run: z.boolean().optional(),
});
export type ImportInputT = z.infer<typeof ImportInput>;

export interface ImportResult {
  dry_run: boolean;
  // New tasks (id is null in a dry run: ids are given only when written).
  // parent: the parent's id for a subtask (null in a dry run when the parent is new too).
  created: Array<{ id: string | null; source: string; title: string; parent?: string | null }>;
  // Sources imported before: the task that holds the link.
  skipped: Array<{ id: string; source: string }>;
}

// Everything wrong with the new tasks, grouped so one error lists every value found.
interface Problems {
  // Field key -> sources that use it, for keys not declared in config.fields.
  fields: Map<string, string[]>;
  // Status -> sources, for statuses not in config.statuses.
  statuses: Map<string, string[]>;
  invalid: Array<{ source: string; field: string; message: string }>;
}

// Add a source to a grouped problem.
function note(map: Map<string, string[]>, key: string, source: string): void {
  const list = map.get(key) ?? [];
  if (!list.includes(source)) list.push(source);
  map.set(key, list);
}

// Collect the problems of one task against the config (no throw: the import reports all of them at once).
function checkTask(config: ConfigT, t: ImportTaskT, problems: Problems): void {
  const bad = (field: string, message: string): void => {
    problems.invalid.push({ source: t.source, field, message });
  };
  const title = TitleInput.safeParse(t.title);
  if (!title.success) bad('title', t.title === '' ? 'title is empty' : `title must be one line of at most 200 characters, got ${JSON.stringify(t.title.slice(0, 60))}`);
  if (!config.statuses.includes(t.status)) note(problems.statuses, t.status, t.source);
  if (t.description !== undefined && !DescriptionInput.safeParse(t.description).success) bad('description', 'description is longer than 100000 characters');
  if (t.assignee !== undefined && !ACTOR_RE.test(t.assignee)) bad('assignee', `assignee ${JSON.stringify(t.assignee)} must match ^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$`);
  for (const label of t.labels ?? []) if (!LABEL_RE.test(label)) bad('labels', `label ${JSON.stringify(label)} must match ^[a-z0-9][a-z0-9._-]{0,39}$`);
  for (const [key, value] of Object.entries(t.fields ?? {})) {
    const def = Object.hasOwn(config.fields, key) ? config.fields[key] : undefined;
    if (!def) note(problems.fields, key, t.source);
    else if (!matchesType(def.type, value)) bad(key, `field ${key} must be ${def.type}, got ${JSON.stringify(value).slice(0, 80)}`);
  }
  for (const e of t.history ?? []) {
    if (!ACTOR_RE.test(e.actor)) bad('history', `history actor ${JSON.stringify(e.actor)} must match ^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$`);
    const text = e.data.text;
    if (typeof text === 'string' && text.length > MAX_COMMENT_CHARS) bad('history', `history text is longer than ${MAX_COMMENT_CHARS} characters`);
  }
}

// "a (2 files), b (1 file)" for at most `max` entries.
function grouped(map: Map<string, string[]>, max = 10): string {
  const entries = [...map.entries()];
  const shown = entries.slice(0, max).map(([k, files]) => `${JSON.stringify(k)} (${files.length} file${files.length === 1 ? '' : 's'})`);
  return shown.join(', ') + (entries.length > max ? `, … ${entries.length - max} more` : '');
}

// One error naming every problem found: unknown keys first, then statuses, then invalid values.
function problemsError(config: ConfigT, problems: Problems): LaneboardError | undefined {
  const { fields, statuses, invalid } = problems;
  if (!fields.size && !statuses.size && !invalid.length) return undefined;
  const parts: string[] = [];
  if (fields.size) parts.push(`keys not declared in config.fields: ${grouped(fields)}`);
  if (statuses.size) parts.push(`statuses not in config.statuses: ${grouped(statuses)}`);
  if (invalid.length) {
    const first = invalid.slice(0, 5).map((p) => `${p.source}: ${p.message}`);
    parts.push(`invalid values: ${first.join('; ')}${invalid.length > 5 ? `; … ${invalid.length - 5} more` : ''}`);
  }
  const code: ErrorCode = fields.size ? 'UNKNOWN_FIELD' : statuses.size ? 'UNKNOWN_STATUS' : 'INVALID_VALUE';
  const allowed = code === 'UNKNOWN_FIELD' ? Object.keys(config.fields) : code === 'UNKNOWN_STATUS' ? [...config.statuses] : undefined;
  return new LaneboardError(code, `import stopped, nothing was written: ${parts.join('; ')}`, {
    ...(allowed ? { allowed } : {}),
    details: {
      unknown_fields: [...fields.entries()].map(([key, files]) => ({ key, files })),
      unknown_statuses: [...statuses.entries()].map(([value, files]) => ({ value, files })),
      invalid,
      statuses: [...config.statuses],
      fields: fieldInfo(config),
    },
    fix: 'map or ignore every value listed in details (unknown_fields, unknown_statuses, invalid), then run the import again',
  });
}

// Which sources already have a task (link file=<source>, active or archive) and whether that task is archived.
function importedSources(files: readonly StoreFileT[]): Map<string, { id: string; archived: boolean }> {
  const out = new Map<string, { id: string; archived: boolean }>();
  for (const f of files) for (const t of f.tasks) for (const l of t.links) if (l.kind === 'file' && !out.has(l.ref)) out.set(l.ref, { id: t.id, archived: f.kind === 'archive' });
  return out;
}

// Parent of each new subtask: the id of a task imported before, or null when the parent is new in this import; problems for the rest.
function resolveParents(fresh: readonly ImportTaskT[], known: ReadonlyMap<string, { id: string; archived: boolean }>, problems: Problems): Map<string, string | null> {
  const freshSources = new Set(fresh.map((t) => t.source));
  const out = new Map<string, string | null>();
  for (const t of fresh) {
    const ps = t.parent_source;
    if (ps === undefined) continue;
    const before = known.get(ps);
    if (ps === t.source) problems.invalid.push({ source: t.source, field: 'parent', message: 'a task cannot be its own parent' });
    else if (freshSources.has(ps)) out.set(t.source, null);
    else if (before === undefined) problems.invalid.push({ source: t.source, field: 'parent', message: `parent ${JSON.stringify(ps)} is neither in this import nor imported before` });
    else if (before.archived) problems.invalid.push({ source: t.source, field: 'parent', message: `parent ${before.id} (${ps}) is archived and read-only: laneboard restore ${before.id}, then import again` });
    else out.set(t.source, before.id);
  }
  return out;
}

// A task imported right into a later check or the final status on a board with checks skips them: the rule of create and update
// (reviewMoveRefusal; the importer that is its assignee is the author of the work). A problem of that task, not a throw.
function checkChecks(config: ConfigT, t: ImportTaskT, actor: string, problems: Problems): void {
  if (!config.statuses.includes(t.status)) return;
  const task = buildTask(config, t, '', undefined, new Date().toISOString(), actor, 'explicit');
  const refusal = reviewMoveRefusal(config, task, actor, t.status, task.assignee === actor);
  if (refusal !== undefined) problems.invalid.push({ source: t.source, field: 'status', message: `${reviewRefusalText(config, refusal, t.status)}; import it in a status before the checks` });
}

// Split into new tasks and skipped ones, and fail when any new task has a problem. `actor`: who imports (undefined in a dry run
// without a name: the checks of the board are not asked then).
function plan(
  config: ConfigT,
  active: StoreFileT,
  archive: StoreFileT,
  tasks: readonly ImportTaskT[],
  actor: string | undefined,
): { fresh: ImportTaskT[]; skipped: ImportResult['skipped']; parents: Map<string, string | null> } {
  const known = importedSources([active, archive]);
  const fresh: ImportTaskT[] = [];
  const skipped: ImportResult['skipped'] = [];
  const problems: Problems = { fields: new Map(), statuses: new Map(), invalid: [] };
  // One source is one task: a repeated source is a problem, never a task dropped without a word.
  const seen = new Set<string>();
  for (const t of tasks) {
    if (seen.has(t.source)) {
      problems.invalid.push({ source: t.source, field: 'source', message: 'two tasks of this import have the same source' });
      continue;
    }
    seen.add(t.source);
    const before = known.get(t.source);
    if (before !== undefined) skipped.push({ id: before.id, source: t.source });
    else fresh.push(t);
  }
  for (const t of fresh) checkTask(config, t, problems);
  if (actor !== undefined) for (const t of fresh) checkChecks(config, t, actor, problems);
  const parents = resolveParents(fresh, known, problems);
  const err = problemsError(config, problems);
  if (err) throw err;
  return { fresh, skipped, parents };
}

// Build a stored task: the source history first (original times), then `created` at import time naming the source.
function buildTask(config: ConfigT, t: ImportTaskT, id: string, parent: string | undefined, now: string, actor: string, source: ActorSource): TaskT {
  const task: TaskT = {
    id,
    rev: 1,
    title: t.title,
    description: t.description ?? '',
    status: t.status,
    assignee: t.assignee ?? null,
    labels: unique(t.labels ?? []),
    links: [{ kind: 'file', ref: t.source }],
    ...(parent !== undefined ? { parent } : {}),
    fields: { ...(t.fields ?? {}) },
    attachments: [],
    events: [],
    events_dropped: 0,
    created_at: now,
    created_by: actor,
    updated_at: now,
    updated_by: actor,
  };
  const history = [...(t.history ?? [])].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const e of history) addEvent(task, config, e.at, e.actor, e.type, e.data);
  addEvent(task, config, now, actor, 'created', { title: task.title, status: task.status, assignee: task.assignee, ...(parent !== undefined ? { parent } : {}), imported_from: t.source }, source);
  return task;
}

// Import tasks: skip sources imported before, validate the rest together, create them in one write (or only report in a dry run).
export async function importTasks(ctx: OpContext, input: ImportInputT): Promise<OpResult<ImportResult>> {
  const p = parseInput(ImportInput, input);
  const warnings: string[] = [];
  if (p.dry_run) {
    const view = await readBoth(ctx.store, { lockWaitMs: ctx.lockWaitMs, warnings });
    // Who may create tasks (P2) is asked in a dry run too, when the name is known.
    if (ctx.actor !== undefined) checkCreator(view.config, view.active, ctx.actor);
    const { fresh, skipped, parents } = plan(view.config, view.active, view.archive, p.tasks, ctx.actor);
    const created = fresh.map((t) => ({ id: null, source: t.source, title: t.title, ...(parents.has(t.source) ? { parent: parents.get(t.source) ?? null } : {}) }));
    return { data: { dry_run: true, created, skipped }, warnings };
  }
  const actor = requireActor(ctx.actor);
  const data = await transact(
    ctx.store,
    { files: ['active', 'archive'] },
    (s) => {
      checkCreator(s.config, s.active, actor);
      const { fresh, skipped, parents } = plan(s.config, s.active, s.archive, p.tasks, actor);
      if (s.active.next_id === undefined) throw new LaneboardError('STORE_INVALID', 'active.json next_id is missing');
      // next_id never decreases and never reuses an id, even after a hand edit (W9).
      const max = maxIdNumber(s.active.tasks, s.archive.tasks);
      if (s.active.next_id <= max) {
        warnings.push(`active.json next_id ${s.active.next_id} was not above the highest id (${max}); continuing from ${max + 1}`);
        s.active.next_id = max + 1;
      }
      // Ids first, so a subtask finds its new parent wherever the parent stands in the input.
      const idOf = new Map<string, string>();
      for (const t of fresh) {
        idOf.set(t.source, `${s.config.prefix}-${s.active.next_id}`);
        s.active.next_id += 1;
      }
      const created: ImportResult['created'] = [];
      for (const t of fresh) {
        const id = idOf.get(t.source) ?? '';
        const parent = parents.has(t.source) ? (parents.get(t.source) ?? idOf.get(t.parent_source ?? '')) : undefined;
        s.active.tasks.push(buildTask(s.config, t, id, parent, s.now, actor, actorSourceOf(ctx)));
        created.push({ id, source: t.source, title: t.title, ...(parent !== undefined ? { parent } : {}) });
      }
      return { dry_run: false, created, skipped };
    },
    txOptions(ctx, warnings),
  );
  return { data, warnings };
}
