// S6u (UX run 2, B-U1): the author of the work never hands a task back into a check it is in or passed. A task that waits in a check
// (handed in, passed on) is refused with "handed in already, waits for <check> of <checkers>" and a comment as the fix; no fix of a
// refusal names an earlier check than the one the task is in. Persona B's flow: dev -> code_review -> qa -> done, checkers rev, orch.
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTemp, cli, newStore } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

const FLOW = ['backlog', 'ready', 'dev', 'code_review', 'qa', 'done'];

// Run the CLI with --json in `s` as `actor`; the exit code and the parsed envelope.
async function run(s: TestStore, actor: string, argv: string[]): Promise<{ code: number; doc: Record<string, any> }> {
  const r = await cli([...argv, '--as', actor, '--json'], { cwd: s.root });
  return { code: r.code, doc: JSON.parse(r.stdout) };
}

// The task as `get` shows it, with its events.
async function task(s: TestStore, id: string): Promise<Record<string, any>> {
  return (await run(s, 'orch', ['get', id, '--events', '100'])).doc.data;
}

// API-1 held by dev-2, handed in to code_review and passed on to qa by rev: it waits for the qa check.
async function inQa(): Promise<TestStore> {
  const s = await newStore({ prefix: 'API', statuses: FLOW });
  expect((await run(s, 'orch', ['config', '--review-statuses', 'code_review,qa', '--reviewers', 'rev,orch'])).code).toBe(0);
  expect((await run(s, 'orch', ['create', 'Add endpoint', '--status', 'ready'])).code).toBe(0);
  expect((await run(s, 'dev-2', ['claim', 'API-1', '--status', 'dev'])).code).toBe(0);
  expect((await run(s, 'dev-2', ['finish', 'API-1', '--result', 'work', '--no-commit'])).doc.data.status).toBe('code_review');
  expect((await run(s, 'rev', ['finish', 'API-1', '--result', 'review ok'])).doc.data).toMatchObject({ status: 'qa', passed: true });
  return s;
}

const WAITS_IN_QA = {
  code: 'INVALID_VALUE',
  message:
    'API-1 is handed in already and waits in qa for the check of rev, orch (code_review -> qa -> done): nothing to do; the author never moves it to another check or into done, and a note for the checkers is a comment',
  fix: 'laneboard comment API-1 "<note for the check>" --as dev-2',
};

describe('S6u B-U1: no hand-in back into a check the task passed', () => {
  it('the repro: finish --status done, then the old fix --status code_review: both refused, the task stays in qa, rev unchanged', async () => {
    const s = await inQa();
    const before = await task(s, 'API-1');
    for (const to of ['done', 'code_review']) {
      const r = await run(s, 'dev-2', ['finish', 'API-1', '--status', to, '--result', 'close it', '--no-commit']);
      expect(r.code, to).toBe(2);
      expect(r.doc.error, to).toEqual(WAITS_IN_QA);
    }
    const after = await task(s, 'API-1');
    expect(after).toMatchObject({ status: 'qa', rev: before.rev });
    expect(after.events).toEqual(before.events);
  });

  it('update and claim of the author into any other check or done get the same refusal; no fix names code_review', async () => {
    const s = await inQa();
    for (const argv of [
      ['update', 'API-1', '--status', 'done'],
      ['claim', 'API-1', '--status', 'done'],
      ['finish', 'API-1', '--status', 'code_review', '--result', 'again', '--no-commit'],
    ]) {
      const r = await run(s, 'dev-2', argv);
      expect(r.doc.error, argv.join(' ')).toEqual(WAITS_IN_QA);
    }
    // The fix runs as printed (rule 13): a comment, the task stays in qa and waits for the check.
    const fixed = await cli(['comment', 'API-1', '<note for the check>', '--as', 'dev-2', '--json'], { cwd: s.root });
    expect(fixed.code).toBe(0);
    expect(await task(s, 'API-1')).toMatchObject({ status: 'qa' });
    expect((await run(s, 'orch', ['finish', 'API-1', '--result', 'qa ok'])).doc.data).toMatchObject({ status: 'done', accepted: true, from: 'qa' });
  });

  it('a former author that no longer holds the task gets the same refusal for an earlier check (no loop of fixes)', async () => {
    const s = await inQa();
    expect((await run(s, 'dev-2', ['update', 'API-1', '--assignee', 'dev-3'])).code).toBe(0);
    const r = await run(s, 'dev-2', ['finish', 'API-1', '--status', 'code_review', '--result', 'again']);
    expect(r.doc.error).toEqual(WAITS_IN_QA);
    expect(await task(s, 'API-1')).toMatchObject({ status: 'qa', assignee: 'dev-3' });
  });

  it('the holder records a new result where the task waits (A15 kept): finish without --status or with qa, no status move', async () => {
    const s = await inQa();
    expect((await run(s, 'dev-2', ['finish', 'API-1', '--result', 'v2 after a note', '--no-commit'])).doc.data.status).toBe('qa');
    expect((await run(s, 'dev-2', ['finish', 'API-1', '--status', 'qa', '--result', 'v3', '--no-commit'])).doc.data.status).toBe('qa');
    const ev = (await task(s, 'API-1')).events as Array<Record<string, any>>;
    expect(ev.filter((e) => e.type === 'status').map((e) => e.data.to)).toEqual(['dev', 'code_review', 'qa']);
    expect(ev.filter((e) => e.data.result === true).map((e) => e.data.text)).toEqual(['work', 'review ok', 'v2 after a note', 'v3']);
  });

  it('a task put into qa by update (not handed in): the author hands it in there, never back to code_review', async () => {
    const s = await newStore({ prefix: 'API', statuses: FLOW });
    await run(s, 'orch', ['config', '--review-statuses', 'code_review,qa', '--reviewers', 'rev,orch']);
    await run(s, 'orch', ['create', 'Hotfix', '--status', 'ready']);
    await run(s, 'dev-2', ['claim', 'API-1', '--status', 'dev']);
    expect((await run(s, 'orch', ['update', 'API-1', '--status', 'qa'])).doc.data.status).toBe('qa');
    const back = await run(s, 'dev-2', ['finish', 'API-1', '--status', 'code_review', '--result', 'r', '--no-commit']);
    expect(back.code).toBe(2);
    expect(back.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard finish API-1 --status qa --result r --no-commit --as dev-2 --json' });
    const checker = await run(s, 'rev', ['finish', 'API-1', '--result', 'x']);
    expect(checker.doc.error.fix).toBe('laneboard comment API-1 "hand it in: laneboard finish API-1 --status qa --result <result>" --as rev');
    const handIn = await run(s, 'dev-2', ['finish', 'API-1', '--result', 'r', '--no-commit']);
    expect(handIn.doc.data).toMatchObject({ status: 'qa' });
    expect((await run(s, 'orch', ['finish', 'API-1', '--result', 'qa ok'])).doc.data).toMatchObject({ status: 'done', accepted: true, from: 'qa' });
  });
});
