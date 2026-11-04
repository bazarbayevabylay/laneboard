// Shared rules for ops: input parsing, id/actor/status/field/link validation, events, views.
import { z } from 'zod';
import { LaneboardError } from '../errors.ts';
import type { ErrorCode } from '../errors.ts';
import { isEarlierSessionName } from '../agent-name.ts';
import type { ActorSource } from '../agent-name.ts';
import { ACTOR_RE, ID_RE, LABEL_RE, LINK_KINDS } from '../schema.ts';
import type { ConfigT, EventType, FieldType, LinkT, StoreFileT, TaskEventT, TaskT } from '../schema.ts';
import type { StoreRef } from '../store.ts';
import type { Faults, TransactOptions } from '../transact.ts';

// Everything an op needs besides its input: the store, who acts, and test-only options.
export interface OpContext {
  store: StoreRef;
  // Required for writes; facades take it from --as / the MCP `actor` param / LANEBOARD_AGENT, else the default name (agent-name.ts).
  actor?: string;
  // Where the actor's name came from (recorded on events); explicit when not given.
  actorSource?: ActorSource;
  // The session default name without its session part (agent-name.ts); claim --resume takes tasks of this base's other sessions.
  sessionBase?: string;
  // The folder the command runs in; finish links the commit of its git checkout.
  cwd?: string;
  // Home directory of the machine board registry (CLI: HOME); ops that register a board need it.
  home?: string;
  faults?: Faults;
  lockWaitMs?: number;
  // Write deadline after the lock acquire (tests only; default LOCK_MAX_HOLD_MS).
  lockMaxHoldMs?: number;
}

// Options for transact taken from the op context; warnings go to `warnings`.
export function txOptions(ctx: OpContext, warnings: string[]): TransactOptions {
  return { faults: ctx.faults, lockWaitMs: ctx.lockWaitMs, lockMaxHoldMs: ctx.lockMaxHoldMs, warnings };
}

// Op output: data for the envelope plus warnings; `reply`: facts of this write for the short write reply (claim --resume, finish).
export interface OpResult<T> {
  data: T;
  warnings: string[];
  reply?: WriteFacts;
  // The op wrote less than it was asked for (finish of a task already in that status that only linked a new commit).
  unchanged?: boolean;
}

export const MAX_COMMENT_CHARS = 10000;
export const DEFAULT_LIST_LIMIT = 20;

// Single-line text: no control characters and not blank.
const SINGLE_LINE_RE = /^(?=.*\S)[^\u0000-\u001F\u007F]+$/;
export const TitleInput = z.string().min(1).max(200).regex(SINGLE_LINE_RE, 'title must be one line of visible text');
export const DescriptionInput = z.string().max(100000);
export const IdInput = z.string().min(1);
export const RevInput = z.int().min(1);
export const LinkInput = z.strictObject({ kind: z.enum(LINK_KINDS), ref: z.string().min(1).max(2000) });

// Read a nested value by zod issue path.
function valueAt(input: unknown, pathParts: PropertyKey[]): unknown {
  let current: unknown = input;
  for (const part of pathParts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[part];
  }
  return current;
}

// Validate op input with a strict zod schema; the first issue becomes USAGE or INVALID_VALUE.
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  if (!issue) throw new LaneboardError('INVALID_VALUE', 'invalid input');
  const where = issue.path.map(String).join('.');
  if (issue.code === 'unrecognized_keys') {
    throw new LaneboardError('USAGE', `unknown parameter: ${issue.keys.join(', ')}`);
  }
  const value = valueAt(input, issue.path);
  if (value === undefined && issue.code === 'invalid_type') {
    throw new LaneboardError('USAGE', `${where} is required`);
  }
  const shown = typeof value === 'string' ? value : JSON.stringify(value);
  const bad = { field: where, value: String(shown) };
  if (issue.code === 'invalid_value') {
    throw new LaneboardError('INVALID_VALUE', `${where}: "${shown}" is not allowed`, { input: bad, allowed: issue.values.map(String), fix: `use a ${where} from \`allowed\`` });
  }
  if (issue.code === 'invalid_format' && issue.format === 'datetime') {
    throw new LaneboardError('INVALID_VALUE', `${where}: "${shown}" is not an ISO 8601 UTC time`, {
      input: { ...bad, format: '<YYYY-MM-DDTHH:MM:SS.sssZ>' },
      fix: `pass ${where} as an ISO 8601 UTC time with milliseconds and Z, e.g. 2026-01-31T09:00:00.000Z`,
    });
  }
  throw new LaneboardError('INVALID_VALUE', `${where}: ${issue.message}`, { input: bad, fix: issueFix(issue, where) });
}

