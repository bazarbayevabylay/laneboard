// S6h: git worktrees and finish (A18, LB-1, B-U4; CARRYOVER S6h). A linked worktree (`git worktree add ../wt`) finds the board of
// its main checkout through the `.git` file and the repository's commondir; setup keeps its exclude block in the common git directory;
// finish links the commit the caller names (--commit, MCP commit) or HEAD of the folder it names (MCP cwd), and in the main checkout
// warns when other worktrees have commits since the claim, naming the folder, its HEAD and the fix. A task handed in again into
// the same status records the new result; the same result again (a retry) records nothing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { callTool, toolListing, TOOLS } from '../../src/mcp/tools.ts';
import { cleanupTemp, cli, newStore, otherWarnings, readStore, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

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

const LONG_AGO = '2020-01-01T00:00:00Z';

interface Repo {
  s: TestStore;
  main: string;
  wt: string;
  git: (args: string[], date?: string) => string;
  wtGit: (args: string[], date?: string) => string;
}

// A board in the main checkout of a git repository (first commit long ago, the board not committed) and a linked worktree outside
// the project tree on branch feat (`git worktree add ../wt -b feat`).
async function repoWithWorktree(): Promise<Repo> {
  const s = await newStore();
  const git = gitIn(s.root);
  git(['init', '-q', '-b', 'main']);
  git(['commit', '-q', '--allow-empty', '-m', 'first'], LONG_AGO);
  const wt = path.join(tempDir(), 'wt');
  git(['worktree', 'add', '-q', wt, '-b', 'feat']);
  return { s, main: s.root, wt, git, wtGit: gitIn(wt) };
}

// Run the CLI with --json in `cwd`; exit code and the parsed envelope.
async function json(cwd: string, argv: string[], env: Record<string, string> = {}): Promise<{ code: number; doc: Record<string, any> }> {
  const r = await cli([...argv, '--json'], { cwd, env });
  return { code: r.code, doc: JSON.parse(r.stdout) };
}

// The task as stored.
function stored(s: TestStore, id: string): { rev: number; status: string; links: unknown[]; events: Array<{ type: string; actor: string; data: Record<string, unknown> }> } {
  const task = readStore(s.dir, 'active').tasks.find((t) => t.id === id);
  if (!task) throw new Error(`${id} not in active.json`);
  return task as never;
}

// One task LB-1 claimed by dev-1 into in_progress (now: after the first commit of the repository).
async function claimed(r: Repo): Promise<void> {
  expect((await json(r.main, ['create', 'Work', '--status', 'todo', '--as', 'dev-1'])).code).toBe(0);
  expect((await json(r.main, ['claim', 'LB-1', '--status', 'in_progress', '--as', 'dev-1'])).code).toBe(0);
}

// The worktree warning of finish in the main checkout (A18, B-U4).
function worktreeWarnings(doc: Record<string, any>): string[] {
  return (doc.warnings as string[]).filter((w) => w.includes('the main checkout'));
}

describe('A18: a linked git worktree outside the project tree uses the board of its main checkout', () => {
  it('prime --hook, list and a write in the worktree and its subfolder: the main board, no warning; no board in main: STORE_NOT_FOUND', async () => {
    const r = await repoWithWorktree();
    const sub = path.join(r.wt, 'src', 'deep');
    fs.mkdirSync(sub, { recursive: true });
    for (const cwd of [r.wt, sub]) {
      const hook = await cli(['prime', '--hook'], { cwd, env: { LANEBOARD_AGENT: 'dev-w' } });
      expect(hook.code, cwd).toBe(0);
      expect(hook.stdout, cwd).toContain(r.s.dir);
      expect(hook.stdout, cwd).not.toContain('no board found');
      const list = await json(cwd, ['list']);
      expect(list.doc, cwd).toMatchObject({ ok: true, store: r.s.dir, warnings: [] });
    }
    expect((await json(sub, ['create', 'From the worktree', '--status', 'todo', '--as', 'dev-w'])).doc.store).toBe(r.s.dir);
    expect(readStore(r.s.dir, 'active').tasks.map((t) => t.title)).toEqual(['From the worktree']);
    fs.rmSync(r.s.dir, { recursive: true });
    expect((await json(r.wt, ['list'])).doc.error.code).toBe('STORE_NOT_FOUND');
  });

  it('a store inside the worktree comes first; a store above the worktree gives way to the main checkout', async () => {
    const r = await repoWithWorktree();
    // An unrelated board in the folder that holds the worktree: walking up alone would find it (behind the .git marker).
    expect((await json(path.dirname(r.wt), ['init', '--name', 'above', '--prefix', 'ABV', '--description', 'another project'], { HOME: tempDir() })).code).toBe(0);
    expect((await json(r.wt, ['list'])).doc).toMatchObject({ store: r.s.dir, warnings: [] });
    // A board of the worktree itself (e.g. a committed .laneboard checked out there) is the nearest one. A bare init there is
    // refused (the worktree is part of the main checkout's board, S6k P3), so it is made by --dir.
    expect((await json(r.wt, ['init', '--name', 'own', '--prefix', 'OWN', '--description', 'own board'], { HOME: tempDir() })).code).toBe(6);
    expect((await json(r.wt, ['init', '--dir', path.join(r.wt, '.laneboard'), '--name', 'own', '--prefix', 'OWN', '--description', 'own board'], { HOME: tempDir() })).code).toBe(0);
    expect((await json(path.join(r.wt), ['list'])).doc.store).toBe(path.join(r.wt, '.laneboard'));
  });
});

describe('A18: setup in a linked worktree keeps the exclude block in the common git directory', () => {
  it('setup claude-code in the worktree writes <main>/.git/info/exclude, and git ignores the backups there', async () => {
    const r = await repoWithWorktree();
    fs.writeFileSync(path.join(r.wt, 'CLAUDE.md'), '# Project\n');
    const home = tempDir();
    const setup = await json(r.wt, ['setup', 'claude-code'], { HOME: home });
    expect(setup.code, JSON.stringify(setup.doc)).toBe(0);
    const exclude = path.join(r.main, '.git', 'info', 'exclude');
    expect(setup.doc.data.files).toContainEqual(expect.objectContaining({ path: exclude, scope: 'project', result: 'updated' }));
    expect(fs.readFileSync(exclude, 'utf8')).toContain('# laneboard:start');
    expect(setup.doc.warnings).toContain(`wrote CLAUDE.md.laneboard.bak (your file before setup; setup --remove restores it); ${exclude} keeps it out of git`);
    expect(r.wtGit(['status', '--porcelain', '--ignored=no'])).not.toContain('laneboard.bak');
  });
});

describe('A18, LB-1: finish links the commit of the worktree', () => {
  it('in the worktree: its HEAD, no warning, even when main and another worktree moved since the claim', async () => {
    const r = await repoWithWorktree();
    const wt2 = path.join(tempDir(), 'wt2');
    r.git(['worktree', 'add', '-q', wt2, '-b', 'other']);
    await claimed(r);
    r.wtGit(['commit', '-q', '--allow-empty', '-m', 'work']);
    gitIn(wt2)(['commit', '-q', '--allow-empty', '-m', 'work of another agent']);
    r.git(['commit', '-q', '--allow-empty', '-m', 'merge of another agent']);
    const head = r.wtGit(['rev-parse', 'HEAD']);
    const f = await json(r.wt, ['finish', 'LB-1', '--status', 'review', '--result', 'done in wt', '--as', 'dev-1']);
    expect(f.code).toBe(0);
    expect(f.doc.data.commit).toBe(head);
    expect(otherWarnings(f.doc.warnings)).toEqual([]);
  });

  it('in the main checkout: the warning names the folder, its HEAD, the worktree with its commit, and a fix that relinks', async () => {
    const r = await repoWithWorktree();
    await claimed(r);
    r.wtGit(['commit', '-q', '--allow-empty', '-m', 'work']);
    const work = r.wtGit(['rev-parse', 'HEAD']);
    const mainHead = r.git(['rev-parse', 'HEAD']);
    const f = await json(r.main, ['finish', 'LB-1', '--status', 'review', '--result', 'done', '--as', 'dev-1']);
    expect(f.code).toBe(0);
    expect(f.doc.data.commit).toBe(mainHead);
    // --json: the fix keeps rule 3 (slice A2, LB-63.2).
    const fix = `laneboard update LB-1 --remove-link commit=${mainHead} --add-link commit=${work} --as dev-1 --json`;
    expect(worktreeWarnings(f.doc)).toEqual([
      `the linked commit ${mainHead.slice(0, 12)} is HEAD of ${r.main} (main), the main checkout, and other worktrees of this repository have commits since you claimed LB-1: ${r.wt} (feat) ${work.slice(0, 12)}; ` +
        `if your work is in one of them, link its commit instead: ${fix} ` +
        '(next time run finish in that folder or pass --commit <sha>; MCP task_finish: cwd "<that folder>" or commit "<sha>")',
    ]);
    // The fix runs as is and leaves the worktree's commit linked.
    expect((await cli(fix.split(' ').slice(1), { cwd: r.main })).code).toBe(0);
    expect(stored(r.s, 'LB-1').links).toEqual([{ kind: 'commit', ref: work }]);
  });

  it('in the main checkout: no warning when the other worktree has no commit since the claim', async () => {
    const r = await repoWithWorktree();
    r.wtGit(['commit', '-q', '--allow-empty', '-m', 'old work'], LONG_AGO);
    await claimed(r);
    r.git(['commit', '-q', '--allow-empty', '-m', 'work in main']);
    const f = await json(r.main, ['finish', 'LB-1', '--result', 'done', '--as', 'dev-1']);
    expect(f.doc.data.commit).toBe(r.git(['rev-parse', 'HEAD']));
    expect(otherWarnings(f.doc.warnings)).toEqual([]);
  });

  it('--commit links that commit (a short sha as the full one); a sha git does not know or --no-commit with it: refused', async () => {
    const r = await repoWithWorktree();
    await claimed(r);
    r.wtGit(['commit', '-q', '--allow-empty', '-m', 'work']);
    const work = r.wtGit(['rev-parse', 'HEAD']);
    const unknown = await json(r.main, ['finish', 'LB-1', '--result', 'done', '--commit', 'deadbeef', '--as', 'dev-1']);
    expect(unknown.code).toBe(2);
    expect(unknown.doc.error).toMatchObject({ code: 'INVALID_VALUE', message: `commit: deadbeef is no commit of the git repository at ${r.main}` });
    const bad = await json(r.main, ['finish', 'LB-1', '--result', 'done', '--commit', 'HEAD', '--as', 'dev-1']);
    expect(bad.doc.error).toMatchObject({ code: 'INVALID_VALUE', message: 'commit: must be a commit sha of 7 to 64 hex digits' });
    const both = await json(r.main, ['finish', 'LB-1', '--result', 'done', '--commit', work, '--no-commit', '--as', 'dev-1']);
    expect(both.code).toBe(2);
    expect(both.doc.error.code).toBe('USAGE');
    expect(both.doc.error.fix).not.toContain('--no-commit');
    expect(stored(r.s, 'LB-1').status).toBe('in_progress');
    const f = await json(r.main, ['finish', 'LB-1', '--status', 'review', '--result', 'done', '--commit', work.slice(0, 7).toUpperCase(), '--as', 'dev-1']);
    expect(f.code).toBe(0);
    expect(f.doc.data.commit).toBe(work);
    expect(otherWarnings(f.doc.warnings)).toEqual([]);
    expect(stored(r.s, 'LB-1').links).toEqual([{ kind: 'commit', ref: work }]);
  });

  it('--commit older than the claim: a warning about that commit, not about HEAD', async () => {
    const r = await repoWithWorktree();
    const first = r.git(['rev-parse', 'HEAD']);
    await claimed(r);
    const f = await json(r.wt, ['finish', 'LB-1', '--result', 'done', '--commit', first, '--as', 'dev-1']);
    expect(otherWarnings(f.doc.warnings)).toEqual([
      `the linked commit ${first.slice(0, 12)} is from before your work: it was committed before you claimed LB-1; check the sha of your work's commit (git rev-parse HEAD in its folder)`,
    ]);
  });
});

describe('A18, B-U4: MCP task_finish with cwd or commit', () => {
  it('cwd: HEAD of that folder; commit: that commit; without them in the main checkout: the warning names both parameters', async () => {
    const r = await repoWithWorktree();
    const env = { cwd: r.main, env: {} };
    for (const id of ['LB-1', 'LB-2', 'LB-3']) {
      expect((await callTool('task_create', { title: id, status: 'in_progress', assignee: 'b', actor: 'b' }, env)).isError).toBeUndefined();
    }
    r.wtGit(['commit', '-q', '--allow-empty', '-m', 'work of b']);
    const work = r.wtGit(['rev-parse', 'HEAD']);
    const byCwd = await callTool('task_finish', { id: 'LB-1', result: 'done', status: 'review', cwd: r.wt, actor: 'b' }, env);
    expect(byCwd.structuredContent).toMatchObject({ id: 'LB-1', commit: work });
    expect(otherWarnings(JSON.parse(byCwd.content[1]?.text ?? '{}').warnings)).toEqual([]);
    const byCommit = await callTool('task_finish', { id: 'LB-2', result: 'done', status: 'review', commit: work, actor: 'b' }, env);
    expect(byCommit.structuredContent).toMatchObject({ id: 'LB-2', commit: work });
    const plain = await callTool('task_finish', { id: 'LB-3', result: 'done', status: 'review', actor: 'b' }, env);
    const warnings = JSON.parse(plain.content[1]?.text ?? '{}').warnings as string[];
    expect(warnings.find((w) => w.includes('the main checkout'))).toContain(`${r.wt} (feat) ${work.slice(0, 12)}; if your work is in one of them`);
    expect(warnings.find((w) => w.includes('the main checkout'))).toContain('MCP task_finish: cwd "<that folder>" or commit "<sha>"');
  });

  it('cwd must be an absolute path of a directory; no_commit goes with neither; tools/list describes cwd and commit', async () => {
    const r = await repoWithWorktree();
    const env = { cwd: r.main, env: {} };
    await callTool('task_create', { title: 'T', status: 'in_progress', assignee: 'b', actor: 'b' }, env);
    const relative = await callTool('task_finish', { id: 'LB-1', result: 'done', cwd: '../wt', actor: 'b' }, env);
    expect(relative.structuredContent).toMatchObject({ code: 'INVALID_VALUE', message: 'cwd: must be an absolute path' });
    const missing = await callTool('task_finish', { id: 'LB-1', result: 'done', cwd: path.join(r.wt, 'nope'), actor: 'b' }, env);
    expect(missing.structuredContent).toMatchObject({ code: 'INVALID_VALUE', message: `cwd: ${path.join(r.wt, 'nope')} is not a directory` });
    const both = await callTool('task_finish', { id: 'LB-1', result: 'done', cwd: r.wt, no_commit: true, actor: 'b' }, env);
    expect(both.structuredContent).toMatchObject({ code: 'USAGE' });
    expect(stored(r.s, 'LB-1').status).toBe('in_progress');
    const finish = TOOLS.finishTask;
    if (finish === 'cli-only') throw new Error('task_finish is a tool');
    const props = toolListing(finish).inputSchema.properties as Record<string, { description?: string }>;
    expect(props.cwd?.description).toContain('absolute path of the folder with your work');
    expect(props.commit?.description).toContain('sha of the commit to link');
  });
});

describe('CARRYOVER S6h: a task handed in again records the new result', () => {
  it('a new result after rework: one result comment, no status event, still handed in (acceptance works); the same result again: no changes', async () => {
    const s = await newStore();
    await json(s.root, ['create', 'Work', '--status', 'in_progress', '--assignee', 'dev-1', '--as', 'dev-1']);
    expect((await json(s.root, ['finish', 'LB-1', '--status', 'review', '--result', 'v1', '--no-commit', '--as', 'dev-1'])).code).toBe(0);
    await json(s.root, ['comment', 'LB-1', 'fix the edge case', '--as', 'orch']);
    // The rework step (0.5.0: a finish with no comment of the assignee since its work began warns).
    await json(s.root, ['comment', 'LB-1', 'edge case fixed', '--as', 'dev-1']);
    const rev = stored(s, 'LB-1').rev;
    const human = await cli(['finish', 'LB-1', '--status', 'review', '--result', 'v2: edge case fixed', '--no-commit', '--as', 'dev-1'], { cwd: s.root });
    expect(human.code).toBe(0);
    expect(human.stdout).toBe(`LB-1 handed in (rev ${rev + 1}, review, dev-1); no commit linked\n`);
    expect(human.stderr).toBe('');
    const t = stored(s, 'LB-1');
    expect(t.rev).toBe(rev + 1);
    expect(t.events.at(-1)).toMatchObject({ type: 'commented', actor: 'dev-1', data: { text: 'v2: edge case fixed', result: true } });
    expect(t.events.filter((e) => e.type === 'status')).toHaveLength(1);
    const retry = await json(s.root, ['finish', 'LB-1', '--status', 'review', '--result', 'v2: edge case fixed', '--no-commit', '--as', 'dev-1']);
    expect(otherWarnings(retry.doc.warnings)).toEqual(['no changes: LB-1 is already review with this result']);
    expect(stored(s, 'LB-1').rev).toBe(rev + 1);
    expect((await json(s.root, ['finish', 'LB-1', '--result', 'accepted', '--as', 'orch'])).doc.data).toMatchObject({ status: 'done', accepted: true });
    // A closed task keeps its result: finish never reopens it, nor records another result.
    const late = await json(s.root, ['finish', 'LB-1', '--status', 'review', '--result', 'v3', '--no-commit', '--as', 'dev-1']);
    expect(otherWarnings(late.doc.warnings)).toEqual(['no changes: LB-1 is already done; the result was not recorded (add it with laneboard comment LB-1 "<text>" --json)']);
    expect(stored(s, 'LB-1').events.filter((e) => e.data.result === true).map((e) => e.data.text)).toEqual(['v1', 'v2: edge case fixed', 'accepted']);
  });

  it('a new result and a new commit: both in one write, the reply names the commit', async () => {
    const r = await repoWithWorktree();
    await claimed(r);
    r.wtGit(['commit', '-q', '--allow-empty', '-m', 'v1']);
    expect((await json(r.wt, ['finish', 'LB-1', '--status', 'review', '--result', 'v1', '--as', 'dev-1'])).code).toBe(0);
    r.wtGit(['commit', '-q', '--allow-empty', '-m', 'v2']);
    const v2 = r.wtGit(['rev-parse', 'HEAD']);
    const rev = stored(r.s, 'LB-1').rev;
    const f = await json(r.wt, ['finish', 'LB-1', '--status', 'review', '--result', 'v2', '--as', 'dev-1']);
    expect({ ...f.doc, warnings: otherWarnings(f.doc.warnings) }).toMatchObject({ data: { rev: rev + 1, status: 'review', commit: v2 }, warnings: [] });
    expect(stored(r.s, 'LB-1').events.slice(-2).map((e) => e.type)).toEqual(['commented', 'updated']);
  });
});

// A commit date `seconds` from now (ISO), so commits after the claim have a known order.
function inSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

describe('review S6h r2: the main checkout, a fix that never guesses, the shared exclude block, the registry', () => {
  it('bare repository + 2 worktrees: finish in the first one links its HEAD with no warning (a bare repository has no main checkout)', async () => {
    const src = tempDir();
    const srcGit = gitIn(src);
    srcGit(['init', '-q', '-b', 'main']);
    srcGit(['commit', '-q', '--allow-empty', '-m', 'first'], LONG_AGO);
    const top = tempDir();
    gitIn(top)(['clone', '-q', '--bare', src, 'repo.git']);
    const bare = gitIn(path.join(top, 'repo.git'));
    bare(['worktree', 'add', '-q', '../alpha', '-b', 'alpha']);
    bare(['worktree', 'add', '-q', '../beta', '-b', 'beta']);
    const alpha = path.join(top, 'alpha');
    const env = { HOME: tempDir() };
    expect((await json(alpha, ['init', '--name', 'a', '--prefix', 'LB', '--description', 'bare layout', '--no-gitignore'], env)).code).toBe(0);
    expect((await json(alpha, ['create', 'Work', '--status', 'todo', '--as', 'dev-1'], env)).code).toBe(0);
    expect((await json(alpha, ['claim', 'LB-1', '--status', 'in_progress', '--as', 'dev-1'], env)).code).toBe(0);
    gitIn(alpha)(['commit', '-q', '--allow-empty', '-m', 'dev-1 work'], inSeconds(60));
    gitIn(path.join(top, 'beta'))(['commit', '-q', '--allow-empty', '-m', 'dev-2 work'], inSeconds(120));
    const f = await json(alpha, ['finish', 'LB-1', '--status', 'review', '--result', 'done', '--as', 'dev-1'], env);
    expect(f.code).toBe(0);
    expect(f.doc.data.commit).toBe(gitIn(alpha)(['rev-parse', 'HEAD']));
    expect(otherWarnings(f.doc.warnings)).toEqual([]);
  });

  it('main checkout + 2 worktrees with commits since the claim: both named (newest first), the fix takes your sha and runs as is only with it', async () => {
    const r = await repoWithWorktree();
    const wt2 = path.join(tempDir(), 'wt2');
    r.git(['worktree', 'add', '-q', wt2, '-b', 'other']);
    const wt2Git = gitIn(wt2);
    await claimed(r);
    r.wtGit(['commit', '-q', '--allow-empty', '-m', 'work'], inSeconds(60));
    wt2Git(['commit', '-q', '--allow-empty', '-m', 'work of another agent'], inSeconds(120));
    const work = r.wtGit(['rev-parse', 'HEAD']);
    const other = wt2Git(['rev-parse', 'HEAD']);
    const mainHead = r.git(['rev-parse', 'HEAD']);
    const f = await json(r.main, ['finish', 'LB-1', '--status', 'review', '--result', 'done', '--as', 'dev-1']);
    expect(f.code).toBe(0);
    // Slice A2 (LB-55.2): one command; the wrong link is dropped only after `&&`, so run as is (the placeholder refused) it drops nothing.
    const relink =
      'laneboard finish LB-1 --status review --commit <HEAD of your worktree> --result "<your result>" --as dev-1 --json && ' +
      `laneboard update LB-1 --remove-link commit=${mainHead} --as dev-1 --json`;
    expect(worktreeWarnings(f.doc)).toEqual([
      `the linked commit ${mainHead.slice(0, 12)} is HEAD of ${r.main} (main), the main checkout, and other worktrees of this repository have commits since you claimed LB-1: ` +
        `${wt2} (other) ${other.slice(0, 12)}, ${r.wt} (feat) ${work.slice(0, 12)}; if your work is in one of them, link the HEAD of yours (listed above) instead of this one: ${relink} ` +
        '(next time run finish in that folder or pass --commit <sha>; MCP task_finish: cwd "<that folder>" or commit "<sha>")',
    ]);
    // No sha of another worktree in any command: the warning never picks one for the agent.
    expect(worktreeWarnings(f.doc)[0]).not.toContain(`commit=${other}`);
    expect(worktreeWarnings(f.doc)[0]).not.toContain('--add-link');
    // Run as is, the placeholder is refused and nothing changes.
    const blind = await json(r.main, ['finish', 'LB-1', '--status', 'review', '--commit', '<HEAD of your worktree>', '--result', 'done', '--as', 'dev-1']);
    expect(blind.code).toBe(2);
    expect(blind.doc.error.code).toBe('INVALID_VALUE');
    expect(stored(r.s, 'LB-1').links).toEqual([{ kind: 'commit', ref: mainHead }]);
    // With the agent's own sha: its commit linked, then the main checkout's HEAD dropped (slice A2, LB-55.2: was "drop it by hand").
    expect((await json(r.main, ['finish', 'LB-1', '--status', 'review', '--commit', work, '--result', 'done', '--as', 'dev-1'])).code).toBe(0);
    expect(stored(r.s, 'LB-1').links).toEqual([{ kind: 'commit', ref: mainHead }, { kind: 'commit', ref: work }]);
    expect((await json(r.main, ['update', 'LB-1', '--remove-link', `commit=${mainHead}`, '--as', 'dev-1'])).code).toBe(0);
    expect(stored(r.s, 'LB-1').links).toEqual([{ kind: 'commit', ref: work }]);
  });

  it('the fix with 2 worktrees names the status finish set (done)', async () => {
    const r = await repoWithWorktree();
    const wt2 = path.join(tempDir(), 'wt2');
    r.git(['worktree', 'add', '-q', wt2, '-b', 'other']);
    await claimed(r);
    r.wtGit(['commit', '-q', '--allow-empty', '-m', 'work'], inSeconds(60));
    gitIn(wt2)(['commit', '-q', '--allow-empty', '-m', 'work of another agent'], inSeconds(120));
    const f = await json(r.main, ['finish', 'LB-1', '--status', 'done', '--result', 'done', '--as', 'dev-1']);
    expect(worktreeWarnings(f.doc)[0]).toContain('laneboard finish LB-1 --status done --commit <HEAD of your worktree>');
  });

  it('board in a subfolder of the main checkout, a worktree under it: the same project, no warning', async () => {
    const main = tempDir();
    const git = gitIn(main);
    git(['init', '-q', '-b', 'main']);
    git(['commit', '-q', '--allow-empty', '-m', 'first'], LONG_AGO);
    const pkg = path.join(main, 'pkg');
    fs.mkdirSync(pkg);
    const env = { HOME: tempDir() };
    expect((await json(pkg, ['init', '--name', 'p', '--prefix', 'PK', '--description', 'p', '--no-gitignore'], env)).code).toBe(0);
    git(['worktree', 'add', '-q', 'pkg/wt', '-b', 'feat']);
    const l = await json(path.join(pkg, 'wt'), ['list'], env);
    expect(l.code).toBe(0);
    expect(l.doc.warnings).toEqual([]);
  });

  it('setup --remove in a worktree keeps the shared exclude block while the setup of the main checkout stands; the last --remove takes it out', async () => {
    const r = await repoWithWorktree();
    const home = tempDir();
    const exclude = path.join(r.main, '.git', 'info', 'exclude');
    for (const dir of [r.main, r.wt]) {
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Project\n');
      expect((await json(dir, ['setup', 'claude-code', '--dir', r.s.dir], { HOME: home })).code, dir).toBe(0);
    }
    const blocks = (): number => fs.readFileSync(exclude, 'utf8').split('# laneboard:start').length - 1;
    expect(blocks()).toBe(1);
    const off = await json(r.wt, ['setup', 'claude-code', '--remove'], { HOME: home });
    expect(off.code, JSON.stringify(off.doc)).toBe(0);
    expect(off.doc.data.files).toContainEqual({ path: exclude, scope: 'project', result: 'kept' });
    expect(off.doc.warnings).toContain(
      `kept the laneboard block in ${exclude}: setup in another checkout of this repository still uses it (${r.main}); laneboard setup <harness> --remove --json there removes it`,
    );
    expect(blocks()).toBe(1);
    // The main checkout's backups stay out of git.
    expect(r.git(['status', '--porcelain'])).not.toContain('laneboard.bak');
    // The other way round: --remove in the main checkout keeps it while the worktree's setup stands.
    expect((await json(r.wt, ['setup', 'claude-code', '--dir', r.s.dir], { HOME: home })).code).toBe(0);
    const main = await json(r.main, ['setup', 'claude-code', '--remove'], { HOME: home });
    expect(main.code, JSON.stringify(main.doc)).toBe(0);
    expect(main.doc.data.files).toContainEqual({ path: '.git/info/exclude', scope: 'project', result: 'kept' });
    expect(blocks()).toBe(1);
    const last = await json(r.wt, ['setup', 'claude-code', '--remove'], { HOME: home });
    expect(last.code, JSON.stringify(last.doc)).toBe(0);
    expect(blocks()).toBe(0);
  });

  it('a worktree of a repository whose main checkout is HOME: ~/.laneboard is the registry, never the board (STORE_NOT_FOUND)', async () => {
    const home = tempDir();
    const git = gitIn(home);
    git(['init', '-q', '-b', 'main']);
    git(['commit', '-q', '--allow-empty', '-m', 'dotfiles'], LONG_AGO);
    // A board elsewhere fills the machine registry ~/.laneboard (boards.json, no config.json).
    expect((await json(tempDir(), ['init', '--name', 'p', '--prefix', 'PP', '--description', 'another project'], { HOME: home })).code).toBe(0);
    expect(fs.existsSync(path.join(home, '.laneboard', 'boards.json'))).toBe(true);
    const wt = path.join(tempDir(), 'wt');
    git(['worktree', 'add', '-q', wt, '-b', 'feat']);
    const list = await json(wt, ['list'], { HOME: home });
    expect(list.code).not.toBe(0);
    expect(list.doc.error.code).toBe('STORE_NOT_FOUND');
  });
});

describe('review S6l X5: claim --resume names the parent only when the same session holds it', () => {
  const BASE = 'claude-code@ann';
  const session = (n: string): Record<string, string> => ({ LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: `${n.repeat(8)}-1a1a-4a1a-8a1a-000000000001` });
  it('a parent held by another earlier session of the same name: no parent warning', async () => {
    const s = await newStore({ prefix: 'WORD', statuses: ['todo', 'doing', 'done'] });
    expect((await json(s.root, ['create', 'Parent', '--status', 'doing', '--assignee', `${BASE}:33333333`], session('3'))).code).toBe(0);
    expect((await json(s.root, ['create', 'Child', '--status', 'doing', '--assignee', `${BASE}:11111111`, '--parent', 'WORD-1'], session('1'))).code).toBe(0);
    const r = await json(s.root, ['claim', 'WORD-2', '--resume'], session('2'));
    expect(r.code).toBe(0);
    expect(r.doc.data.resumed_from).toBe(`${BASE}:11111111`);
    expect(r.doc.warnings.filter((w: string) => w.includes('its parent'))).toEqual([]);
    // The control: the same layout with the parent held by the resumed session names it.
    const c = await newStore({ prefix: 'WORD', statuses: ['todo', 'doing', 'done'] });
    await json(c.root, ['create', 'Parent', '--status', 'doing', '--assignee', `${BASE}:11111111`], session('1'));
    await json(c.root, ['create', 'Child', '--status', 'doing', '--assignee', `${BASE}:11111111`, '--parent', 'WORD-1'], session('1'));
    const control = await json(c.root, ['claim', 'WORD-2', '--resume'], session('2'));
    expect(control.doc.warnings).toContain(`its parent WORD-1 is held by the same session ${BASE}:11111111: laneboard claim WORD-1 --resume --json`);
  });
});
