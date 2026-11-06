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
  // Told once when the command has waited for the store lock a while (CLI human mode prints it on stderr).
  onLockWait?: (message: string) => void;
}

// Options for transact taken from the op context; warnings go to `warnings`.
export function txOptions(ctx: OpContext, warnings: string[]): TransactOptions {
  return { faults: ctx.faults, lockWaitMs: ctx.lockWaitMs, lockMaxHoldMs: ctx.lockMaxHoldMs, onLockWait: ctx.onLockWait, warnings };
}

// Op output: data for the envelope plus warnings; `reply`: facts of this write for the short write reply (claim --resume, finish).
export interface OpResult<T> {
  data: T;
  warnings: string[];
  reply?: WriteFacts;
  // The op wrote less than it was asked for (finish of a task already in that status that only linked a new commit).
  unchanged?: boolean;
  // finish by the assignee handed the task in (a status that is not final); the CLI line says "handed in" (LB-11 c), not in the JSON reply.
  handed_in?: boolean;
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

// The check statuses of a board in order (config review.statuses, P1); empty without checks, and then finish, update and the marks
// work as in 0.3.1 (ADR §22).
export function reviewStatuses(config: ConfigT): string[] {
  return [...(config.review?.statuses ?? [])];
}

// Who passes a handed-in task on or accepts it on a board with checks (config review.by); empty: anybody but its assignee.
export function reviewers(config: ConfigT): string[] {
  return [...(config.review?.by ?? [])];
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

// When the current assignee's work on the task began: the time of the event that gave it the task; across `claim --resume`
// (an `assigned` event with `resumed: true`) that of the session it resumed from, back to the first one, since an earlier session's
// commit is this work too (review S3b MINOR). Undefined for an unassigned task or when that event was dropped by the events limit.
export function workStartedAt(task: TaskT): string | undefined {
  let holder = task.assignee;
  for (let i = task.events.length - 1; i >= 0 && holder !== null; i--) {
    const e = task.events[i];
    if (e?.type === 'created') return e.data.assignee === holder ? e.at : undefined;
    if (e?.type !== 'assigned') continue;
    if (e.data.to !== holder) return undefined;
    if (e.data.resumed !== true) return e.at;
    holder = typeof e.data.from === 'string' ? e.data.from : null;
  }
  return undefined;
}

// Is the task the work of another session of the actor's default name (claim --resume)? Its holder looks like `<base>:<session>`
// and took it itself under its session default name: that event says actor_source `default`. By the data, not the form of the name:
// an explicit name of the same form (`<base>:reviewer`) and a task handed to such a name by someone else never qualify (review S3).
export function heldByEarlierSession(task: TaskT, sessionBase: string | undefined, actor: string): boolean {
  const holder = task.assignee;
  if (holder === null) return false;
  const e = assignmentEvent(task);
  return e !== undefined && e.actor === holder && byEarlierSession(e, sessionBase, actor);
}

// Was event `e` written by another session of the actor's default name: its actor looks like `<sessionBase>:<session>` and wrote it
// under its session default name (actor_source `default`). The one test of "another session of yours" by the data (review S3): for
// claim --resume (heldByEarlierSession) and for the author of the work on a board with checks (S6w r3: the same author in any session).
export function byEarlierSession(e: TaskEventT, sessionBase: string | undefined, actor: string): boolean {
  return e.actor_source === 'default' && isEarlierSessionName(e.actor, sessionBase, actor);
}

// An earlier session of the default name that wrote nothing on the board for this long is taken for closed (a /clear or a restart):
// its task's ALREADY_CLAIMED then offers `claim --resume` as the fix; a younger one may be a parallel session at work (P5, S6l).
export const EARLIER_SESSION_SILENT_MS = 15 * 60_000;

// Milliseconds since `holder` last wrote on the board: its newest event on any of `tasks` (a session at work writes to its other
// tasks too, e.g. a subtask of the one asked about); Infinity when no event of it is left.
export function silentFor(tasks: readonly TaskT[], holder: string, now: string): number {
  let last = -Infinity;
  for (const task of tasks) {
    for (const e of task.events) {
      if (e.actor === holder) last = Math.max(last, Date.parse(e.at));
    }
  }
  return Math.max(0, Date.parse(now) - last);
}

// Whole minutes of `ms` for a message: "<1 min" under a minute.
export function minutesText(ms: number): string {
  return ms < 60_000 ? '<1 min' : `${Math.floor(ms / 60_000)} min`;
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

// The label a fix offers for one that breaks the format (B-U7): lowercase, accents dropped, every run of other characters one "-",
// starting with a letter or digit, at most 40 characters (`Zone:API` -> zone-api); a valid label is itself; undefined when nothing
// is left (`日本`).
export function labelSuggestion(label: string): string | undefined {
  const plain = label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const fitted = plain.replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 40);
  return LABEL_RE.test(fitted) ? fitted : undefined;
}

// Label format check.
export function checkLabel(label: string): void {
  if (!LABEL_RE.test(label)) {
    const suggestion = labelSuggestion(label);
    throw new LaneboardError('INVALID_VALUE', `label "${label}" must match ^[a-z0-9][a-z0-9._-]{0,39}$ (lowercase)`, {
      input: { field: 'label', value: label, format: '<label like ui-bug>', ...(suggestion !== undefined ? { suggestion } : {}) },
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

// A number field's CLI value: an optional minus, digits, an optional fraction (`-3`, `0.5`, `12`).
const DECIMAL_RE = /^-?[0-9]+(\.[0-9]+)?$/;

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
        // Decimal notation only (B-U8): Number() also reads `0x10` as 16, `1e3`, ` 5 ` and `Infinity`.
        if (!DECIMAL_RE.test(raw)) throw bad('a number');
        out[key] = Number(raw);
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

// `kind=task` links must reference an existing id in either file; `checked`: links to another board's tasks, checked on that board
// before the lock (checkForeignTaskLinks, ADR §30).
export function checkTaskLinks(links: readonly LinkT[], files: readonly StoreFileT[], prefix: string, checked: ReadonlySet<string> = new Set()): void {
  for (const link of links) {
    if (link.kind !== 'task' || checked.has(link.ref)) continue;
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

// Check a parent for `childId` (undefined: a task being created) and return its exact id (ADR §25): a task of this board (a foreign
// prefix gets the fix to link it instead: `linkParam` is the op's link parameter), existing, not archived, and not the child itself
// or one of its descendants (the chain is walked through both files, so a cycle can never be stored).
export function checkParent(files: { active: StoreFileT; archive: StoreFileT }, raw: string, prefix: string, childId: string | undefined, linkParam: 'links' | 'add_links'): string {
  const foreign = ID_RE.test(raw) ? raw.slice(0, raw.lastIndexOf('-')) : prefix;
  if (foreign !== prefix) {
    const param = linkParam === 'links' ? '--link' : '--add-link';
    throw new LaneboardError('INVALID_VALUE', `parent must be a task on this board (${prefix}); ${raw} is on another board: link it instead`, {
      input: { field: 'parent', value: raw },
      fix: `drop parent and pass ${linkParam} [{"kind": "task", "ref": "${raw}"}] (CLI: ${param} task=${raw})`,
      edit: { drop: [{ name: 'parent' }], add: [{ name: linkParam, value: `task=${raw}` }] },
    });
  }
  const id = normalizeId(raw, prefix, 'parent');
  const found = locate(files, id);
  if (!found) throw new LaneboardError('TASK_NOT_FOUND', `parent ${id}: no such task`, { input: { field: 'parent', value: id } });
  if (found.archived) throw new LaneboardError('TASK_ARCHIVED', `parent ${id} is archived and read-only`, { fix: `laneboard restore ${id}` });
  if (childId === undefined) return id;
  // Walk up from the new parent: reaching the child means the parent is the child itself or under it.
  const chain = [id];
  let at: TaskT = found.task;
  while (at.id !== childId) {
    const up = at.parent;
    const next = up === undefined || chain.includes(up) ? undefined : locate(files, up)?.task;
    if (next === undefined) return id;
    chain.push(next.id);
    at = next;
  }
  const why = id === childId ? 'a task cannot be its own parent' : `${id} is under ${childId} (${[...chain].reverse().join(' > ')})`;
  const instead = `<id of a task not under ${childId}>`;
  throw new LaneboardError('INVALID_VALUE', `${id} cannot be the parent of ${childId}: ${why}`, {
    input: { field: 'parent', value: id },
    fix: `laneboard update ${childId} --parent ${instead}`,
    edit: { drop: [{ name: 'parent' }], add: [{ name: 'parent', value: instead }] },
  });
}

// Warning when `parent` is archived or moved into a final status while its children in active.json are not final (ADR §25, Q2:
// a warning, not an error; the children keep their parent). Undefined when it has no open child.
export function openChildrenWarning(active: StoreFileT, parent: string, finals: readonly string[]): string | undefined {
  const open = active.tasks.filter((t) => t.parent === parent && !finals.includes(t.status));
  if (!open.length) return undefined;
  return `${parent} has open children: ${open.map((t) => `${t.id} [${t.status}]`).join(', ')}; they keep parent ${parent}`;
}

// The one label name the core knows (ADR §28): the orchestrator marks a task that waits for the owner's answer with it; filters
// are the usual --label ones, cards and the all-boards overview show it.
export const WAITING_OWNER_LABEL = 'waiting-owner';

// Longest first line of a comment a card or a list row shows (code points, cut with an ellipsis).
export const COMMENT_LINE_MAX = 120;

// The newest comment of a task as a card line: when, who, its first non-blank line, and whether it is finish's result (ADR §27).
export interface LastComment {
  at: string;
  actor: string;
  text: string;
  result: boolean;
}

// The newest `commented` event as a card line (ADR §28): its first non-blank line, trimmed, cut to COMMENT_LINE_MAX; null without one.
export function lastComment(task: TaskT): LastComment | null {
  for (let i = task.events.length - 1; i >= 0; i--) {
    const e = task.events[i];
    if (e?.type !== 'commented') continue;
    const raw = typeof e.data.text === 'string' ? e.data.text : '';
    const line = (raw.split('\n').find((l) => l.trim() !== '') ?? '').trim();
    const chars = [...line];
    const text = chars.length <= COMMENT_LINE_MAX ? line : `${chars.slice(0, COMMENT_LINE_MAX - 1).join('')}…`;
    return { at: e.at, actor: e.actor, text, result: e.data.result === true };
  }
  return null;
}

// Find a task that may be changed: must exist and not be archived; `missing` builds the not-found error (missingTask names the board
// of an id with another board's prefix, ADR §30).
export function requireActiveTask(files: { active: StoreFileT; archive: StoreFileT }, id: string, missing: (id: string) => LaneboardError = notFound): TaskT {
  const found = locate(files, id);
  if (!found) throw missing(id);
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

// Events the limit drops last (A16): the one just added, `created`, the newest `status`, the newest `assigned` and the newest result
// comment, which the hand-in, the acceptance, the author of the work and the result are read from; their positions in `events`.
function keptEvents(events: readonly TaskEventT[]): Set<number> {
  const kept = new Set<number>([events.length - 1]);
  const newest = (match: (e: TaskEventT) => boolean): void => {
    const at = events.findLastIndex(match);
    if (at >= 0) kept.add(at);
  };
  newest((e) => e.type === 'created');
  newest((e) => e.type === 'status');
  newest((e) => e.type === 'assigned');
  newest((e) => e.type === 'commented' && e.data.result === true);
  return kept;
}

// Append an event (core only) and drop the oldest over limits.events_per_task: the other events first, the kept ones (keptEvents)
// only when they alone are over the limit.
// `source` is set for events of a caller (explicit or default name); imported history events have none.
export function addEvent(task: TaskT, config: ConfigT, at: string, actor: string, type: EventType, data: Record<string, unknown>, source?: ActorSource): void {
  const event: TaskEventT = source === undefined ? { at, actor, type, data } : { at, actor, actor_source: source, type, data };
  task.events.push(event);
  const over = task.events.length - config.limits.events_per_task;
  if (over <= 0) return;
  const kept = keptEvents(task.events);
  const others = task.events.flatMap((_, i) => (kept.has(i) ? [] : [i]));
  const keptOldest = [...kept].sort((a, b) => a - b);
  const dropped = [...others, ...keptOldest].slice(0, over).sort((a, b) => b - a);
  for (const i of dropped) task.events.splice(i, 1);
  task.events_dropped += over;
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
  // Id of the parent task on this board (ADR §25); null for a top-level task.
  parent: string | null;
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
  // Only on a tombstone (ADR §6 Q1, S6e): when and by whom the task was deleted.
  deleted?: DeletedMark;
}

// When and by whom a task was deleted: the mark of a tombstone (store@1 keeps unknown task keys, so 0.3.1 reads and keeps it).
export interface DeletedMark {
  at: string;
  by: string;
}

// The deleted mark of a task, or undefined for a task that was not deleted.
export function deletedMark(task: TaskT): DeletedMark | undefined {
  const mark = (task as { deleted?: unknown }).deleted;
  if (typeof mark !== 'object' || mark === null) return undefined;
  const { at, by } = mark as { at?: unknown; by?: unknown };
  return { at: typeof at === 'string' ? at : '?', by: typeof by === 'string' ? by : '?' };
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
    parent: task.parent ?? null,
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
    ...deletedField(task, archived),
  };
}

// `deleted` for a view: present only on a tombstone (an archived task with the mark), so the view of any other task keeps its keys.
// An active task with the mark (restored by 0.3.1, which keeps unknown keys) is a live task again: no `deleted`, as delete and restore treat it.
export function deletedField(task: TaskT, archived: boolean): { deleted?: DeletedMark } {
  if (!archived) return {};
  const mark = deletedMark(task);
  return mark ? { deleted: mark } : {};
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
// the commit finish linked (null: none, outside git, --no-commit or an acceptance), and that finish accepted somebody else's handed-in task.
export interface WriteFacts {
  resumed_from?: string;
  commit?: string | null;
  accepted?: true;
  // On a board with checks (P1): finish by a checker passed the task on to the next check, and the status it came from (also of an acceptance).
  passed?: true;
  from?: string;
  // On a board with checks: this update returned a handed-in task for rework (S7a U6 run 8): who holds it now, and the reason its
  // prime shows (the returner's comment since the hand-in, as lastComment shows it; null: none, see the warning).
  returned?: { to: string | null; reason: string | null };
}

// Explicit mapping of a task view to the short write reply; `attached`: the write added an attachment (attach appends it last).
export function writeReply(task: TaskView, attached = false, facts: WriteFacts = {}): WriteReply {
  const reply: WriteReply = { id: task.id, rev: task.rev, status: task.status, assignee: task.assignee };
  const added = attached ? task.attachments.at(-1) : undefined;
  if (added) reply.attachment = { name: added.name, size: added.size, sha256: added.sha256 };
  if (facts.resumed_from !== undefined) reply.resumed_from = facts.resumed_from;
  if (facts.commit !== undefined) reply.commit = facts.commit;
  if (facts.accepted === true) reply.accepted = true;
  if (facts.passed === true) reply.passed = true;
  if (facts.from !== undefined) reply.from = facts.from;
  if (facts.returned !== undefined) reply.returned = { to: facts.returned.to, reason: facts.returned.reason };
  return reply;
}

// Throw helper for invariants that need a specific code.
export function fail(code: ErrorCode, message: string, fix?: string): never {
  throw new LaneboardError(code, message, fix ? { fix } : {});
}
