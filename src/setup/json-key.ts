// JSON edits owned by laneboard: one key at a path, or one entry in an array (hooks).
// Every change is a minimal text edit on the parsed tree (jsonc-parser): bytes outside our key stay as they are, comments included.
// What cannot be edited that way (a syntax error, a byte order mark, a duplicate key on our path, comments right next to our entry) is refused.
import { getNodeValue, parse, parseTree, printParseErrorCode } from 'jsonc-parser';
import type { Node, ParseError } from 'jsonc-parser';
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

// What laneboard owns in a JSON file.
export type JsonOwned =
  // `path` -> value (e.g. mcpServers.laneboard).
  | { kind: 'key'; path: string[]; value: Json }
  // An entry of the array at `path` that `match` recognizes (e.g. hooks.SessionStart[]).
  | { kind: 'entry'; path: string[]; value: Json; match: (entry: unknown) => boolean };

// `value` nested under `keys` ({a: {b: value}}).
function nest(keys: readonly string[], value: Json): Json {
  let out = value;
  for (const key of [...keys].reverse()) out = { [key]: out };
  return out;
}

// Our value at the end of the path: the key's value, or an array holding our entry.
function leafOf(owned: JsonOwned): Json {
  return owned.kind === 'key' ? owned.value : [owned.value];
}

// What our part looks like at the file root.
function ownedAtRoot(owned: JsonOwned): Json {
  return nest(owned.path, leafOf(owned));
}

// Snippet to add by hand when a file cannot be edited: our value nested under its path.
function snippet(owned: JsonOwned): string {
  return JSON.stringify(ownedAtRoot(owned), null, 2);
}

// SETUP_UNPARSEABLE with the snippet to add by hand.
function unparseable(file: string, why: string, owned: JsonOwned): LaneboardError {
  return new LaneboardError('SETUP_UNPARSEABLE', `${file} ${why}; nothing was written`, {
    details: { file, snippet: snippet(owned) },
    fix: `add the snippet (details.snippet) to ${file} by hand, or fix the file and run setup again`,
  });
}

// Parse the file into a tree: comments and trailing commas are allowed (JSONC harness files have them); anything else fails.
function treeOf(text: string, file: string, owned: JsonOwned): Node {
  if (text.charCodeAt(0) === 0xfeff) throw unparseable(file, 'starts with a byte order mark', owned);
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  const first = errors[0];
  if (first) {
    const lines = text.slice(0, first.offset).split('\n');
    throw unparseable(file, `is not valid JSON (${printParseErrorCode(first.error)} at line ${lines.length}, column ${(lines.at(-1)?.length ?? 0) + 1})`, owned);
  }
  if (!root || root.type !== 'object') throw unparseable(file, 'does not hold a JSON object', owned);
  return root;
}

// Children of a node (objects: property nodes, arrays: value nodes).
function kids(node: Node): Node[] {
  return node.children ?? [];
}

// Value node of a property node.
function valueNode(property: Node): Node {
  const value = kids(property)[1];
  if (!value) throw new Error('jsonc-parser returned a property without a value');
  return value;
}

// Index of the property `key` in an object node, or -1; a key given twice cannot be edited without guessing which one counts.
function indexOfKey(object: Node, key: string, file: string, owned: JsonOwned): number {
  const hits = kids(object).flatMap((p, i) => (kids(p)[0]?.value === key ? [i] : []));
  if (hits.length > 1) throw unparseable(file, `has the key "${key}" ${hits.length} times`, owned);
  return hits[0] ?? -1;
}

// The deepest object along `keys` and how many keys it covers; a non-object on the way fails.
function walk(root: Node, keys: readonly string[], file: string, owned: JsonOwned): { node: Node; depth: number } {
  let node = root;
  for (const [depth, key] of keys.entries()) {
    const index = indexOfKey(node, key, file, owned);
    const property = kids(node)[index];
    if (!property) return { node, depth };
    const value = valueNode(property);
    if (value.type !== 'object') throw unparseable(file, `has "${key}" that is not an object`, owned);
    node = value;
  }
  return { node, depth: keys.length };
}

// Line ending and indent unit of the file, for the text laneboard inserts.
interface Layout {
  eol: string;
  unit: string;
}

function layoutOf(text: string): Layout {
  return { eol: text.includes('\r\n') ? '\r\n' : '\n', unit: /\n([ \t]+)\S/.exec(text)?.[1] ?? '  ' };
}

// Leading whitespace of the line that holds `offset`.
function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start))?.[0] ?? '';
}

// Is the node written on one line?
function oneLine(text: string, node: Node): boolean {
  return !text.slice(node.offset, node.offset + node.length).includes('\n');
}

// A value as text: compact on one-line containers, else pretty with the file's indent, continuation lines starting at `indent`.
function render(value: Json, indent: string, layout: Layout, compact: boolean): string {
  if (compact) return JSON.stringify(value);
  return JSON.stringify(value, null, layout.unit).split('\n').join(`${layout.eol}${indent}`);
}

