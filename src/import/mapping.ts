// Map source records to import tasks by the options: which key is the title, status, assignee…, how statuses are renamed,
// which keys become fields or are dropped, and how a JSON history becomes events. Structural problems are collected, not thrown one by one.
// A checklist maps item by item: checked -> the done status, indent -> parent, heading -> label (when asked).
import { ACTOR_RE, MAX_COMMENT_CHARS } from '../core/index.ts';
import type { ImportTaskT } from '../core/index.ts';
import type { ChecklistItem, SourceRecord } from './sources.ts';

export interface MappingOptions {
  titleKey: string;
  statusKey: string;
  // Source status -> configured status.
  statusMap: ReadonlyMap<string, string>;
  // Source key -> declared field.
  fieldMap: ReadonlyMap<string, string>;
  ignoreKeys: readonly string[];
  assigneeKey?: string;
  labelsKey?: string;
  // JSON only: the key holding the description (Markdown uses the body).
  descriptionKey?: string;
  // JSON only: the key holding a list of history entries.
  historyKey?: string;
  // Actor for history entries without a usable actor.
  actor: string;
  // Time of the import, for history entries without a usable time.
  now: string;
}

export interface MappingProblem {
  source: string;
  field: string;
  message: string;
}

export interface Mapped {
  tasks: ImportTaskT[];
  problems: MappingProblem[];
  // Files that are not tasks (no frontmatter).
  ignored: Array<{ source: string; reason: string }>;
  // Ignored files that hold checklist items (`import checklist` reads them).
  checklists: Array<{ source: string; checkboxes: number }>;
  // History texts cut to the comment limit.
  truncated: number;
}

export interface ChecklistOptions {
  // Status of an open item (`- [ ]`).
  status: string;
  // Status of a checked item (`- [x]`).
  doneStatus: string;
  // The nearest heading above an item becomes its label.
  headingLabels: boolean;
}

// Longest task title in code points (the core's TitleInput: zod 4 counts code points).
const TITLE_MAX = 200;

// Empty result of a mapping.
function emptyMapped(): Mapped {
  return { tasks: [], problems: [], ignored: [], checklists: [], truncated: 0 };
}

// A record that is not a task: listed as ignored, and as a checklist when it holds checkbox items.
function noteIgnored(out: Mapped, r: { source: string; reason: string; checkboxes: number }): void {
  out.ignored.push({ source: r.source, reason: r.reason });
  if (r.checkboxes > 0) out.checklists.push({ source: r.source, checkboxes: r.checkboxes });
}

// A heading as a label: lower case, runs of other characters -> '-', at most 40 characters; undefined when nothing is left.
export function headingLabel(heading: string): string | undefined {
  const slug = heading
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug === '' ? undefined : slug;
}

// The idempotency key of an item: file and item text; the n-th item with the same text in the file gets " (n)".
function itemSource(file: string, text: string, seen: Map<string, number>): string {
  const n = (seen.get(text) ?? 0) + 1;
  seen.set(text, n);
  return `${file}#${text}${n > 1 ? ` (${n})` : ''}`;
}

// One checklist file as tasks: each item is a task; an item indented under another is its child (parent_source); a heading starts anew.
function checklistTasks(file: string, items: readonly ChecklistItem[], o: ChecklistOptions): ImportTaskT[] {
  const tasks: ImportTaskT[] = [];
  const seen = new Map<string, number>();
  // Open items above the current one, shallowest first: the parent is the nearest one with a smaller indent.
  let stack: Array<{ indent: number; source: string }> = [];
  let heading: string | undefined;
  for (const item of items) {
    if (item.heading !== heading) stack = [];
    heading = item.heading;
    while (stack.length && (stack.at(-1)?.indent ?? 0) >= item.indent) stack.pop();
    const source = itemSource(file, item.text, seen);
    const chars = Array.from(item.text);
    const long = chars.length > TITLE_MAX;
    const task: ImportTaskT = { source, title: long ? `${chars.slice(0, TITLE_MAX - 1).join('')}…` : item.text, status: item.checked ? o.doneStatus : o.status };
    // A title cut to the limit keeps the whole text in the description.
    if (long) task.description = item.text;
    const parent = stack.at(-1);
    if (parent) task.parent_source = parent.source;
    const label = o.headingLabels ? headingLabel(item.heading) : undefined;
    if (label !== undefined) task.labels = [label];
    tasks.push(task);
    stack.push({ indent: item.indent, source });
  }
  return tasks;
}

