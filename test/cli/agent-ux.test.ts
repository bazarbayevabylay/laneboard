// 0.4.4, from the lb-tokens experiment (90 clean Claude Code runs): claim says how to comment a step and finish warns when no step was
// commented; the commands and options agents made up (show, edit, finish --add-link, --commit without a value) run or get a ready fix;
// text with quotes, tabs or newlines goes through stdin.
import { afterAll, describe, expect, it } from 'vitest';
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
  `no comment on LB-1 between your claim and this finish, so the board shows no steps of the work: comment after each step (laneboard comment LB-1 "<what you did>"${as} --json); the steps of this task can still be added`;

describe('steps: claim names the comment command, finish without a comment warns', () => {
  it('claim --json: next is the comment command for this task with your --as; the human line names it too', async () => {
    const s = await board();
    const r = await run(s, ['claim', 'LB-1', '--status', 'in_progress', '--as', 'dev-1']);
    expect(r.code).toBe(0);
    expect(r.doc.data).toEqual({ id: 'LB-1', rev: 2, status: 'in_progress', assignee: 'dev-1', next: 'laneboard comment LB-1 "<what you did>" --as dev-1 --json' });
    const human = await cli(['claim', 'LB-1', '--as', 'dev-1'], { cwd: s.root });
    expect(human.stdout).toBe('LB-1 claimed (rev 2, in_progress, dev-1); after each step: laneboard comment LB-1 "<what you did>" --as dev-1 --json\n');
  });

  it('under the session default name the command has no --as (rule 3)', async () => {
    const s = await board();
    const r = await cli(['claim', 'LB-1', '--json'], { cwd: s.root, env: { LANEBOARD_DEFAULT_AGENT: 'claude-code@ann', CLAUDE_CODE_SESSION_ID: 'aaaa1111-1a1a-4a1a-8a1a-000000000001' } });
    expect(JSON.parse(r.stdout).data.next).toBe('laneboard comment LB-1 "<what you did>" --json');
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

  it('UNKNOWN_FIELD with an unknown key and one declared field: the fix keeps the placeholder (a guess could set the wrong field)', async () => {
    const s = await board();
    const r = await run(s, ['update', 'LB-1', '--field', 'color=red', '--as', 'dev-1']);
    expect(r.doc.error).toMatchObject({ code: 'UNKNOWN_FIELD', fix: 'laneboard update LB-1 --field <field from allowed>=red --as dev-1 --json' });
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

  it('update --append-description-file - and finish --result-file -: from stdin', async () => {
    const s = await board();
    expect((await run(s, ['update', 'LB-1', '--append-description-file', '-', '--as', 'dev-1'], text)).code).toBe(0);
    expect(readStore(s.dir, 'active').tasks[0]?.description).toBe(text);
    await run(s, ['claim', 'LB-1', '--as', 'dev-1']);
    expect((await run(s, ['finish', 'LB-1', '--result-file', '-', '--no-commit', '--as', 'dev-1'], text)).code).toBe(0);
    const result = events(s).find((e) => e.type === 'commented' && e.data.result === true);
    expect(result?.data.text).toBe(text);
  });

  it('--result with --result-file, --file with --text-file: USAGE', async () => {
    const s = await board();
    expect((await run(s, ['finish', 'LB-1', '--result', 'a', '--result-file', '-', '--as', 'dev-1'], 'b')).doc.error.code).toBe('USAGE');
    expect((await run(s, ['comment', 'LB-1', '--file', '-', '--text-file', '-', '--as', 'dev-1'], 'b')).doc.error.code).toBe('USAGE');
  });
});
