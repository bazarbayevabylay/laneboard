// TOML block owned by laneboard (Codex config.toml): a marked block with one table, appended at the end of the file.
import { blockEdit } from './md-block.ts';
import type { Markers } from './md-block.ts';
import type { TextEdit } from './files.ts';

export const TOML_MARKERS: Markers = { start: '# laneboard:start', end: '# laneboard:end' };

// Quote a TOML basic string.
function tomlString(value: string): string {
  return JSON.stringify(value);
}

// `[<table>]` with command and args, inside the laneboard markers; a second definition of the table outside them is a conflict.
export function tomlTableEdit(file: string, table: string, command: string, args: readonly string[]): TextEdit {
  const body = [`[${table}]`, `command = ${tomlString(command)}`, `args = [${args.map(tomlString).join(', ')}]`].join('\n');
  const [parent, name] = [table.slice(0, table.lastIndexOf('.')), table.slice(table.lastIndexOf('.') + 1)];
  const header = new RegExp(`^\\s*\\[\\s*${parent.replace(/\./g, '\\s*\\.\\s*')}\\s*\\.\\s*["']?${name}["']?\\s*[\\].]`, 'm');
  const inline = new RegExp(`^\\s*${parent.replace(/\./g, '\\.')}\\s*\\.\\s*["']?${name}["']?\\s*=`, 'm');
  return blockEdit(file, TOML_MARKERS, body, (outside) => (header.test(outside) || inline.test(outside) ? `already defines [${table}] outside the laneboard block` : undefined));
}
