// S6t (LB-45): tails before the 0.4.0 RC. A client calling the removed MCP tool task_delete hears the CLI command; no tool is marked
// destructive; list and get show a tombstone's `deleted {at, by}`; the STORE_READ_ONLY fix covers both meanings of the code; redact
// counts a damaged active.json.bak only beyond the live file; a restore keeps next_id above kept damaged files; setup claude-code says
// in one warning when the pin goes to the committed .claude/settings.json.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTask, deleteTask, doctor, ERRORS, redactTask } from '../../src/core/index.ts';
import { callTool, TOOL_LIST, toolListing } from '../../src/mcp/tools.ts';
import { as, cleanupTemp, cli, newStore, rejectsWith, tempDir, writeRaw } from '../helpers.ts';

afterAll(cleanupTemp);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SECRET = 'sk-test-0123456789';

describe('MCP: task_delete is people-only (CLI), and no tool is destructive', () => {
  it('a call of task_delete is USAGE "unknown tool" whose fix is the CLI command; the task stays', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'keep me', status: 'todo' });
    const env = { cwd: s.root, env: { HOME: tempDir() }, dir: s.dir };
    const r = await callTool('task_delete', { id: 'LB-1', confirm_id: 'LB-1', actor: 'm' }, env);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      code: 'USAGE',
      message: 'unknown tool "task_delete"',
      fix: 'delete is for people only, through the CLI: laneboard delete <ID> --confirm <ID> (agents do not delete tasks; archive them with task_archive)',
    });
    // The list of tools is unchanged: task_delete is not in it.
    expect((r.structuredContent as { allowed: string[] }).allowed).not.toContain('task_delete');
    expect(TOOL_LIST.map((t) => t.def.name)).not.toContain('task_delete');
    const got = await callTool('task_get', { id: 'LB-1' }, env);
    expect(got.structuredContent).toMatchObject({ id: 'LB-1', archived: false });
  });

  it('any other unknown name keeps the generic fix, also names of Object.prototype', async () => {
    const s = await newStore();
    const env = { cwd: s.root, env: { HOME: tempDir() }, dir: s.dir };
    for (const name of ['task_nope', 'constructor', 'toString', '__proto__']) {
      const r = await callTool(name, {}, env);
      expect(r.structuredContent, name).toMatchObject({ code: 'USAGE', message: `unknown tool "${name}"`, fix: 'call one of the tools in `allowed`' });
    }
  });

  it('tools/list marks no tool destructive (delete and redact are CLI-only)', () => {
    for (const { def } of TOOL_LIST) expect(toolListing(def).annotations.destructiveHint, def.name).toBe(false);
  });
});

describe('list and get show a tombstone: deleted {at, by}', () => {
  it('--json carries deleted on the tombstone only; the human text says when and by whom', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'gone', status: 'todo' });
    await createTask(as(s, 'a'), { title: 'archived', status: 'todo' });
    expect((await cli(['archive', 'LB-2', '--as', 'a'], { cwd: s.root })).code).toBe(0);
    await deleteTask(as(s, 'owner'), { id: 'LB-1', confirm_id: 'LB-1' });

    const list = JSON.parse((await cli(['list', '--scope', 'archive', '--json'], { cwd: s.root })).stdout).data.items as Array<Record<string, unknown>>;
    const gone = list.find((i) => i.id === 'LB-1');
    expect(gone?.deleted).toEqual({ at: expect.stringMatching(ISO), by: 'owner' });
    expect(list.find((i) => i.id === 'LB-2')).not.toHaveProperty('deleted');
    const at = (gone?.deleted as { at: string }).at;

    const listText = (await cli(['list', '--scope', 'archive'], { cwd: s.root })).stdout;
    expect(listText).toContain(`gone [deleted ${at} by owner]`);
    expect(listText).toContain('archived [archived]');

    const got = JSON.parse((await cli(['get', 'LB-1', '--json'], { cwd: s.root })).stdout).data;
    expect(got.deleted).toEqual({ at, by: 'owner' });
    expect(JSON.parse((await cli(['get', 'LB-2', '--json'], { cwd: s.root })).stdout).data).not.toHaveProperty('deleted');
    const getText = (await cli(['get', 'LB-1'], { cwd: s.root })).stdout;
    expect(getText).toContain(`  deleted: ${at} by owner (only this trace is kept`);
    expect((await cli(['get', 'LB-2'], { cwd: s.root })).stdout).not.toContain('deleted:');
  });
});

describe('STORE_READ_ONLY: the registry fix covers both meanings the docs give it', () => {
  it('a write through --board and a machine registry that cannot be written (boards --forget)', () => {
    const fix = ERRORS.STORE_READ_ONLY.fix;
    expect(fix).toContain('--board');
    expect(fix).toContain('boards --forget');
    expect(fix).toContain('registry');
  });
});

describe('redact and a damaged active.json.bak (review S6e r3 MINOR)', () => {
  it('a secret only in another live task is not counted from the damaged backup: INVALID_VALUE, nothing written', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'a', status: 'todo' });
    await createTask(as(s, 'a'), { title: `b ${SECRET}`, status: 'todo' });
    // The backup cannot be parsed but holds what the live file holds (LB-2's title and its created event).
    const live = fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8');
    writeRaw(path.join(s.dir, 'active.json.bak'), `{ damaged ${live}`);
    const before = fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8');
    const err = await rejectsWith(redactTask(as(s, 'owner'), { id: 'LB-1', text: SECRET }), 'INVALID_VALUE');
    expect(err.message).toContain('does not occur in LB-1');
    expect(fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8')).toBe(before);
  });

  it('a secret only in the damaged backup counts and is removed', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'a', status: 'todo' });
    writeRaw(path.join(s.dir, 'active.json.bak'), `{ damaged ${SECRET} ${SECRET}`);
    const r = await redactTask(as(s, 'owner'), { id: 'LB-1', text: SECRET });
    expect(r.data).toMatchObject({ redacted: 0, backups: 2 });
    expect(fs.readFileSync(path.join(s.dir, 'active.json.bak'), 'utf8')).not.toContain(SECRET);
  });
});

