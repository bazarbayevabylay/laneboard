// 0.4.1 slice A2: finish, refusal codes and the check bypass.
// The check bypass (triage "new finding"): on a board with checks update --status <final> closes only a task that waits in the last
// check; LB-63.6 a name that may not check a waiting task never moves it out of the check (nor takes it, in either order); LB-63.1 a
// stale check of a task returned for rework, or of one its holder did not hand in, is ALREADY_CLAIMED by finish and by update alike;
// LB-63.2 (A2 part: the fixes of the A2 refusals and warnings carry --json, asserted with them); LB-63.3 the reply of a hand-in says handed_in; LB-55.1 finish warns when
// the commit it linked is linked to another task; LB-55.2 the worktree warning with several worktrees names one exact command;
// LB-55.3 that warning comes without the "HEAD has not moved" one; LB-65.9 no unused exports.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as core from '../../src/core/index.ts';
// @ts-expect-error LB-65.9: ReworkReturn is update.ts's own type, not exported.
import type { ReworkReturn } from '../../src/core/ops/update.ts';
import { CLI_SOURCE, cleanupTemp, cli, newStore, readStore, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

// Run the CLI with --json as `actor` in `cwd`; exit code and the parsed envelope.
async function run(cwd: string, actor: string, argv: string[]): Promise<{ code: number; doc: Record<string, any> }> {
  const r = await cli([...argv, '--as', actor, '--json'], { cwd });
  return { code: r.code, doc: JSON.parse(r.stdout) };
}

// The task as `get` shows it.
async function task(s: TestStore, id: string): Promise<Record<string, any>> {
  return (await run(s.root, 'orch', ['get', id])).doc.data;
}

// A board todo, in_progress, `checks`, done with `checks` as its checks and review.by `by` (none: anybody but the author checks);
// API-1 claimed by dev-1 into in_progress; handed in with finish when `handIn`.
async function board(checks: string[], by: string, handIn: boolean): Promise<TestStore> {
  const s = await newStore({ prefix: 'API', statuses: ['todo', 'in_progress', ...checks, 'done'] });
  expect((await run(s.root, 'orch', ['config', '--review-statuses', checks.join(','), ...(by === '' ? [] : ['--reviewers', by])])).code).toBe(0);
  expect((await run(s.root, 'orch', ['create', 'Add endpoint', '--status', 'todo'])).code).toBe(0);
  expect((await run(s.root, 'dev-1', ['claim', 'API-1', '--status', 'in_progress'])).code).toBe(0);
  if (handIn) expect((await run(s.root, 'dev-1', ['finish', 'API-1', '--result', 'work', '--no-commit'])).doc.data.status).toBe(checks[0]);
  return s;
}

describe('the check bypass: update --status <final> on a board with checks closes only a task waiting in the last check', () => {
  it('a task in work held by another name: ALREADY_CLAIMED, the fix asks its holder to hand it in; nothing changes', async () => {
    for (const by of ['', 'r1,r2']) {
      const s = await board(['review'], by, false);
      const r = await run(s.root, 'r2', ['update', 'API-1', '--status', 'done']);
      expect(r.code, by).toBe(4);
      expect(r.doc.error, by).toMatchObject({
        code: 'ALREADY_CLAIMED',
        details: { assignee: 'dev-1' },
        fix: 'laneboard comment API-1 "hand it in: laneboard finish API-1 --status review --result <result>" --as r2',
      });
      expect(r.doc.error.message, by).toContain('task API-1 is claimed by dev-1 and is in_progress, not handed in with finish');
      expect(await task(s, 'API-1'), by).toMatchObject({ status: 'in_progress', assignee: 'dev-1', rev: 2 });
    }
  });

  it('a task returned for rework: ALREADY_CLAIMED, the fix reads the task', async () => {
    const s = await board(['review'], '', true);
    expect((await run(s.root, 'r1', ['comment', 'API-1', 'tests missing'])).code).toBe(0);
    expect((await run(s.root, 'r1', ['update', 'API-1', '--status', 'in_progress'])).code).toBe(0);
    const r = await run(s.root, 'r2', ['update', 'API-1', '--status', 'done']);
    expect(r.code).toBe(4);
    expect(r.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', details: { assignee: 'dev-1' }, fix: 'laneboard get API-1' });
    expect(r.doc.error.message).toContain('API-1 was returned for rework by r1');
    expect((await task(s, 'API-1')).status).toBe('in_progress');
  });

  it('an unassigned task in work: INVALID_VALUE, the fix hands it in to the first check', async () => {
    const s = await board(['review'], '', false);
    expect((await run(s.root, 'orch', ['update', 'API-1', '--unassign'])).code).toBe(0);
    const r = await run(s.root, 'r2', ['update', 'API-1', '--status', 'done']);
    expect(r.code).toBe(2);
    expect(r.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard finish API-1 --status review --result "<what you did, how you checked it>" --as r2' });
    expect((await task(s, 'API-1')).status).toBe('in_progress');
  });

  it('a task waiting in an earlier check: INVALID_VALUE, the later check is named, the fix reads the task', async () => {
    const s = await board(['code_review', 'qa'], '', true);
    const r = await run(s.root, 'rev', ['update', 'API-1', '--status', 'done']);
    expect(r.code).toBe(2);
    expect(r.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard get API-1' });
    expect(r.doc.error.message).toContain('update never closes it: qa is still to check, and a check passes it on with finish');
    expect((await task(s, 'API-1')).status).toBe('code_review');
  });

  it('control: a task waiting in the last check closes by update with the A17 warning; a board without checks as before', async () => {
    const s = await board(['code_review', 'qa'], '', true);
    expect((await run(s.root, 'rev', ['finish', 'API-1', '--status', 'qa', '--result', 'code ok'])).doc.data.status).toBe('qa');
    const closed = await run(s.root, 'qa-1', ['update', 'API-1', '--status', 'done']);
    expect(closed.code).toBe(0);
    expect(closed.doc.warnings[0]).toContain('API-1 was handed in; closed by this move it has no result of a check and no acceptance mark');
    const t = await newStore({ prefix: 'API', statuses: ['todo', 'in_progress', 'review', 'done'] });
    expect((await run(t.root, 'orch', ['create', 'Work', '--status', 'in_progress', '--assignee', 'dev-1'])).code).toBe(0);
    expect((await run(t.root, 'orch', ['update', 'API-1', '--status', 'done'])).code).toBe(0);
  });
});

describe('LB-63.6: a name that may not check a waiting task never moves it out of the check', () => {
  const MESSAGE =
    'API-1 is handed in and waits in review for the check of r1 (review -> done): you may not check it (config review.by: r1), so you never move it out of the check: ' +
    'a checker passes it on with finish or returns it for rework; a note for the checkers is a comment';

  it('update --status <work>, then update --assignee itself: both refused, the task stays handed in with dev-1', async () => {
    const s = await board(['review'], 'r1', true);
    const moved = await run(s.root, 'x', ['update', 'API-1', '--status', 'in_progress']);
    expect(moved.code).toBe(4);
    expect(moved.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', message: MESSAGE, details: { assignee: 'dev-1' }, fix: 'laneboard comment API-1 "<note for the check>" --as x --json' });
    expect((await run(s.root, 'x', ['update', 'API-1', '--assignee', 'x'])).doc.error.code).toBe('ALREADY_CLAIMED');
    expect(await task(s, 'API-1')).toMatchObject({ status: 'review', assignee: 'dev-1', rev: 3 });
  });

  it('unassigned while waiting: INVALID_VALUE with the same message', async () => {
    const s = await board(['review'], 'r1', true);
    expect((await run(s.root, 'orch', ['update', 'API-1', '--unassign'])).code).toBe(0);
    const r = await run(s.root, 'x', ['update', 'API-1', '--status', 'todo']);
    expect(r.code).toBe(2);
    expect(r.doc.error).toMatchObject({ code: 'INVALID_VALUE', message: MESSAGE });
  });

  it('control: its checker returns it for rework, its author moves it back', async () => {
    const s = await board(['review'], 'r1', true);
    expect((await run(s.root, 'r1', ['update', 'API-1', '--status', 'in_progress'])).code).toBe(0);
    const t = await board(['review'], 'r1', true);
    expect((await run(t.root, 'dev-1', ['update', 'API-1', '--status', 'in_progress'])).code).toBe(0);
  });
});

describe('LB-63.1: one code for a stale check, by finish and by update', () => {
  it('a task returned for rework: finish and update into the check are both ALREADY_CLAIMED with the same message', async () => {
    const s = await board(['review'], 'r1,r2', true);
    expect((await run(s.root, 'r1', ['comment', 'API-1', 'tests missing'])).code).toBe(0);
    expect((await run(s.root, 'r1', ['update', 'API-1', '--status', 'in_progress'])).code).toBe(0);
    const fin = await run(s.root, 'r2', ['finish', 'API-1', '--status', 'done', '--result', 'ok']);
    const upd = await run(s.root, 'r2', ['update', 'API-1', '--status', 'review']);
    expect([fin.code, upd.code]).toEqual([4, 4]);
    expect(upd.doc.error).toEqual(fin.doc.error);
    expect(upd.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', details: { assignee: 'dev-1' }, fix: 'laneboard get API-1' });
  });

  it('a task its holder did not hand in: update into the check is ALREADY_CLAIMED, as finish', async () => {
    const s = await board(['review'], 'r1', false);
    const fin = await run(s.root, 'r1', ['finish', 'API-1', '--status', 'done', '--result', 'ok']);
    const upd = await run(s.root, 'r1', ['update', 'API-1', '--status', 'review']);
    expect([fin.doc.error.code, upd.doc.error.code, fin.code, upd.code]).toEqual(['ALREADY_CLAIMED', 'ALREADY_CLAIMED', 4, 4]);
    expect(upd.doc.error).toMatchObject({
      details: { assignee: 'dev-1' },
      fix: 'laneboard comment API-1 "hand it in: laneboard finish API-1 --status review --result <result>" --as r1',
    });
  });
});

describe('LB-63.3: the reply of finish says handed_in', () => {
  it('into a status that is not final: handed_in true; into the final status and with --full: no such key', async () => {
    const s = await newStore({ prefix: 'API', statuses: ['todo', 'doing', 'review', 'done'] });
    expect((await run(s.root, 'dev-1', ['create', 'Work', '--status', 'doing', '--assignee', 'dev-1'])).code).toBe(0);
    const handed = await run(s.root, 'dev-1', ['finish', 'API-1', '--status', 'review', '--result', 'work', '--no-commit']);
    expect(handed.doc.data).toEqual({ id: 'API-1', rev: 2, status: 'review', assignee: 'dev-1', commit: null, handed_in: true });
    const closed = await run(s.root, 'dev-1', ['finish', 'API-1', '--result', 'all done', '--no-commit']);
    expect(closed.doc.data).toEqual({ id: 'API-1', rev: 3, status: 'done', assignee: 'dev-1', commit: null });
    expect((await run(s.root, 'dev-1', ['create', 'More', '--status', 'doing', '--assignee', 'dev-1'])).code).toBe(0);
    const full = await run(s.root, 'dev-1', ['finish', 'API-2', '--status', 'review', '--result', 'work', '--no-commit', '--full']);
    expect(full.doc.data.status).toBe('review');
    expect(full.doc.data.handed_in).toBeUndefined();
  });
});

// git isolated from the user's config; commits dated `date` (ISO) when given, else now.
function gitIn(dir: string): (args: string[], date?: string) => string {
  const home = tempDir();
  const config = path.join(home, '.gitconfig');
  fs.writeFileSync(config, '');
  return (args, date) => {
    const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', ...(date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {}) };
    return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, env, encoding: 'utf8' }).trim();
  };
}

// A board in the main checkout of a git repository (first commit long ago); LB-1 claimed by dev-1 and LB-2 by dev-2 since.
async function repo(): Promise<{ s: TestStore; git: (args: string[], date?: string) => string }> {
  const s = await newStore();
  const git = gitIn(s.root);
  git(['init', '-q', '-b', 'main']);
  git(['commit', '-q', '--allow-empty', '-m', 'first'], '2020-01-01T00:00:00Z');
  for (const [n, dev] of [[1, 'dev-1'], [2, 'dev-2']] as const) {
    expect((await run(s.root, dev, ['create', `Work ${n}`, '--status', 'todo', '--assignee', dev])).code).toBe(0);
    expect((await run(s.root, dev, ['claim', `LB-${n}`, '--status', 'in_progress'])).code).toBe(0);
  }
  return { s, git };
}

// The links of a stored task.
function links(s: TestStore, id: string): unknown {
  return readStore(s.dir, 'active').tasks.find((t) => t.id === id)?.links;
}

// Run a command line in sh in `cwd` with `laneboard` on PATH (the CLI from source); exit code.
function sh(cwd: string, line: string): number {
  const bin = tempDir();
  fs.writeFileSync(path.join(bin, 'laneboard'), `#!/bin/sh\nexec "${process.execPath}" "${CLI_SOURCE}" "$@"\n`, { mode: 0o755 });
  try {
    execFileSync('sh', ['-c', line], { cwd, env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: tempDir() }, stdio: 'pipe' });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

describe('LB-55.1: finish warns when the commit it links is linked to another task', () => {
  it('dev-2 commits and finishes in the folder, then dev-1 finishes there: the warning names LB-2; its fix relinks; a new commit: no warning', async () => {
    const { s, git } = await repo();
    git(['commit', '-q', '--allow-empty', '-m', 'work of dev-2']);
    const head = git(['rev-parse', 'HEAD']);
    expect((await run(s.root, 'dev-2', ['finish', 'LB-2', '--result', 'mine'])).doc.warnings).toEqual([]);
    const f = await run(s.root, 'dev-1', ['finish', 'LB-1', '--result', 'mine too']);
    expect(f.code).toBe(0);
    expect(f.doc.data.commit).toBe(head);
    const fix =
      `laneboard finish LB-1 --status done --commit <sha of your work> --result "<your result>" --as dev-1 --json && ` +
      `laneboard update LB-1 --remove-link commit=${head} --as dev-1 --json`;
    expect(f.doc.warnings).toEqual([
      `commit ${head.slice(0, 12)} is already linked to LB-2 of dev-2: if it holds the work of both, nothing to do; if it is not your work (HEAD of a folder where another agent committed), ` +
        `link the commit of yours instead: ${fix}`,
    ]);
    // Run blindly the fix changes nothing (--commit takes hex only); with the sha of the work it relinks.
    expect(sh(s.root, fix)).not.toBe(0);
    expect(links(s, 'LB-1')).toEqual([{ kind: 'commit', ref: head }]);
    git(['commit', '-q', '--allow-empty', '-m', 'work of dev-1']);
    const mine = git(['rev-parse', 'HEAD']);
    expect(sh(s.root, fix.replace('<sha of your work>', mine))).toBe(0);
    expect(links(s, 'LB-1')).toEqual([{ kind: 'commit', ref: mine }]);
  });

  it('a commit linked by hand as a short sha counts, an archived task too; a commit of its own only: no warning', async () => {
    const { s, git } = await repo();
    git(['commit', '-q', '--allow-empty', '-m', 'work']);
    const head = git(['rev-parse', 'HEAD']);
    expect((await run(s.root, 'orch', ['update', 'LB-2', '--add-link', `commit=${head.slice(0, 7)}`, '--status', 'done'])).code).toBe(0);
    expect((await run(s.root, 'orch', ['archive', 'LB-2'])).code).toBe(0);
    const f = await run(s.root, 'dev-1', ['finish', 'LB-1', '--status', 'review', '--result', 'mine']);
    expect(f.doc.warnings).toHaveLength(1);
    expect(f.doc.warnings[0]).toContain(`commit ${head.slice(0, 12)} is already linked to LB-2 of dev-2:`);
    // Finished again into the final status: the commit is LB-1's own link already, nothing new is linked, no warning.
    expect((await run(s.root, 'dev-1', ['finish', 'LB-1', '--result', 'closed'])).doc.warnings).toEqual([]);
  });
});

describe('LB-55.2, 55.3: finish in the main checkout with several worktrees that have commits since the claim', () => {
  it('one warning (not also "HEAD has not moved"), one exact command: run blindly it changes nothing, with the sha it relinks', async () => {
    const { s, git } = await repo();
    const trees = [path.join(tempDir(), 'wt-a'), path.join(tempDir(), 'wt-b')];
    for (const [i, wt] of trees.entries()) {
      git(['worktree', 'add', '-q', wt, '-b', `feat-${i}`]);
      gitIn(wt)(['commit', '-q', '--allow-empty', '-m', `work ${i}`]);
    }
    const work = gitIn(trees[0] ?? '')(['rev-parse', 'HEAD']);
    const mainHead = git(['rev-parse', 'HEAD']);
    const f = await run(s.root, 'dev-1', ['finish', 'LB-1', '--status', 'review', '--result', 'done']);
    expect(f.code).toBe(0);
    expect(f.doc.warnings).toHaveLength(1);
    expect(f.doc.warnings[0]).not.toContain('HEAD has not moved');
    const fix =
      `laneboard finish LB-1 --status review --commit <HEAD of your worktree> --result "<your result>" --as dev-1 --json && ` +
      `laneboard update LB-1 --remove-link commit=${mainHead} --as dev-1 --json`;
    expect(f.doc.warnings[0]).toContain(`if your work is in one of them, link the HEAD of yours (listed above) instead of this one: ${fix} (next time run finish in that folder`);
    expect(sh(s.root, fix)).not.toBe(0);
    expect(links(s, 'LB-1')).toEqual([{ kind: 'commit', ref: mainHead }]);
    expect(sh(s.root, fix.replace('<HEAD of your worktree>', work))).toBe(0);
    expect(links(s, 'LB-1')).toEqual([{ kind: 'commit', ref: work }]);
  });

  it('control: no commit in other worktrees since the claim, so HEAD older than the claim still gets "HEAD has not moved"', async () => {
    const { s } = await repo();
    const f = await run(s.root, 'dev-1', ['finish', 'LB-1', '--status', 'review', '--result', 'done']);
    expect(f.doc.warnings).toHaveLength(1);
    expect(f.doc.warnings[0]).toContain('HEAD has not moved since you claimed LB-1');
  });
});

describe('LB-65.9: no unused exports', () => {
  it('core exports no GIT_PROJECT_MARKERS (ReworkReturn: the @ts-expect-error import above fails typecheck once it is exported)', () => {
    expect(Object.keys(core)).not.toContain('GIT_PROJECT_MARKERS');
    expect(Object.keys(core)).toContain('PROJECT_MARKERS');
    const unused: ReworkReturn | undefined = undefined;
    expect(unused).toBeUndefined();
  });
});