// A concrete fix for a zod issue that has no special case above.
function issueFix(issue: z.core.$ZodIssue, where: string): string {
  if (issue.code === 'too_big') return issue.origin === 'string' ? `shorten ${where} to at most ${String(issue.maximum)} characters` : `use a ${where} of at most ${String(issue.maximum)}`;
  if (issue.code === 'too_small') return issue.origin === 'string' ? `${where} must not be empty` : `use a ${where} of at least ${String(issue.minimum)}`;
  if (issue.code === 'invalid_type') return `pass ${where} as ${issue.expected}`;
  return `correct ${where}: ${issue.message}`;
}

// Edit distance with adjacent transpositions counted as one edit (optimal string alignment).
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  const at = (i: number, j: number): number => d[i]?.[j] ?? 0;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, at(i - 2, j - 2) + 1);
      const row = d[i];
      if (row) row[j] = best;
    }
  }
  return at(a.length, b.length);
}

// Closest candidate only for an obvious typo (same letters ignoring case and -_, or one edit/transposition).
// A fix may be run blindly by an agent, so "doing" must not become "done".
export function suggestClosest(value: string, candidates: readonly string[]): string | undefined {
  const norm = (s: string): string => s.toLowerCase().replace(/[-_\s]/g, '');
  const same = candidates.filter((c) => norm(c) === norm(value));
  if (same.length === 1) return same[0];
  const near = candidates.filter((c) => distance(value.toLowerCase(), c.toLowerCase()) === 1);
  return near.length === 1 ? near[0] : undefined;
}

// Where the acting name came from, for events (explicit unless the facade used the default name).
export function actorSourceOf(ctx: OpContext): ActorSource {
  return ctx.actorSource ?? 'explicit';
}

// Writes need an actor; validate its format.
export function requireActor(actor: string | undefined): string {
  if (actor === undefined || actor === '') throw new LaneboardError('ACTOR_REQUIRED', 'this command changes the store and needs an actor');
  checkActor(actor, 'actor');
  return actor;
}

// Validate an actor-shaped value (actor, assignee).
export function checkActor(value: string, field: string): void {
  if (!ACTOR_RE.test(value)) {
    throw new LaneboardError('INVALID_VALUE', `${field} "${value}" must match ^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$`, {
      input: { field, value, format: '<name like dev-1>' },
      fix: `use letters, digits and . _ : @ - without spaces for ${field}, e.g. dev-1`,
    });
  }
}

// Ids are exact (`LB-12`); `12` or `lb-12` fail with the exact id as suggestion.
export function normalizeId(raw: string, prefix: string, field = 'id'): string {
  if (ID_RE.test(raw)) return raw;
  let suggestion: string | undefined;
  if (/^[1-9][0-9]*$/.test(raw)) suggestion = `${prefix}-${raw}`;
  else if (ID_RE.test(raw.toUpperCase())) suggestion = raw.toUpperCase();
  throw new LaneboardError('INVALID_VALUE', `"${raw}" is not a task id; ids are exact, like ${suggestion ?? `${prefix}-12`}`, {
    input: suggestion ? { field, value: raw, suggestion } : { field, value: raw },
    fix: suggestion ? `use ${suggestion}` : `use an exact id like ${prefix}-12 (see laneboard list)`,
  });
}

// Statuses that end the work: the last configured status (config has one final status).
export function finalStatuses(statuses: readonly string[]): string[] {
  const last = statuses.at(-1);
  return last === undefined ? [] : [last];
}

// The event that gave the task its current assignee (the newest `assigned` event, else `created`); undefined for an unassigned task
// or when that event was dropped by the events limit.
export function assignmentEvent(task: TaskT): TaskEventT | undefined {
  if (task.assignee === null) return undefined;
  for (let i = task.events.length - 1; i >= 0; i--) {
    const e = task.events[i];
    if (e?.type === 'assigned') return e.data.to === task.assignee ? e : undefined;
    if (e?.type === 'created') return e.data.assignee === task.assignee ? e : undefined;
  }
  return undefined;
}

// Is the task the work of another session of the actor's default name (claim --resume)? Its holder looks like `<base>:<session>`
// and took it itself under its session default name: that event says actor_source `default`. By the data, not the form of the name:
// an explicit name of the same form (`<base>:reviewer`) and a task handed to such a name by someone else never qualify (review S3).
export function heldByEarlierSession(task: TaskT, sessionBase: string | undefined, actor: string): boolean {
  const holder = task.assignee;
  if (holder === null || !isEarlierSessionName(holder, sessionBase, actor)) return false;
  const e = assignmentEvent(task);
  return e !== undefined && e.actor === holder && e.actor_source === 'default';
}

