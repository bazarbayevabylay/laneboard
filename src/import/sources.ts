// Read source task files for `laneboard import`: Markdown with YAML frontmatter, JSON objects, or a Markdown checklist (`- [ ]` items).
// Reads only, never writes.
import fs from 'node:fs';
import path from 'node:path';
import { LaneboardError } from '../core/index.ts';

export type ImportFormat = 'markdown' | 'json' | 'checklist';

// One `- [ ]` / `- [x]` line of a checklist file.
export interface ChecklistItem {
  // 1-based line number (for problems).
  line: number;
  // Leading columns (a tab counts 4): a deeper item is a child of the nearest shallower one above it.
  indent: number;
  checked: boolean;
  // Item text, trimmed, inner whitespace collapsed.
  text: string;
  // The nearest Markdown heading above the item (empty when none).
  heading: string;
}

// One source file as read: its keys, and for Markdown the body after the frontmatter.
export type SourceRecord =
  | { kind: 'task'; source: string; data: Record<string, unknown>; body?: string }
  // A Markdown file without frontmatter (README, index): not a task, listed in the result.
  // `checkboxes`: how many checklist items it holds (`import checklist` makes tasks of them).
  | { kind: 'not-task'; source: string; reason: string; checkboxes: number }
  // A checklist file: every `- [ ]` / `- [x]` item in order.
  | { kind: 'checklist'; source: string; items: ChecklistItem[] }
  // A file that cannot be read as a task: reported with every other problem.
  | { kind: 'broken'; source: string; reason: string };

const EXTENSION: Record<ImportFormat, string> = { markdown: '.md', json: '.json', checklist: '.md' };

// A list item with a checkbox: `- [ ] text`, `* [x] text`, `+ [X] text`, `1. [ ] text`.
const CHECKBOX_RE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\][ \t]+(\S.*)$/;
// An ATX heading: `## Backend` (closing #s dropped).
const HEADING_RE = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
// A code fence line (CommonMark 4.5): indent, a run of 3+ backticks or tildes, the rest; items inside a fenced block are not items.
const FENCE_RE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
// Any list item, with or without a checkbox: its content column holds a fence that belongs to the item.
const LIST_ITEM_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)\S/;
// An HTML comment opens at the start of a line (CommonMark HTML block 2): lines up to `-->` are not items.
const COMMENT_OPEN_RE = /^[ \t]*<!--/;

// Leading columns of an indent: a tab counts 4.
function columns(indent: string): number {
  let n = 0;
  for (const ch of indent) n += ch === '\t' ? 4 : 1;
  return n;
}

// Checklist items of a Markdown text in order, with the nearest heading above each; fenced code and HTML comments are skipped.
export function checklistItems(text: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  let heading = '';
  // The open fence: its character run (a closing fence uses the same character, at least as long) and the column it is measured from.
  let fence: { run: string; base: number } | undefined;
  let comment = false;
  // Content columns of the list items above (innermost last): a fence up to 3 columns past the innermost one belongs to it.
  let lists: number[] = [];
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  lines.forEach((raw, i) => {
    if (comment) {
      if (raw.includes('-->')) comment = false;
      return;
    }
    const f = FENCE_RE.exec(raw);
    if (fence) {
      const run = f?.[2] ?? '';
      if (f && run[0] === fence.run[0] && run.length >= fence.run.length && (f[3] ?? '').trim() === '' && columns(f[1] ?? '') - fence.base <= 3) fence = undefined;
      return;
    }
    if (raw.trim() === '') return;
    const indent = columns(/^[ \t]*/.exec(raw)?.[0] ?? '');
    lists = lists.filter((col) => col <= indent);
    const base = lists.at(-1) ?? 0;
    // A backtick fence's info string has no backticks (else it is inline code).
    if (f && indent - base <= 3 && !((f[2] ?? '').startsWith('`') && (f[3] ?? '').includes('`'))) {
      fence = { run: f[2] ?? '', base };
      return;
    }
    if (COMMENT_OPEN_RE.test(raw)) {
      comment = !raw.slice(raw.indexOf('<!--') + 4).includes('-->');
      return;
    }
    const h = HEADING_RE.exec(raw);
    if (h) {
      heading = (h[1] ?? '').trim();
      lists = [];
      return;
    }
    const li = LIST_ITEM_RE.exec(raw);
    if (li) lists.push(columns(li[1] ?? '') + (li[2] ?? '').length + columns(li[3] ?? ''));
    const m = CHECKBOX_RE.exec(raw);
    if (!m) return;
    const itemText = (m[3] ?? '').replace(/\s+/g, ' ').trim();
    items.push({ line: i + 1, indent: columns(m[1] ?? ''), checked: m[2] !== ' ', text: itemText, heading });
  });
  return items;
}

