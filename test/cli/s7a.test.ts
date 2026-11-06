// S7a (UX run 8, persona B: U1, U6).
// U1: after a restart the orchestrator's SessionStart hook ran prime under the session's default name, not the name in --reviewers or
// --creators (orch): "Only orch create tasks (not you)" and no queue of its checks. `setup claude-code --as orch` now writes the
// SessionStart hook with `prime --hook --as orch`, and that hook says to pass --as orch on every command. SessionStart fires for the
// session only and its output reaches only the main conversation, so no subagent gets the name; nothing goes into the env (subagents'
// Bash inherits it) and the edit hook (PostToolUse fires inside subagents too) stays without a name. Without --as nothing changes.
// U6: the documented return for rework (comment, then update into the work status) warned the checker as if it erred, with the
// author's hand-in under the author's --as; now the reply confirms the return (to whom, the reason, the author hands it in again).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PRIME_MAX_CHARS } from '../../src/cli/format.ts';
import { EDIT_HOOK_COMMAND, PRIME_HOOK_COMMAND } from '../../src/setup/index.ts';
import { cleanupTemp, cli, CLI_SOURCE, newStore, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

const SESSION = '0rch0002-bbbb-4bbb-8bbb-000000000002';
const HOOK_LINE =
  "Your name: orch, given by this project's SessionStart hook (laneboard setup claude-code --as orch): pass --as orch on every laneboard command (MCP tools: actor orch); never export LANEBOARD_AGENT. Subagents and parallel workers are not orch: each passes its own --as <name>.";

interface Project {
  cwd: string;
  home: string;
  // The CLI in the project folder, as `laneboard <argv>` under this HOME (plus `env`).
  run: (argv: string[], env?: Record<string, string>) => ReturnType<typeof cli>;
}

// A project with the run 8 board: statuses with two checks, reviewers rev and orch, creators orch; a temp HOME (no git).
async function project(): Promise<Project> {
  const cwd = tempDir();
  const home = tempDir();
  const run = (argv: string[], env: Record<string, string> = {}): ReturnType<typeof cli> => cli(argv, { cwd, env: { HOME: home, ...env } });
  expect((await run(['init', '--description', 'run 8 board', '--prefix', 'BACK', '--statuses', 'todo,in_progress,code_review,qa,done'])).code).toBe(0);
  expect((await run(['config', '--review-statuses', 'code_review,qa', '--reviewers', 'rev,orch', '--creators', 'orch'])).code).toBe(0);
  return { cwd, home, run };
}

// Parsed JSON of a project file, or null when it is missing.
function readJson(p: Project, file: string): Record<string, any> | null {
  const full = path.join(p.cwd, file);
  return fs.existsSync(full) ? (JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, any>) : null;
}

// The commands of the SessionStart and PostToolUse hooks in .claude/settings.json.
function hooks(p: Project): { start: string[]; edit: string[] } {
  const settings = readJson(p, '.claude/settings.json') ?? {};
  const commands = (event: string): string[] => ((settings.hooks?.[event] ?? []) as Array<{ hooks: Array<{ command: string }> }>).flatMap((g) => g.hooks.map((h) => h.command));
  return { start: commands('SessionStart'), edit: commands('PostToolUse') };
}

// A folder with `laneboard` running this source, for commands run in sh as Claude Code runs them.
function binDir(): string {
  const bin = tempDir();
  fs.writeFileSync(path.join(bin, 'laneboard'), `#!/bin/sh\nexec "${process.execPath}" "${CLI_SOURCE}" "$@"\n`, { mode: 0o755 });
  return bin;
}

// The environment Claude Code gives a session in the project and its subprocesses: the env of the local settings setup wrote, the session id.
function sessionEnv(p: Project): Record<string, string> {
  const env = (readJson(p, '.claude/settings.local.json')?.env ?? {}) as Record<string, string>;
  return { ...env, HOME: p.home, CLAUDE_CODE_SESSION_ID: SESSION };
}

// Run the SessionStart hook command setup wrote, in sh, as Claude Code does at startup (hook input on stdin); its stdout.
function runHook(p: Project): string {
  const [command] = hooks(p).start;
  return execFileSync('sh', ['-c', command ?? 'false'], {
    cwd: p.cwd,
    env: { ...sessionEnv(p), PATH: `${binDir()}:${process.env.PATH ?? ''}` },
    input: JSON.stringify({ source: 'startup', session_id: SESSION }),
    encoding: 'utf8',
  });
}

// BACK-1 created by orch for dev-1, claimed and handed in to code_review: it waits for the check of rev or orch.
async function handedIn(p: Project): Promise<void> {
  expect((await p.run(['create', 'Add endpoint', '--status', 'todo', '--assignee', 'dev-1', '--as', 'orch'])).code).toBe(0);
  expect((await p.run(['claim', 'BACK-1', '--status', 'in_progress', '--as', 'dev-1'])).code).toBe(0);
  expect((await p.run(['finish', 'BACK-1', '--result', 'endpoint added', '--no-commit', '--as', 'dev-1'])).code).toBe(0);
}

describe('S7a U1: setup claude-code --as <name> names the main session in the SessionStart hook', () => {
  it('writes prime --hook --as orch in SessionStart only: the edit hook, the env and CLAUDE.md carry no name; a second run is unchanged', async () => {
    const p = await project();
    const r = await p.run(['setup', 'claude-code', '--as', 'orch', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).warnings).toEqual([]);
    expect(hooks(p)).toEqual({
      start: ["command -v laneboard >/dev/null 2>&1 && laneboard prime --hook --as orch || echo 'laneboard CLI missing: npm i -g laneboard'"],
      edit: [EDIT_HOOK_COMMAND],
    });
    // Subagents inherit the env and read CLAUDE.md, so neither holds the name.
    expect(Object.keys(readJson(p, '.claude/settings.local.json')?.env ?? {}).sort()).toEqual(['LANEBOARD_DEFAULT_AGENT', 'LANEBOARD_DIR']);
    expect(JSON.stringify(readJson(p, '.claude/settings.local.json'))).not.toContain('orch');
    expect(fs.readFileSync(path.join(p.cwd, 'CLAUDE.md'), 'utf8')).not.toContain('orch');
    const again = JSON.parse((await p.run(['setup', 'claude-code', '--as', 'orch', '--json'])).stdout);
    expect(again.data.files.map((f: { result: string }) => f.result)).toEqual(again.data.files.map(() => 'unchanged'));
  });

  it('without --as setup writes the hook as before (PRIME_HOOK_COMMAND) and says nothing about a name', async () => {
    const p = await project();
    const r = JSON.parse((await p.run(['setup', 'claude-code', '--json'])).stdout);
    expect(r.warnings).toEqual([]);
    expect(hooks(p)).toEqual({ start: [PRIME_HOOK_COMMAND], edit: [EDIT_HOOK_COMMAND] });
  });

  it('a later setup without --as (or with another name) replaces the named hook and warns how to keep the name; --remove takes it out', async () => {
    const p = await project();
    expect((await p.run(['setup', 'claude-code', '--as', 'orch'])).code).toBe(0);
    const plain = JSON.parse((await p.run(['setup', 'claude-code', '--json'])).stdout);
    expect(plain.warnings).toEqual([
      "the SessionStart hook in .claude/settings.json ran laneboard prime --hook --as orch; this setup without --as writes it without a name, so after a restart the main session gets the session's default name again; to keep orch: laneboard setup claude-code --as orch",
    ]);
    expect(hooks(p).start).toEqual([PRIME_HOOK_COMMAND]);
    expect((await p.run(['setup', 'claude-code', '--as', 'orch'])).code).toBe(0);
    const other = JSON.parse((await p.run(['setup', 'claude-code', '--as', 'lead', '--json'])).stdout);
    expect(other.warnings).toEqual(['the SessionStart hook in .claude/settings.json ran laneboard prime --hook --as orch; this setup writes --as lead instead']);
    expect(hooks(p).start).toEqual(["command -v laneboard >/dev/null 2>&1 && laneboard prime --hook --as lead || echo 'laneboard CLI missing: npm i -g laneboard'"]);
    expect((await p.run(['setup', 'claude-code', '--remove'])).code).toBe(0);
    expect(hooks(p)).toEqual({ start: [], edit: [] });
  });

  it('--as for a harness without a hook is refused, nothing written; a bad name is refused', async () => {
    const p = await project();
    const codex = await p.run(['setup', 'codex', '--as', 'orch', '--json']);
    expect(codex.code).toBe(2);
    expect(JSON.parse(codex.stdout).error).toEqual({
      code: 'USAGE',
      message: '--as names the main session in the SessionStart hook setup claude-code writes; setup codex writes no hook, so pass --as <name> on every laneboard command instead',
      fix: 'laneboard setup codex --json',
    });
    expect(fs.existsSync(path.join(p.cwd, 'AGENTS.md'))).toBe(false);
    const bad = await p.run(['setup', 'claude-code', '--as', 'orch lead', '--json']);
    expect(JSON.parse(bad.stdout).error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard setup claude-code --as <name like orch> --json' });
    expect(fs.existsSync(path.join(p.cwd, '.claude'))).toBe(false);
  });

  it('the repro: after a restart the hook runs as orch - its queue with the pass command, create allowed, the line to pass --as orch', async () => {
    const p = await project();
    expect((await p.run(['setup', 'claude-code', '--as', 'orch'])).code).toBe(0);
    await handedIn(p);
    const out = runHook(p);
    expect(out).toContain(`\n${HOOK_LINE}\n`);
    expect(out).toContain('Waiting for your check:\n  BACK-1  [code_review]');
    expect(out).toContain('    pass: laneboard finish BACK-1 --status qa --result "<result of your check>" --as orch --json');
    expect(out).toContain('laneboard create "<short title of your work>" --status todo --assignee orch --as orch --json');
    expect(out).not.toContain('not you');
    expect(out).not.toContain('Your name: session default');
    expect(out.length).toBeLessThanOrEqual(PRIME_MAX_CHARS + 1);
  });

  it('control: the hook of a setup without --as runs under the session default name, as before (no hook line, not orch)', async () => {
    const p = await project();
    expect((await p.run(['setup', 'claude-code'])).code).toBe(0);
    await handedIn(p);
    const out = runHook(p);
    expect(out).toContain('Your name: session default claude-code@');
    expect(out).not.toContain('given by this project');
    expect(out).not.toContain('Waiting for your check');
  });

  it('a subagent of that session (the same env, no --as) never writes as orch: its name stays the session default', async () => {
    const p = await project();
    expect((await p.run(['setup', 'claude-code', '--as', 'orch'])).code).toBe(0);
    await handedIn(p);
    const r = await cli(['comment', 'BACK-1', 'subagent note', '--json'], { cwd: p.cwd, env: sessionEnv(p) });
    expect(r.code).toBe(0);
    const events = JSON.parse((await p.run(['get', 'BACK-1', '--json'])).stdout).data.events as Array<{ type: string; actor: string; actor_source: string }>;
    expect(events.at(-1)).toMatchObject({ type: 'commented', actor: expect.stringMatching(/^claude-code@.+:0rch0002$/), actor_source: 'default' });
  });

  it('the line is only the hook\'s own --as: plain prime --as orch, and the hook under LANEBOARD_AGENT, print it not', async () => {
    const p = await project();
    expect((await p.run(['prime', '--as', 'orch'])).stdout).not.toContain('given by this project');
    const viaEnv = await p.run(['prime', '--hook'], { LANEBOARD_AGENT: 'orch' });
    expect(viaEnv.stdout).not.toContain('given by this project');
    const viaAs = await p.run(['prime', '--hook', '--as', 'orch']);
    expect(viaAs.stdout).toContain(HOOK_LINE);
  });

  it('the hook line fits PRIME_MAX_CHARS with a 64-character name and a long queue', async () => {
    const p = await project();
    const name = `o${'r'.repeat(62)}h`;
    for (let i = 1; i <= 12; i++) {
      expect((await p.run(['create', `Task ${i} ${'t'.repeat(150)}`, '--status', 'todo', '--assignee', 'dev-1', '--as', 'orch'])).code).toBe(0);
      expect((await p.run(['claim', `BACK-${i}`, '--status', 'in_progress', '--as', 'dev-1'])).code).toBe(0);
      expect((await p.run(['finish', `BACK-${i}`, '--result', 'r', '--no-commit', '--as', 'dev-1'])).code).toBe(0);
    }
    expect((await p.run(['config', '--reviewers', `rev,orch,${name}`])).code).toBe(0);
    const out = (await p.run(['prime', '--hook', '--as', name])).stdout;
    expect(out).toContain(`Your name: ${name}, given by this project's SessionStart hook`);
    expect(out).toContain('Waiting for your check:\n  BACK-');
    expect(out.length).toBeLessThanOrEqual(PRIME_MAX_CHARS + 1);
  });
});

// A board with checks (reviewers rev, orch; no creators): API-1 claimed by dev-1 and handed in to the first check.
async function waiting(statuses: string[], checks: string[], work: string): Promise<TestStore> {
  const s = await newStore({ prefix: 'API', statuses });
  const run = (actor: string, argv: string[]): ReturnType<typeof cli> => cli([...argv, '--as', actor, '--json'], { cwd: s.root });
  expect((await run('orch', ['config', '--review-statuses', checks.join(','), '--reviewers', 'rev,orch'])).code).toBe(0);
  expect((await run('orch', ['create', 'Add endpoint', '--status', statuses[0] ?? ''])).code).toBe(0);
  expect((await run('dev-1', ['claim', 'API-1', '--status', work])).code).toBe(0);
  expect((await run('dev-1', ['finish', 'API-1', '--result', 'work', '--no-commit'])).code).toBe(0);
  return s;
}

// Run a command line in sh in the store's folder with `laneboard` on PATH; exit code and output.
function sh(s: TestStore, line: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('sh', ['-c', line], { cwd: s.root, env: { PATH: `${binDir()}:${process.env.PATH ?? ''}`, HOME: tempDir() }, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const LAYOUTS = [
  { name: 'two checks', statuses: ['todo', 'in_progress', 'code_review', 'qa', 'done'], checks: ['code_review', 'qa'], work: 'in_progress' },
  { name: 'one check', statuses: ['todo', 'in_progress', 'review', 'done'], checks: ['review'], work: 'in_progress' },
];

describe('S7a U6: the documented return for rework is confirmed, not warned', () => {
  for (const l of LAYOUTS) {
    it(`${l.name}: the fix of a checker's finish into ${l.work}, run as printed: a neutral confirmation, no command under dev-1's --as`, async () => {
      const s = await waiting(l.statuses, l.checks, l.work);
      const refused = await cli(['finish', 'API-1', '--status', l.work, '--result', 'tests missing', '--as', 'rev', '--json'], { cwd: s.root });
      const fix = JSON.parse(refused.stdout).error.fix as string;
      expect(fix).toBe(`laneboard comment API-1 --as rev -- 'tests missing' && laneboard update API-1 --status ${l.work} --as rev`);
      const r = sh(s, fix);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toContain(
        `API-1 returned for rework to dev-1 (rev 5, ${l.work}, dev-1); reason: "tests missing"; dev-1 reworks it and hands it in again with finish, then it is back in the checkers' queue\n`,
      );
      expect(r.stdout).not.toContain('--as dev-1');
    });

    it(`${l.name}: --json: no warning, the reply's returned names the holder and the reason`, async () => {
      const s = await waiting(l.statuses, l.checks, l.work);
      expect((await cli(['comment', 'API-1', 'tests missing', '--as', 'rev'], { cwd: s.root })).code).toBe(0);
      const r = JSON.parse((await cli(['update', 'API-1', '--status', l.work, '--as', 'rev', '--json'], { cwd: s.root })).stdout);
      expect(r.warnings).toEqual([]);
      expect(r.data).toEqual({ id: 'API-1', rev: 5, status: l.work, assignee: 'dev-1', returned: { to: 'dev-1', reason: 'tests missing' } });
    });
  }

  it('a return with no reason keeps only the S6z warning (no A17); the reply says returned with reason null', async () => {
    const s = await waiting(LAYOUTS[0]?.statuses ?? [], ['code_review', 'qa'], 'in_progress');
    const r = JSON.parse((await cli(['update', 'API-1', '--status', 'in_progress', '--as', 'orch', '--json'], { cwd: s.root })).stdout);
    expect(r.warnings).toEqual([
      "API-1 went back for rework with no reason from you: dev-1's prime says it was returned with no reason; add the reason (shown to dev-1 until the next hand-in): laneboard comment API-1 --as orch -- '<why it goes back>'",
    ]);
    expect(r.data.returned).toEqual({ to: 'dev-1', reason: null });
    const human = await cli(['update', 'API-1', '--status', 'todo', '--as', 'orch'], { cwd: s.root });
    expect(human.stdout).not.toContain('returned for rework');
  });

  it('a return that gives the task to another holder names that holder; unassigned: nobody, whoever takes it hands it in', async () => {
    const s = await waiting(LAYOUTS[1]?.statuses ?? [], ['review'], 'in_progress');
    expect((await cli(['comment', 'API-1', 'dev-2 takes over', '--as', 'orch'], { cwd: s.root })).code).toBe(0);
    const moved = await cli(['update', 'API-1', '--status', 'in_progress', '--assignee', 'dev-2', '--as', 'orch'], { cwd: s.root });
    expect(moved.stdout).toContain('API-1 returned for rework to dev-2 (rev 5, in_progress, dev-2); reason: "dev-2 takes over"; dev-2 reworks it and hands it in again with finish');
    const t = await waiting(LAYOUTS[1]?.statuses ?? [], ['review'], 'in_progress');
    expect((await cli(['comment', 'API-1', 'free it', '--as', 'orch'], { cwd: t.root })).code).toBe(0);
    const freed = await cli(['update', 'API-1', '--status', 'in_progress', '--unassign', '--as', 'orch'], { cwd: t.root });
    expect(freed.stdout).toContain('API-1 returned for rework to nobody (unassigned) (rev 5, in_progress, unassigned); reason: "free it"; whoever takes it reworks it');
  });

  it('only the write that returns it is confirmed: later moves of the returned task (the author parks it, orch moves it) have no returned', async () => {
    const s = await waiting(LAYOUTS[0]?.statuses ?? [], ['code_review', 'qa'], 'in_progress');
    expect((await cli(['comment', 'API-1', 'tests missing', '--as', 'rev'], { cwd: s.root })).code).toBe(0);
    expect(JSON.parse((await cli(['update', 'API-1', '--status', 'in_progress', '--as', 'rev', '--json'], { cwd: s.root })).stdout).data.returned).toEqual({ to: 'dev-1', reason: 'tests missing' });
    const parked = JSON.parse((await cli(['update', 'API-1', '--status', 'todo', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout);
    expect(parked.data.returned).toBeUndefined();
    expect(parked.warnings).toEqual([]);
    const moved = JSON.parse((await cli(['update', 'API-1', '--status', 'in_progress', '--as', 'orch', '--json'], { cwd: s.root })).stdout);
    expect(moved.data.returned).toBeUndefined();
    expect(moved.warnings).toEqual([]);
  });

  it('control: the author\'s own move out of the check and a close by update keep the A17 warning; no returned in the reply', async () => {
    const s = await waiting(LAYOUTS[0]?.statuses ?? [], ['code_review', 'qa'], 'in_progress');
    const own = JSON.parse((await cli(['update', 'API-1', '--status', 'in_progress', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout);
    expect(own.data.returned).toBeUndefined();
    expect(own.warnings).toEqual([
      'API-1 was handed in; after this move it is not (a check passes it on or accepts it with finish --status qa, not by a move), so no checker sees it until it is handed in again: laneboard finish API-1 --status code_review --result "<what you did, how you checked it>" --as dev-1',
    ]);
    const t = await waiting(LAYOUTS[0]?.statuses ?? [], ['code_review', 'qa'], 'in_progress');
    const closed = JSON.parse((await cli(['update', 'API-1', '--status', 'done', '--as', 'orch', '--json'], { cwd: t.root })).stdout);
    expect(closed.data.returned).toBeUndefined();
    expect(closed.warnings[0]).toContain('API-1 was handed in; closed by this move it has no result of a check and no acceptance mark');
  });

  it('a board without checks: a move of a handed-in task is no return (no returned, as before)', async () => {
    const s = await newStore({ prefix: 'API', statuses: ['todo', 'in_progress', 'review', 'done'] });
    expect((await cli(['create', 'x', '--status', 'todo', '--as', 'orch'], { cwd: s.root })).code).toBe(0);
    expect((await cli(['claim', 'API-1', '--status', 'in_progress', '--as', 'dev-1'], { cwd: s.root })).code).toBe(0);
    expect((await cli(['finish', 'API-1', '--status', 'review', '--result', 'r', '--no-commit', '--as', 'dev-1'], { cwd: s.root })).code).toBe(0);
    const r = JSON.parse((await cli(['update', 'API-1', '--status', 'in_progress', '--as', 'rev', '--json'], { cwd: s.root })).stdout);
    expect(r.data.returned).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });
});