// Status must be one of config.statuses.
export function checkStatus(config: ConfigT, status: string): void {
  if (config.statuses.includes(status)) return;
  const suggestion = suggestClosest(status, config.statuses);
  throw new LaneboardError('UNKNOWN_STATUS', `"${status}" is not a configured status`, {
    allowed: [...config.statuses],
    input: suggestion ? { field: 'status', value: status, suggestion } : { field: 'status', value: status },
    fix: suggestion ? `use status ${suggestion}` : 'use a status from `allowed`',
  });
}

// Label format check.
export function checkLabel(label: string): void {
  if (!LABEL_RE.test(label)) {
    throw new LaneboardError('INVALID_VALUE', `label "${label}" must match ^[a-z0-9][a-z0-9._-]{0,39}$ (lowercase)`, {
      input: { field: 'label', value: label, format: '<label like ui-bug>', ...(LABEL_RE.test(label.toLowerCase()) ? { suggestion: label.toLowerCase() } : {}) },
      fix: 'use lowercase letters, digits, dot, dash or underscore, e.g. ui-bug',
    });
  }
}

// Remove duplicates, keeping the first occurrence.
export function unique<T>(items: readonly T[], key: (item: T) => string = String): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Declared fields as agents need them: type, description, an example `key=value` (UNKNOWN_FIELD details, prime).
export interface FieldInfo {
  type: FieldType;
  description?: string;
  example: string;
}

export function fieldInfo(config: ConfigT): Record<string, FieldInfo> {
  return Object.fromEntries(
    Object.entries(config.fields).map(([key, def]) => [key, { type: def.type, ...(def.description ? { description: def.description } : {}), example: `${key}=${FIELD_EXAMPLE[def.type]}` }]),
  );
}

// One-line list of declared fields: `priority (number, 0 = highest)`.
export function fieldsLine(fields: Record<string, FieldInfo>): string {
  return Object.entries(fields)
    .map(([key, f]) => `${key} (${[f.type, f.description].filter(Boolean).join(', ')})`)
    .join(', ');
}

// Field key must be declared in config.fields; the error names each declared field with its type.
function fieldType(config: ConfigT, key: string): FieldType {
  const def = Object.hasOwn(config.fields, key) ? config.fields[key] : undefined;
  if (!def) {
    const allowed = Object.keys(config.fields);
    const suggestion = suggestClosest(key, allowed);
    const fields = fieldInfo(config);
    const declared = allowed.length ? `declared: ${fieldsLine(fields)}` : 'no fields are declared';
    throw new LaneboardError('UNKNOWN_FIELD', `field "${key}" is not declared in config.fields (${declared})`, {
      allowed,
      details: { fields },
      input: suggestion ? { field: 'field', value: key, suggestion } : { field: 'field', value: key },
    });
  }
  return def.type;
}

// Is `value` valid for a declared field type? (also used by import to collect every problem at once)
export function matchesType(type: FieldType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'json':
      return value !== undefined;
  }
}

// Validate typed field values against config.fields.
export function checkFields(config: ConfigT, fields: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(fields)) {
    const type = fieldType(config, key);
    if (!matchesType(type, value)) {
      const example = FIELD_JSON_EXAMPLE[type];
      throw new LaneboardError('INVALID_VALUE', `field ${key} must be ${type} (e.g. {"${key}": ${example}}), got ${JSON.stringify(value)}`, {
        input: { field: key, value: JSON.stringify(value) },
        details: { field: key, type, example: `{"${key}": ${example}}` },
        fix: `pass ${key} as a ${type} value, e.g. fields: {"${key}": ${example}}`,
      });
    }
  }
}

// Expected value format and an example per field type, for fixes.
const FIELD_FORMAT: Record<FieldType, string> = { string: 'text', number: 'number', boolean: 'true|false', 'string[]': 'a,b,c', json: 'json' };
const FIELD_EXAMPLE: Record<FieldType, string> = { string: 'text', number: '1', boolean: 'true', 'string[]': 'a,b', json: '{"k":1}' };
// The same examples as JSON values (MCP `fields`).
const FIELD_JSON_EXAMPLE: Record<FieldType, string> = { string: '"text"', number: '1', boolean: 'true', 'string[]': '["a", "b"]', json: '{"k": 1}' };