// Basename match for --exclude: `*` any run of characters, `?` one character, the rest literal.
function matches(name: string, pattern: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`, 's').test(name);
}

// Source files: the file itself, or the format's files directly in the directory (not recursive), sorted by name.
export function sourceFiles(format: ImportFormat, target: string, exclude: readonly string[]): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    // A missing path is the caller's input error.
    throw new LaneboardError('INVALID_VALUE', `${target}: no such file or directory`, {
      input: { field: 'path', value: target },
      fix: `pass the directory (or file) that holds the ${format} task files`,
    });
  }
  if (stat.isFile()) return [target];
  return fs
    .readdirSync(target, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(EXTENSION[format]) && !exclude.some((p) => matches(e.name, p)))
    .map((e) => path.join(target, e.name))
    .sort();
}

// Is the value a plain object (not an array, not null)?
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Split `---\n<yaml>\n---\n<body>`; undefined when the file does not start with frontmatter.
function splitFrontmatter(text: string): { yaml: string; body: string } | undefined {
  const clean = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!clean.startsWith('---\n')) return undefined;
  const end = /^(?:---|\.\.\.)[ \t]*$/m.exec(clean.slice(4));
  if (!end) return undefined;
  const yaml = clean.slice(4, 4 + end.index);
  const body = clean.slice(4 + end.index + end[0].length).replace(/^\n+/, '').trimEnd();
  return { yaml, body };
}

// Read one Markdown task file: frontmatter keys (YAML core schema, so dates stay strings) and the body.
async function readMarkdown(file: string, source: string): Promise<SourceRecord> {
  const text = fs.readFileSync(file, 'utf8');
  const parts = splitFrontmatter(text);
  if (!parts) return { kind: 'not-task', source, reason: 'no YAML frontmatter', checkboxes: checklistItems(text).length };
  // yaml is loaded only for Markdown imports (ADR-0001 §10).
  const { parse } = await import('yaml');
  let data: unknown;
  try {
    data = parse(parts.yaml, { schema: 'core', uniqueKeys: true });
  } catch (err) {
    // Broken YAML is one of the problems listed together.
    return { kind: 'broken', source, reason: `frontmatter is not valid YAML: ${(err as Error).message.split('\n')[0]}` };
  }
  if (!isObject(data)) return { kind: 'broken', source, reason: 'frontmatter is not a YAML mapping of keys' };
  return { kind: 'task', source, data, body: parts.body };
}

// Read one JSON task file: one task object per file.
function readJson(file: string, source: string): SourceRecord {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    // Broken JSON is one of the problems listed together.
    return { kind: 'broken', source, reason: `not valid JSON: ${(err as Error).message}` };
  }
  if (!isObject(data)) return { kind: 'broken', source, reason: 'not a JSON object (one task per file)' };
  return { kind: 'task', source, data };
}

// Read one checklist file: its items; a file without any item is not a task source (listed in the result).
function readChecklist(file: string, source: string): SourceRecord {
  const items = checklistItems(fs.readFileSync(file, 'utf8'));
  if (!items.length) return { kind: 'not-task', source, reason: 'no checklist items (- [ ] / - [x])', checkboxes: 0 };
  return { kind: 'checklist', source, items };
}

// Read every source file; `root` makes the source paths relative (the idempotency key), with / separators.
export async function readSources(format: ImportFormat, target: string, root: string, exclude: readonly string[]): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for (const file of sourceFiles(format, target, exclude)) {
    const source = path.relative(root, file).split(path.sep).join('/');
    out.push(format === 'markdown' ? await readMarkdown(file, source) : format === 'checklist' ? readChecklist(file, source) : readJson(file, source));
  }
  return out;
}
