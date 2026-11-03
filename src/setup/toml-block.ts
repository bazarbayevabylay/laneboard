// TOML block owned by laneboard (Codex config.toml): a marked block with one table, appended at the end of the file.
// The text outside the block is scanned for every key path it defines, so our table declared there in any TOML form
// (`[mcp_servers.laneboard]`, `laneboard = {…}` or `laneboard.command = …` under `[mcp_servers]`, dotted keys at the root)
// is a SETUP_CONFLICT instead of a second definition that would break the whole file for Codex.
import { blockEdit } from './md-block.ts';
import type { Markers } from './md-block.ts';
import type { TextEdit } from './files.ts';

export const TOML_MARKERS: Markers = { start: '# laneboard:start', end: '# laneboard:end' };

// Quote a TOML basic string.
function tomlString(value: string): string {
  return JSON.stringify(value);
}

// One definition in a TOML text: a table header or a key, with its full key path and line.
export interface TomlDef {
  path: string[];
  kind: 'table' | 'array-table' | 'key';
  line: number;
}

// Every key path a TOML text defines (headers, and keys joined to their table), or the reason the text cannot be read.
// Values are skipped, not parsed: strings (also multi-line), arrays and inline tables are tracked only to find where they end.
export function tomlDefinitions(text: string): TomlDef[] | { error: string } {
  const defs: TomlDef[] = [];
  let i = 0;
  let line = 1;
  let table: string[] = [];
  // Advance to `to`, counting the lines passed.
  const moveTo = (to: number): void => {
    for (; i < to; i++) if (text[i] === '\n') line++;
  };
  const skipSpace = (): void => {
    while (text[i] === ' ' || text[i] === '\t') i++;
  };
  const skipComment = (): void => {
    if (text[i] === '#') while (i < text.length && text[i] !== '\n') i++;
  };
  // End index of a one-line string that starts at `from` (basic strings honor escapes), or -1.
  const stringEnd = (from: number): number => {
    const quote = text[from];
    for (let j = from + 1; j < text.length; j++) {
      const c = text[j];
      if (c === '\n') return -1;
      if (quote === '"' && c === '\\') j++;
      else if (c === quote) return j;
    }
    return -1;
  };
  // Index after a multi-line string that starts at `from` (with up to two extra closing quotes), or -1.
  const multiEnd = (from: number): number => {
    const delim = text.slice(from, from + 3);
    for (let j = from + 3; j < text.length; j++) {
      if (delim === '"""' && text[j] === '\\') j++;
      else if (text.startsWith(delim, j)) {
        let k = j + 3;
        while (k < text.length && text[k] === delim[0] && k - j < 5) k++;
        return k;
      }
    }
    return -1;
  };
  // One part of a key: bare, "basic" or 'literal'.
  const keyPart = (): string | undefined => {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = stringEnd(i);
      if (end < 0) return undefined;
      const raw = text.slice(i, end + 1);
      i = end + 1;
      if (c === "'") return raw.slice(1, -1);
      try {
        return JSON.parse(raw) as string;
      } catch {
        // A TOML-only escape (\U, \e): compare the raw text; such a key is never ours.
        return raw.slice(1, -1);
      }
    }
    const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(i))?.[0];
    if (!bare) return undefined;
    i += bare.length;
    return bare;
  };
  // A dotted key like a."b".c.
  const dottedKey = (): string[] | undefined => {
    const parts: string[] = [];
    for (;;) {
      skipSpace();
      const part = keyPart();
      if (part === undefined) return undefined;
      parts.push(part);
      skipSpace();
      if (text[i] !== '.') return parts;
      i++;
    }
  };
  // Skip a value up to the end of its line; returns a problem or undefined.
  const skipValue = (): string | undefined => {
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
        const end = multiEnd(i);
        if (end < 0) return 'an unterminated multi-line string';
        moveTo(end);
        continue;
      }
      if (c === '"' || c === "'") {
        const end = stringEnd(i);
        if (end < 0) return 'an unterminated string';
        i = end + 1;
        continue;
      }
      if (c === '#') {
        skipComment();
        continue;
      }
      if (c === '\n') {
        if (depth === 0) return undefined;
        line++;
      } else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        depth--;
        if (depth < 0) return 'an unbalanced bracket';
      }
      i++;
    }
    return depth === 0 ? undefined : 'an unclosed array or inline table';
  };
  // The rest of a header or key line may hold only a comment.
  const endOfLine = (): boolean => {
    skipSpace();
    skipComment();
    return i >= text.length || text[i] === '\n' || text.startsWith('\r\n', i);
  };

  while (i < text.length) {
    skipSpace();
    const c = text[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === '\r' || c === '#') {
      if (c === '\r') i++;
      else skipComment();
      continue;
    }
    const at = line;
    if (c === '[') {
      const array = text[i + 1] === '[';
      i += array ? 2 : 1;
      const path = dottedKey();
      const close = array ? ']]' : ']';
      if (!path || !text.startsWith(close, i)) return { error: `a table header laneboard cannot read on line ${at}` };
      i += close.length;
      if (!endOfLine()) return { error: `text after the table header on line ${at}` };
      table = path;
      defs.push({ path, kind: array ? 'array-table' : 'table', line: at });
      continue;
    }
    const key = dottedKey();
    skipSpace();
    if (!key || text[i] !== '=') return { error: `a line laneboard cannot read as key = value on line ${at}` };
    i++;
    skipSpace();
    defs.push({ path: [...table, ...key], kind: 'key', line: at });
    const problem = skipValue();
    if (problem) return { error: `${problem} on line ${at}` };
  }
  return defs;
}

