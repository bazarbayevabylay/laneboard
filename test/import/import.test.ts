// `laneboard import markdown|json`: fixtures of 5+ synthetic task files per format; a re-run creates nothing; an undeclared key or an
// unmapped status stops the import and lists every value found; a dry run writes nothing (ADR-0001 §12 S5).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTemp, cli, readStore, REPO, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

const FIXTURES = path.join(REPO, 'test', 'fixtures', 'import');

interface Project {
  root: string;
  dir: string;
  run(argv: string[]): Promise<{ code: number; json: Record<string, any> }>;
}

// A project with a store (statuses todo..done plus blocked), extra declared fields, and a copy of one fixture folder in tasks/.
async function project(format: 'markdown' | 'json', fields: Record<string, { type: string }>): Promise<Project> {
  const root = tempDir();
  const dir = path.join(root, '.laneboard');
  expect((await cli(['init', '--prefix', 'IMP', '--statuses', 'todo,in_progress,review,blocked,done'], { cwd: root })).code).toBe(0);
  const configFile = path.join(dir, 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.fields = { ...config.fields, ...fields };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  fs.cpSync(path.join(FIXTURES, format), path.join(root, 'tasks'), { recursive: true });
  return {
    root,
    dir,
    run: async (argv) => {
      const r = await cli([...argv, '--json'], { cwd: root });
      return { code: r.code, json: JSON.parse(r.stdout) };
    },
  };
}

const MD_FIELDS = { project: { type: 'string' }, branch: { type: 'string' }, agents: { type: 'json' } };
const MD_ARGS = ['import', 'markdown', 'tasks', '--status-key', 'stage', '--status-map', 'dev=in_progress', '--status-map', 'research=todo', '--ignore-key', 'owner', '--ignore-key', 'created', '--ignore-key', 'updated', '--ignore-key', 'depends_on'];

const JSON_FIELDS = { source_id: { type: 'string' }, acceptance: { type: 'string[]' } };
const JSON_ARGS = [
  'import', 'json', 'tasks', '--status-key', 'state',
  '--status-map', 'backlog=todo', '--status-map', 'testing=review', '--status-map', 'closed=done',
  '--assignee-key', 'assignee', '--labels-key', 'labels', '--history-key', 'history',
  '--field-map', 'id=source_id', '--field-map', 'priority_score=priority', '--field-map', 'acceptance_criteria=acceptance', '--ignore-key', 'created_at',
];

// Task count and file rev of active.json (nothing written = both unchanged).
function storeState(p: Project): { tasks: number; rev: number } {
  const active = readStore(p.dir, 'active');
  return { tasks: active.tasks.length, rev: active.rev };
}

describe('import markdown', () => {
  it('5 task files -> 5 tasks; frontmatter -> title/status/fields, body -> description; a re-run creates 0 and skips 5', async () => {
    const p = await project('markdown', MD_FIELDS);
    const first = await p.run([...MD_ARGS, '--as', 'importer']);
    expect(first.code).toBe(0);
    expect(first.json.data.created.map((c: { id: string }) => c.id)).toEqual(['IMP-1', 'IMP-2', 'IMP-3', 'IMP-4', 'IMP-5']);
    expect(first.json.data.ignored).toEqual([{ source: 'tasks/README.md', reason: 'no YAML frontmatter' }]);
    expect(first.json.warnings).toEqual(['1 file(s) are not tasks and were left out (no YAML frontmatter): tasks/README.md']);

    const task = (await p.run(['get', 'IMP-3'])).json.data;
    expect(task).toMatchObject({
      title: 'Warm the cache after deploy',
      status: 'blocked',
      description: 'Blocked until the deploy hook exists.',
      links: [{ kind: 'file', ref: 'tasks/20260103-cache-warmup.md' }],
      fields: { project: 'api', branch: 'feat/20260103-cache-warmup', agents: [{ role: 'code-analyst', status: 'done', result_ref: 'notes/cache-map.md' }, { role: 'backend-developer', status: 'spawned' }] },
      created_by: 'importer',
    });
    expect(task.events.map((e: { type: string }) => e.type)).toEqual(['created']);
    expect(task.events[0].data).toMatchObject({ imported_from: 'tasks/20260103-cache-warmup.md' });
    const statuses = (await p.run(['list', '--limit', '10'])).json.data.items.map((t: { id: string; status: string }) => `${t.id}=${t.status}`).sort();
    expect(statuses).toEqual(['IMP-1=in_progress', 'IMP-2=todo', 'IMP-3=blocked', 'IMP-4=done', 'IMP-5=review']);
    // A body that starts with "- " and holds "---" stays as it is.
    expect((await p.run(['get', 'IMP-5'])).json.data.description).toBe('- limit 100 requests per minute per key\n- --- notes ---');

    const again = await p.run([...MD_ARGS, '--as', 'importer']);
    expect(again.code).toBe(0);
    expect(again.json.data.created).toEqual([]);
    expect(again.json.data.skipped).toHaveLength(5);
    expect(storeState(p).tasks).toBe(5);
  });

  it('idempotent across archive and for new files: an archived import is skipped, only a new file is created', async () => {
    const p = await project('markdown', MD_FIELDS);
    await p.run([...MD_ARGS, '--as', 'importer']);
    expect((await p.run(['archive', 'IMP-4', '--as', 'importer'])).code).toBe(0);
    fs.writeFileSync(path.join(p.root, 'tasks', '20260106-new.md'), '---\ntitle: A new one\nstage: research\n---\n');
    const r = await p.run([...MD_ARGS, '--as', 'importer']);
    expect(r.json.data.created).toEqual([{ id: 'IMP-6', source: 'tasks/20260106-new.md', title: 'A new one' }]);
    expect(r.json.data.skipped).toContainEqual({ id: 'IMP-4', source: 'tasks/20260104-docs-refresh.md' });
    expect(r.json.data.skipped).toHaveLength(5);
  });

  it('undeclared keys -> UNKNOWN_FIELD listing every key with its files (and unmapped statuses), nothing written', async () => {
    const p = await project('markdown', {});
    const before = storeState(p);
    const r = await p.run(['import', 'markdown', 'tasks', '--status-key', 'stage', '--as', 'importer']);
    expect(r.code).toBe(2);
    expect(r.json.error.code).toBe('UNKNOWN_FIELD');
    expect(r.json.error.details.unknown_fields.map((f: { key: string; files: string[] }) => `${f.key}:${f.files.length}`)).toEqual([
      'owner:5', 'project:5', 'branch:3', 'created:5', 'updated:5', 'depends_on:2', 'agents:1',
    ]);
    expect(r.json.error.details.unknown_statuses).toEqual([
      { value: 'dev', files: ['tasks/20260101-login-form.md'] },
      { value: 'research', files: ['tasks/20260102-export-csv.md'] },
    ]);
    expect(r.json.error.message).toContain('"owner" (5 files)');
    expect(r.json.error.fix).toContain('--ignore-key <key>');
    expect(r.json.error.fix).toContain('--status-map <value>=<status from details.statuses>');
    expect(storeState(p)).toEqual(before);
  });

  it('a status that is neither configured nor mapped -> UNKNOWN_STATUS listing every such value, nothing written', async () => {
    const p = await project('markdown', MD_FIELDS);
    const before = storeState(p);
    const args = MD_ARGS.filter((a, i) => a !== 'research=todo' && MD_ARGS[i + 1] !== 'research=todo');
    const r = await p.run([...args, '--as', 'importer']);
    expect(r.code).toBe(2);
    expect(r.json.error).toMatchObject({
      code: 'UNKNOWN_STATUS',
      allowed: ['todo', 'in_progress', 'review', 'blocked', 'done'],
      details: { unknown_fields: [], unknown_statuses: [{ value: 'research', files: ['tasks/20260102-export-csv.md'] }] },
    });
    expect(r.json.error.fix).not.toContain('--ignore-key');
    expect(storeState(p)).toEqual(before);
  });

  it('--dry-run reports what would be created and writes nothing (no actor needed)', async () => {
    const p = await project('markdown', MD_FIELDS);
    const before = storeState(p);
    const r = await p.run([...MD_ARGS, '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.json.data.dry_run).toBe(true);
    expect(r.json.data.created).toHaveLength(5);
    expect(r.json.data.created[0]).toEqual({ id: null, source: 'tasks/20260101-login-form.md', title: 'Login form validation' });
    expect(storeState(p)).toEqual(before);
  });

  it('broken frontmatter and a missing title -> INVALID_VALUE naming each file, nothing written', async () => {
    const p = await project('markdown', MD_FIELDS);
    fs.writeFileSync(path.join(p.root, 'tasks', 'bad-yaml.md'), '---\ntitle: x\ntitle: y\n---\n');
    fs.writeFileSync(path.join(p.root, 'tasks', 'no-title.md'), '---\nstage: dev\n---\n');
    const before = storeState(p);
    const r = await p.run([...MD_ARGS, '--as', 'importer']);
    expect(r.code).toBe(2);
    expect(r.json.error.code).toBe('INVALID_VALUE');
    expect(r.json.error.details.invalid.map((x: { source: string }) => x.source)).toEqual(['tasks/bad-yaml.md', 'tasks/no-title.md']);
    expect(r.json.error.details.invalid[1].message).toBe('no "title" key (the title; --title-key names another key)');
    expect(storeState(p)).toEqual(before);
    const skipped = await p.run([...MD_ARGS, '--exclude', 'bad-*', '--exclude', 'no-title.md', '--as', 'importer']);
    expect(skipped.json.data.created).toHaveLength(5);
  });

  it('input errors: unknown format, missing --status-key, json-only options with markdown', async () => {
    const p = await project('markdown', MD_FIELDS);
    expect((await p.run(['import', 'yaml', 'tasks', '--status-key', 'stage'])).json.error).toMatchObject({ code: 'INVALID_VALUE', allowed: ['markdown', 'json'] });
    expect((await p.run(['import', 'markdown', 'tasks'])).json.error).toMatchObject({ code: 'USAGE', message: '--status-key is required (the source key that holds the status)' });
    expect((await p.run(['import', 'markdown', 'tasks', '--status-key', 'stage', '--history-key', 'h'])).json.error.code).toBe('USAGE');
    expect((await p.run(['import', 'markdown', 'nowhere', '--status-key', 'stage'])).json.error.code).toBe('INVALID_VALUE');
    expect((await p.run([...MD_ARGS, '--status-map', 'dev=done'])).json.error.message).toBe('--status-map maps "dev" twice (in_progress, done); pass it once');
  });
});

describe('import json', () => {
  it('5 task files -> 5 tasks with mapped keys; history -> events with the original times; a re-run creates 0', async () => {
    const p = await project('json', JSON_FIELDS);
    const first = await p.run([...JSON_ARGS, '--as', 'importer']);
    expect(first.code).toBe(0);
    expect(first.json.data.created).toHaveLength(5);
    const task = (await p.run(['get', 'IMP-3'])).json.data;
    expect(task).toMatchObject({
      title: 'Search by phone number',
      status: 'review',
      assignee: 'qa-bot',
      labels: ['search'],
      description: 'Normalize numbers before the lookup.',
      links: [{ kind: 'file', ref: 'tasks/T-2026-01-02-001.json' }],
      fields: { source_id: 'T-2026-01-02-001', priority: 5, acceptance: ['AC-1 +7 and 8 prefixes match'] },
    });
    expect(task.events.map((e: { at: string; actor: string; type: string; data: unknown }) => [e.at, e.actor, e.type, e.data]).slice(0, 3)).toEqual([
      ['2026-01-02T00:00:00.000Z', 'pm-bot', 'commented', { text: '[created]' }],
      ['2026-01-03T03:00:00.000Z', 'dev-bot', 'status', { from: 'in_progress', to: 'done_by_dev' }],
      // An actor that is not a valid name is kept in the data; the event is the importer's.
      ['2026-01-03T09:00:00.000Z', 'importer', 'commented', { text: '[note] pushed to test', source_actor: 'Тестировщик' }],
    ]);
    expect(task.events[3]).toMatchObject({ actor: 'importer', type: 'created' });
    // Statuses in history are mapped like the task's own; an entry without a time becomes a comment at import time.
    const closed = (await p.run(['get', 'IMP-4'])).json.data;
    expect(closed.events[1]).toMatchObject({ type: 'status', data: { from: 'passed', to: 'done' } });
    const blocked = (await p.run(['get', 'IMP-5'])).json.data;
    expect(blocked.events[1]).toMatchObject({ actor: 'pm-bot', type: 'commented', data: { text: 'history entry without a usable time: {"actor":"pm-bot","event":"blocked","note":"waiting for the partner\'s sandbox"}' } });
    expect(Math.abs(Date.parse(blocked.events[1].at) - Date.parse(blocked.created_at))).toBeLessThan(60_000);

    const again = await p.run([...JSON_ARGS, '--as', 'importer']);
    expect(again.json.data).toMatchObject({ created: [], skipped: expect.arrayContaining([{ id: 'IMP-1', source: 'tasks/T-2026-01-01-001.json' }]) });
    expect(storeState(p).tasks).toBe(5);
  });

  it('one file instead of a directory', async () => {
    const p = await project('json', JSON_FIELDS);
    const args = JSON_ARGS.map((a) => (a === 'tasks' ? 'tasks/T-2026-01-01-002.json' : a));
    const r = await p.run([...args, '--as', 'importer']);
    expect(r.json.data.created).toEqual([{ id: 'IMP-1', source: 'tasks/T-2026-01-01-002.json', title: 'Nightly export job' }]);
  });

  it('unmapped statuses and undeclared keys are listed together; --dry-run writes nothing; broken JSON is named', async () => {
    const p = await project('json', JSON_FIELDS);
    const before = storeState(p);
    const r = await p.run(['import', 'json', 'tasks', '--status-key', 'state', '--dry-run']);
    expect(r.code).toBe(2);
    expect(r.json.error.code).toBe('UNKNOWN_FIELD');
    expect(r.json.error.details.unknown_fields.map((f: { key: string }) => f.key)).toEqual(['id', 'assignee', 'labels', 'priority_score', 'acceptance_criteria', 'created_at', 'history']);
    expect(r.json.error.details.unknown_statuses.map((s: { value: string }) => s.value)).toEqual(['backlog', 'testing', 'closed']);
    const dry = await p.run([...JSON_ARGS, '--dry-run']);
    expect(dry.json.data.created).toHaveLength(5);
    expect(storeState(p)).toEqual(before);
    fs.writeFileSync(path.join(p.root, 'tasks', 'broken.json'), '{"title": ');
    fs.writeFileSync(path.join(p.root, 'tasks', 'list.json'), '[]');
    const bad = await p.run([...JSON_ARGS, '--as', 'importer']);
    expect(bad.json.error.code).toBe('INVALID_VALUE');
    expect(bad.json.error.details.invalid.map((x: { source: string; message: string }) => `${x.source}: ${x.message.split(':')[0]}`)).toEqual([
      'tasks/broken.json: not valid JSON',
      'tasks/list.json: not a JSON object (one task per file)',
    ]);
    expect(storeState(p)).toEqual(before);
  });

  it('a wrong value type for a declared field -> INVALID_VALUE naming the file and the field', async () => {
    const p = await project('json', { ...JSON_FIELDS, source_id: { type: 'number' } });
    const r = await p.run([...JSON_ARGS, '--as', 'importer']);
    expect(r.json.error.code).toBe('INVALID_VALUE');
    expect(r.json.error.details.invalid[0]).toEqual({ source: 'tasks/T-2026-01-01-001.json', field: 'source_id', message: 'field source_id must be number, got "T-2026-01-01-001"' });
  });
});
