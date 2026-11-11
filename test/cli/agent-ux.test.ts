// 0.5.0, from the lb-tokens experiment (90 clean Claude Code runs): claim says how to comment a step and finish warns when no step was
// commented; the commands and options agents made up (show, edit, finish --add-link, --commit without a value) run or get a ready fix;
// text with quotes, tabs or newlines goes through stdin.
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.ts';
import { cleanupTemp, cli, newStore, readStore } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

// The --json envelope of a CLI run in the store's project (`stdin` piped in).
async function run(s: TestStore, argv: string[], stdin?: string): Promise<{ code: number; doc: Record<string, any> }> {
  const r = await cli([...argv, '--json'], { cwd: s.root, ...(stdin === undefined ? {} : { stdin }) });
  return { code: r.code, doc: JSON.parse(r.stdout) };
}

// The events of LB-1 as stored.
function events(s: TestStore): Array<{ type: string; data: Record<string, unknown> }> {
  return (readStore(s.dir, 'active').tasks[0]?.events ?? []) as Array<{ type: string; data: Record<string, unknown> }>;
}

// A board with LB-1 in todo, unassigned.
async function board(): Promise<TestStore> {
  const s = await newStore({ statuses: ['todo', 'in_progress', 'done'] });
  expect((await run(s, ['create', 'Add median', '--status', 'todo', '--as', 'orch'])).code).toBe(0);
  return s;
}

const noStepsWarning = (as: string) =>
  `no comment on LB-1 since your work on it began, so the board shows no steps of the work: comment after each step (laneboard comment LB-1 "<what you did>"${as} --json); the steps of this task can still be added`;

// 0.5.1 (ADR §59, AB-193): the `next` of a write that starts the work asks for the plan now, then each step.
const plan = (id: string, as: string) => `laneboard comment ${id} "<now: your plan; then after each step: what you did>"${as} --json`;

