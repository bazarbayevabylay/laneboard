// Small parsers that turn parseArgs values into op input (no business rules here).
import fs from 'node:fs';
import path from 'node:path';
import { LaneboardError } from '../../core/index.ts';
import type { CliIo, Values } from './types.ts';

// String option value.
export function str(values: Values, name: string): string | undefined {
  const v = values[name];
  return typeof v === 'string' ? v : undefined;
}

// Repeatable string option values.
export function list(values: Values, name: string): string[] | undefined {
  const v = values[name];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

// Comma-separated option value as a list (`--statuses todo,doing,done`), each item trimmed.
export function commaList(values: Values, name: string): string[] | undefined {
  return str(values, name)?.split(',').map((item) => item.trim());
}

// Boolean flag.
export function flag(values: Values, name: string): boolean {
  return values[name] === true;
}

// Whole-number option value.
export function int(values: Values, name: string): number | undefined {
  const raw = str(values, name);
  if (raw === undefined) return undefined;
  if (!/^[0-9]+$/.test(raw)) {
    throw new LaneboardError('INVALID_VALUE', `--${name} must be a whole number, got "${raw}"`, {
      input: { field: name, value: raw, format: '<whole number>' },
      fix: `pass --${name} as a whole number, e.g. --${name} 1`,
    });
  }
  return Number(raw);
}

// At most one of two options; the fix keeps the first one.
export function exclusive(values: Values, a: string, b: string): void {
  if (values[a] !== undefined && values[b] !== undefined) throw new LaneboardError('USAGE', `--${a} and --${b} cannot be combined`, { edit: { drop: [{ name: b }] } });
}

// Text from a file path or `-` (stdin).
export function readTextFile(io: CliIo, file: string, option: string): string {
  if (file === '-') return io.readStdin();
  try {
    return fs.readFileSync(path.resolve(io.cwd, file), 'utf8');
  } catch {
    // Unreadable file is an input error for this option.
    throw new LaneboardError('INVALID_VALUE', `--${option} ${file}: file cannot be read`, {
      input: { field: option, value: file },
      fix: `pass the path of an existing, readable file to --${option}, or - to read stdin`,
    });
  }
}

// Text to add to the description, from --append-description or --append-description-file; neither goes with a replacing
// --description or --description-file (the fix drops the append option).
export function appendedDescription(values: Values, io: CliIo): string | undefined {
  exclusive(values, 'append-description', 'append-description-file');
  for (const replace of ['description', 'description-file']) for (const append of ['append-description', 'append-description-file']) exclusive(values, replace, append);
  const file = str(values, 'append-description-file');
  return file !== undefined ? readTextFile(io, file, 'append-description-file') : str(values, 'append-description');
}

// Description from --description or --description-file.
export function description(values: Values, io: CliIo): string | undefined {
  exclusive(values, 'description', 'description-file');
  const file = str(values, 'description-file');
  return file !== undefined ? readTextFile(io, file, 'description-file') : str(values, 'description');
}