// Map checklist records: every item of every file is a task; files without items are listed as ignored.
export function mapChecklist(records: readonly SourceRecord[], o: ChecklistOptions): Mapped {
  const out = emptyMapped();
  for (const r of records) {
    if (r.kind === 'not-task') noteIgnored(out, r);
    else if (r.kind === 'checklist') out.tasks.push(...checklistTasks(r.source, r.items, o));
    else out.problems.push({ source: r.source, field: 'file', message: r.kind === 'broken' ? r.reason : 'not a checklist file' });
  }
  return out;
}

// Keys a history entry may use for its time, actor, and text (first one present wins).
const TIME_KEYS = ['at', 'ts', 'time', 'timestamp', 'date', 'created_at'];
const ACTOR_KEYS = ['actor', 'by', 'author', 'user'];
const TEXT_KEYS = ['note', 'text', 'message', 'comment'];
const EVENT_KEYS = ['event', 'type', 'action'];

// First present (non-null) value among `keys`.
function pick(entry: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) if (Object.hasOwn(entry, k) && entry[k] !== null && entry[k] !== undefined) return entry[k];
  return undefined;
}

// A scalar as text (numbers and booleans too); objects are not scalars.
function scalarText(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

// A source time as ISO UTC with ms: a full ISO time (no offset = UTC), a date (midnight UTC), or epoch seconds/ms; else undefined.
export function isoTime(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v >= 1e12 ? v : v >= 1e9 ? v * 1000 : NaN;
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) return undefined;
  const d = new Date(`${m[1]}T${m[2]}${m[3] ?? 'Z'}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// A status renamed by the map (history keeps an unmapped value as it was: it describes the past).
function mapStatus(value: string, map: ReadonlyMap<string, string>): string {
  return map.get(value) ?? value;
}

// Cut a comment to the limit; reports whether it was cut.
function clip(text: string): { text: string; cut: boolean } {
  return text.length <= MAX_COMMENT_CHARS ? { text, cut: false } : { text: `${text.slice(0, MAX_COMMENT_CHARS - 1)}…`, cut: true };
}

// One JSON history entry as an event: from/to -> `status`, else `commented`; no usable time -> a comment at import time saying so.
function historyEvent(entry: unknown, o: MappingOptions): { event: NonNullable<ImportTaskT['history']>[number]; cut: boolean } {
  const obj = typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>) : undefined;
  const at = obj ? isoTime(pick(obj, TIME_KEYS)) : undefined;
  const rawActor = obj ? scalarText(pick(obj, ACTOR_KEYS)) : undefined;
  const actor = rawActor !== undefined && ACTOR_RE.test(rawActor) ? rawActor : o.actor;
  const extra: Record<string, unknown> = rawActor !== undefined && actor !== rawActor ? { source_actor: rawActor } : {};
  if (!obj || at === undefined) {
    const { text, cut } = clip(`history entry without a usable time: ${typeof entry === 'string' ? entry : JSON.stringify(entry)}`);
    return { event: { at: o.now, actor, type: 'commented', data: { text, ...extra } }, cut };
  }
  const note = scalarText(pick(obj, TEXT_KEYS));
  const from = scalarText(obj.from);
  const to = scalarText(obj.to);
  if (from !== undefined || to !== undefined) {
    const data: Record<string, unknown> = { from: from === undefined ? null : mapStatus(from, o.statusMap), to: to === undefined ? null : mapStatus(to, o.statusMap), ...extra };
    if (note !== undefined) data.note = note;
    return { event: { at, actor, type: 'status', data }, cut: false };
  }
  const name = scalarText(pick(obj, EVENT_KEYS));
  const body = [name !== undefined ? `[${name}]` : undefined, note].filter((x) => x !== undefined && x !== '').join(' ');
  const { text, cut } = clip(body === '' ? JSON.stringify(obj) : body);
  return { event: { at, actor, type: 'commented', data: { text, ...extra } }, cut };
}

// Map every record; problems name the source file and the key.
export function mapRecords(records: readonly SourceRecord[], o: MappingOptions): Mapped {
  const out = emptyMapped();
  const special = new Set([o.titleKey, o.statusKey, o.assigneeKey, o.labelsKey, o.descriptionKey, o.historyKey].filter((k): k is string => k !== undefined));
  for (const r of records) {
    if (r.kind === 'not-task') {
      noteIgnored(out, r);
      continue;
    }
    const bad = (field: string, message: string): void => {
      out.problems.push({ source: r.source, field, message });
    };
    if (r.kind === 'broken' || r.kind === 'checklist') {
      // A checklist record comes only from `import checklist` (mapChecklist); here it is a file that is not a task.
      bad('file', r.kind === 'broken' ? r.reason : 'a checklist file, not a task file');
      continue;
    }
    const d = r.data;
    const value = (key: string | undefined): unknown => (key !== undefined && Object.hasOwn(d, key) && d[key] !== null ? d[key] : undefined);

    const title = scalarText(value(o.titleKey));
    if (title === undefined) bad(o.titleKey, value(o.titleKey) === undefined ? `no "${o.titleKey}" key (the title; --title-key names another key)` : `"${o.titleKey}" is not text`);
    const rawStatus = scalarText(value(o.statusKey));
    if (rawStatus === undefined) bad(o.statusKey, value(o.statusKey) === undefined ? `no "${o.statusKey}" key (the status; --status-key names another key)` : `"${o.statusKey}" is not text`);

    const task: ImportTaskT = { source: r.source, title: title ?? '', status: rawStatus === undefined ? '' : mapStatus(rawStatus, o.statusMap) };
    if (r.body !== undefined) task.description = r.body;
    else if (value(o.descriptionKey) !== undefined) {
      const text = scalarText(value(o.descriptionKey));
      if (text === undefined) bad(o.descriptionKey ?? 'description', `"${o.descriptionKey}" is not text`);
      else task.description = text;
    }
    if (value(o.assigneeKey) !== undefined) {
      const who = scalarText(value(o.assigneeKey));
      if (who === undefined) bad(o.assigneeKey ?? 'assignee', `"${o.assigneeKey}" is not text`);
      else task.assignee = who;
    }
    const labels = value(o.labelsKey);
    if (labels !== undefined) {
      if (typeof labels === 'string') task.labels = labels.split(',').map((l) => l.trim()).filter(Boolean);
      else if (Array.isArray(labels) && labels.every((l) => typeof l === 'string')) task.labels = labels as string[];
      else bad(o.labelsKey ?? 'labels', `"${o.labelsKey}" is not a list of text`);
    }
    const history = value(o.historyKey);
    if (history !== undefined) {
      if (!Array.isArray(history)) bad(o.historyKey ?? 'history', `"${o.historyKey}" is not a list`);
      else {
        task.history = history.map((entry) => {
          const h = historyEvent(entry, o);
          if (h.cut) out.truncated++;
          return h.event;
        });
      }
    }
    const fields: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(d)) {
      if (special.has(key) || o.ignoreKeys.includes(key) || v === null) continue;
      fields[o.fieldMap.get(key) ?? key] = v;
    }
    if (Object.keys(fields).length) task.fields = fields;
    out.tasks.push(task);
  }
  return out;
}
