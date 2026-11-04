// S3c: review S3b r2. finish asks git itself (rev-parse, log, status with a timeout; no git, a timeout or an error: "could not
// check git", finish still works), the short forms of the rules live in agent-rules.md next to the full ones, the repeat finish that
// links a new commit no longer says "no changes", and the stale-commit check counts from the first session's claim across --resume.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agentRules, shortRuleForms } from '../../src/core/index.ts';
import type { TaskT } from '../../src/core/index.ts';
import { workStartedAt } from '../../src/core/ops/common.ts';
import { cleanupTemp, cli, CLI_SOURCE, newStore, readStore, spawnNode, tempDir, writeRaw } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

const BASE = 'claude-code@ann';
const SESSION_A = { LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: 'aaaa1111-1a1a-4a1a-8a1a-000000000001' };
const SESSION_B = { LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: 'bbbb2222-2b2b-4b2b-8b2b-000000000002' };
const NAME_A = `${BASE}:aaaa1111`;
const NAME_B = `${BASE}:bbbb2222`;

// git in `dir`, isolated from the user's config; `at`: the commit time (unix seconds) for commits.
function git(dir: string, args: string[], at?: number): string {
  const date = at === undefined ? {} : { GIT_COMMITTER_DATE: `@${at} +0000`, GIT_AUTHOR_DATE: `@${at} +0000` };
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...date };
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, env, encoding: 'utf8' }).trim();
}

// A repository in `dir` with app.txt committed at `at` (unix seconds); returns HEAD.
function repoWithFile(dir: string, at: number): string {
  git(dir, ['init', '-q']);
  fs.writeFileSync(path.join(dir, 'app.txt'), 'one\n');
  git(dir, ['add', 'app.txt']);
  git(dir, ['commit', '-q', '-m', 'first'], at);
  return git(dir, ['rev-parse', 'HEAD']);
}

// Unix seconds now.
const nowSec = (): number => Math.floor(Date.now() / 1000);

// The --json envelope of `finish LB-1` by `actor` (or the session default in `env`).
async function finish(s: TestStore, extra: string[] = ['--as', 'dev-1'], env: Record<string, string> = {}): Promise<{ data: Record<string, unknown>; warnings: string[] }> {
  const r = await cli(['finish', 'LB-1', '--result', 'done', ...extra, '--json'], { cwd: s.root, env });
  expect(r.code, r.stdout).toBe(0);
  return JSON.parse(r.stdout);
}

const dirtyWarning = (sha: string) =>
  `the working tree has uncommitted changes to tracked files, so the linked commit ${sha.slice(0, 12)} may not hold your work; commit your work and run laneboard finish LB-1 again to link the new commit (work without a commit: --no-commit)`;
const staleWarning = (sha: string) =>
  `the linked commit ${sha.slice(0, 12)} is from before your work: HEAD has not moved since you claimed LB-1; commit your work and run laneboard finish LB-1 again to link the new commit (work without a commit: --no-commit)`;

