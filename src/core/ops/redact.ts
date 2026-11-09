// Op: remove a text (a secret pasted by mistake) from every text of one task and from the store backups (CLI only: `laneboard redact`).
import fs from 'node:fs';
import { z } from 'zod';
import { LaneboardError } from '../errors.ts';
import { Link, Task } from '../schema.ts';
import type { ConfigT, FileKind, StoreFileT, TaskT } from '../schema.ts';
import { backupPath, serializeStoreFile } from '../store.ts';
import { transact } from '../transact.ts';
import { actorSourceOf, addEvent, IdInput, locate, normalizeId, parseInput, requireActor, touch, txOptions } from './common.ts';
import type { OpContext, OpResult } from './common.ts';
import { missingTask } from './links.ts';

export const RedactInput = z.strictObject({
  id: IdInput,
  // The exact text to remove; never echoed back (not in errors, replies or events).
  text: z.string().min(1),
});
export type RedactInputT = z.infer<typeof RedactInput>;

export interface RedactResult {
  id: string;
  rev: number;
  // How many occurrences were replaced in the task.
  redacted: number;
  // How many occurrences the store backups (`.bak`) held before they were written anew (a task deleted before the redact, an old
  // version of a text).
  backups: number;
}

// What a removed text becomes.
export const REDACTED = '[redacted]';

// The shortest text redact accepts: a shorter one would rewrite ordinary words and names all over the history.
export const REDACT_MIN_CHARS = 4;

// The max length of a string schema, read from the schema so the store limit has one source.
function maxOf(schema: { maxLength: number | null }): number {
  if (schema.maxLength === null) throw new Error('redact: a rewritten text has no store limit');
  return schema.maxLength;
}

// Store limits of the texts redact rewrites: a replacement longer than the text may not push a value past them.
const TITLE_MAX = maxOf(Task.shape.title);
const DESCRIPTION_MAX = maxOf(Task.shape.description);
const LINK_REF_MAX = maxOf(Link.shape.ref);

// Replace every occurrence of `secret` in `text`; `count` gets the number replaced.
function replaceIn(text: string, secret: string, count: { n: number }): string {
  const parts = text.split(secret);
  if (parts.length === 1) return text;
  count.n += parts.length - 1;
  return parts.join(REDACTED);
}

// Cut a text to at most `max` UTF-16 units without splitting a character (the store checks .length); a cut is reported in `cuts`.
function fit(text: string, max: number, what: string, cuts: string[]): string {
  if (text.length <= max) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  cuts.push(`${what} cut to ${max} characters after redact (${text.length - out.length} lost)`);
  return out;
}

// Every string inside a JSON value (event data, a json field) with the secret replaced; other values as they are.
function redactValue(value: unknown, secret: string, count: { n: number }): unknown {
  if (typeof value === 'string') return replaceIn(value, secret, count);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secret, count));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secret, count)]));
  }
  return value;
}

// Replace the secret in the task's title, description, link refs, field values and event data; returns how many were replaced.
function redactTaskTexts(task: TaskT, secret: string, cuts: string[]): number {
  const count = { n: 0 };
  task.title = fit(replaceIn(task.title, secret, count), TITLE_MAX, 'title', cuts);
  task.description = fit(replaceIn(task.description, secret, count), DESCRIPTION_MAX, 'description', cuts);
  task.links = task.links.map((l, i) => ({ kind: l.kind, ref: fit(replaceIn(l.ref, secret, count), LINK_REF_MAX, `links[${i}].ref`, cuts) }));
  task.fields = redactValue(task.fields, secret, count) as TaskT['fields'];
  for (const event of task.events) event.data = redactValue(event.data, secret, count) as typeof event.data;
  return count.n;
}

// Paths of every key and string in `value` that still holds the secret (labels[0], attachments[1].name, events[2].actor).
function remainingPlaces(value: unknown, secret: string, at: string, out: string[]): string[] {
  if (typeof value === 'string') {
    if (value.includes(secret)) out.push(at);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => remainingPlaces(item, secret, `${at}[${i}]`, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const place = at === '' ? key : `${at}.${key}`;
      if (key.includes(secret)) out.push(`${place} (key)`);
      remainingPlaces(item, secret, place, out);
    }
  }
  return out;
}

// Refuse a text that would rewrite what the board itself uses: too short, a part of [redacted], the id, the prefix, a status or an actor.
function refuseBoardWord(secret: string, id: string, config: ConfigT, task: TaskT, actor: string): void {
  const fix = `pass the whole secret (at least ${REDACT_MIN_CHARS} characters), exactly as it was pasted: laneboard redact ${id} --text-file <path> --json`;
  const refuse = (why: string): never => {
    throw new LaneboardError('INVALID_VALUE', `the text to redact ${why}; nothing was changed`, { input: { field: 'text', value: '' }, fix });
  };
  if ([...secret].length < REDACT_MIN_CHARS) refuse(`is shorter than ${REDACT_MIN_CHARS} characters`);
  if (REDACTED.includes(secret)) refuse(`is a part of ${REDACTED}`);
  // A part counts too: `doin` would rewrite every `doing` in the status history.
  if (config.prefix.includes(secret)) refuse('is (part of) the board prefix');
  if (id.includes(secret)) refuse('is (part of) the task id');
  if (config.statuses.some((st) => st.includes(secret))) refuse('is (part of) a status name');
  const actors = [actor, task.assignee, task.created_by, task.updated_by, ...task.events.map((e) => e.actor), ...task.attachments.map((a) => a.added_by)];
  if (actors.some((a) => a?.includes(secret))) refuse('is (part of) an actor name');
}

