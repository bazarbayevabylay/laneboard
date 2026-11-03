// JSON edits owned by laneboard: one key at a path, or one entry in an array (hooks). Formatting of the rest is kept.
import { LaneboardError } from '../core/index.ts';
import type { TextEdit } from './files.ts';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

// Is the value a plain JSON object?
function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Same JSON value (key order ignored)?
export function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
  }
  return a === b;
}

// Indent of an existing JSON text (default two spaces).
function indentOf(text: string): string {
  return /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
}

// Serialize with the file's own indent and a trailing newline.
function serialize(value: JsonObject, like: string | null): string {
  return `${JSON.stringify(value, null, like === null ? '  ' : indentOf(like))}\n`;
}

// What laneboard owns in a JSON file.
export type JsonOwned =
  // `path` -> value (e.g. mcpServers.laneboard).
  | { kind: 'key'; path: string[]; value: Json }
  // An entry of the array at `path` that `match` recognizes (e.g. hooks.SessionStart[]).
  | { kind: 'entry'; path: string[]; value: Json; match: (entry: unknown) => boolean };

// Snippet to add by hand when a file cannot be edited: our value nested under its path.
function snippet(owned: JsonOwned): string {
  let value: Json = owned.kind === 'key' ? owned.value : [owned.value];
  for (const part of [...owned.path].reverse()) value = { [part]: value };
  return JSON.stringify(value, null, 2);
}

// Parse a JSON object file or fail with SETUP_UNPARSEABLE (no write happens).
function parseObject(text: string, file: string, owned: JsonOwned): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Comments (JSONC) or broken JSON: laneboard does not rewrite such a file.
    throw unparseable(file, 'is not plain JSON (comments or a syntax error)', owned);
  }
  if (!isObject(parsed)) throw unparseable(file, 'does not hold a JSON object', owned);
  return parsed;
}

// SETUP_UNPARSEABLE with the snippet to add by hand.
function unparseable(file: string, why: string, owned: JsonOwned): LaneboardError {
  return new LaneboardError('SETUP_UNPARSEABLE', `${file} ${why}; nothing was written`, {
    details: { file, snippet: snippet(owned) },
    fix: `add the snippet (details.snippet) to ${file} by hand, or fix the file and run setup again`,
  });
}

// The object at `path`, creating missing levels; fails when a level is not an object.
function containerAt(root: JsonObject, path: string[], file: string, owned: JsonOwned, create: boolean): JsonObject | undefined {
  let current = root;
  for (const part of path) {
    const next = current[part];
    if (next === undefined) {
      if (!create) return undefined;
      current[part] = {};
    } else if (!isObject(next)) {
      throw unparseable(file, `has "${part}" that is not an object`, owned);
    }
    current = current[part] as JsonObject;
  }
  return current;
}

// Drop empty objects/arrays along `path`, deepest first (only levels on our path).
function prune(root: JsonObject, path: string[]): void {
  const nodes: JsonObject[] = [root];
  for (const part of path.slice(0, -1)) {
    const next = nodes[nodes.length - 1]?.[part];
    if (!isObject(next)) break;
    nodes.push(next);
  }
  for (let depth = nodes.length; depth > 0; depth--) {
    const parent = nodes[depth - 1];
    const key = path[depth - 1] ?? '';
    const value = parent?.[key];
    const empty = (Array.isArray(value) && value.length === 0) || (isObject(value) && Object.keys(value).length === 0);
    if (!parent || !empty) return;
    delete parent[key];
  }
}

// Remove what laneboard owns from a parsed object (in place).
function stripOwned(root: JsonObject, owned: JsonOwned, file: string): void {
  if (owned.kind === 'key') {
    const parent = containerAt(root, owned.path.slice(0, -1), file, owned, false);
    const key = owned.path[owned.path.length - 1] ?? '';
    if (!parent || !Object.hasOwn(parent, key)) return;
    delete parent[key];
    prune(root, owned.path.slice(0, -1));
    return;
  }
  const parent = containerAt(root, owned.path.slice(0, -1), file, owned, false);
  const key = owned.path[owned.path.length - 1] ?? '';
  const list = parent?.[key];
  if (!parent || !Array.isArray(list)) return;
  const kept = list.filter((e) => !owned.match(e));
  if (kept.length === list.length) return;
  parent[key] = kept;
  prune(root, owned.path);
}

// Text edit for a JSON file: add/replace our value, or strip it.
export function jsonEdit(file: string, owned: JsonOwned): TextEdit {
  return {
    add(text) {
      const root = text === null ? {} : parseObject(text, file, owned);
      const next = structuredClone(root);
      if (owned.kind === 'key') {
        const parent = containerAt(next, owned.path.slice(0, -1), file, owned, true) as JsonObject;
        parent[owned.path[owned.path.length - 1] ?? ''] = owned.value;
      } else {
        const parent = containerAt(next, owned.path.slice(0, -1), file, owned, true) as JsonObject;
        const key = owned.path[owned.path.length - 1] ?? '';
        const list = parent[key] ?? [];
        if (!Array.isArray(list)) throw unparseable(file, `has "${key}" that is not an array`, owned);
        const index = list.findIndex((e) => owned.match(e));
        if (index < 0) list.push(owned.value);
        else list[index] = owned.value;
        parent[key] = list;
      }
      // Nothing to change: keep the bytes as they are.
      if (text !== null && sameJson(root, next)) return text;
      return serialize(next, text);
    },
    strip(text) {
      const root = parseObject(text, file, owned);
      const next = structuredClone(root);
      stripOwned(next, owned, file);
      return sameJson(root, next) ? text : serialize(next, text);
    },
    same(a, b) {
      // Empty containers on our path (`"mcp": {}`) do not count: setup may have created or pruned them.
      const levels = owned.kind === 'key' ? owned.path.slice(0, -1) : owned.path;
      const [x, y] = [JSON.parse(a) as JsonObject, JSON.parse(b) as JsonObject];
      prune(x, levels);
      prune(y, levels);
      return sameJson(x, y);
    },
    isEmpty(text) {
      const parsed: unknown = JSON.parse(text);
      return isObject(parsed) && Object.keys(parsed).length === 0;
    },
  };
}