// Parse CLI-style `key=value` field arguments using the declared field types.
export function parseFieldArgs(config: ConfigT, args: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq <= 0) {
      throw new LaneboardError('INVALID_VALUE', `field "${arg}" must be key=value`, { input: { field: 'field', value: arg, format: '<key=value>' }, fix: 'pass the field as key=value, e.g. priority=1' });
    }
    const key = arg.slice(0, eq);
    const raw = arg.slice(eq + 1);
    const type = fieldType(config, key);
    const bad = (expected: string): LaneboardError =>
      new LaneboardError('INVALID_VALUE', `field ${key} is ${type}: expected ${expected} (e.g. ${key}=${FIELD_EXAMPLE[type]}), got "${raw}"`, {
        input: { field: key, value: arg, format: `${key}=<${FIELD_FORMAT[type]}>` },
        details: { field: key, type, example: `${key}=${FIELD_EXAMPLE[type]}` },
        fix: `pass ${key}=<${FIELD_FORMAT[type]}>, e.g. ${key}=${FIELD_EXAMPLE[type]}`,
      });
    switch (type) {
      case 'string':
        out[key] = raw;
        break;
      case 'number': {
        const n = Number(raw);
        if (raw.trim() === '' || !Number.isFinite(n)) throw bad('a number');
        out[key] = n;
        break;
      }
      case 'boolean':
        if (raw !== 'true' && raw !== 'false') throw bad('true or false');
        out[key] = raw === 'true';
        break;
      case 'string[]':
        out[key] = raw === '' ? [] : raw.split(',');
        break;
      case 'json':
        try {
          out[key] = JSON.parse(raw);
        } catch {
          // Not JSON: report it as the field's format error.
          throw bad('JSON');
        }
        break;
    }
  }
  return out;
}

// Parse a CLI-style `kind=ref` link argument.
export function parseLinkArg(arg: string): LinkT {
  const eq = arg.indexOf('=');
  const kind = eq > 0 ? arg.slice(0, eq) : '';
  if (!(LINK_KINDS as readonly string[]).includes(kind)) {
    throw new LaneboardError('INVALID_VALUE', `link "${arg}" must be kind=ref with kind one of ${LINK_KINDS.join(', ')}`, {
      allowed: [...LINK_KINDS],
      input: { field: 'link', value: arg, format: '<kind from allowed>=<ref>' },
      fix: 'pass the link as kind=ref with a kind from `allowed`, e.g. branch=fix/login',
    });
  }
  return parseInput(LinkInput, { kind, ref: arg.slice(eq + 1) });
}

// Same link? (kind and ref).
export function linkKey(link: LinkT): string {
  return `${link.kind}=${link.ref}`;
}

// `kind=task` links must reference an existing id in either file.
export function checkTaskLinks(links: readonly LinkT[], files: readonly StoreFileT[], prefix: string): void {
  for (const link of links) {
    if (link.kind !== 'task') continue;
    normalizeId(link.ref, prefix, 'link');
    if (!files.some((f) => f.tasks.some((t) => t.id === link.ref))) {
      throw new LaneboardError('TASK_NOT_FOUND', `link task=${link.ref}: no such task`, { input: { field: 'link', value: link.ref } });
    }
  }
}

export interface Located {
  task: TaskT;
  archived: boolean;
  file: StoreFileT;
}

// Find a task in active, then archive.
export function locate(files: { active?: StoreFileT; archive?: StoreFileT }, id: string): Located | undefined {
  const inActive = files.active?.tasks.find((t) => t.id === id);
  if (inActive && files.active) return { task: inActive, archived: false, file: files.active };
  const inArchive = files.archive?.tasks.find((t) => t.id === id);
  if (inArchive && files.archive) return { task: inArchive, archived: true, file: files.archive };
  return undefined;
}

// Not-found error for a task id.
export function notFound(id: string): LaneboardError {
  return new LaneboardError('TASK_NOT_FOUND', `task ${id} does not exist (active or archive)`);
}

// Find a task that may be changed: must exist and not be archived.
export function requireActiveTask(files: { active: StoreFileT; archive: StoreFileT }, id: string): TaskT {
  const found = locate(files, id);
  if (!found) throw notFound(id);
  if (found.archived) {
    throw new LaneboardError('TASK_ARCHIVED', `task ${id} is archived and read-only`, { fix: `laneboard restore ${id}` });
  }
  return found.task;
}

