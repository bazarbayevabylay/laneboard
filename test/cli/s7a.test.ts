// S7a (UX run 8, persona B: U1, U6).
// U1: after a restart the orchestrator's SessionStart hook ran prime under the session's default name, not the name in --reviewers or
// --creators (orch): "Only orch create tasks (not you)" and no queue of its checks. r1: no project file carries a name (a name there
// reaches every session that reads it: a colleague's clone, another window, a worker in a linked worktree), so `setup --as` is refused.
// An unnamed session on a board with named roles reads one line with the names and `laneboard prime --as <name>`; "not you" is said
// only to a session that named itself. The orchestrator runs `laneboard prime --as orch` first after a restart (README).
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
const OTHER_SESSION = '0the0003-cccc-4ccc-8ccc-000000000003';
const HINT =
  'Named roles here: reviewers rev, orch; creators orch. If you are one of them: `laneboard prime --as <name>`, then --as <name> on every command.';

interface Project {
  cwd: string;
  home: string;
  // The CLI in the project folder, as `laneboard <argv>` under this HOME (plus `env`).
  run: (argv: string[], env?: Record<string, string>) => ReturnType<typeof cli>;
}

// A project with a board under a temp HOME (no git): the run 8 board (statuses with two checks, reviewers rev and orch, creators
// orch) unless `roles` gives other config arguments ([] for a board without named roles).
async function project(roles = ['--review-statuses', 'code_review,qa', '--reviewers', 'rev,orch', '--creators', 'orch']): Promise<Project> {
  const cwd = tempDir();
  const home = tempDir();
  const run = (argv: string[], env: Record<string, string> = {}): ReturnType<typeof cli> => cli(argv, { cwd, env: { HOME: home, ...env } });
  expect((await run(['init', '--description', 'run 8 board', '--prefix', 'BACK', '--statuses', 'todo,in_progress,code_review,qa,done'])).code).toBe(0);
  if (roles.length > 0) expect((await run(['config', ...roles])).code).toBe(0);
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
function sessionEnv(p: Project, session = SESSION): Record<string, string> {
  const env = (readJson(p, '.claude/settings.local.json')?.env ?? {}) as Record<string, string>;
  return { ...env, HOME: p.home, CLAUDE_CODE_SESSION_ID: session };
}

// Run the SessionStart hook command setup wrote, in sh, as Claude Code does at startup (hook input on stdin); its stdout.
function runHook(p: Project, session = SESSION): string {
  const [command] = hooks(p).start;
  return execFileSync('sh', ['-c', command ?? 'false'], {
    cwd: p.cwd,
    env: { ...sessionEnv(p, session), PATH: `${binDir()}:${process.env.PATH ?? ''}` },
    input: JSON.stringify({ source: 'startup', session_id: session }),
    encoding: 'utf8',
  });
}

// BACK-1 created by orch for dev-1, claimed and handed in to code_review: it waits for the check of rev or orch.
async function handedIn(p: Project): Promise<void> {
  expect((await p.run(['create', 'Add endpoint', '--status', 'todo', '--assignee', 'dev-1', '--as', 'orch'])).code).toBe(0);
  expect((await p.run(['claim', 'BACK-1', '--status', 'in_progress', '--as', 'dev-1'])).code).toBe(0);
  expect((await p.run(['finish', 'BACK-1', '--result', 'endpoint added', '--no-commit', '--as', 'dev-1'])).code).toBe(0);
}

describe('S7a U1 r1: no project file names a session; an unnamed session reads the named roles and how to take one', () => {
  it('setup refuses --as (USAGE, fix without it) for every harness, with --remove and empty too; nothing is written; usage has no --as', async () => {
    const p = await project();
    for (const argv of [
      ['setup', 'claude-code', '--as', 'orch'],
      ['setup', 'codex', '--as', 'orch'],
      ['setup', 'claude-code', '--remove', '--as', 'orch'],
      ['setup', 'claude-code', '--as='],
    ]) {
      const r = await p.run([...argv, '--json']);
      expect(r.code, argv.join(' ')).toBe(2);
      const error = JSON.parse(r.stdout).error as { code: string; message: string; fix: string };
      expect(error.code).toBe('USAGE');
      expect(error.message).toContain('setup takes no --as');
      expect(error.message).toContain('laneboard prime --as <name>');
      expect(error.fix).toBe(`laneboard ${argv.filter((a) => a !== '--as' && a !== 'orch' && a !== '--as=').join(' ')} --json`);
    }
    expect(fs.existsSync(path.join(p.cwd, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(p.cwd, 'AGENTS.md'))).toBe(false);
    const help = (await p.run(['setup', '--help'])).stdout;
    expect(help.split('\n')[0]).toBe('laneboard setup <claude-code|codex|cursor|gemini|opencode> [--remove [--global]] [--dry-run]');
  });

  it('setup writes the hooks without a name and puts no role name into any file', async () => {
    const p = await project();
    expect(JSON.parse((await p.run(['setup', 'claude-code', '--json'])).stdout).warnings).toEqual([]);
    expect(hooks(p)).toEqual({ start: [PRIME_HOOK_COMMAND], edit: [EDIT_HOOK_COMMAND] });
    for (const file of ['.claude/settings.json', '.claude/settings.local.json', 'CLAUDE.md', '.mcp.json']) {
      const full = path.join(p.cwd, file);
      if (fs.existsSync(full)) expect(fs.readFileSync(full, 'utf8'), file).not.toMatch(/\borch\b|--as [A-Za-z0-9]/);
    }
  });

  it('the repro: the hook of an unnamed main session prints the hint, never "not you", and no queue of orch', async () => {
    const p = await project();
    expect((await p.run(['setup', 'claude-code'])).code).toBe(0);
    await handedIn(p);
    const out = runHook(p);
    expect(out).toContain('Your name: session default claude-code@');
    expect(out).toContain(`\n${HINT}\n`);
    expect(out).toContain('Only orch create tasks here (not under the default name).');
    expect(out).toContain('Only orch create tasks on this board: not one of them? ask whoever started you for a task id');
    expect(out).not.toContain('not you');
    expect(out).not.toContain('Waiting for your check');
    expect(out).not.toContain('--as orch');
  });

  it('another window (its own session) sees the hint too and writes under its own default name, never as orch', async () => {
    const p = await project();
    expect((await p.run(['setup', 'claude-code'])).code).toBe(0);
    await handedIn(p);
    expect(runHook(p, OTHER_SESSION)).toContain(HINT);
    expect((await cli(['comment', 'BACK-1', 'second window note', '--json'], { cwd: p.cwd, env: sessionEnv(p, OTHER_SESSION) })).code).toBe(0);
    const events = JSON.parse((await p.run(['get', 'BACK-1', '--json'])).stdout).data.events as Array<{ type: string; actor: string; actor_source: string }>;
    expect(events.at(-1)).toMatchObject({ type: 'commented', actor: expect.stringMatching(/^claude-code@.+:0the0003$/), actor_source: 'default' });
  });

  it('the orchestrator after prime --as orch: its queue with the pass command, create allowed, no hint', async () => {
    const p = await project();
    expect((await p.run(['setup', 'claude-code'])).code).toBe(0);
    await handedIn(p);
    const out = (await cli(['prime', '--as', 'orch'], { cwd: p.cwd, env: sessionEnv(p) })).stdout;
    expect(out).toContain('Waiting for your check:\n  BACK-1  [code_review]');
    expect(out).toContain('    pass: laneboard finish BACK-1 --status qa --result "<result of your check>" --as orch --json');
    expect(out).toContain('laneboard create "<short title of your work>" --status todo --assignee orch --as orch --json');
    expect(out).toContain('Only orch create tasks here.');
    expect(out).not.toContain('Named roles here');
  });

  it('a named session gets no hint (--as or LANEBOARD_AGENT); a named non-creator still reads "not you"', async () => {
    const p = await project();
    expect((await p.run(['setup', 'claude-code'])).code).toBe(0);
    for (const named of [await cli(['prime', '--as', 'dev-2'], { cwd: p.cwd, env: sessionEnv(p) }), await cli(['prime'], { cwd: p.cwd, env: { ...sessionEnv(p), LANEBOARD_AGENT: 'dev-2' } })]) {
      expect(named.stdout).not.toContain('Named roles here');
      expect(named.stdout).toContain('Only orch create tasks here (not you).');
      expect(named.stdout).toContain('Only orch create tasks on this board: ask whoever started you');
    }
    expect((await cli(['prime', '--hook', '--as', 'dev-2'], { cwd: p.cwd, env: sessionEnv(p), stdin: '{"source":"startup"}' })).stdout).not.toContain('Named roles here');
  });

  it('no hint on a board without named roles (none, or checks by anybody); the hint names only the roles there are', async () => {
    for (const roles of [[], ['--review-statuses', 'code_review,qa']]) {
      const p = await project(roles);
      expect((await p.run(['setup', 'claude-code'])).code).toBe(0);
      expect(runHook(p), roles.join(' ')).not.toContain('Named roles here');
    }
    const reviewers = await project(['--review-statuses', 'code_review,qa', '--reviewers', 'rev,orch']);
    expect((await reviewers.run(['setup', 'claude-code'])).code).toBe(0);
    expect(runHook(reviewers)).toContain('\nNamed roles here: reviewers rev, orch. If you are one of them: `laneboard prime --as <name>`');
    const creators = await project(['--creators', 'orch']);
    expect((await creators.run(['setup', 'claude-code'])).code).toBe(0);
    expect(runHook(creators)).toContain('\nNamed roles here: creators orch. If you are one of them: `laneboard prime --as <name>`');
  });

  it('a session with no name at all (outside Claude Code) gets the hint; a default name that is in the roles gets none', async () => {
    const p = await project();
    const bare = (await p.run(['prime'])).stdout;
    expect(bare).toContain(HINT);
    expect(bare).toContain('Only orch create tasks here (not without a name).');
    expect(bare).not.toContain('not you');
    expect((await p.run(['setup', 'claude-code'])).code).toBe(0);
    const own = JSON.parse((await cli(['prime', '--json'], { cwd: p.cwd, env: sessionEnv(p) })).stdout).data.agent as string;
    expect(own).toMatch(/^claude-code@.+:0rch0002$/);
    expect((await p.run(['config', '--reviewers', `rev,orch,${own}`])).code).toBe(0);
    expect(runHook(p)).not.toContain('Named roles here');
  });

  it('a default name only among the creators counts as named: no hint', async () => {
    const p = await project();
    expect((await p.run(['setup', 'claude-code'])).code).toBe(0);
    const own = JSON.parse((await cli(['prime', '--json'], { cwd: p.cwd, env: sessionEnv(p) })).stdout).data.agent as string;
    expect((await p.run(['config', '--creators', `orch,${own}`])).code).toBe(0);
    const out = runHook(p);
    expect(out).toContain(own); // in the creators, not in the reviewers rev, orch
    expect(out).not.toContain('Named roles here');
  });

  it('the hint fits PRIME_MAX_CHARS with long name lists and a long queue; the lists are cut, the command never', async () => {
    const p = await project();
    expect((await p.run(['setup', 'claude-code'])).code).toBe(0);
    const names = Array.from({ length: 10 }, (_, i) => `${'n'.repeat(62)}${i}x`);
    expect((await p.run(['config', '--reviewers', names.join(','), '--creators', names.join(',')])).code).toBe(0);
    for (let i = 1; i <= 12; i++) {
      expect((await p.run(['create', `Task ${i} ${'t'.repeat(150)}`, '--status', 'todo', '--assignee', 'dev-1', '--as', names[0] ?? ''])).code).toBe(0);
    }
    const out = runHook(p);
    const hint = out.split('\n').find((l) => l.startsWith('Named roles here: reviewers '));
    expect(hint).toBeDefined();
    expect(hint).toContain('…; creators ');
    expect(hint).toMatch(/If you are one of them: `laneboard prime --as <name>`, then --as <name> on every command\.$/);
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
      expect(fix).toBe(`laneboard comment API-1 --as rev --json -- 'tests missing' && laneboard update API-1 --status ${l.work} --as rev --json`);
      const r = sh(s, fix);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe('');
      // The fix carries --json on each command (LB-63.2): the update's envelope confirms the return, with no warning.
      const update = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as { data: unknown; warnings: unknown };
      expect(update.data).toEqual({ id: 'API-1', rev: 5, status: l.work, assignee: 'dev-1', returned: { to: 'dev-1', reason: 'tests missing' } });
      expect(update.warnings).toEqual([]);
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
    // A close by update skips no check (slice A2, the check bypass): rev passes it on to qa, the last check, first.
    expect((await cli(['finish', 'API-1', '--status', 'qa', '--result', 'code ok', '--as', 'rev'], { cwd: t.root })).code).toBe(0);
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
