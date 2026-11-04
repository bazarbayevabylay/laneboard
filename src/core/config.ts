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

// File names that init's config never lets attach (secrets and keys); case-insensitive `*` / `?` globs (attach.ts globMatch). The ssh
// key patterns name each key type (rsa, dsa, ecdsa, ed25519, xmss, with their _sk variants): a glob cannot leave out `.pub`, and
// `id_*` would also refuse files like id_mapping.csv. `*credentials*` covers .git-credentials and the AWS credentials file.
export const DEFAULT_DENY_NAMES: readonly string[] = [
  '.env*',
  '*.pem',
  '*.key',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  'id_xmss*',
  '*credentials*',
  '.netrc',
  '.npmrc',
  '*.p12',
  '*.pfx',
  '*.kdbx',
];

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
    attachments: { deny_names: [...DEFAULT_DENY_NAMES] },
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

// errno codes of a passing state of the process or the machine (out of file handles or memory, busy, interrupted, timed out): the
// file is intact, so the fix is to run the command again, never a restore that would roll live tasks back (review S5a MINOR 2). Only
// these: any other code (ELOOP, ENXIO, EISDIR, EIO, an unknown one) stays on a second run, so it is never "run it again" (review S5b MINOR 2).
const TRANSIENT_CODES = new Set(['EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'EINTR', 'ENOMEM', 'ETIMEDOUT']);

// Does this process have read, write and search permission on `dir`?
function dirAccessible(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    // Any failure means the chmod of the directory is part of the fix.
    return false;
  }
}

// A store file that exists but cannot be read: a store error with one runnable fix, not INTERNAL (review LB-19 MINOR 1, S5a MINOR 1-2).
// No permission: the chmod that gives it back, on the store directory too when that is what was taken away (a file in a directory
// without search permission cannot be chmod-ed). A passing state (TRANSIENT_CODES): INTERNAL, run the same command again. Anything
// else (a directory or a symlink loop in its place, a disk error, an unknown code): the path is not a readable file, restore it.
export function unreadableStoreFile(file: string, label: string, err: unknown): LaneboardError {
  const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
  if (code === 'EACCES' || code === 'EPERM') {
    const dir = path.dirname(file);
    const fix = dirAccessible(dir) ? `chmod u+rw ${shellQuote(file)}` : `chmod u+rwx ${shellQuote(dir)} && chmod u+rw ${shellQuote(file)}`;
    return new LaneboardError('STORE_INVALID', `${label} cannot be read (${code}): ${file}`, { fix });
  }
  if (TRANSIENT_CODES.has(code)) {
    // The CLI fix is the caller's own command unchanged (an empty edit); MCP gets the text.
    return new LaneboardError('INTERNAL', `${label} cannot be read right now (${code}): ${file}; the file is not damaged`, { fix: 'run the same command again', edit: {} });
  }
  return new LaneboardError('STORE_INVALID', `${label} cannot be read (${code}): ${file}`, { fix: `restore ${file} as a readable file (from git or a copy), then check the store: laneboard doctor` });
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
    throw unreadableStoreFile(file, 'config.json', err);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new LaneboardError('STORE_INVALID', `config.json is not valid JSON: ${(err as Error).message}`, { fix: `fix the JSON syntax in ${file}` });
  }
  return validateConfig(json, 'config.json');
}
