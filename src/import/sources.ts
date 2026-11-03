// Read source task files for `laneboard import`: Markdown with YAML frontmatter, or JSON objects. Reads only, never writes.
import fs from 'node:fs';
import path from 'node:path';
import { LaneboardError } from '../core/index.ts';

export type ImportFormat = 'markdown' | 'json';

// One source file as read: its keys, and for Markdown the body after the frontmatter.
export type SourceRecord =
  | { kind: 'task'; source: string; data: Record<string, unknown>; body?: string }
  // A Markdown file without frontmatter (README, index): not a task, listed in the result.
  | { kind: 'not-task'; source: string; reason: string }
  // A file that cannot be read as a task: reported with every other problem.
  | { kind: 'broken'; source: string; reason: string };

const EXTENSION: Record<ImportFormat, string> = { markdown: '.md', json: '.json' };

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
  const parts = splitFrontmatter(fs.readFileSync(file, 'utf8'));
  if (!parts) return { kind: 'not-task', source, reason: 'no YAML frontmatter' };
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

// Read every source file; `root` makes the source paths relative (the idempotency key), with / separators.
export async function readSources(format: ImportFormat, target: string, root: string, exclude: readonly string[]): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for (const file of sourceFiles(format, target, exclude)) {
    const source = path.relative(root, file).split(path.sep).join('/');
    out.push(format === 'markdown' ? await readMarkdown(file, source) : readJson(file, source));
  }
  return out;
}