describe('steps: claim names the comment command, finish without a comment warns', () => {
  it('claim --json: next is the comment of your plan for this task with your --as; the human line asks for the plan now', async () => {
    const s = await board();
    const r = await run(s, ['claim', 'LB-1', '--status', 'in_progress', '--as', 'dev-1']);
    expect(r.code).toBe(0);
    expect(r.doc.data).toEqual({ id: 'LB-1', rev: 2, status: 'in_progress', assignee: 'dev-1', next: plan('LB-1', ' --as dev-1') });
    // K4: a claim of your own task again (no change) gives the same next.
    const human = await cli(['claim', 'LB-1', '--as', 'dev-1'], { cwd: s.root });
    expect(human.stdout).toBe(`LB-1 claimed (rev 2, in_progress, dev-1); now comment your plan, then each step: ${plan('LB-1', ' --as dev-1')}\n`);
    // --full shows the task, no next.
    const full = await run(s, ['claim', 'LB-1', '--full', '--as', 'dev-1']);
    expect(full.doc.data.next).toBeUndefined();
    expect((await cli(['claim', 'LB-1', '--full', '--as', 'dev-1'], { cwd: s.root })).stdout).not.toContain('now comment your plan');
  });

  it('under the session default name the command has no --as (rule 3)', async () => {
    const s = await board();
    const r = await cli(['claim', 'LB-1', '--json'], { cwd: s.root, env: { LANEBOARD_DEFAULT_AGENT: 'claude-code@ann', CLAUDE_CODE_SESSION_ID: 'aaaa1111-1a1a-4a1a-8a1a-000000000001' } });
    expect(JSON.parse(r.stdout).data.next).toBe(plan('LB-1', ''));
  });

  it('K4: a task somebody else holds: ALREADY_CLAIMED with its fix for the holder, no next', async () => {
    const s = await board();
    await run(s, ['claim', 'LB-1', '--status', 'in_progress', '--as', 'dev-1']);
    const r = await run(s, ['claim', 'LB-1', '--as', 'dev-2']);
    expect(r.code).toBe(4);
    expect(r.doc.error.code).toBe('ALREADY_CLAIMED');
    expect(r.doc.error.fix).toContain('laneboard comment LB-1');
    expect(r.doc.error.fix).not.toContain('your plan');
    expect(r.doc.data).toBeUndefined();
  });

  it('K5: two names claim one task at the same time: the first write wins with next, the other gets ALREADY_CLAIMED without it', async () => {
    const s = await board();
    const both = await Promise.all(['dev-1', 'dev-2'].map((name) => run(s, ['claim', 'LB-1', '--status', 'in_progress', '--as', name])));
    const won = both.filter((r) => r.code === 0);
    const lost = both.filter((r) => r.code !== 0);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const winner = won[0]?.doc.data.assignee as string;
    expect(won[0]?.doc.data.next).toBe(plan('LB-1', ` --as ${winner}`));
    expect(lost[0]?.code).toBe(4);
    expect(lost[0]?.doc.error.code).toBe('ALREADY_CLAIMED');
    expect(lost[0]?.doc.data).toBeUndefined();
    expect(readStore(s.dir, 'active').tasks[0]?.assignee).toBe(winner);
  });

  it('K3: create with yourself as assignee replies the same next (human line too); for nobody or another name, or right into the final status, none', async () => {
    const s = await board();
    const own = await run(s, ['create', 'Fix typo', '--status', 'in_progress', '--assignee', 'dev-5', '--as', 'dev-5']);
    expect(own.code).toBe(0);
    expect(own.doc.data).toEqual({ id: 'LB-2', rev: 1, status: 'in_progress', assignee: 'dev-5', next: plan('LB-2', ' --as dev-5') });
    const human = await cli(['create', 'Fix docs', '--status', 'todo', '--assignee', 'dev-5', '--as', 'dev-5'], { cwd: s.root });
    expect(human.stdout).toBe(`LB-3 created (rev 1, todo, dev-5); now comment your plan, then each step: ${plan('LB-3', ' --as dev-5')}\n`);
    expect((await run(s, ['create', 'Free one', '--status', 'todo', '--as', 'dev-5'])).doc.data.next).toBeUndefined();
    const other = await run(s, ['create', 'For dev-6', '--status', 'todo', '--assignee', 'dev-6', '--as', 'dev-5']);
    expect(other.doc.data.next).toBeUndefined();
    expect(other.doc.warnings[0]).toContain('is assigned to dev-6, not to you (dev-5)');
    // A record of done work: no work starts, no plan.
    expect((await run(s, ['create', 'Done before', '--status', 'done', '--assignee', 'dev-5', '--as', 'dev-5'])).doc.data.next).toBeUndefined();
    const humanOther = await cli(['create', 'For dev-7', '--status', 'todo', '--assignee', 'dev-7', '--as', 'dev-5'], { cwd: s.root });
    expect(humanOther.stdout).toBe('LB-7 created (rev 1, todo, dev-7)\n');
  });

  it('K3: create for yourself under the session default name: next without --as', async () => {
    const s = await board();
    const env = { LANEBOARD_DEFAULT_AGENT: 'claude-code@ann', CLAUDE_CODE_SESSION_ID: 'aaaa1111-1a1a-4a1a-8a1a-000000000001' };
    const name = JSON.parse((await cli(['claim', 'LB-1', '--json'], { cwd: s.root, env })).stdout).data.assignee as string;
    const r = await cli(['create', 'Mine', '--status', 'in_progress', '--assignee', name, '--json'], { cwd: s.root, env });
    expect(JSON.parse(r.stdout).data.next).toBe(plan('LB-2', ''));
  });

  it('K6: only the comment of the plan since the claim: finish gives no warning', async () => {
    const s = await board();
    await run(s, ['claim', 'LB-1', '--status', 'in_progress', '--as', 'dev-1']);
    await run(s, ['comment', 'LB-1', 'plan: add median() to stats.py, then a test', '--as', 'dev-1']);
    expect((await run(s, ['finish', 'LB-1', '--result', 'median added', '--no-commit', '--as', 'dev-1'])).doc.warnings).toEqual([]);
  });

  it('finish with no comment since the claim: the result is recorded, a warning names the comment command (exit 0)', async () => {
    const s = await board();
    await run(s, ['claim', 'LB-1', '--status', 'in_progress', '--as', 'dev-1']);
    const r = await run(s, ['finish', 'LB-1', '--result', 'median added', '--no-commit', '--as', 'dev-1']);
    expect(r.code).toBe(0);
    expect(r.doc.data.status).toBe('done');
    expect(r.doc.warnings).toEqual([noStepsWarning(' --as dev-1')]);
  });

  it('a comment of yours after the claim: no warning; a comment before the claim or by somebody else does not count', async () => {
    const s = await board();
    await run(s, ['comment', 'LB-1', 'before the claim', '--as', 'dev-1']);
    await run(s, ['claim', 'LB-1', '--status', 'in_progress', '--as', 'dev-1']);
    await run(s, ['comment', 'LB-1', 'a note from the orchestrator', '--as', 'orch']);
    // A hand-in (finish into a status that is not final) warns too.
    expect((await run(s, ['finish', 'LB-1', '--result', 'r', '--status', 'in_progress', '--no-commit', '--as', 'dev-1'])).doc.warnings).toEqual([noStepsWarning(' --as dev-1')]);
  });

  it('the warning names no claim: a task created for you, or an unassigned one your finish takes, warns the same', async () => {
    const s = await board();
    // Rule 4's other start: create with yourself as assignee (no claim).
    expect((await run(s, ['create', 'Fix typo', '--status', 'in_progress', '--assignee', 'dev-5', '--as', 'dev-5'])).code).toBe(0);
    const created = await run(s, ['finish', 'LB-2', '--result', 'typo fixed', '--no-commit', '--as', 'dev-5']);
    expect(created.doc.warnings).toEqual([noStepsWarning(' --as dev-5').replaceAll('LB-1', 'LB-2')]);
    const free = await run(s, ['finish', 'LB-1', '--result', 'median added', '--no-commit', '--as', 'dev-1']);
    expect(free.doc.warnings).toEqual([noStepsWarning(' --as dev-1')]);
    expect(free.doc.warnings[0]).not.toContain('claim');
  });

  it('a step commented: finish gives no warning', async () => {
    const s = await board();
    await run(s, ['claim', 'LB-1', '--status', 'in_progress', '--as', 'dev-1']);
    await run(s, ['comment', 'LB-1', 'added median()', '--as', 'dev-1']);
    expect((await run(s, ['finish', 'LB-1', '--result', 'median added', '--no-commit', '--as', 'dev-1'])).doc.warnings).toEqual([]);
  });
});