// `"key": value` for objects, `value` for arrays.
function memberText(key: string | undefined, value: Json, indent: string, layout: Layout, compact: boolean): string {
  const rendered = render(value, indent, layout, compact);
  if (key === undefined) return rendered;
  return compact ? `${JSON.stringify(key)}:${rendered}` : `${JSON.stringify(key)}: ${rendered}`;
}

// Replace [from, to) of the text.
function splice(text: string, from: number, to: number, piece: string): string {
  return text.slice(0, from) + piece + text.slice(to);
}

// Add a member (property `key`, or an array element when key is undefined) at the end of a container node.
function insertMember(text: string, container: Node, key: string | undefined, value: Json, file: string, owned: JsonOwned): string {
  const layout = layoutOf(text);
  const open = container.offset + 1;
  const close = container.offset + container.length - 1;
  const last = kids(container).at(-1);
  if (last) {
    const end = last.offset + last.length;
    if (oneLine(text, container)) return splice(text, end, end, `,${memberText(key, value, '', layout, true)}`);
    const indent = lineIndent(text, last.offset);
    return splice(text, end, end, `,${layout.eol}${indent}${memberText(key, value, indent, layout, false)}`);
  }
  // An empty container: comments inside it would end up around our entry, so such a file is edited by hand.
  if (text.slice(open, close).trim() !== '') throw unparseable(file, 'has comments inside the container laneboard adds to', owned);
  if (!text.trimEnd().includes('\n')) return splice(text, open, close, memberText(key, value, '', layout, true));
  const base = lineIndent(text, container.offset);
  const inner = `${base}${layout.unit}`;
  return splice(text, open, close, `${layout.eol}${inner}${memberText(key, value, inner, layout, false)}${layout.eol}${base}`);
}

// Replace the value node with our value (same position and indent).
function replaceValue(text: string, node: Node, container: Node, value: Json): string {
  const layout = layoutOf(text);
  return splice(text, node.offset, node.offset + node.length, render(value, lineIndent(text, node.offset), layout, oneLine(text, container)));
}

// Remove one member of a container with its separating comma; refuses when a comment sits in what would be cut.
function removeMember(text: string, container: Node, index: number, file: string, what: string): string {
  const list = kids(container);
  const member = list[index];
  if (!member) return text;
  const end = member.offset + member.length;
  const refuse = (): LaneboardError =>
    new LaneboardError('SETUP_UNPARSEABLE', `${file} has comments next to the laneboard entry ${what}, so it cannot be removed without touching them; nothing was written`, {
      details: { file },
      fix: `delete the laneboard entry ${what} from ${file} by hand`,
    });
  const previous = list[index - 1];
  const next = list[index + 1];
  if (previous) {
    const from = previous.offset + previous.length;
    if (!/^\s*,\s*$/.test(text.slice(from, member.offset))) throw refuse();
    return splice(text, from, end, '');
  }
  if (next) {
    if (!/^\s*,\s*$/.test(text.slice(end, next.offset))) throw refuse();
    return splice(text, member.offset, next.offset, '');
  }
  const open = container.offset + 1;
  const close = container.offset + container.length - 1;
  if (!/^[\s,]*$/.test(text.slice(open, member.offset) + text.slice(end, close))) throw refuse();
  return splice(text, open, close, '');
}

// Drop containers on our path that are now empty (`{}` / `[]` with only whitespace inside), deepest first.
function pruneText(text: string, keys: readonly string[], file: string, owned: JsonOwned): string {
  for (let depth = keys.length; depth > 0; depth--) {
    const root = treeOf(text, file, owned);
    const { node: parent, depth: reached } = walk(root, keys.slice(0, depth - 1), file, owned);
    if (reached !== depth - 1) return text;
    const index = indexOfKey(parent, keys[depth - 1] ?? '', file, owned);
    const property = kids(parent)[index];
    if (!property) return text;
    const value = valueNode(property);
    const empty = (value.type === 'object' || value.type === 'array') && kids(value).length === 0;
    if (!empty || text.slice(value.offset + 1, value.offset + value.length - 1).trim() !== '') return text;
    text = removeMember(text, parent, index, file, `"${keys.slice(0, depth).join('.')}"`);
  }
  return text;
}

// Where our part is in a parsed file: the container node and the member index, or undefined.
function findOwned(root: Node, owned: JsonOwned, file: string): { container: Node; index: number } | undefined {
  const keys = owned.path.slice(0, -1);
  const last = owned.path.at(-1) ?? '';
  const { node, depth } = walk(root, keys, file, owned);
  if (depth < keys.length) return undefined;
  const index = indexOfKey(node, last, file, owned);
  if (owned.kind === 'key') return index < 0 ? undefined : { container: node, index };
  const property = kids(node)[index];
  if (!property) return undefined;
  const list = valueNode(property);
  if (list.type !== 'array') throw unparseable(file, `has "${last}" that is not an array`, owned);
  const at = kids(list).findIndex((e) => owned.match(getNodeValue(e)));
  return at < 0 ? undefined : { container: list, index: at };
}