describe('review S3b MAJOR: finish asks git for the uncommitted work', () => {
  it('changes staged but not committed (a pre-commit hook refused the commit): the warning', async () => {
    const s = await newStore();
    await cli(['create', 'T', '--status', 'in_progress', '--assignee', 'dev-1', '--as', 'a', '--json'], { cwd: s.root });
    const head = repoWithFile(s.root, nowSec() + 5);
    fs.writeFileSync(path.join(s.root, 'app.txt'), 'two\n');
    git(s.root, ['add', 'app.txt']);
    const r = await finish(s);
    expect(r.data.commit).toBe(head);
    expect(r.warnings).toEqual([dirtyWarning(head)]);
  });

  it('a clean tree, also with a file touched under core.autocrlf: no warning', async () => {
    const s = await newStore();
    await cli(['create', 'T', '--status', 'in_progress', '--assignee', 'dev-1', '--as', 'a', '--json'], { cwd: s.root });
    const head = repoWithFile(s.root, nowSec() + 5);
    git(s.root, ['config', 'core.autocrlf', 'true']);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(s.root, 'app.txt'), later, later);
    expect(git(s.root, ['status', '--porcelain', '-uno'])).toBe('');
    const r = await finish(s);
    expect(r).toMatchObject({ data: { commit: head, status: 'done' }, warnings: [] });
  });

  it('no git in PATH: finish works, links nothing and says git could not be checked', async () => {
    const s = await newStore();
    await cli(['create', 'T', '--status', 'in_progress', '--assignee', 'dev-1', '--as', 'a', '--json'], { cwd: s.root });
    repoWithFile(s.root, nowSec());
    const r = await spawnNode([CLI_SOURCE, 'finish', 'LB-1', '--result', 'done', '--as', 'dev-1', '--json'], { cwd: s.root, env: { PATH: '', HOME: tempDir() } });
    expect(r.code, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.data).toEqual({ id: 'LB-1', rev: 2, status: 'done', assignee: 'dev-1', commit: null });
    expect(doc.warnings).toEqual(['could not check git (git not found in PATH): no commit linked']);
  });

  // A stand-in `git` in a folder of its own: the PATH of the CLI child names only it.
  function fakeGit(script: string): string {
    const bin = tempDir();
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return bin;
  }

  it('git does not answer in time: finish works after the timeout, links nothing, warns', async () => {
    const s = await newStore();
    await cli(['create', 'T', '--status', 'in_progress', '--assignee', 'dev-1', '--as', 'a', '--json'], { cwd: s.root });
    const bin = fakeGit('exec /bin/sleep 10');
    const started = Date.now();
    const r = await spawnNode([CLI_SOURCE, 'finish', 'LB-1', '--result', 'done', '--as', 'dev-1', '--json'], { cwd: s.root, env: { PATH: bin, HOME: tempDir() } });
    expect(Date.now() - started).toBeLessThan(8000);
    expect(r.code, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.data).toMatchObject({ status: 'done', commit: null });
    expect(doc.warnings).toEqual(['could not check git (git did not answer in 2 s): no commit linked']);
  }, 15_000);

  it('HEAD known but git status fails: the commit is linked, the check is named as skipped', async () => {
    const s = await newStore();
    await cli(['create', 'T', '--status', 'in_progress', '--assignee', 'dev-1', '--as', 'a', '--json'], { cwd: s.root });
    const sha = 'c'.repeat(40);
    const bin = fakeGit(`case "$4" in rev-parse) echo ${sha} ;; log) echo 9999999999 ;; *) echo "fatal: index file corrupt" >&2; exit 128 ;; esac`);
    const r = await spawnNode([CLI_SOURCE, 'finish', 'LB-1', '--result', 'done', '--as', 'dev-1', '--json'], { cwd: s.root, env: { PATH: bin, HOME: tempDir() } });
    expect(r.code, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.data).toMatchObject({ status: 'done', commit: sha });
    expect(doc.warnings).toEqual([`could not check git (git status: fatal: index file corrupt): not checked whether the linked commit ${sha.slice(0, 12)} holds your work`]);
  });

  it('another git failure before HEAD (not "not a repository"): no link, the reason in the warning', async () => {
    const s = await newStore();
    await cli(['create', 'T', '--status', 'in_progress', '--assignee', 'dev-1', '--as', 'a', '--json'], { cwd: s.root });
    const bin = fakeGit(`echo "fatal: detected dubious ownership in repository at '/x'" >&2; exit 128`);
    const r = await spawnNode([CLI_SOURCE, 'finish', 'LB-1', '--result', 'done', '--as', 'dev-1', '--json'], { cwd: s.root, env: { PATH: bin, HOME: tempDir() } });
    expect(JSON.parse(r.stdout).warnings).toEqual(["could not check git (git rev-parse: fatal: detected dubious ownership in repository at '/x'): no commit linked"]);
  });

  it('outside a repository and before the first commit: no link and no warning', async () => {
    const s = await newStore();
    await cli(['create', 'T', '--status', 'in_progress', '--assignee', 'dev-1', '--as', 'a', '--json'], { cwd: s.root });
    await cli(['create', 'U', '--status', 'in_progress', '--assignee', 'dev-1', '--as', 'a', '--json'], { cwd: s.root });
    expect(await finish(s)).toMatchObject({ data: { commit: null }, warnings: [] });
    git(s.root, ['init', '-q']);
    const r = JSON.parse((await cli(['finish', 'LB-2', '--result', 'done', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout);
    expect(r).toMatchObject({ data: { commit: null }, warnings: [] });
  });
});

describe('review S3b MAJOR: the short forms of the rules live in agent-rules.md next to the full ones', () => {
  const full = new Map(agentRules().split('\n').map((l) => [/^(\d+)\. /.exec(l)?.[1] ?? '', l] as const));
  // Flags and error codes / variables (REV_CONFLICT, UNKNOWN_*, LANEBOARD_DIR): what an agent copies, so a short form keeps them all.
  const terms = (text: string): Set<string> => new Set(text.match(/--[a-z][a-z-]*|\b[A-Z]+_[A-Z_]*\*?/g) ?? []);
  // Backticked code of a short form, split into words: each word is in the full rule (nothing invented).
  const codeWords = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].flatMap((m) => (m[1] ?? '').split(/[\s=;]+/)).filter(Boolean);

  it('one short form per rule number, never the whole rules, and not in the text of the skill, MCP or prime', () => {
    const forms = shortRuleForms();
    // S4: rule 7 got a short form (its acceptance sentence did not fit the prime grid).
    expect(forms.map((f) => f.n)).toEqual(['3', '4', '5', '6', '7', '8', '9', '11', '12', '14']);
    expect(agentRules()).not.toContain('short forms');
    expect(agentRules().split('\n').at(-1)?.startsWith('14. ')).toBe(true);
  });

  for (const form of shortRuleForms()) {
    it(`rule ${form.n}: written for the current full rule (hash), shorter, the same flags and codes, no invented code`, () => {
      const rule = full.get(form.n) ?? '';
      const hash = crypto.createHash('sha256').update(rule).digest('hex').slice(0, 8);
      expect(form.hash, `rule ${form.n} changed: re-read its short form in agent-rules.md so it says the same, then put hash ${hash}`).toBe(hash);
      expect(`${form.n}. ${form.text}`.length).toBeLessThan(rule.length);
      expect([...terms(rule)].filter((t) => !terms(form.text).has(t)), 'flags and codes of the full rule missing').toEqual([]);
      expect([...terms(form.text)].filter((t) => !terms(rule).has(t)), 'flags and codes the full rule does not have').toEqual([]);
      expect(codeWords(form.text).filter((w) => !rule.includes(w)), 'code words the full rule does not have').toEqual([]);
    });
  }
});

describe('review S3b MINOR: a repeat finish that links a new commit says so', () => {
  it('JSON warning: status and result unchanged, the new commit linked; with nothing new: no changes', async () => {
    const s = await newStore();
    await cli(['create', 'T', '--status', 'in_progress', '--assignee', 'dev-1', '--as', 'a', '--json'], { cwd: s.root });
    repoWithFile(s.root, nowSec() + 5);
    expect((await finish(s)).warnings).toEqual([]);
    fs.writeFileSync(path.join(s.root, 'app.txt'), 'two\n');
    git(s.root, ['commit', '-q', '-am', 'second'], nowSec() + 6);
    const second = git(s.root, ['rev-parse', 'HEAD']);
    const again = await finish(s);
    expect(again.data).toMatchObject({ rev: 3, commit: second });
    expect(again.warnings).toEqual([`status and result unchanged: LB-1 is already done; the result was not recorded (add it with laneboard comment LB-1 "<text>"); commit ${second.slice(0, 12)} linked`]);
    const third = await finish(s);
    expect(third.data.rev).toBe(3);
    expect(third.warnings).toEqual(['no changes: LB-1 is already done; the result was not recorded (add it with laneboard comment LB-1 "<text>")']);
  });
});

describe('review S3b MINOR: after claim --resume the stale check counts from the first session claim', () => {
  // Session A claims LB-1, its events are moved 100 s back (A worked a while ago), then session B resumes it now.
  async function resumedTask(): Promise<{ s: TestStore; claimedA: number }> {
    const s = await newStore();
    await cli(['create', 'Fix cart total', '--status', 'todo', '--json'], { cwd: s.root, env: SESSION_A });
    await cli(['claim', 'LB-1', '--status', 'in_progress', '--json'], { cwd: s.root, env: SESSION_A });
    const claimedA = nowSec() - 100;
    const file = path.join(s.dir, 'active.json');
    const doc = readStore(s.dir, 'active');
    const task = doc.tasks[0] as unknown as TaskT;
    for (const e of task.events) e.at = new Date(claimedA * 1000).toISOString();
    writeRaw(file, JSON.stringify(doc, null, 2));
    return { s, claimedA };
  }

  it("session A's commit after its claim is the work: no warning after B resumed", async () => {
    const { s, claimedA } = await resumedTask();
    const head = repoWithFile(s.root, claimedA + 50);
    const resumed = JSON.parse((await cli(['claim', 'LB-1', '--resume', '--json'], { cwd: s.root, env: SESSION_B })).stdout);
    expect(resumed.data).toMatchObject({ assignee: NAME_B, resumed_from: NAME_A });
    const r = await finish(s, [], SESSION_B);
    expect(r).toMatchObject({ data: { commit: head, assignee: NAME_B }, warnings: [] });
  });

  it('a commit from before session A claimed: still the warning', async () => {
    const { s, claimedA } = await resumedTask();
    const head = repoWithFile(s.root, claimedA - 50);
    await cli(['claim', 'LB-1', '--resume', '--json'], { cwd: s.root, env: SESSION_B });
    expect((await finish(s, [], SESSION_B)).warnings).toEqual([staleWarning(head)]);
  });

  it('workStartedAt: back through resumed assignments to the first; a plain handover or another holder starts anew', () => {
    const ev = (type: string, at: string, data: Record<string, unknown>) => ({ type, at, actor: 'x', data });
    const task = (assignee: string | null, events: unknown[]) => ({ assignee, events }) as unknown as TaskT;
    const chain = [ev('created', 't0', { assignee: null }), ev('assigned', 't1', { from: null, to: 'a' }), ev('status', 't2', {}), ev('assigned', 't3', { from: 'a', to: 'b', resumed: true }), ev('assigned', 't4', { from: 'b', to: 'c', resumed: true })];
    expect(workStartedAt(task('c', chain))).toBe('t1');
    expect(workStartedAt(task('c', [...chain.slice(0, 3), ev('assigned', 't3', { from: 'a', to: 'b' }), chain[4]]))).toBe('t3');
    expect(workStartedAt(task('a', [ev('created', 't0', { assignee: 'a' })]))).toBe('t0');
    expect(workStartedAt(task('b', [ev('created', 't0', { assignee: 'a' })]))).toBeUndefined();
    expect(workStartedAt(task(null, chain))).toBeUndefined();
  });
});
