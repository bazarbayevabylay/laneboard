// S3: finish a task in one command (result comment, commit link, final status) and claim --resume of the agent's own task from
// before /clear (another session id of the same default name base); review S2g: the free-task footer, the session line, one order of ways.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { archiveTasks, claimTask, createTask, finishTask, gitHead, isEarlierSessionName } from '../../src/core/index.ts';
import { primeText } from '../../src/cli/format.ts';
import type { PrimeData } from '../../src/cli/format.ts';
import { callTool } from '../../src/mcp/tools.ts';
import { as, cleanupTemp, cli, newStore, readStore, rejectsWith, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

const BASE = 'claude-code@ann';
// Two Claude Code sessions of one user: the first one before /clear, the second one after it (or a parallel session).
const SESSION_A = { LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: 'aaaa1111-1a1a-4a1a-8a1a-000000000001' };
const SESSION_B = { LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: 'bbbb2222-2b2b-4b2b-8b2b-000000000002' };
const NAME_A = `${BASE}:aaaa1111`;
const NAME_B = `${BASE}:bbbb2222`;

// A real git repository in `dir` with one empty commit (isolated from the user's git config); returns HEAD.
function gitRepo(dir: string): string {
  const home = tempDir();
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, env, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  return git('rev-parse', 'HEAD');
}

// The task as stored (events with their data).
function stored(s: TestStore, id: string): { rev: number; status: string; assignee: string | null; links: unknown[]; events: Array<{ type: string; actor: string; data: Record<string, unknown> }> } {
  const task = readStore(s.dir, 'active').tasks.find((t) => t.id === id);
  if (!task) throw new Error(`${id} not in active.json`);
  return task as never;
}

describe('git HEAD read from the repository files (git is not run)', () => {
  const sha = 'a'.repeat(40);
  const other = 'b'.repeat(40);

  it('loose ref, packed ref, detached HEAD, a worktree (.git file + commondir); none outside a repository or before the first commit', () => {
    const root = tempDir();
    const gitDir = path.join(root, '.git');
    fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    // Before the first commit the branch has no ref.
    expect(gitHead(root)).toBeUndefined();
    fs.writeFileSync(path.join(gitDir, 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${other} refs/heads/other\n${sha} refs/heads/main\n`);
    expect(gitHead(path.join(root, 'sub', 'dir'))).toBe(sha);
    // A loose ref wins over the packed one.
    fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), `${other}\n`);
    expect(gitHead(root)).toBe(other);
    fs.writeFileSync(path.join(gitDir, 'HEAD'), `${sha}\n`);
    expect(gitHead(root)).toBe(sha);
    // A worktree: HEAD in .git/worktrees/<name>, branches in the main repository.
    const wt = path.join(root, 'wt');
    fs.mkdirSync(path.join(gitDir, 'worktrees', 'wt'), { recursive: true });
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(gitDir, 'worktrees', 'wt')}\n`);
    fs.writeFileSync(path.join(gitDir, 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(gitDir, 'worktrees', 'wt', 'commondir'), '../..\n');
    expect(gitHead(wt)).toBe(other);
    expect(gitHead(tempDir())).toBeUndefined();
  });

  it('matches git rev-parse HEAD in a real repository', () => {
    const root = tempDir();
    const head = gitRepo(root);
    expect(gitHead(root)).toBe(head);
  });
});

describe('laneboard finish', () => {
  it('one write: the result comment, the commit link, then the final status; short reply with the commit; no --expected-rev', async () => {
    const s = await newStore();
    const head = gitRepo(s.root);
    await createTask(as(s, 'a'), { title: 'Fix login', status: 'todo' });
    await claimTask(as(s, 'dev-1'), { id: 'LB-1', status: 'in_progress' });
    const r = await cli(['finish', 'LB-1', '--result', 'Fixed, tests green', '--as', 'dev-1', '--json'], { cwd: s.root });
    expect(r.code, r.stdout).toBe(0);
    expect(JSON.parse(r.stdout).data).toEqual({ id: 'LB-1', rev: 3, status: 'done', assignee: 'dev-1', commit: head });
    const t = stored(s, 'LB-1');
    expect(t.links).toEqual([{ kind: 'commit', ref: head }]);
    // The result comes before the status change, all at the same time (one write, one rev).
    expect(t.events.slice(-3).map((e) => [e.type, e.data])).toEqual([
      ['commented', { text: 'Fixed, tests green' }],
      ['updated', { links: [[], [{ kind: 'commit', ref: head }]] }],
      ['status', { from: 'in_progress', to: 'done' }],
    ]);
    const human = await cli(['get', 'LB-1'], { cwd: s.root });
    expect(human.stdout).toContain('dev-1  commented  Fixed, tests green');
  });

  it('human line names the linked commit; the same commit is not linked twice; --no-commit and a folder outside git link none', async () => {
    const s = await newStore();
    const head = gitRepo(s.root);
    await createTask(as(s, 'a'), { title: 'One', status: 'todo', assignee: 'dev-1', links: [{ kind: 'commit', ref: head }] });
    await createTask(as(s, 'a'), { title: 'Two', status: 'todo', assignee: 'dev-1' });
    const one = await cli(['finish', 'LB-1', '--result', 'done', '--as', 'dev-1'], { cwd: s.root });
    expect(one.stdout).toBe(`LB-1 finished (rev 2, done, dev-1); commit ${head.slice(0, 12)} linked\n`);
    expect(stored(s, 'LB-1').links).toEqual([{ kind: 'commit', ref: head }]);
    expect(stored(s, 'LB-1').events.map((e) => e.type)).toEqual(['created', 'commented', 'status']);
    const two = await cli(['finish', 'LB-2', '--result', 'done', '--no-commit', '--as', 'dev-1', '--json'], { cwd: s.root });
    expect(JSON.parse(two.stdout).data).toMatchObject({ status: 'done', commit: null });
    expect(stored(s, 'LB-2').links).toEqual([]);
    const plain = await newStore();
    await createTask(as(plain, 'a'), { title: 'No git', status: 'todo' });
    const outside = await cli(['finish', 'LB-1', '--result', 'done', '--as', 'dev-1'], { cwd: plain.root });
    expect(outside.stdout).toBe('LB-1 finished (rev 2, done, dev-1); no commit linked\n');
  });

  it('an unassigned task: the finisher becomes its assignee (before the status event)', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Free', status: 'todo' });
    const r = await finishTask(as(s, 'dev-2', { cwd: s.root }), { id: 'LB-1', result: 'done' });
    expect(r.data).toMatchObject({ assignee: 'dev-2', status: 'done', rev: 2 });
    expect(r.reply).toEqual({ commit: null });
    expect(stored(s, 'LB-1').events.slice(-3).map((e) => [e.type, e.data])).toEqual([
      ['commented', { text: 'done' }],
      ['assigned', { from: null, to: 'dev-2' }],
      ['status', { from: 'todo', to: 'done' }],
    ]);
  });

  it("somebody else's task: ALREADY_CLAIMED with the comment fix, nothing written; an earlier session of the default name: the message names --resume", async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Theirs', status: 'in_progress', assignee: 'dev-1' });
    const before = fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8');
    const r = JSON.parse((await cli(['finish', 'LB-1', '--result', 'x', '--as', 'dev-2', '--json'], { cwd: s.root })).stdout);
    expect(r.error).toMatchObject({ code: 'ALREADY_CLAIMED', details: { assignee: 'dev-1' }, fix: 'laneboard comment LB-1 "<note for dev-1>" --as dev-2' });
    expect(r.error.message).not.toContain('--resume');
    expect(fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8')).toBe(before);
    await createTask(as(s, NAME_A, { actorSource: 'default' }), { title: 'Mine before /clear', status: 'in_progress', assignee: NAME_A });
    const mine = JSON.parse((await cli(['finish', 'LB-2', '--result', 'x', '--json'], { cwd: s.root, env: SESSION_B })).stdout);
    expect(mine.error.code).toBe('ALREADY_CLAIMED');
    expect(mine.error.message).toContain(`${NAME_A} is your default name in another session (before /clear, or a parallel session). Only if you did this task yourself and it matches your current request: laneboard claim LB-2 --resume; otherwise leave it`);
    expect(mine.error.fix).toBe(`laneboard comment LB-2 "<note for ${NAME_A}>" --as ${NAME_B}`);
  });

  it('a task already in the final status: unchanged, with a warning that the result was not recorded (exit 0)', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Done', status: 'done', assignee: 'dev-1' });
    const r = await cli(['finish', 'LB-1', '--result', 'again', '--as', 'dev-1', '--json'], { cwd: s.root });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.data).toEqual({ id: 'LB-1', rev: 1, status: 'done', assignee: 'dev-1' });
    expect(doc.warnings).toEqual(['no changes: LB-1 is already done; the result was not recorded (add it with laneboard comment LB-1 "<text>")']);
    expect(stored(s, 'LB-1').rev).toBe(1);
  });

  it('--status must be a final status (the fix names it); unknown status, missing --result, archived task fail as elsewhere', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'T', status: 'todo', assignee: 'dev-1' });
    const review = JSON.parse((await cli(['finish', 'LB-1', '--result', 'x', '--status', 'review', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout);
    expect(review.error).toMatchObject({ code: 'INVALID_VALUE', allowed: ['done'], fix: "laneboard finish LB-1 --result x --status done --as dev-1 --json" });
    expect(review.error.message).toBe('"review" is not a final status; finish sets done (other statuses: laneboard update LB-1 --status <status>)');
    expect((await cli(['finish', 'LB-1', '--result', 'x', '--status', 'done', '--as', 'dev-1'], { cwd: s.root })).code).toBe(0);
    await createTask(as(s, 'a'), { title: 'U', status: 'todo' });
    expect(JSON.parse((await cli(['finish', 'LB-2', '--result', 'x', '--status', 'doing', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout).error.code).toBe('UNKNOWN_STATUS');
    const missing = JSON.parse((await cli(['finish', 'LB-2', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout).error;
    expect(missing).toMatchObject({ code: 'USAGE', message: '--result is required' });
    expect(JSON.parse((await cli(['finish', 'LB-2', '--result', '  ', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout).error.code).toBe('INVALID_VALUE');
    await archiveTasks(as(s, 'a'), { ids: ['LB-2'] });
    expect(JSON.parse((await cli(['finish', 'LB-2', '--result', 'x', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout).error.code).toBe('TASK_ARCHIVED');
  });

  it('MCP task_finish: the commit of the server folder, no_commit, the same errors as the CLI', async () => {
    const s = await newStore();
    const head = gitRepo(s.root);
    await createTask(as(s, 'a'), { title: 'A', status: 'in_progress', assignee: 'm' });
    await createTask(as(s, 'a'), { title: 'B', status: 'in_progress', assignee: 'm' });
    const env = { cwd: s.root, env: {} };
    expect((await callTool('task_finish', { id: 'LB-1', result: 'done', actor: 'm' }, env)).structuredContent).toEqual({ id: 'LB-1', rev: 2, status: 'done', assignee: 'm', commit: head });
    expect((await callTool('task_finish', { id: 'LB-2', result: 'done', no_commit: true, actor: 'm' }, env)).structuredContent).toMatchObject({ commit: null });
    expect(stored(s, 'LB-2').links).toEqual([]);
    await createTask(as(s, 'a'), { title: 'C', status: 'todo', assignee: 'dev-1' });
    const taken = await callTool('task_finish', { id: 'LB-3', result: 'x', actor: 'm' }, env);
    expect(taken.isError).toBe(true);
    expect(taken.structuredContent).toMatchObject({ code: 'ALREADY_CLAIMED', fix: 'laneboard comment LB-3 "<note for dev-1>" --as m' });
    expect((await callTool('task_finish', { id: 'LB-3', result: 'x', expected_rev: 1, actor: 'dev-1' }, env)).structuredContent).toMatchObject({ code: 'USAGE' });
  });
});

describe('claim --resume (after /clear the session default name changes)', () => {
  it('isEarlierSessionName: the same base and a session part only; never the actor itself, another user or an explicit name', () => {
    expect(isEarlierSessionName(NAME_A, BASE, NAME_B)).toBe(true);
    expect(isEarlierSessionName(NAME_B, BASE, NAME_B)).toBe(false);
    expect(isEarlierSessionName('claude-code@bob:aaaa1111', BASE, NAME_B)).toBe(false);
    expect(isEarlierSessionName('claude-code@ann2:aaaa1111', BASE, NAME_B)).toBe(false);
    expect(isEarlierSessionName(BASE, BASE, NAME_B)).toBe(false);
    expect(isEarlierSessionName(`${BASE}:aaaa1111:x`, BASE, NAME_B)).toBe(false);
    expect(isEarlierSessionName('dev-1', BASE, NAME_B)).toBe(false);
    expect(isEarlierSessionName(NAME_A, undefined, 'dev-2')).toBe(false);
  });

  it('session A works on a task, a new session B sees it in prime with its age and takes it with claim --resume ("resumed from")', async () => {
    const s = await newStore();
    const run = (argv: string[], env: Record<string, string>) => cli(argv, { cwd: s.root, env });
    expect((await run(['create', 'Fix cart total', '--status', 'todo', '--assignee', NAME_A, '--json'], SESSION_A)).code).toBe(0);
    expect((await run(['claim', 'LB-1', '--status', 'in_progress', '--json'], SESSION_A)).code).toBe(0);
    // Not listed: a finished task of session A, a task of another user, an explicit name's task.
    await createTask(as(s, NAME_A), { title: 'Old done', status: 'done', assignee: NAME_A });
    await createTask(as(s, 'a'), { title: 'Bob', status: 'in_progress', assignee: 'claude-code@bob:cccc3333' });
    await createTask(as(s, 'a'), { title: 'Dev', status: 'in_progress', assignee: 'dev-1' });
    const prime = (await run(['prime'], SESSION_B)).stdout;
    expect(prime).toContain(
      'You have no task in progress. Start one the first way that fits:\n1. The request names a task id: laneboard claim <ID> --json\n' +
        '2. Your own task from before /clear (below) fits the request: laneboard claim <ID> --resume --json\n3. Otherwise create one:\n',
    );
    expect(prime).toContain(
      '\nYour earlier sessions, unfinished (a parallel session of yours has the same name: resume only your own):\n  LB-1  [in_progress]  <1m ago  session aaaa1111  Fix cart total\n',
    );
    expect(prime).not.toMatch(/Old done|Bob|  Dev/);
    expect(JSON.parse((await run(['prime', '--json'], SESSION_B)).stdout).data).toMatchObject({ session_base: BASE, resumable: [{ id: 'LB-1', assignee: NAME_A }] });
    // Session A itself (or an explicit name) gets no such section.
    expect((await run(['prime'], SESSION_A)).stdout).not.toContain('Your earlier sessions');
    expect((await run(['prime', '--as', 'dev-2'], SESSION_B)).stdout).not.toContain('Your earlier sessions');

    const r = await run(['claim', 'LB-1', '--resume'], SESSION_B);
    expect(r.stdout).toBe(`LB-1 resumed from ${NAME_A} (rev 3, in_progress, ${NAME_B})\n`);
    const t = stored(s, 'LB-1');
    expect(t.events.at(-1)).toMatchObject({ type: 'assigned', actor: NAME_B, actor_source: 'default', data: { from: NAME_A, to: NAME_B, resumed: true } });
    expect((await run(['get', 'LB-1'], SESSION_B)).stdout).toContain(`${NAME_B} (default name)  assigned  resumed from ${NAME_A} to=${NAME_B}`);
    // Now it is session B's own task: prime lists it there, the resume section is gone.
    const after = (await run(['prime'], SESSION_B)).stdout;
    expect(after).toContain(`Your active tasks (${NAME_B}), newest update first:\n  LB-1  [in_progress]  rev 3  Fix cart total`);
    expect(after).not.toContain('Your earlier sessions');
  });

  it('--json reply names resumed_from; without --resume ALREADY_CLAIMED names --resume in the message, never in the fix', async () => {
    const s = await newStore();
    await createTask(as(s, NAME_A, { actorSource: 'default' }), { title: 'Mine', status: 'in_progress', assignee: NAME_A });
    const plain = JSON.parse((await cli(['claim', 'LB-1', '--json'], { cwd: s.root, env: SESSION_B })).stdout);
    expect(plain.error.code).toBe('ALREADY_CLAIMED');
    expect(plain.error.message).toContain('laneboard claim LB-1 --resume');
    expect(plain.error.fix).not.toContain('--resume');
    const r = JSON.parse((await cli(['claim', 'LB-1', '--resume', '--json'], { cwd: s.root, env: SESSION_B })).stdout);
    expect(r.data).toEqual({ id: 'LB-1', rev: 2, status: 'in_progress', assignee: NAME_B, resumed_from: NAME_A });
    // On a free task or an own one --resume is a plain claim.
    await createTask(as(s, 'a'), { title: 'Free', status: 'todo' });
    expect(JSON.parse((await cli(['claim', 'LB-2', '--resume', '--json'], { cwd: s.root, env: SESSION_B })).stdout).data).toEqual({ id: 'LB-2', rev: 2, status: 'todo', assignee: NAME_B });
    expect(stored(s, 'LB-2').events.at(-1)?.data).toEqual({ from: null, to: NAME_B });
  });

  it('refused: an explicit holder, another user, an explicit actor; nothing written', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Dev', status: 'in_progress', assignee: 'dev-1' });
    await createTask(as(s, 'a'), { title: 'Bob', status: 'in_progress', assignee: 'claude-code@bob:aaaa1111' });
    await createTask(as(s, 'a'), { title: 'Ann', status: 'in_progress', assignee: NAME_A });
    const before = fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8');
    const err = async (argv: string[], env: Record<string, string>) => JSON.parse((await cli([...argv, '--json'], { cwd: s.root, env })).stdout).error;
    for (const id of ['LB-1', 'LB-2']) {
      const e = await err(['claim', id, '--resume'], SESSION_B);
      expect(e.code).toBe('ALREADY_CLAIMED');
      expect(e.message).toContain(`--resume takes over only a default name ${BASE}:<other session>, and `);
    }
    const explicit = await err(['claim', 'LB-3', '--resume', '--as', 'dev-2'], SESSION_B);
    expect(explicit).toMatchObject({ code: 'ALREADY_CLAIMED', fix: `laneboard comment LB-3 "<note for ${NAME_A}>" --as dev-2` });
    expect(explicit.message).toContain('--resume takes over only a task of an earlier session of the session default name, and you write as dev-2');
    // Without a session id there is no earlier session either.
    const noSession = await err(['claim', 'LB-3', '--resume'], { LANEBOARD_DEFAULT_AGENT: BASE });
    expect(noSession.code).toBe('ALREADY_CLAIMED');
    expect(fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8')).toBe(before);
    await rejectsWith(claimTask(as(s, NAME_B, { actorSource: 'default', sessionBase: BASE }), { id: 'LB-2', resume: true }), 'ALREADY_CLAIMED');
  });

  it('at the size limit (long store path, long board description) the newest earlier-session task is still listed', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Add discount to total()', status: 'in_progress', assignee: NAME_A });
    await createTask(as(s, 'a'), { title: 'Newest work', status: 'in_progress', assignee: NAME_A });
    const data = JSON.parse((await cli(['prime', '--json'], { cwd: s.root, env: SESSION_B })).stdout).data as PrimeData;
    const text = primeText({ ...data, store: `/${'p'.repeat(150)}/.laneboard`, name: 'n'.repeat(60), description: 'd'.repeat(200) });
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain('  LB-2  [in_progress]  <1m ago  session aaaa1111  Newest work\n... 1 more not shown');
  });

  it('MCP task_claim resume: true under the server session default name', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Ann', status: 'in_progress', assignee: NAME_A });
    const r = await callTool('task_claim', { id: 'LB-1', resume: true }, { cwd: s.root, env: SESSION_B });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ id: 'LB-1', rev: 2, status: 'in_progress', assignee: NAME_B, resumed_from: NAME_A });
  });

  it("no resume section or command under a warning that the store looks like another project's", async () => {
    const parent = await newStore();
    await createTask(as(parent, 'a'), { title: 'Ann', status: 'in_progress', assignee: NAME_A });
    const nested = path.join(parent.root, 'nested');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'CLAUDE.md'), '# nested project\n');
    const data = JSON.parse((await cli(['prime', '--json'], { cwd: nested, env: SESSION_B })).stdout).data as PrimeData;
    // The summary still finds the task; the text (checked with a short store path, so nothing is cut) offers no resume.
    expect(data.store_warning).toContain('looks like a separate project');
    expect(data.resumable.map((t) => t.id)).toEqual(['LB-1']);
    const text = primeText({ ...data, store: '/p/.laneboard', store_warning: 'the store looks like another project' });
    expect(text).toContain("You have no task in progress. The store above looks like another project's");
    expect(text).not.toContain('Your earlier sessions');
    expect(text).not.toContain('--resume --json');
    // Without the warning the same data offers it.
    expect(primeText({ ...data, store: '/p/.laneboard', store_warning: null })).toContain('Your earlier sessions');
  });
});

describe('review S2g: the free-task footer command shows exactly the tasks it counts', () => {
  it('a free task in the final status is neither counted nor listed by the footer command', async () => {
    const s = await newStore();
    for (let i = 1; i <= 12; i++) await createTask(as(s, 'a'), { title: `Task ${i}`, status: 'todo' });
    await createTask(as(s, 'a'), { title: 'Done free', status: 'done' });
    const out = (await cli(['prime', '--as', 'dev-1'], { cwd: s.root })).stdout;
    const footer = /\n\.\.\. (\d+) more: laneboard (list .*)\n$/.exec(out);
    expect(footer?.[1]).toBe('2');
    const argv = (footer?.[2] ?? '').split(' ');
    const listed = JSON.parse((await cli(argv, { cwd: s.root })).stdout).data;
    // The footer counts what prime did not show: 10 shown + 2 more = what the command lists.
    expect(listed.total).toBe(12);
    expect(listed.items.map((t: { title: string }) => t.title)).not.toContain('Done free');
  });
});