// Parsed value of a file (comments allowed); used only for comparisons.
function valueOf(text: string): unknown {
  return parse(text, [], { allowTrailingComma: true });
}

// Drop empty objects/arrays along `levels` of a parsed value, deepest first.
function pruneValue(root: unknown, levels: readonly string[]): void {
  const nodes: unknown[] = [root];
  for (const part of levels.slice(0, -1)) {
    const current = nodes.at(-1);
    const next = isObject(current) ? current[part] : undefined;
    if (!isObject(next)) break;
    nodes.push(next);
  }
  for (let depth = nodes.length; depth > 0; depth--) {
    const parent = nodes[depth - 1];
    const key = levels[depth - 1] ?? '';
    if (!isObject(parent)) return;
    const value = parent[key];
    const empty = (Array.isArray(value) && value.length === 0) || (isObject(value) && Object.keys(value).length === 0);
    if (!empty) return;
    delete parent[key];
  }
}

// Text edit for a JSON file: add/replace our value, or strip it.
export function jsonEdit(file: string, owned: JsonOwned): TextEdit {
  const keys = owned.path.slice(0, -1);
  const last = owned.path.at(-1) ?? '';
  return {
    add(text) {
      if (text === null) return `${JSON.stringify(ownedAtRoot(owned), null, 2)}\n`;
      const root = treeOf(text, file, owned);
      const found = findOwned(root, owned, file);
      if (found) {
        const node = kids(found.container)[found.index];
        if (!node) return text;
        const value = owned.kind === 'key' ? valueNode(node) : node;
        if (sameJson(getNodeValue(value), owned.value)) return text;
        return replaceValue(text, value, found.container, owned.value);
      }
      const { node, depth } = walk(root, keys, file, owned);
      if (depth < keys.length) return insertMember(text, node, keys[depth] ?? '', nest([...keys.slice(depth + 1), last], leafOf(owned)), file, owned);
      if (owned.kind === 'key') return insertMember(text, node, last, owned.value, file, owned);
      const property = kids(node)[indexOfKey(node, last, file, owned)];
      if (!property) return insertMember(text, node, last, [owned.value], file, owned);
      return insertMember(text, valueNode(property), undefined, owned.value, file, owned);
    },
    strip(text) {
      let out = text;
      // Every matching entry goes (an array may hold our entry twice after hand edits).
      for (let found = findOwned(treeOf(out, file, owned), owned, file); found; found = findOwned(treeOf(out, file, owned), owned, file)) {
        out = removeMember(out, found.container, found.index, file, `"${owned.path.join('.')}"`);
      }
      return out === text ? text : pruneText(out, owned.kind === 'key' ? keys : owned.path, file, owned);
    },
    owns(text) {
      return findOwned(treeOf(text, file, owned), owned, file) !== undefined;
    },
    same(a, b) {
      // Empty containers on our path (`"mcp": {}`) do not count: setup may have created or pruned them.
      const levels = owned.kind === 'key' ? keys : owned.path;
      const [x, y] = [valueOf(a), valueOf(b)];
      pruneValue(x, levels);
      pruneValue(y, levels);
      return sameJson(x, y);
    },
    isEmpty(text) {
      // Only a bare `{}` counts: a comment left in the file is the user's and keeps it.
      return text.replace(/\s/g, '') === '{}';
    },
  };
}

// Text edit for several laneboard parts of one JSON file (Claude Code settings: hooks and env), applied one after another.
export function jsonEdits(file: string, parts: readonly JsonOwned[]): TextEdit {
  const edits = parts.map((p) => jsonEdit(file, p));
  return {
    add(text) {
      let out = text;
      for (const e of edits) out = e.add(out);
      return out ?? '';
    },
    strip(text) {
      return edits.reduce((out, e) => e.strip(out), text);
    },
    owns(text) {
      return edits.some((e) => e.owns(text));
    },
    same(a, b) {
      // Prune the empty containers of every part twice: one part's empty array may be what keeps another's parent alive.
      const [x, y] = [valueOf(a), valueOf(b)];
      for (let pass = 0; pass < 2; pass++) {
        for (const owned of parts) {
          const levels = owned.kind === 'key' ? owned.path.slice(0, -1) : owned.path;
          pruneValue(x, levels);
          pruneValue(y, levels);
        }
      }
      return sameJson(x, y);
    },
    isEmpty(text) {
      return edits.every((e) => e.isEmpty(text));
    },
  };
}

// The value at `keys` of a JSON/JSONC text (comments allowed), or undefined when the text or the path is missing.
export function jsonValueAt(text: string | null, keys: readonly string[]): unknown {
  if (text === null) return undefined;
  let current: unknown = valueOf(text);
  for (const key of keys) {
    if (!isObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}