describe('commands and options agents made up', () => {
  it('show runs as get, edit as update; the help lists neither', async () => {
    const s = await board();
    const shown = await run(s, ['show', 'LB-1']);
    expect(shown.code).toBe(0);
    expect(shown.doc.data).toMatchObject({ id: 'LB-1', title: 'Add median' });
    const edited = await run(s, ['edit', 'LB-1', '--append-description', 'criterion: 3 words', '--as', 'dev-1']);
    expect(edited.code).toBe(0);
    expect(readStore(s.dir, 'active').tasks[0]?.description).toBe('criterion: 3 words');
    // A fix of an alias names the command itself.
    expect((await run(s, ['edit', 'LB-1', '--stauts', 'done', '--as', 'dev-1'])).doc.error.fix).toBe('laneboard update LB-1 --status done --as dev-1 --json');
    const help = await cli(['--help'], { cwd: s.root });
    expect(help.stdout).not.toMatch(/^ {2}(show|edit) /m);
  });

  it('an unknown command that is another word for one: the fix is that command, ready to run', async () => {
    const s = await board();
    const r = await run(s, ['info', 'LB-1']);
    expect(r.code).toBe(2);
    expect(r.doc.error.fix).toBe('laneboard get LB-1 --json');
    expect(r.doc.error.fix).not.toContain('<');
  });

  it('an alias that is not the first word (--json show LB-1): the fix moves the command itself first (review 044 NIT)', async () => {
    const s = await board();
    const r = await cli(['--json', 'show', 'LB-1'], { cwd: s.root });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error.fix).toBe('laneboard get --json LB-1');
    const edited = await cli(['--as', 'dev-1', 'edit', 'LB-1', '--status', 'done', '--json'], { cwd: s.root });
    expect(JSON.parse(edited.stdout).error.fix).toBe('laneboard update --as dev-1 LB-1 --status done --json');
    // No command at all: prime, as before.
    expect(JSON.parse((await cli(['--json', 'LB-1'], { cwd: s.root })).stdout).error.fix).toBe('laneboard prime --json LB-1');
  });

  it('close, done, complete or a typo of finish: the fix is finish with --result <result>, the option it cannot run without (review 044 NIT)', async () => {
    const s = await board();
    for (const word of ['close', 'done', 'complete', 'finsh']) {
      const r = await run(s, [word, 'LB-1', '--as', 'dev-3']);
      expect(r.code, word).toBe(2);
      expect(r.doc.error.fix, word).toBe('laneboard finish LB-1 --as dev-3 --json --result <result>');
    }
    // A result given, by option or as a file, is not asked for again; text after `--` stays text.
    expect((await run(s, ['close', 'LB-1', '--result', 'r', '--as', 'dev-3'])).doc.error.fix).toBe('laneboard finish LB-1 --result r --as dev-3 --json');
    expect((await run(s, ['close', 'LB-1', '--result=r', '--as', 'dev-3'])).doc.error.fix).toBe('laneboard finish LB-1 --result=r --as dev-3 --json');
    expect((await run(s, ['close', 'LB-1', '--result-file', '-', '--as', 'dev-3'])).doc.error.fix).toBe('laneboard finish LB-1 --result-file - --as dev-3 --json');
    expect((await cli(['close', 'LB-1', '--json', '--', '--result'], { cwd: s.root })).stdout).toContain('"fix":"laneboard finish LB-1 --json --result=--result"');
  });

  it('done with the result as a word: the fix passes it as --result, and runs as printed (review 051 MINOR)', async () => {
    const s = await board();
    await run(s, ['claim', 'LB-1', '--status', 'in_progress', '--as', 'dev-3']);
    expect((await run(s, ['done', 'LB-1', 'Added median', '--as', 'dev-3'])).doc.error.fix).toBe("laneboard finish LB-1 --as dev-3 --json '--result=Added median'");
    const r = await run(s, ['done', 'LB-1', "it's median", '--as', 'dev-3']);
    expect(r.doc.error.fix).toBe("laneboard finish LB-1 --as dev-3 --json '--result=it'\\''s median'");
    const argv = ['finish', 'LB-1', "--result=it's median", '--no-commit', '--as', 'dev-3'];
    const done = await run(s, argv);
    expect(done.code).toBe(0);
    expect(JSON.stringify(events(s))).toContain("it's median");
  });

  it('new or add: the fix is create with --status <first status> of the board (review 044 NIT, as create --title)', async () => {
    const s = await board();
    expect((await run(s, ['new', 'Add mode', '--as', 'dev-3'])).doc.error.fix).toBe('laneboard create \'Add mode\' --as dev-3 --json --status todo');
    expect((await run(s, ['add', 'Add mode', '--status', 'in_progress', '--as', 'dev-3'])).doc.error.fix).toBe('laneboard create \'Add mode\' --status in_progress --as dev-3 --json');
  });

  it('finish --add-link commit=<sha>: accepted, the commit is the named one (no HEAD next to it); other links are added', async () => {
    const s = await board();
    await run(s, ['claim', 'LB-1', '--status', 'in_progress', '--as', 'dev-1']);
    const sha = '89a3186c0ffee';
    const r = await run(s, ['finish', 'LB-1', '--result', 'r', '--add-link', `commit=${sha}`, '--add-link', 'pr=https://example.invalid/pr/1', '--as', 'dev-1']);
    expect(r.code).toBe(0);
    expect(r.doc.data).toMatchObject({ status: 'done', commit: sha });
    expect(readStore(s.dir, 'active').tasks[0]?.links).toEqual([
      { kind: 'commit', ref: sha },
      { kind: 'pr', ref: 'https://example.invalid/pr/1' },
    ]);
  });

  it('finish --commit without a value: the fix leaves it out (HEAD is linked), no <value> placeholder', async () => {
    const s = await board();
    const r = await run(s, ['finish', 'LB-1', '--result', 'r', '--commit', '--as', 'dev-1']);
    expect(r.code).toBe(2);
    expect(r.doc.error.message).toBe('--commit needs a value; without it finish links HEAD of this folder');
    expect(r.doc.error.fix).toBe('laneboard finish LB-1 --result r --as dev-1 --json');
  });

  it('an unknown option that is another name for one (finish --message): the fix uses the option', async () => {
    const s = await board();
    const r = await run(s, ['finish', 'LB-1', '--message', 'done', '--as', 'dev-1']);
    expect(r.doc.error).toMatchObject({ code: 'UNKNOWN_OPTION', fix: 'laneboard finish LB-1 --result done --as dev-1 --json' });
  });

  it.each([
    ['--link', 'pr=https://example.invalid/pr/1', '--add-link'],
    ['--desc', 'criterion: 3 words', '--description'],
    ['--label', 'ui', '--add-label'],
    ['--append', 'criterion: 3 words', '--append-description'],
    ['--assign', 'dev-2', '--assignee'],
  ])('update %s %s (another name for an option): UNKNOWN_OPTION, the fix uses %s', async (typed, value, meant) => {
    const s = await board();
    const r = await run(s, ['update', 'LB-1', typed, value, '--as', 'dev-1']);
    expect(r.code).toBe(2);
    expect(r.doc.error).toMatchObject({ code: 'UNKNOWN_OPTION', fix: `laneboard update LB-1 ${meant} ${value.includes(' ') ? `'${value}'` : value} --as dev-1 --json` });
    // Nothing was written.
    expect(readStore(s.dir, 'active').tasks[0]?.rev).toBe(1);
  });

  it('claim --status or --expected-rev without a value: USAGE, the fix leaves the option out (no <value> placeholder)', async () => {
    const s = await board();
    const r = await run(s, ['claim', 'LB-1', '--status', '--as', 'dev-1']);
    expect(r.code).toBe(2);
    expect(r.doc.error).toMatchObject({
      code: 'USAGE',
      message: '--status needs a value; without it claim moves your task from the first status to the work status',
      fix: 'laneboard claim LB-1 --as dev-1 --json',
    });
    const rev = await run(s, ['claim', 'LB-1', '--expected-rev', '--as', 'dev-1']);
    expect(rev.doc.error).toMatchObject({ code: 'USAGE', message: '--expected-rev needs a value; without it claim needs no rev', fix: 'laneboard claim LB-1 --as dev-1 --json' });
    // The fix runs as printed.
    expect((await run(s, ['claim', 'LB-1', '--as', 'dev-1'])).code).toBe(0);
  });

  it('UNKNOWN_FIELD with an unknown key and one declared field: the fix keeps the placeholder (a guess could set the wrong field)', async () => {
    const s = await board();
    const r = await run(s, ['update', 'LB-1', '--field', 'color=red', '--as', 'dev-1']);
    expect(r.doc.error).toMatchObject({ code: 'UNKNOWN_FIELD', fix: 'laneboard update LB-1 --field <field from allowed>=red --as dev-1 --json' });
  });
});

