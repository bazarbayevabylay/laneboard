// Config: explicit defaults written by init, strict validation on every command.
import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { LaneboardError } from './errors.ts';
import { CONFIG_SCHEMA, CONFIG_VERSION, Config } from './schema.ts';
import type { ConfigT } from './schema.ts';

export const DEFAULT_PREFIX = 'LB';
export const DEFAULT_STATUSES = ['todo', 'in_progress', 'review', 'done'];

// Path of config.json inside a store directory.
export function configPath(storeDir: string): string {
  return path.join(storeDir, 'config.json');
}

// Build the full config that init writes: every key explicit, no hidden defaults.
export function buildConfig(prefix: string, statuses: string[]): ConfigT {
  return {
    schema: CONFIG_SCHEMA,
    prefix,
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
      throw new LaneboardError('STORE_INVALID', `config.json is missing in ${storeDir}`, { fix: `restore ${file} or re-create the store with laneboard init` });
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
