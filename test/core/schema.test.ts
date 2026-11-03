// C8: committed schema/*.json equals what the zod schemas generate; a stale file fails the check.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { jsonSchemas } from '../../src/core/index.ts';
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
