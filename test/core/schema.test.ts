// C8: committed schema/*.json equals what the zod schemas generate; a stale file fails the check.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { jsonSchemas } from '../../src/core/index.ts';
import { Config, CONFIG_VERSION, EVENT_TYPES, FieldDef, LINK_KINDS, STORE_VERSION } from '../../src/core/schema.ts';
import { cleanupTemp, REPO, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

const SCRIPT = path.join(REPO, 'scripts', 'gen-schema.ts');

describe('generated JSON Schema (C8)', () => {
  it('schema/ matches the zod schemas', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });

  it('a stale or missing schema file fails the check', () => {
    const dir = tempDir();
    for (const name of Object.keys(jsonSchemas())) fs.copyFileSync(path.join(REPO, 'schema', name), path.join(dir, name));
    fs.writeFileSync(path.join(dir, 'task.json'), '{}\n');
    fs.rmSync(path.join(dir, 'config.json'));
    const r = spawnSync(process.execPath, [SCRIPT, '--check', '--dir', dir], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('schema/task.json is out of date');
    expect(r.stderr).toContain('schema/config.json is missing');
  });

  it('task and config schemas keep the contract shape', () => {
    const s = jsonSchemas() as Record<string, { required?: string[]; additionalProperties?: unknown }>;
    expect(s['task.json']?.required).toEqual([
      'id', 'rev', 'title', 'description', 'status', 'assignee', 'labels', 'links', 'fields', 'attachments', 'events', 'events_dropped', 'created_at', 'created_by', 'updated_at', 'updated_by',
    ]);
    expect(s['config.json']?.additionalProperties).toBe(false);
    expect(s['task.json']?.additionalProperties).toEqual({});
  });
});

// K1 (ADR §24): copies of 0.3.1 keep running after an upgrade, and a new enum value or config key makes every read of theirs
// STORE_INVALID. While the store stays store@1 the closed enums and the config keys stay the 0.3.1 ones; a change needs store@2 + migrate.
describe('K1: store@1 keeps the 0.3.1 enums and config keys', () => {
  it('LINK_KINDS, EVENT_TYPES and the Config keys are the 0.3.1 sets while STORE_VERSION and CONFIG_VERSION are 1', () => {
    expect([STORE_VERSION, CONFIG_VERSION]).toEqual([1, 1]);
    expect([...LINK_KINDS]).toEqual(['task', 'branch', 'pr', 'commit', 'url', 'file']);
    expect([...EVENT_TYPES]).toEqual(['created', 'updated', 'status', 'assigned', 'commented', 'attached', 'detached', 'archived', 'restored']);
    const keys = (shape: Record<string, unknown>): string[] => Object.keys(shape).sort();
    expect(keys(Config.shape)).toEqual(['attachments', 'board', 'description', 'fields', 'limits', 'name', 'prefix', 'schema', 'statuses']);
    expect(keys(Config.shape.limits.shape)).toEqual(['attachment_bytes', 'events_per_task', 'list_limit_max']);
    expect(keys(Config.shape.attachments.shape)).toEqual(['deny_names']);
    expect(keys(Config.shape.board.shape)).toEqual(['port']);
    expect(keys(FieldDef.shape)).toEqual(['description', 'type']);
  });
});
