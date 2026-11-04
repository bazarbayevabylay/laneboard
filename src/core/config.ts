// Config: explicit defaults written by init, strict validation on every command.
import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { LaneboardError } from './errors.ts';
import { shellQuote } from './shell.ts';
import { CONFIG_SCHEMA, CONFIG_VERSION, Config } from './schema.ts';
import type { ConfigT } from './schema.ts';

export const DEFAULT_PREFIX = 'LB';
export const DEFAULT_STATUSES = ['todo', 'in_progress', 'review', 'done'];

// Longest prefix init derives: short ids (LANE-12) are easier to type and read than the whole name (LANEBOARD-12).
export const DERIVED_PREFIX_MAX = 4;

// Prefix that init derives from the board name (by default the project folder's name), or undefined when none fits.
// Rule: a name of several words gives their initials (`my-web-app` -> MWA), one word its first letters (`laneboard` -> LANE);
// at most 4 characters, a trailing number is kept (`agent-2` -> AGE2), uppercase letters and digits, starting with a letter.
export function derivePrefix(name: string): string | undefined {
  // Accented letters keep their base letter (café -> CAFE) instead of being dropped.
  const plain = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const words = plain.split(/[^A-Z0-9]+/).filter((w) => w !== '');
  const last = words.pop() ?? '';
  const number = /[0-9]+$/.exec(last)?.[0] ?? '';
  // Words without leading digits (`2024_report` -> REPORT); a word of digits only is dropped (its number is kept above when last).
  const letters = [...words, last.slice(0, last.length - number.length)].map((w) => w.replace(/^[0-9]+/, '')).filter((w) => w !== '');
  if (letters.length === 0) return undefined;
  const base = letters.length === 1 ? (letters[0] ?? '') : letters.map((w) => w[0]).join('');
  const kept = number.length < DERIVED_PREFIX_MAX ? number : '';
  return base.slice(0, DERIVED_PREFIX_MAX - kept.length) + kept;
}

// Prefix of the store at `storeDir`, or null when its config cannot be read (only shown to the reader, never trusted for writes).
export function storePrefix(storeDir: string): string | null {
  try {
    const json = JSON.parse(fs.readFileSync(configPath(storeDir), 'utf8')) as { prefix?: unknown };
    return typeof json.prefix === 'string' ? json.prefix : null;
  } catch {
    // Missing or broken config: the command itself reports it; the envelope just has no prefix.
    return null;
  }
}

// Path of config.json inside a store directory.
export function configPath(storeDir: string): string {
  return path.join(storeDir, 'config.json');
}

// Build the full config that init writes: every key explicit, no hidden defaults.
export function buildConfig(prefix: string, statuses: string[], board: { name?: string; description?: string } = {}): ConfigT {
  return {
    schema: CONFIG_SCHEMA,
    prefix,
    ...(board.name !== undefined ? { name: board.name } : {}),
    ...(board.description !== undefined ? { description: board.description } : {}),
    statuses,
    fields: { priority: { type: 'number', description: '0 = highest' } },
    limits: { events_per_task: 500, attachment_bytes: 26214400, list_limit_max: 200 },
    attachments: { deny_names: ['.env*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*'] },
    board: { port: 7420 },
  };
}

// Serialize config for config.json.
export function serializeConfig(config: ConfigT): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

// Describe the first zod issue as `path: message`.
export function describeIssue(error: z.ZodError, prefix: string): string {
  const issue = error.issues[0];
  if (!issue) return `${prefix}: invalid`;
  const where = issue.path.length ? issue.path.join('.') : '(root)';
  return `${prefix} ${where}: ${issue.message}`;
}

// Version number from a `laneboard/<kind>@N` schema string, or 0 when absent or malformed.
export function schemaVersion(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const m = /@([1-9][0-9]*)$/.exec(value);
  return m ? Number(m[1]) : 0;
}

// Check a full config object; returns it or throws STORE_INVALID / STORE_TOO_NEW.
export function validateConfig(json: unknown, label: string): ConfigT {
  const version = schemaVersion((json as { schema?: unknown } | null)?.schema);
  if (version > CONFIG_VERSION) {
    throw new LaneboardError('STORE_TOO_NEW', `${label} is ${String((json as { schema: unknown }).schema)}; this laneboard supports ${CONFIG_SCHEMA}`);
  }
  const parsed = Config.safeParse(json);
  if (!parsed.success) {
    throw new LaneboardError('STORE_INVALID', describeIssue(parsed.error, label), {
      fix: `edit ${label} to match schema/config.json (unknown keys are rejected)`,
    });
  }
  const config = json as ConfigT;
  const seen = new Set<string>();
  for (const status of config.statuses) {
    if (seen.has(status)) {
      throw new LaneboardError('STORE_INVALID', `${label} statuses: duplicate "${status}"`, { fix: `remove the duplicate status from ${label}` });
    }
    seen.add(status);
  }
  return config;
}

// Read and validate config.json fresh from disk.
export function loadConfig(storeDir: string): ConfigT {
  const file = configPath(storeDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LaneboardError('STORE_INVALID', `config.json is missing in ${storeDir}`, {
        fix: `restore ${file} (from git or a copy); or move ${shellQuote(storeDir)} aside and create a new board: laneboard init --dir ${shellQuote(storeDir)} --name <name> --description "<whose project, what work>"`,
      });
    }
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new LaneboardError('STORE_INVALID', `config.json is not valid JSON: ${(err as Error).message}`, { fix: `fix the JSON syntax in ${file}` });
  }
  return validateConfig(json, 'config.json');
}
