// Op: remove a text (a secret pasted by mistake) from every text of one task and from the store backups (CLI only: `laneboard redact`).
import { z } from 'zod';
import { LaneboardError } from '../errors.ts';
import type { TaskT } from '../schema.ts';
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
  // How many occurrences were replaced.
  redacted: number;
}

// What a removed text becomes.
export const REDACTED = '[redacted]';

// Store limits of the texts redact rewrites (schema.ts): a replacement longer than the text may not push a value past them.
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 100000;
const LINK_REF_MAX = 2000;

// Replace every occurrence of `secret` in `text`; `count` gets the number replaced.
function replaceIn(text: string, secret: string, count: { n: number }): string {
  const parts = text.split(secret);
  if (parts.length === 1) return text;
  count.n += parts.length - 1;
  return parts.join(REDACTED);
}

// Cut a text to at most `max` UTF-16 units without splitting a character (the store checks .length).
function fit(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
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
function redactTaskTexts(task: TaskT, secret: string): number {
  const count = { n: 0 };
  task.title = fit(replaceIn(task.title, secret, count), TITLE_MAX);
  task.description = fit(replaceIn(task.description, secret, count), DESCRIPTION_MAX);
  task.links = task.links.map((l) => ({ kind: l.kind, ref: fit(replaceIn(l.ref, secret, count), LINK_REF_MAX) }));
  task.fields = redactValue(task.fields, secret, count) as TaskT['fields'];
  for (const event of task.events) event.data = redactValue(event.data, secret, count) as typeof event.data;
  return count.n;
}

// Redact one task (active or archived, a deleted one too): every occurrence becomes `[redacted]`, an `updated {redacted: {count}}`
// event says who did it and when, and both store files and their `.bak` are written from the new content, so no backup keeps the text.
export async function redactTask(ctx: OpContext, input: RedactInputT): Promise<OpResult<RedactResult>> {
  const actor = requireActor(ctx.actor);
  const p = parseInput(RedactInput, input);
  // A blank text would replace spaces and line breaks everywhere; the message never repeats the text.
  if (p.text.trim() === '') {
    throw new LaneboardError('INVALID_VALUE', 'the text to redact is blank', { input: { field: 'text', value: '' }, fix: 'pass a file that holds the exact text to remove: laneboard redact <id> --text-file <path>' });
  }
  const warnings: string[] = [];
  const data = await transact(
    ctx.store,
    { files: ['active', 'archive'] },
    (s) => {
      const id = normalizeId(p.id, s.config.prefix);
      const found = locate(s, id);
      if (!found) throw missingTask(ctx, id, s.config.prefix, 'write');
      const count = redactTaskTexts(found.task, p.text);
      if (count === 0) {
        // Nothing is written: the store and its backups stay as they are.
        throw new LaneboardError('INVALID_VALUE', `the text does not occur in ${id} (title, description, links, fields, history); nothing was changed`, {
          input: { field: 'text', value: '' },
          fix: `check the exact text (case, spaces; one trailing newline of the file is ignored) against laneboard get ${id} --json`,
        });
      }
      touch(found.task, s.now, actor);
      addEvent(found.task, s.config, s.now, actor, 'updated', { redacted: { count } }, actorSourceOf(ctx));
      return { id, rev: found.task.rev, redacted: count };
    },
    { ...txOptions(ctx, warnings), freshBackups: true },
  );
  return { data, warnings };
}