// Refuse before any write when the secret is still in the task after the replace: in a label or an attachment name (their format has
// no room for [redacted], and an attachment's name is its file) or in an id, status, actor, date or key. The fix says what to remove first.
function refuseRemaining(task: TaskT, secret: string, archived: boolean): void {
  const places = remainingPlaces(task, secret, '', []);
  if (places.length === 0) return;
  const steps: string[] = [];
  const labels = places.some((p) => p.startsWith('labels['));
  const attachments = places.some((p) => p.startsWith('attachments['));
  if ((labels || attachments) && archived) steps.push(`restore it first: laneboard restore ${task.id} --json`);
  if (labels) steps.push(`remove the label: laneboard update ${task.id} --remove-label <label> --json`);
  if (attachments) steps.push(`remove the attachment (its file goes too): laneboard attach ${task.id} --remove <name> --json`);
  if (!labels && !attachments) steps.push('the text is part of an id, status, actor name, date or key, which redact never changes: pass only the exact secret');
  else steps.push(`then run laneboard redact ${task.id} --json again (it also clears the events of the removal)`);
  const shown = places.length > 10 ? [...places.slice(0, 10), `${places.length - 10} more`] : places;
  throw new LaneboardError('INVALID_VALUE', `the text also occurs where redact cannot replace it: ${shown.join(', ')}; nothing was changed`, {
    input: { field: 'text', value: '' },
    fix: `${steps.join('; ')} (laneboard get ${task.id} --json shows them)`,
  });
}

// How often `secret` occurs in `text` as stored (JSON-escaped).
function storedCount(text: string, secret: string): number {
  return text.split(JSON.stringify(secret).slice(1, -1)).length - 1;
}

// How many occurrences the backup of each declared file holds in its copies of task `id` (an old version, the task before a delete).
// Copies of other tasks do not count: they are theirs to redact, and the fresh backup keeps whatever they still hold.
function backupOccurrences(storeDir: string, kinds: readonly FileKind[], id: string, secret: string, current: Record<FileKind, StoreFileT>): number {
  let n = 0;
  for (const kind of kinds) {
    let raw: string;
    try {
      raw = fs.readFileSync(backupPath(storeDir, kind), 'utf8');
    } catch (err) {
      // No backup yet (a fresh store): nothing to find in it; any other read error is reported.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    let tasks: unknown;
    try {
      tasks = (JSON.parse(raw) as { tasks?: unknown }).tasks;
    } catch {
      // A damaged backup: count what it holds beyond the new content of that file (what the fresh backup drops).
      n += Math.max(0, storedCount(raw, secret) - storedCount(serializeStoreFile(current[kind]), secret));
      continue;
    }
    if (!Array.isArray(tasks)) continue;
    for (const task of tasks) {
      if ((task as { id?: unknown } | null)?.id === id) n += storedCount(JSON.stringify(task), secret);
    }
  }
  return n;
}

// Redact one task (active or archived, a deleted one too): every occurrence becomes `[redacted]`, an `updated {redacted: {count, backups}}`
// event says who did it and when, and both store files and their `.bak` are written from the new content, so no backup keeps the text
// (also when only a backup holds it: a task deleted before the redact).
export async function redactTask(ctx: OpContext, input: RedactInputT): Promise<OpResult<RedactResult>> {
  const actor = requireActor(ctx.actor);
  const p = parseInput(RedactInput, input);
  // A blank text would replace spaces and line breaks everywhere; the message never repeats the text.
  if (p.text.trim() === '') {
    throw new LaneboardError('INVALID_VALUE', 'the text to redact is blank', { input: { field: 'text', value: '' }, fix: `pass a file that holds the exact text to remove: laneboard redact ${p.id} --text-file <path> --json` });
  }
  const warnings: string[] = [];
  const files = ['active', 'archive'] as const;
  const data = await transact(
    ctx.store,
    { files },
    (s) => {
      const id = normalizeId(p.id, s.config.prefix);
      const found = locate(s, id);
      if (!found) throw missingTask(ctx, id, s.config.prefix, 'write');
      refuseBoardWord(p.text, id, s.config, found.task, actor);
      const cuts: string[] = [];
      const count = redactTaskTexts(found.task, p.text, cuts);
      refuseRemaining(found.task, p.text, found.archived);
      // Read under the lock, so no writer rotates a backup between this count and the write below.
      const backups = backupOccurrences(ctx.store.dir, files, id, p.text, { active: s.active, archive: s.archive });
      if (count === 0 && backups === 0) {
        // Nothing is written: the store and its backups stay as they are.
        throw new LaneboardError('INVALID_VALUE', `the text does not occur in ${id} (title, description, links, fields, history) or in the store backups; nothing was changed`, {
          input: { field: 'text', value: '' },
          fix: `check the exact text (case, spaces; one trailing newline of the file is ignored) against laneboard get ${id} --json`,
        });
      }
      warnings.push(...cuts);
      const others = [...s.active.tasks, ...s.archive.tasks].filter((t) => t.id !== id && storedCount(JSON.stringify(t), p.text) > 0);
      if (others.length > 0) warnings.push(`the text also occurs in ${others.map((t) => t.id).join(', ')}: redact each of them too`);
      touch(found.task, s.now, actor);
      addEvent(found.task, s.config, s.now, actor, 'updated', { redacted: { count, backups } }, actorSourceOf(ctx));
      return { id, rev: found.task.rev, redacted: count, backups };
    },
    { ...txOptions(ctx, warnings), freshBackups: true },
  );
  return { data, warnings };
}