// expected_rev must match the current task rev (W5); details carry the current task.
export function checkExpectedRev(task: TaskT, archived: boolean, expected: number | undefined): void {
  if (expected === undefined || expected === task.rev) return;
  throw new LaneboardError('REV_CONFLICT', `task ${task.id} is at rev ${task.rev}, you expected rev ${expected}`, {
    details: { task: toTaskView(task, archived) },
    fix: `details.task is the current ${task.id} (rev ${task.rev}): re-apply your change on it (merge, do not overwrite others' edits) with --expected-rev ${task.rev}`,
  });
}

// Append an event (core only) and drop the oldest over limits.events_per_task.
// `source` is set for events of a caller (explicit or default name); imported history events have none.
export function addEvent(task: TaskT, config: ConfigT, at: string, actor: string, type: EventType, data: Record<string, unknown>, source?: ActorSource): void {
  const event: TaskEventT = source === undefined ? { at, actor, type, data } : { at, actor, actor_source: source, type, data };
  task.events.push(event);
  const over = task.events.length - config.limits.events_per_task;
  if (over > 0) {
    task.events.splice(0, over);
    task.events_dropped += over;
  }
}

// Mark a task as changed: rev +1 and updated_at/by.
export function touch(task: TaskT, at: string, actor: string): void {
  task.rev += 1;
  task.updated_at = at;
  task.updated_by = actor;
}

// Task as returned to callers: known fields only, plus `archived`.
export interface TaskView {
  id: string;
  rev: number;
  title: string;
  description: string;
  status: string;
  assignee: string | null;
  labels: string[];
  links: LinkT[];
  fields: Record<string, unknown>;
  attachments: TaskT['attachments'];
  // actor_source: explicit or the session's default name; null for events written before it was recorded (and imported history).
  events: Array<{ at: string; actor: string; actor_source: ActorSource | null; type: EventType; data: Record<string, unknown> }>;
  events_dropped: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  archived_at: string | null;
  archived: boolean;
}

// Explicit mapping of a stored task to its view; `eventsLimit` keeps only the newest N events.
export function toTaskView(task: TaskT, archived: boolean, eventsLimit?: number): TaskView {
  const events = eventsLimit === undefined ? task.events : eventsLimit === 0 ? [] : task.events.slice(-eventsLimit);
  return {
    id: task.id,
    rev: task.rev,
    title: task.title,
    description: task.description,
    status: task.status,
    assignee: task.assignee,
    labels: [...task.labels],
    links: task.links.map((l) => ({ kind: l.kind, ref: l.ref })),
    fields: { ...task.fields },
    attachments: task.attachments.map((a) => ({ name: a.name, size: a.size, sha256: a.sha256, mime: a.mime, added_by: a.added_by, added_at: a.added_at })),
    events: events.map((e) => ({ at: e.at, actor: e.actor, actor_source: e.actor_source ?? null, type: e.type, data: e.data })),
    events_dropped: task.events_dropped,
    created_at: task.created_at,
    created_by: task.created_by,
    updated_at: task.updated_at,
    updated_by: task.updated_by,
    archived_at: task.archived_at ?? null,
    archived,
  };
}

// Short reply of a write that changed one task (CLI --json and MCP by default): what the next step needs, not the whole task
// (`get` or --full / MCP `full` gives that). The newest attachment rides along after an attach (its name removes it again).
export interface WriteReply extends WriteFacts {
  id: string;
  rev: number;
  status: string;
  assignee: string | null;
  attachment?: { name: string; size: number; sha256: string };
}

// What a write did that the task alone does not show: the earlier session a claim --resume took the task from,
// the commit finish linked (null: none, outside git or --no-commit).
export interface WriteFacts {
  resumed_from?: string;
  commit?: string | null;
}

// Explicit mapping of a task view to the short write reply; `attached`: the write added an attachment (attach appends it last).
export function writeReply(task: TaskView, attached = false, facts: WriteFacts = {}): WriteReply {
  const reply: WriteReply = { id: task.id, rev: task.rev, status: task.status, assignee: task.assignee };
  const added = attached ? task.attachments.at(-1) : undefined;
  if (added) reply.attachment = { name: added.name, size: added.size, sha256: added.sha256 };
  if (facts.resumed_from !== undefined) reply.resumed_from = facts.resumed_from;
  if (facts.commit !== undefined) reply.commit = facts.commit;
  return reply;
}

// Throw helper for invariants that need a specific code.
export function fail(code: ErrorCode, message: string, fix?: string): never {
  throw new LaneboardError(code, message, fix ? { fix } : {});
}
