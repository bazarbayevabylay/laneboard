// S3b: review S3 (prime keeps its commands at the real path length, resume decided by the events, the setup block names finish,
// finish checks the owner first) and the owner's decisions (finish --status <any but the first>, warnings when the linked commit
// may not hold the work, no --resume offer in ALREADY_CLAIMED, the resume section of prime --hook only after /clear).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agentRules, claimTask, createTask, readCheckout, shellQuote } from '../../src/core/index.ts';
import { PRIME_MAX_CHARS, PRIME_MIN_FREE, primeText } from '../../src/cli/format.ts';
import type { PrimeData } from '../../src/cli/format.ts';
import type { ListItem } from '../../src/core/index.ts';
import { runCli } from '../../src/cli/run.ts';
import { callTool } from '../../src/mcp/tools.ts';
import { as, ceilingRules, cleanupTemp, cli, newStore, readStore, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

const BASE = 'claude-code@ann';
const SESSION_A = { LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: 'aaaa1111-1a1a-4a1a-8a1a-000000000001' };
const SESSION_B = { LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: 'bbbb2222-2b2b-4b2b-8b2b-000000000002' };
const NAME_A = `${BASE}:aaaa1111`;
const NAME_B = `${BASE}:bbbb2222`;

// git in `dir`, isolated from the user's config; `at`: the commit and reflog time (unix seconds) for commits.
function git(dir: string, args: string[], at?: number): string {
  const home = path.join(dir, '..', `${path.basename(dir)}-githome`);
  fs.mkdirSync(home, { recursive: true });
  const date = at === undefined ? {} : { GIT_COMMITTER_DATE: `@${at} +0000`, GIT_AUTHOR_DATE: `@${at} +0000` };
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', ...date };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, env, encoding: 'utf8' }).trim();
}

// A repository in `dir` with `file` committed at `at` (unix seconds); returns HEAD.
function repoWithFile(dir: string, at: number, extra: string[] = []): string {
  git(dir, ['init', '-q', ...extra]);
  fs.writeFileSync(path.join(dir, 'app.txt'), 'one\n');
  git(dir, ['add', 'app.txt']);
  git(dir, ['commit', '-q', '-m', 'first'], at);
  return git(dir, ['rev-parse', 'HEAD']);
}

// Does git see changes of tracked files, staged or not (`git status --porcelain -uno` prints a line)? The oracle for readCheckout.
function gitSeesChanges(dir: string): boolean {
  return git(dir, ['status', '--porcelain', '-uno']) !== '';
}

// The task as stored.
function stored(s: TestStore, id: string): { rev: number; status: string; links: unknown[]; events: Array<{ type: string; actor: string; data: Record<string, unknown> }> } {
  const task = readStore(s.dir, 'active').tasks.find((t) => t.id === id);
  if (!task) throw new Error(`${id} not in active.json`);
  return task as never;
}

// Unix seconds now: commit times are set relative to it (after or before the claim).
const nowSec = (): number => Math.floor(Date.now() / 1000);

describe('review S3 MAJOR 1: prime keeps the status and field lines, the commands and the first tasks whole', () => {
  const STATUS_LINE = (todo: number, inProgress: number) => `Statuses in order (final: done), active tasks: todo ${todo}, in_progress ${inProgress}, review 0; done 0`;
  const FIELDS_LINE = 'Fields (--field key=value): priority (number, 0 = highest)';

  // A store whose path is exactly `len` characters, like the real Projects/laneboard/.laneboard (85).
  async function storeAt(len: number): Promise<{ root: string; dir: string }> {
    const base = tempDir();
    const root = path.join(base, 'p'.repeat(len - base.length - '/'.length - '/.laneboard'.length));
    fs.mkdirSync(root);
    const r = await cli(['init', '--dir', '.laneboard', '--name', 'shop', '--description', 'Shop backend and admin panel: orders, payments, refunds', '--json'], { cwd: root, env: { HOME: tempDir(), ...SESSION_A } });
    expect(r.code, r.stdout).toBe(0);
    return { root, dir: path.join(root, '.laneboard') };
  }

  it('the review input: 85-character store path, one task of an earlier session, three free tasks; prime, prime --dir, prime --hook after /clear', async () => {
    const { root, dir } = await storeAt(85);
    expect(dir.length).toBe(85);
    const env = (s: Record<string, string>) => ({ HOME: tempDir(), ...s });
    await cli(['create', 'Add discount to total()', '--status', 'in_progress', '--assignee', NAME_A, '--json'], { cwd: root, env: env(SESSION_A) });
    for (const i of [1, 2, 3]) await cli(['create', `Free task ${i}`, '--status', 'todo', '--as', 'x', '--json'], { cwd: root, env: env({}) });
    const runs = [
      { argv: ['prime'], stdin: '', dirArg: '' },
      { argv: ['prime', '--dir', dir], stdin: '', dirArg: ` --dir ${shellQuote(dir)}` },
      { argv: ['prime', '--hook'], stdin: '{"session_id":"bbbb2222","source":"clear"}', dirArg: '' },
    ];
    for (const run of runs) {
      const out = (await cli(run.argv, { cwd: root, env: env(SESSION_B), stdin: run.stdin })).stdout.trimEnd();
      const where = run.argv.join(' ');
      expect(out.length, where).toBeLessThanOrEqual(PRIME_MAX_CHARS);
      const lines = out.split('\n');
      expect(lines, where).toContain(STATUS_LINE(3, 1));
      expect(lines, where).toContain(FIELDS_LINE);
      // With --dir in each command it would not fit: one line names it (the commands stay whole either way).
      // Rewritten in S4b (review S4): the path is printed once, as `--dir <path>` in the Store line, which the dir line points to.
      const dirLine = 'This board was named by --dir: add the --dir option of the Store line to every laneboard command below.';
      const inCommands = lines.includes(`  laneboard create "<short title of your work>" --status todo --assignee ${NAME_B}${run.dirArg} --json`);
      const once = lines.includes(dirLine) && lines.some((l) => l.startsWith(`Store: --dir ${shellQuote(dir)} (prefix SHOP)`));
      expect(inCommands || (once && lines.includes(`  laneboard create "<short title of your work>" --status todo --assignee ${NAME_B} --json`)), where).toBe(true);
      expect(lines, where).toContain('  SHOP-1  [in_progress]  <1m ago  session aaaa1111  Add discount to total()');
      for (const i of [1, 2, 3]) expect(lines, where).toContain(`  SHOP-${i + 1}  [todo]  rev 1  Free task ${i}`);
      // Only the board line may be cut.
      expect(lines.filter((l) => l.includes('…') && !l.startsWith('Store: ')), where).toEqual([]);
    }
  });

  // Synthetic summaries: own tasks, earlier-session tasks, free tasks, at a store path of `len` characters.
  const item = (id: number, title: string, assignee: string | null): ListItem => ({ id: `LB-${id}`, title, status: 'todo', assignee, labels: [], parent: null, last_comment: null, updated_at: new Date().toISOString(), updated_by: 'a', rev: 1, archived: false });
  // Default name bases: the length of the real one on the owner's machine, and the longest a name may get (64 with the session part).
  const BASES = ['claude-code@abylaybazarbayev', `claude-code@${'u'.repeat(43)}`];
  const summary = (len: number, own: number, resume: number, free: number, description: string, base: string): PrimeData => ({
    rules: ceilingRules(),
    agent: `${base}:bbbb2222`,
    agent_source: 'default',
    name: 'shop',
    description,
    store: `/${'p'.repeat(len - '/'.length - '/.laneboard'.length)}/.laneboard`,
    prefix: 'LB',
    store_warning: null,
    store_problem: null,
    statuses: ['todo', 'in_progress', 'review', 'done'].map((status) => ({ status, count: 0 })),
    first_status: 'todo',
    final_status: 'done',
    open_statuses: ['todo', 'in_progress', 'review'],
    fields: { priority: { type: 'number', description: '0 = highest', example: 'priority=1' } },
    tasks: Array.from({ length: own }, (_, i) => item(i + 1, `Own task ${i + 1} with a title of ordinary length`, `${base}:bbbb2222`)),
    in_progress: own,
    unassigned: Array.from({ length: Math.min(free, 10) }, (_, i) => item(100 + i, `Free task ${i + 1} with a title of ordinary length`, null)),
    unassigned_total: free,
    session_base: base,
    resumable: Array.from({ length: resume }, (_, i) => item(200 + i, 'Add discount to total()', `${base}:aaaa1111`)),
  });

  it('grid: store path 85/120/160 × --dir or not × free 0/3/12 × earlier 0/1 × own 0/1 × description 56/200 × name 37/64 characters', () => {
    for (const [len, base] of [85, 120, 160].flatMap((l) => BASES.map((b) => [l, b] as const))) {
      for (const withDir of [false, true]) {
        for (const free of [0, 3, 12]) {
          for (const resume of [0, 1]) {
            for (const own of [0, 1]) {
              for (const description of ['Shop backend and admin panel: orders, payments, refunds', 'd'.repeat(200)]) {
                const d = summary(len, own, resume, free, description, base);
                const name = `${base}:bbbb2222`;
                const storeDir = withDir ? (d.store ?? '') : undefined;
                const text = primeText(d, storeDir);
                const where = `len=${len} dir=${withDir} free=${free} resume=${resume} own=${own} desc=${description.length} name=${name.length}`;
                expect(text.length, where).toBeLessThanOrEqual(PRIME_MAX_CHARS);
                const lines = text.split('\n');
                expect(lines, where).toContain(STATUS_LINE(0, 0));
                expect(lines, where).toContain(FIELDS_LINE);
                expect(lines.some((l) => l.startsWith('Your name: session default ')), where).toBe(true);
                // Rewritten in S4b: the path once, in the Store line as `--dir <path>`; the dir line points to it.
                const dirOnce = lines.includes('This board was named by --dir: add the --dir option of the Store line to every laneboard command below.');
                if (dirOnce) expect(lines.some((l) => l.startsWith(`Store: --dir ${storeDir} (prefix LB)`)), where).toBe(true);
                if (dirOnce) expect(text.split(storeDir ?? '').length - 1, where).toBe(1);
                const dirArg = withDir && !dirOnce ? ` --dir ${storeDir}` : '';
                if (own === 0) {
                  expect(lines, where).toContain(`  laneboard create "<short title of your work>" --status todo --assignee ${name}${dirArg} --json`);
                  const claim = `laneboard claim <ID>${dirArg} --json`;
                  expect(lines.some((l) => l.endsWith(`The request names a task id: ${claim}`) || l === `Given a task id instead: ${claim}`), where).toBe(true);
                } else {
                  expect(lines, where).toContain('  LB-1  [todo]  rev 1  Own task 1 with a title of ordinary length');
                }
                if (resume && !own) expect(lines.some((l) => l.startsWith('  LB-200  [todo]  <1m ago  session aaaa1111  Add discount')), where).toBe(true);
                if (free) {
                  const shown = lines.filter((l) => /^ {2}LB-1\d\d {2}\[todo\] {2}rev 1 {2}Free task/.test(l)).length;
                  expect(shown, where).toBeGreaterThanOrEqual(Math.min(free, PRIME_MIN_FREE));
                  const footer = `... ${free - shown} more: laneboard list --unassigned --status todo --status in_progress --status review${dirArg} --json`;
                  if (shown < free) expect(lines, where).toContain(footer);
                  if (own) expect(lines, where).toContain(`Free tasks (no assignee); take one: laneboard claim <ID>${dirArg} --json`);
                }
                if (withDir && !dirOnce) expect(text, where).not.toContain('This board was named by --dir');
                // Only the board line and long task titles may be cut.
                expect(lines.filter((l) => l.includes('…') && !l.startsWith('Store: ') && !/^ {2}LB-\d+ /.test(l)), where).toEqual([]);
              }
            }
          }
        }
      }
    }
  });
});

// The rules as prime prints them (S3c: agent-rules.md also holds the short forms, so through agentRules).
function readRules(): string {
  return agentRules();
}

describe('review S3 MAJOR 2: claim --resume decides by the events, not by the form of the name', () => {
  it('an explicit name of the session form (claude-code@ann:reviewer) is neither listed nor taken over', async () => {
    const s = await newStore();
    const run = (argv: string[], env: Record<string, string>) => cli(argv, { cwd: s.root, env });
    expect((await run(['create', 'Review the cart', '--status', 'in_progress', '--assignee', `${BASE}:reviewer`, '--as', `${BASE}:reviewer`, '--json'], SESSION_A)).code).toBe(0);
    expect(stored(s, 'LB-1').events[0]).toMatchObject({ actor: `${BASE}:reviewer`, actor_source: 'explicit' });
    const prime = (await run(['prime'], SESSION_B)).stdout;
    expect(prime).not.toContain('Your earlier sessions');
    expect(prime).not.toContain('--resume');
    const before = fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8');
    const r = JSON.parse((await run(['claim', 'LB-1', '--resume', '--json'], SESSION_B)).stdout);
    expect(r.error.code).toBe('ALREADY_CLAIMED');
    expect(r.error.message).toContain(`and ${BASE}:reviewer did not;`);
    expect(fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8')).toBe(before);
  });

  it('a default-form name the holder never wrote under (handed over by another session) does not qualify; the holder taking it itself does', async () => {
    const s = await newStore();
    const run = (argv: string[], env: Record<string, string>) => cli(argv, { cwd: s.root, env });
    // Session A (its default name) creates a task for `claude-code@ann:cccc3333`: actor_source default, but the actor is A.
    await run(['create', 'Handed over', '--status', 'in_progress', '--assignee', `${BASE}:cccc3333`, '--json'], SESSION_A);
    // Session A takes its own task: claim by A under its default name.
    await run(['create', 'Mine', '--status', 'todo', '--json'], SESSION_A);
    await run(['claim', 'LB-2', '--status', 'in_progress', '--json'], SESSION_A);
    const data = JSON.parse((await run(['prime', '--json'], SESSION_B)).stdout).data as PrimeData;
    expect(data.resumable.map((t) => t.id)).toEqual(['LB-2']);
    expect(JSON.parse((await run(['claim', 'LB-1', '--resume', '--json'], SESSION_B)).stdout).error.code).toBe('ALREADY_CLAIMED');
    expect(JSON.parse((await run(['claim', 'LB-2', '--resume', '--json'], SESSION_B)).stdout).data).toMatchObject({ assignee: NAME_B, resumed_from: NAME_A });
  });
});

describe('review S3 MAJOR 3: the setup block tells every harness to finish', () => {
  const OLD_RULE = 'when done, set the final status and add a result comment';
  const NEW_RULE = 'when done: commit, then `laneboard finish <ID> --result "<result>" --json` (one write: the result, the commit link, the status).';
  const files: Record<string, string> = { 'claude-code': 'CLAUDE.md', codex: 'AGENTS.md', cursor: 'AGENTS.md', gemini: 'GEMINI.md', opencode: 'AGENTS.md' };

  for (const [harness, file] of Object.entries(files)) {
    it(`${harness}: ${file} names finish; a block written by S3 setup is updated`, async () => {
      const cwd = tempDir();
      const home = tempDir();
      const run = (argv: string[]) => cli([...argv, '--json'], { cwd, env: { HOME: home } });
      expect((await run(['init', '--dir', '.laneboard', '--name', 'p', '--description', 'probe'])).code).toBe(0);
      expect((await run(['setup', harness])).code).toBe(0);
      const text = fs.readFileSync(path.join(cwd, file), 'utf8');
      expect(text).toContain(NEW_RULE);
      expect(text).not.toContain(OLD_RULE);
      // The block as S3 wrote it: the next setup replaces it.
      fs.writeFileSync(path.join(cwd, file), text.replace(NEW_RULE, `${OLD_RULE}. No untracked work.`).replace(' No untracked work. No untracked work.', ' No untracked work.'));
      const again = JSON.parse((await run(['setup', harness])).stdout).data as { files: Array<{ path: string; result: string }> };
      expect(again.files.find((f) => f.path === file)?.result).toBe('updated');
      expect(fs.readFileSync(path.join(cwd, file), 'utf8')).toContain(NEW_RULE);
    });
  }
});

describe('finish --status: any status but the first one (owner, S3b)', () => {
  it('hands in to review in one write (result, commit, status); again in review: unchanged with a warning; then the final status', async () => {
    const s = await newStore();
    const head = repoWithFile(s.root, nowSec() + 5);
    await createTask(as(s, 'a'), { title: 'Fix login', status: 'todo' });
    await claimTask(as(s, 'dev-1'), { id: 'LB-1', status: 'in_progress' });
    const r = JSON.parse((await cli(['finish', 'LB-1', '--result', 'Ready for review', '--status', 'review', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout);
    expect(r.data).toEqual({ id: 'LB-1', rev: 3, status: 'review', assignee: 'dev-1', commit: head });
    expect(r.warnings).toEqual([]);
    expect(stored(s, 'LB-1').events.slice(-3).map((e) => [e.type, e.data])).toEqual([
      ['commented', { text: 'Ready for review', result: true }],
      ['updated', { links: [[], [{ kind: 'commit', ref: head }]] }],
      // S4b: the assignee's finish into a status that is not final hands the task in.
      ['status', { from: 'in_progress', to: 'review', handed_in: true }],
    ]);
    const again = await cli(['finish', 'LB-1', '--result', 'Again', '--status', 'review', '--as', 'dev-1', '--json'], { cwd: s.root });
    expect(again.code).toBe(0);
    const doc = JSON.parse(again.stdout);
    expect(doc.data).toEqual({ id: 'LB-1', rev: 3, status: 'review', assignee: 'dev-1' });
    expect(doc.warnings).toEqual(['no changes: LB-1 is already review; the result was not recorded (add it with laneboard comment LB-1 "<text>")']);
    expect((await cli(['finish', 'LB-1', '--result', 'Approved', '--as', 'dev-1', '--json'], { cwd: s.root })).code).toBe(0);
    expect(stored(s, 'LB-1')).toMatchObject({ rev: 4, status: 'done' });
    // A closed task is not reopened by a later hand-in.
    const late = JSON.parse((await cli(['finish', 'LB-1', '--result', 'x', '--status', 'review', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout);
    expect(late.data.status).toBe('done');
    expect(late.warnings[0]).toBe('no changes: LB-1 is already done; the result was not recorded (add it with laneboard comment LB-1 "<text>")');
  });

  it('MCP task_finish takes status review as well', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'A', status: 'in_progress', assignee: 'm' });
    const r = await callTool('task_finish', { id: 'LB-1', result: 'done', status: 'review', no_commit: true, actor: 'm' }, { cwd: s.root, env: {} });
    expect(r.structuredContent).toEqual({ id: 'LB-1', rev: 2, status: 'review', assignee: 'm', commit: null });
  });
});

describe('finish warns when the linked commit may not hold the work (owner, S3b)', () => {
  const dirtyWarning = (sha: string) =>
    `the working tree has uncommitted changes to tracked files, so the linked commit ${sha.slice(0, 12)} may not hold your work; commit your work and run laneboard finish LB-1 again to link the new commit (work without a commit: --no-commit)`;
  const staleWarning = (sha: string) =>
    `the linked commit ${sha.slice(0, 12)} is from before your work: HEAD has not moved since you claimed LB-1; commit your work and run laneboard finish LB-1 again to link the new commit (work without a commit: --no-commit)`;

  it('a commit after the claim and a clean tree: no warning', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'T', status: 'todo', assignee: 'dev-1' });
    const head = repoWithFile(s.root, nowSec() + 5);
    const r = JSON.parse((await cli(['finish', 'LB-1', '--result', 'done', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout);
    expect(r.data.commit).toBe(head);
    expect(r.warnings).toEqual([]);
  });

  it('uncommitted changes: a warning; commit, finish again: the new commit is linked (status and result unchanged)', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'T', status: 'todo', assignee: 'dev-1' });
    const first = repoWithFile(s.root, nowSec() + 5);
    fs.writeFileSync(path.join(s.root, 'app.txt'), 'two\n');
    const r = await cli(['finish', 'LB-1', '--result', 'done', '--as', 'dev-1', '--json'], { cwd: s.root });
    expect(JSON.parse(r.stdout).warnings).toEqual([dirtyWarning(first)]);
    git(s.root, ['commit', '-q', '-am', 'second'], nowSec() + 6);
    const second = git(s.root, ['rev-parse', 'HEAD']);
    const again = await cli(['finish', 'LB-1', '--result', 'done', '--as', 'dev-1'], { cwd: s.root });
    expect(again.stdout).toBe(`LB-1 unchanged (rev 3, done, dev-1); commit ${second.slice(0, 12)} linked\n`);
    // Rewritten in S3c (review S3b MINOR): a new link is a change, so the warning no longer says "no changes".
    expect(again.stderr).toContain(`status and result unchanged: LB-1 is already done; the result was not recorded (add it with laneboard comment LB-1 "<text>"); commit ${second.slice(0, 12)} linked`);
    expect(again.stderr).not.toContain('uncommitted');
    const t = stored(s, 'LB-1');
    expect(t.links).toEqual([{ kind: 'commit', ref: first }, { kind: 'commit', ref: second }]);
    expect(t.events.filter((e) => e.type === 'commented')).toHaveLength(1);
    expect(t.events.at(-1)).toMatchObject({ type: 'updated', data: { links: [[{ kind: 'commit', ref: first }], [{ kind: 'commit', ref: first }, { kind: 'commit', ref: second }]] } });
  });

  it('HEAD has not moved since the claim: a warning; --no-commit and a task the finisher did not hold: none', async () => {
    const s = await newStore();
    const head = repoWithFile(s.root, nowSec() - 100);
    await createTask(as(s, 'a'), { title: 'T', status: 'todo', assignee: 'dev-1' });
    await createTask(as(s, 'a'), { title: 'U', status: 'todo', assignee: 'dev-1' });
    await createTask(as(s, 'a'), { title: 'Free', status: 'todo' });
    expect(JSON.parse((await cli(['finish', 'LB-1', '--result', 'done', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout).warnings).toEqual([staleWarning(head)]);
    expect(JSON.parse((await cli(['finish', 'LB-2', '--result', 'done', '--no-commit', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout).warnings).toEqual([]);
    // An unassigned task has no claim to compare with (the finisher takes it now).
    expect(JSON.parse((await cli(['finish', 'LB-3', '--result', 'done', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout).warnings).toEqual([]);
  });
});

// Rewritten in S3c: git itself is asked (review S3b MAJOR); the same cases, now with staged changes seen.
describe('git checkout facts as git gives them, checked against git status', () => {
  it('dirty: changed, deleted, mode change, intent-to-add, touched only, untracked, staged; index v4; SHA-256', async () => {
    for (const extra of [[], ['--object-format=sha256']]) {
      const dir = tempDir();
      repoWithFile(dir, nowSec(), extra);
      fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'one.txt'), '1\n');
      git(dir, ['add', 'b.txt', 'src']);
      git(dir, ['commit', '-q', '-m', 'b']);
      // Both laneboard and git status give the expected answer.
      const check = async (want: boolean, what: string) => {
        const sha = git(dir, ['rev-parse', 'HEAD']);
        expect(await readCheckout(dir), `${extra.join('')} ${what}`).toMatchObject({ head: sha, dirty: want });
        expect(gitSeesChanges(dir), `git: ${extra.join('')} ${what}`).toBe(want);
      };
      await check(false, 'clean');
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(dir, 'app.txt'), later, later);
      await check(false, 'touched');
      fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked\n');
      await check(false, 'untracked file');
      fs.writeFileSync(path.join(dir, 'app.txt'), 'oNe\n');
      await check(true, 'same size, other content');
      git(dir, ['add', 'app.txt']);
      await check(true, 'staged');
      git(dir, ['commit', '-q', '-m', 'c']);
      fs.rmSync(path.join(dir, 'b.txt'));
      await check(true, 'deleted');
      git(dir, ['checkout', '--', 'b.txt']);
      await check(false, 'restored');
      fs.chmodSync(path.join(dir, 'b.txt'), 0o755);
      await check(true, 'mode');
      fs.chmodSync(path.join(dir, 'b.txt'), 0o644);
      git(dir, ['add', '-N', 'new.txt']);
      await check(true, 'intent to add');
      git(dir, ['reset', '-q', 'new.txt']);
      git(dir, ['update-index', '--index-version', '4']);
      await check(false, 'index v4 clean');
      fs.writeFileSync(path.join(dir, 'b.txt'), 'changed\n');
      await check(true, 'index v4 changed');
    }
    expect(await readCheckout(tempDir())).toEqual({});
  });

  it('committedAt: the commit time of HEAD (unix seconds)', async () => {
    const dir = tempDir();
    const head = repoWithFile(dir, 1_000_000_000);
    expect(await readCheckout(dir)).toEqual({ head, committedAt: 1_000_000_000, dirty: false });
  });
});

describe('owner, S3b: claim --resume is offered only by the resume section, and prime --hook shows it only after /clear', () => {
  async function earlierTask(): Promise<TestStore> {
    const s = await newStore();
    await cli(['create', 'Fix cart total', '--status', 'in_progress', '--json'], { cwd: s.root, env: SESSION_A });
    await cli(['claim', 'LB-1', '--json'], { cwd: s.root, env: SESSION_A });
    return s;
  }

  it('prime --hook: the section and the resume way for source "clear" only; plain prime keeps them with the age', async () => {
    const s = await earlierTask();
    const hook = async (stdin: string) => (await cli(['prime', '--hook'], { cwd: s.root, env: SESSION_B, stdin })).stdout;
    const clear = await hook('{"session_id":"bbbb2222","source":"clear"}');
    expect(clear).toContain('2. Your own task from before /clear (below) fits the request: laneboard claim <ID> --resume --json\n');
    expect(clear).toContain('Your earlier sessions, unfinished (a parallel session of yours has the same name: resume only your own):\n  LB-1  [in_progress]  <1m ago  session aaaa1111  Fix cart total');
    for (const stdin of ['{"session_id":"bbbb2222","source":"startup"}', '{"source":"compact"}', '{"source":"resume"}', '', 'not json', '[]']) {
      const out = await hook(stdin);
      expect(out, stdin).not.toContain('Your earlier sessions');
      expect(out, stdin).not.toContain('--resume');
      expect(out, stdin).toContain('laneboard create "<short title of your work>"');
    }
    const plain = (await cli(['prime'], { cwd: s.root, env: SESSION_B })).stdout;
    expect(plain).toContain('  LB-1  [in_progress]  <1m ago  session aaaa1111  Fix cart total');
    expect(plain).toContain('resume only your own');
  });

  it('prime --hook with a terminal on stdin does not read it', async () => {
    const s = await earlierTask();
    let out = '';
    let read = false;
    const code = await runCli({
      argv: ['prime', '--hook'],
      env: SESSION_B,
      cwd: s.root,
      stdinIsTTY: true,
      // Reading a terminal would wait for Ctrl+D: it must not happen (and what it would give is not used).
      readStdin: () => {
        read = true;
        return '{"source":"clear"}';
      },
      stdout: (t) => {
        out += t;
      },
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(read).toBe(false);
    expect(out).toContain('laneboard create "<short title of your work>"');
    expect(out).not.toContain('Your earlier sessions');
  });

  it('ALREADY_CLAIMED on an earlier session task names no --resume (claim and finish)', async () => {
    const s = await earlierTask();
    for (const argv of [['claim', 'LB-1'], ['finish', 'LB-1', '--result', 'x']]) {
      const e = JSON.parse((await cli([...argv, '--json'], { cwd: s.root, env: SESSION_B })).stdout).error;
      expect(e.code).toBe('ALREADY_CLAIMED');
      expect(`${e.message} ${e.fix}`).not.toContain('--resume');
      // Rewritten in S4 (LB-9): finish by somebody else names acceptance; claim keeps the old text. S4b: acceptance by the data.
      expect(e.message).toBe(argv[0] === 'claim' ? `task LB-1 is already claimed by ${NAME_A}; do not take it over: reassignment is the orchestrator's decision` : `task LB-1 is claimed by ${NAME_A} and is in_progress, not handed in with finish; somebody else's finish only accepts a task its assignee handed in (laneboard finish LB-1 --status <one of: in_progress, review>); do not take it over: ask ${NAME_A} to hand it in, or close it as the orchestrator: laneboard update LB-1 --status done --as ${NAME_B}`);
    }
  });
});

describe('review S3 NIT: finish checks the owner before "already closed"', () => {
  // Rewritten in S4b (owner): somebody else's finish of a closed task is a repeated acceptance (or a retry), a no-op with a warning;
  // into a status that is not final it stays ALREADY_CLAIMED.
  it("somebody else's closed task: a no-op with a warning into the final status, ALREADY_CLAIMED (exit 4) into another; nothing written", async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Done', status: 'done', assignee: 'dev-1' });
    const before = fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8');
    const r = await cli(['finish', 'LB-1', '--result', 'x', '--as', 'dev-2', '--json'], { cwd: s.root });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ data: { id: 'LB-1', rev: 1, status: 'done', assignee: 'dev-1' }, warnings: ['no changes: LB-1 is already done; the result was not recorded (add it with laneboard comment LB-1 "<text>")'] });
    const back = await cli(['finish', 'LB-1', '--result', 'x', '--status', 'review', '--as', 'dev-2', '--json'], { cwd: s.root });
    expect(back.code).toBe(4);
    expect(JSON.parse(back.stdout).error).toMatchObject({ code: 'ALREADY_CLAIMED', details: { assignee: 'dev-1' } });
    expect(fs.readFileSync(path.join(s.dir, 'active.json'), 'utf8')).toBe(before);
  });
});