describe('doctor --restore-backup and kept damaged files (review S6d r2 NIT)', () => {
  it('a restore without --fix keeps next_id above the ids an older *.invalid-* file names', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 't1', status: 'todo' });
    await createTask(as(s, 'a'), { title: 't2', status: 'todo' });
    fs.writeFileSync(path.join(s.dir, 'active.json.invalid-2026-01-01T00-00-00-000Z'), '{"next_id": 9, "tasks": [{"id": "LB-8"');
    writeRaw(path.join(s.dir, 'active.json'), '{');
    const r = await doctor(as(s), { restore_backup: true });
    expect(r.data.checks.find((c) => c.name === 'active.json')).toMatchObject({ ok: false, fixed: true });
    expect((await createTask(as(s, 'a'), { title: 'next', status: 'todo' })).data.id).toBe('LB-9');
  });
});

// git isolated from the user's config.
function gitIn(dir: string): (args: string[]) => string {
  const home = tempDir();
  const config = path.join(home, '.gitconfig');
  fs.writeFileSync(config, '');
  return (args) => {
    const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: path.join(home, '.config') };
    return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, env, encoding: 'utf8' }).trim();
  };
}

// Run the CLI with --json in `cwd`; exit code and the parsed envelope.
async function json(cwd: string, argv: string[], env: Record<string, string>): Promise<{ code: number; doc: Record<string, any> }> {
  const r = await cli([...argv, '--json'], { cwd, env });
  return { code: r.code, doc: JSON.parse(r.stdout) };
}

// The warnings of a setup run that say the pin went to the committed settings.json.
function committedPin(doc: Record<string, any>): string[] {
  return (doc.warnings as string[]).filter((w) => w.startsWith('.claude/settings.json holds env LANEBOARD_DIR='));
}

describe('setup claude-code warns when the pin goes to the committed .claude/settings.json (review S6r risk 1)', () => {
  // A git repository (one commit) with the board MONO at its root and an empty packages/billing.
  async function repo(): Promise<{ root: string; billing: string; env: Record<string, string> }> {
    const root = tempDir();
    gitIn(root)(['init', '-q', '-b', 'main']);
    const billing = path.join(root, 'packages', 'billing');
    fs.mkdirSync(billing, { recursive: true });
    fs.writeFileSync(path.join(billing, 'package.json'), '{ "name": "billing" }\n');
    gitIn(root)(['add', '-A']);
    gitIn(root)(['commit', '-q', '-m', 'first']);
    const env = { HOME: tempDir(), USER: 'tester' };
    expect((await json(root, ['init', '--name', 'mono', '--prefix', 'MONO', '--description', 'the monorepo'], env)).code).toBe(0);
    return { root, billing, env };
  }

  it('a package with a board of its own, and the root once another board lies in the repository: one warning each, with the reason', async () => {
    const m = await repo();
    // Control: the root alone keeps its env in its git-ignored local file, no warning.
    const first = await json(m.root, ['setup', 'claude-code'], m.env);
    expect(first.code).toBe(0);
    expect(committedPin(first.doc)).toEqual([]);

    expect((await json(m.billing, ['init', '--dir', path.join(m.billing, '.laneboard'), '--prefix', 'BILL', '--description', 'billing'], m.env)).code).toBe(0);
    // The root first (its pin in the root local file would reach the package: SETUP_CONFLICT's fix sends setup there first).
    const again = await json(m.root, ['setup', 'claude-code'], m.env);
    expect(again.code, JSON.stringify(again.doc)).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(m.root, '.claude', 'settings.json'), 'utf8')).env.LANEBOARD_DIR).toBe(path.join(m.root, '.laneboard'));
    const root = committedPin(again.doc);
    expect(root).toHaveLength(1);
    expect(root[0]).toContain(`LANEBOARD_DIR=${path.join(m.root, '.laneboard')}`);
    expect(root[0]).toContain(`another board lies in this repository (${path.join(m.billing, '.laneboard')})`);
    expect(root[0]).toContain('commit .claude/settings.json only knowingly');
    expect(root[0]).not.toContain('\n');

    const pkg = await json(m.billing, ['setup', 'claude-code'], m.env);
    expect(pkg.code, JSON.stringify(pkg.doc)).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(m.billing, '.claude', 'settings.json'), 'utf8')).env.LANEBOARD_DIR).toBe(path.join(m.billing, '.laneboard'));
    const own = committedPin(pkg.doc);
    expect(own).toHaveLength(1);
    expect(own[0]).toContain(`LANEBOARD_DIR=${path.join(m.billing, '.laneboard')}`);
    expect(own[0]).toContain(`this folder's board is not the one at the repository root ${m.root}`);

    // --remove says nothing about it.
    expect(committedPin((await json(m.billing, ['setup', 'claude-code', '--remove'], m.env)).doc)).toEqual([]);
  });

  it('control: a package pinned to the repository board (env in the root local file) gets no such warning', async () => {
    const m = await repo();
    const r = await json(m.billing, ['setup', 'claude-code'], m.env);
    expect(r.code, JSON.stringify(r.doc)).toBe(0);
    expect(fs.existsSync(path.join(m.root, '.claude', 'settings.local.json'))).toBe(true);
    expect(committedPin(r.doc)).toEqual([]);
  });
});