// Does `path` start with `prefix`?
function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((p, i) => path[i] === p);
}

// Why our table cannot be added next to these definitions, or undefined.
export function tableClash(defs: readonly TomlDef[], table: readonly string[]): { line: number; why: string } | undefined {
  const name = table.join('.');
  for (const d of defs) {
    if (startsWith(d.path, table)) return { line: d.line, why: `already defines ${name} on line ${d.line}` };
    // A key or an array of tables on our path (e.g. `mcp_servers = {…}`) leaves no room for a [mcp_servers.laneboard] table.
    if (d.kind !== 'table' && d.path.length < table.length && startsWith(table, d.path)) {
      return { line: d.line, why: `defines ${d.path.join('.')} as ${d.kind === 'key' ? 'a value' : 'an array of tables'} on line ${d.line}, so no [${name}] table can be added` };
    }
  }
  return undefined;
}

// Definitions inside our block that are not our table (or its keys and subtables): another table written into the block
// (by hand or by a tool that edits config.toml) would be deleted with it, so replace and remove refuse instead.
function foreignInside(inside: string, firstLine: number, tablePath: readonly string[], file: string): { conflict: string; fix: string } | undefined {
  const defs = tomlDefinitions(inside);
  const line = (d: { line: number }): number => firstLine + d.line - 2;
  if (!Array.isArray(defs)) {
    return { conflict: `has text laneboard cannot read inside its block (${defs.error.replace(/line (\d+)/, (_, n: string) => `line ${firstLine + Number(n) - 2}`)})`, fix: `move everything that is not laneboard's out of the block between "${TOML_MARKERS.start}" and "${TOML_MARKERS.end}" in ${file}, then run setup again` };
  }
  const foreign = defs.filter((d) => !startsWith(d.path, tablePath));
  const first = foreign[0];
  if (!first) return undefined;
  const names = foreign.map((d) => `${d.path.join('.')} (line ${line(d)})`).join(', ');
  return {
    conflict: `holds ${names} inside the laneboard block, which is not laneboard's`,
    fix: `move ${names} above the "${TOML_MARKERS.start}" line in ${file}, then run setup again`,
  };
}

// `[<table>]` with command, args and extra keys, inside the laneboard markers; the same table (in any form) outside them is a conflict,
// and anything else inside them is never replaced or removed.
export function tomlTableEdit(file: string, table: string, command: string, args: readonly string[], extra: ReadonlyArray<[string, readonly string[]]> = []): TextEdit {
  const body = [
    `[${table}]`,
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(', ')}]`,
    ...extra.map(([key, values]) => `${key} = [${values.map(tomlString).join(', ')}]`),
  ].join('\n');
  const tablePath = table.split('.');
  return blockEdit(
    file,
    TOML_MARKERS,
    body,
    (outside) => {
      const defs = tomlDefinitions(outside);
      if (!Array.isArray(defs)) return { unparseable: `is not TOML laneboard can read (${defs.error})` };
      const clash = tableClash(defs, tablePath);
      if (!clash) return undefined;
      return {
        conflict: clash.why,
        fix: `delete that ${table} entry (line ${clash.line}) from ${file} and run setup again (laneboard writes its own in a marked block), or keep yours and skip setup for Codex`,
      };
    },
    (inside, firstLine) => foreignInside(inside, firstLine, tablePath, file),
  );
}