describe('finish of somebody else\'s task with --add-link', () => {
  it('the acceptance adds no links and warns with the update command that adds them', async () => {
    const s = await board();
    await run(s, ['claim', 'LB-1', '--status', 'in_progress', '--as', 'dev-1']);
    await run(s, ['comment', 'LB-1', 'added median()', '--as', 'dev-1']);
    expect((await run(s, ['finish', 'LB-1', '--result', 'r', '--status', 'in_progress', '--no-commit', '--as', 'dev-1'])).doc.data.handed_in).toBe(true);
    const r = await run(s, ['finish', 'LB-1', '--result', 'ok', '--add-link', 'pr=https://example.invalid/pr/1', '--as', 'orch']);
    expect(r.code).toBe(0);
    expect(r.doc.data).toMatchObject({ status: 'done', accepted: true });
    expect(r.doc.warnings).toEqual(["links not added: only the assignee's finish adds links; laneboard update LB-1 --add-link pr=https://example.invalid/pr/1 --as orch --json"]);
    expect(readStore(s.dir, 'active').tasks[0]?.links).toEqual([]);
  });
});

describe('text from stdin', () => {
  const text = "Acceptance: word_count('a\\tb\\nc') returns 3\n- \"quoted\" line\n";

  it('comment <ID> - and --text-file -: the text from stdin, byte for byte', async () => {
    const s = await board();
    expect((await run(s, ['comment', 'LB-1', '-', '--as', 'dev-1'], text)).code).toBe(0);
    expect((await run(s, ['comment', 'LB-1', '--text-file', '-', '--as', 'dev-1'], text)).code).toBe(0);
    const comments = events(s).filter((e) => e.type === 'commented').map((e) => e.data.text);
    expect(comments).toEqual([text, text]);
  });

  it('comment <ID> -- - reads stdin as comment <ID> - does (kept in 0.5.1: the heredoc fix and rule 14 put `--` before `-`)', async () => {
    const s = await board();
    expect((await cli(['comment', 'LB-1', '--as', 'dev-1', '--json', '--', '-'], { cwd: s.root, stdin: text })).code).toBe(0);
    expect(events(s).filter((e) => e.type === 'commented').map((e) => e.data.text)).toEqual([text]);
  });

  it('update --append-description-file - and finish --result-file -: from stdin', async () => {
    const s = await board();
    expect((await run(s, ['update', 'LB-1', '--append-description-file', '-', '--as', 'dev-1'], text)).code).toBe(0);
    expect(readStore(s.dir, 'active').tasks[0]?.description).toBe(text);
    await run(s, ['claim', 'LB-1', '--as', 'dev-1']);
    expect((await run(s, ['finish', 'LB-1', '--result-file', '-', '--no-commit', '--as', 'dev-1'], text)).code).toBe(0);
    const result = events(s).find((e) => e.type === 'commented' && e.data.result === true);
    expect(result?.data.text).toBe(text);
  });

  it('a terminal on stdin: USAGE before any read, the fix is the same command with a heredoc', async () => {
    const s = await board();
    for (const [argv, what] of [
      [['comment', 'LB-1', '-', '--as', 'dev-1', '--json'], 'the text -'],
      [['finish', 'LB-1', '--result-file', '-', '--as', 'dev-1', '--json'], '--result-file -'],
      [['update', 'LB-1', '--append-description-file', '-', '--as', 'dev-1', '--json'], '--append-description-file -'],
    ] as const) {
      let stdout = '';
      let read = false;
      const code = await runCli({
        argv: [...argv],
        env: {},
        cwd: s.root,
        stdinIsTTY: true,
        // Reading a terminal waits for Ctrl+D, then fails with EAGAIN: it must not happen.
        readStdin: () => {
          read = true;
          return 'typed';
        },
        stdout: (t) => {
          stdout += t;
        },
        stderr: () => undefined,
      });
      expect(code).toBe(2);
      expect(read).toBe(false);
      expect(JSON.parse(stdout).error).toMatchObject({
        code: 'USAGE',
        message: `${what} reads the text from stdin, and stdin is a terminal here: pipe the text in`,
        fix: `laneboard ${argv.join(' ')} <<'EOF' ... EOF`,
      });
    }
    expect(readStore(s.dir, 'active').tasks[0]?.rev).toBe(1);
  });

  it('an empty stdin for a comment or a result: INVALID_VALUE that says stdin was empty, with the heredoc fix', async () => {
    const s = await board();
    await run(s, ['claim', 'LB-1', '--as', 'dev-1']);
    for (const [argv, what] of [
      [['comment', 'LB-1', '-', '--as', 'dev-1'], 'the text -'],
      [['comment', 'LB-1', '--file', '-', '--as', 'dev-1'], '--file -'],
      [['finish', 'LB-1', '--result-file', '-', '--as', 'dev-1'], '--result-file -'],
    ] as const) {
      const r = await run(s, [...argv], '');
      expect(r.code).toBe(2);
      expect(r.doc.error).toMatchObject({
        code: 'INVALID_VALUE',
        message: `${what}: stdin is empty, and the text must not be empty`,
        fix: `laneboard ${argv.join(' ')} --json <<'EOF' ... EOF`,
      });
    }
    // Only the claim was written (rev 2): no comment, no result.
    expect(readStore(s.dir, 'active').tasks[0]?.rev).toBe(2);
  });

  it('--result with --result-file, --file with --text-file: USAGE', async () => {
    const s = await board();
    expect((await run(s, ['finish', 'LB-1', '--result', 'a', '--result-file', '-', '--as', 'dev-1'], 'b')).doc.error.code).toBe('USAGE');
    expect((await run(s, ['comment', 'LB-1', '--file', '-', '--text-file', '-', '--as', 'dev-1'], 'b')).doc.error.code).toBe('USAGE');
  });
});
