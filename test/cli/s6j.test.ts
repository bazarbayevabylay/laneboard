// S6j: checks in N steps (P1: A14 in the form review {statuses, by}, B-U1, B-U2, B-U5; A17; A-U5) and the create_by key (P2).
// The flow of persona B: backlog, ready, dev, code_review, qa, done with `config --review-statuses code_review,qa --reviewers rev,orch`.
// Owner TG 8723: every new key is optional, a board without them behaves as in 0.3.1, config@2 only while one of them is on.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CONFIG_SCHEMA, CONFIG_SCHEMA_V2 } from '../../src/core/schema.ts';
import { cleanupTemp, cli, newStore, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

const FLOW = ['backlog', 'ready', 'dev', 'code_review', 'qa', 'done'];

// Run the CLI with --json in `s` as `actor`; the exit code and the parsed envelope.
async function run(s: TestStore, actor: string, argv: string[]): Promise<{ code: number; doc: Record<string, any> }> {
  const r = await cli([...argv, '--as', actor, '--json'], { cwd: s.root });
  return { code: r.code, doc: JSON.parse(r.stdout) };
}

// The list row of `id` (handed_in, in_work, stale marks).
async function row(s: TestStore, id: string): Promise<Record<string, any>> {
  const r = await run(s, 'orch', ['list', '--scope', 'active']);
  return r.doc.data.items.find((t: { id: string }) => t.id === id);
}

// The events of `id` as stored.
async function events(s: TestStore, id: string): Promise<Array<Record<string, any>>> {
  const r = await run(s, 'orch', ['get', id, '--events', '100']);
  return r.doc.data.events;
}

// The text of config.json.
function configText(s: TestStore): string {
  return fs.readFileSync(path.join(s.dir, 'config.json'), 'utf8');
}

// Persona B's board: six statuses, checks code_review then qa, checkers rev and orch; API-1 in dev held by dev-a.
async function reviewBoard(by: string[] = ['rev', 'orch']): Promise<TestStore> {
  const s = await newStore({ prefix: 'API', statuses: FLOW });
  const conf = await run(s, 'orch', ['config', '--review-statuses', 'code_review,qa', ...(by.length ? ['--reviewers', by.join(',')] : [])]);
  expect(conf.code).toBe(0);
  expect((await run(s, 'orch', ['create', 'Add endpoint', '--status', 'ready'])).code).toBe(0);
  expect((await run(s, 'dev-a', ['claim', 'API-1', '--status', 'dev'])).code).toBe(0);
  return s;
}

describe('P1 criteria (1)-(8): a task goes dev -> code_review -> qa -> done with finish alone', () => {
  it('(1)-(3): the assignee hands in to the first check, rev passes it to qa (still handed in), orch accepts; three results', async () => {
    const s = await reviewBoard();
    const handIn = await run(s, 'dev-a', ['finish', 'API-1', '--result', 'r', '--no-commit']);
    expect(handIn.code).toBe(0);
    expect(handIn.doc.data).toMatchObject({ status: 'code_review', assignee: 'dev-a' });
    expect(await row(s, 'API-1')).toMatchObject({ status: 'code_review', handed_in: true, in_work: false, stale: false });

    const pass = await run(s, 'rev', ['finish', 'API-1', '--result', 'ok']);
    expect(pass.code).toBe(0);
    expect(pass.doc.data).toMatchObject({ status: 'qa', assignee: 'dev-a', passed: true, from: 'code_review', commit: null });
    expect(pass.doc.data.accepted).toBeUndefined();
    // B-U5: waiting in qa is not the assignee's work, so neither in work nor (after 4 h) stale.
    expect(await row(s, 'API-1')).toMatchObject({ status: 'qa', handed_in: true, in_work: false, stale: false });
    const human = await cli(['finish', 'API-1', '--result', 'qa ok', '--as', 'orch', '--status', 'qa'], { cwd: s.root });
    expect(human.code).toBe(2); // qa is where the task is: a check moves it on only

    const accept = await run(s, 'orch', ['finish', 'API-1', '--result', 'accepted']);
    expect(accept.code).toBe(0);
    expect(accept.doc.data).toMatchObject({ status: 'done', accepted: true, from: 'qa', commit: null });
    const ev = await events(s, 'API-1');
    expect(ev.filter((e) => e.type === 'commented' && e.data.result === true).map((e) => [e.actor, e.data.text])).toEqual([
      ['dev-a', 'r'],
      ['rev', 'ok'],
      ['orch', 'accepted'],
    ]);
    expect(ev.filter((e) => e.type === 'status').map((e) => e.data)).toEqual([
      { from: 'ready', to: 'dev' },
      { from: 'dev', to: 'code_review', handed_in: true },
      { from: 'code_review', to: 'qa', passed: true },
      { from: 'qa', to: 'done', accepted: true },
    ]);
  });

  it('the CLI line of a pass names the next check', async () => {
    const s = await reviewBoard();
    await run(s, 'dev-a', ['finish', 'API-1', '--result', 'r', '--no-commit']);
    const r = await cli(['finish', 'API-1', '--result', 'ok', '--as', 'rev'], { cwd: s.root });
    expect(r.stdout).toContain('API-1 passed to qa (rev 4, qa, dev-a)');
  });

  it('(4): the assignee into the final status: finish and update are INVALID_VALUE with the hand-in to code_review as the fix', async () => {
    const s = await reviewBoard();
    const viaFinish = await run(s, 'dev-a', ['finish', 'API-1', '--status', 'done', '--result', 'r', '--no-commit']);
    expect(viaFinish.code).toBe(2);
    expect(viaFinish.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard finish API-1 --status code_review --result r --no-commit --as dev-a --json' });
    const viaUpdate = await run(s, 'dev-a', ['update', 'API-1', '--status', 'done']);
    expect(viaUpdate.code).toBe(2);
    expect(viaUpdate.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard finish API-1 --status code_review --result "<what you did, how you checked it>" --as dev-a' });
    // Nor a later check: the assignee does not skip code_review.
    expect((await run(s, 'dev-a', ['finish', 'API-1', '--status', 'qa', '--result', 'r', '--no-commit'])).doc.error.code).toBe('INVALID_VALUE');
    expect((await row(s, 'API-1')).status).toBe('dev');
  });

  it('(5): somebody not in review.by cannot pass on, accept or close: ALREADY_CLAIMED with the comment as the fix', async () => {
    const s = await reviewBoard();
    await run(s, 'dev-a', ['finish', 'API-1', '--result', 'r', '--no-commit']);
    const r = await run(s, 'dev-b', ['finish', 'API-1', '--result', 'lgtm']);
    expect(r.code).toBe(4);
    expect(r.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', fix: 'laneboard comment API-1 "<note for dev-a>" --as dev-b' });
    expect(r.doc.error.message).not.toContain('laneboard update');
    const closing = await run(s, 'dev-b', ['update', 'API-1', '--status', 'done']);
    expect(closing.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', fix: 'laneboard comment API-1 "<note for dev-a>" --as dev-b' });
    // The orchestrator in review.by still closes by update (no acceptance mark).
    expect((await run(s, 'orch', ['update', 'API-1', '--status', 'done'])).code).toBe(0);
  });

  it('(6): rev returns the task with update --status dev: the hand-in is gone, with the A17 warning; the comment is the last one dev-a sees', async () => {
    const s = await reviewBoard();
    await run(s, 'dev-a', ['finish', 'API-1', '--result', 'r', '--no-commit']);
    expect((await run(s, 'rev', ['comment', 'API-1', 'REWORK: tests missing'])).code).toBe(0);
    const back = await run(s, 'rev', ['update', 'API-1', '--status', 'dev']);
    expect(back.code).toBe(0);
    expect(back.doc.warnings).toEqual(['API-1 was handed in; after this move it is not: pass it on or accept it with laneboard finish API-1 --result "<result>" instead, or the assignee hands it in again with finish']);
    expect(await row(s, 'API-1')).toMatchObject({ status: 'dev', handed_in: false, in_work: true, last_comment: { actor: 'rev', text: 'REWORK: tests missing' } });
    // Handed in again after rework: a new hand-in to code_review with the new result (A15).
    const again = await run(s, 'dev-a', ['finish', 'API-1', '--result', 'r2 with tests', '--no-commit']);
    expect(again.doc.data.status).toBe('code_review');
    expect((await events(s, 'API-1')).filter((e) => e.data.result === true).map((e) => e.data.text)).toEqual(['r', 'r2 with tests']);
  });

  it('A15: returned by a comment only, the assignee hands in again into the same check: the new result is recorded, the task stays handed in', async () => {
    const s = await reviewBoard();
    await run(s, 'dev-a', ['finish', 'API-1', '--result', 'v1', '--no-commit']);
    await run(s, 'rev', ['comment', 'API-1', 'REWORK']);
    const v2 = await run(s, 'dev-a', ['finish', 'API-1', '--result', 'v2', '--no-commit']);
    expect(v2.code).toBe(0);
    expect((await events(s, 'API-1')).filter((e) => e.data.result === true).map((e) => e.data.text)).toEqual(['v1', 'v2']);
    expect(await row(s, 'API-1')).toMatchObject({ status: 'code_review', handed_in: true });
  });

  it('(7): rev runs its finish again (a lost reply): no changes, the task stays in qa', async () => {
    const s = await reviewBoard();
    await run(s, 'dev-a', ['finish', 'API-1', '--result', 'r', '--no-commit']);
    await run(s, 'rev', ['finish', 'API-1', '--result', 'ok']);
    const again = await run(s, 'rev', ['finish', 'API-1', '--result', 'ok']);
    expect(again.code).toBe(0);
    expect(again.doc.data).toMatchObject({ status: 'qa' });
    expect(again.doc.warnings[0]).toMatch(/^no changes: API-1 is already qa, where you passed it on/);
    const explicitAgain = await run(s, 'rev', ['finish', 'API-1', '--result', 'ok', '--status', 'qa']);
    expect(explicitAgain.doc.data.status).toBe('qa');
    // The same checker moves it on only by naming the status; an earlier check is refused.
    expect((await run(s, 'rev', ['finish', 'API-1', '--result', 'x', '--status', 'code_review'])).doc.error).toMatchObject({ code: 'INVALID_VALUE', allowed: ['done'] });
    expect((await run(s, 'rev', ['finish', 'API-1', '--result', 'qa too', '--status', 'done'])).doc.data).toMatchObject({ status: 'done', accepted: true, from: 'qa' });
  });

  it('(8): rev and orch finish at once from code_review: both exit 0, the second goes on from qa', async () => {
    const s = await reviewBoard();
    await run(s, 'dev-a', ['finish', 'API-1', '--result', 'r', '--no-commit']);
    const [a, b] = await Promise.all([run(s, 'rev', ['finish', 'API-1', '--result', 'rev ok']), run(s, 'orch', ['finish', 'API-1', '--result', 'orch ok'])]);
    expect([a.code, b.code]).toEqual([0, 0]);
    const froms = [a.doc.data.from, b.doc.data.from].sort();
    expect(froms).toEqual(['code_review', 'qa']);
    expect((await row(s, 'API-1')).status).toBe('done');
  });

  it('review.by empty: anybody but the assignee checks', async () => {
    const s = await reviewBoard([]);
    await run(s, 'dev-a', ['finish', 'API-1', '--result', 'r', '--no-commit']);
    expect((await run(s, 'dev-b', ['finish', 'API-1', '--result', 'ok'])).doc.data).toMatchObject({ status: 'qa', passed: true });
    expect((await run(s, 'dev-a', ['finish', 'API-1', '--result', 'again', '--no-commit'])).doc.data.status).toBe('qa');
    expect((await run(s, 'dev-a', ['update', 'API-1', '--status', 'done'])).doc.error.code).toBe('INVALID_VALUE');
  });

  it('a check of a task its assignee did not hand in is refused without a command around the check', async () => {
    const s = await reviewBoard();
    const r = await run(s, 'rev', ['finish', 'API-1', '--result', 'ok']);
    expect(r.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', fix: 'laneboard comment API-1 "hand it in: laneboard finish API-1 --status code_review --result <result>" --as rev' });
    expect(r.doc.error.message).not.toContain('close it as the orchestrator');
  });
});

describe('review r1: no way around the checks (claim --status, a hand-in outside the checks, the author after unassign)', () => {
  const updateFix = (actor: string): string => `laneboard finish API-1 --status code_review --result "<what you did, how you checked it>" --as ${actor}`;

  it('claim --status done: the assignee INVALID_VALUE, not in review.by ALREADY_CLAIMED, a checker taking the task INVALID_VALUE (as update)', async () => {
    const s = await reviewBoard();
    const own = await run(s, 'dev-a', ['claim', 'API-1', '--status', 'done']);
    expect(own.code).toBe(2);
    expect(own.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: updateFix('dev-a') });
    expect((await run(s, 'dev-a', ['update', 'API-1', '--status', 'done'])).doc.error).toEqual(own.doc.error);
    await run(s, 'orch', ['create', 'Free', '--status', 'ready']);
    const other = await run(s, 'dev-b', ['claim', 'API-2', '--status', 'done']);
    expect(other.code).toBe(4);
    expect(other.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', fix: 'laneboard comment API-2 "<note for its assignee>" --as dev-b' });
    expect((await run(s, 'dev-b', ['update', 'API-2', '--status', 'done'])).doc.error).toEqual(other.doc.error);
    const checker = await run(s, 'rev', ['claim', 'API-2', '--status', 'done']);
    expect(checker.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard finish API-2 --status code_review --result "<what you did, how you checked it>" --as rev' });
    expect((await row(s, 'API-1')).status).toBe('dev');
    expect(await row(s, 'API-2')).toMatchObject({ status: 'ready', assignee: null });
  });

  it('claim --status of a handed-in task warns that the hand-in is lost (A17), as update', async () => {
    const s = await reviewBoard();
    await run(s, 'dev-a', ['finish', 'API-1', '--result', 'r', '--no-commit']);
    // Review r2: the author passing its own task on to a later check is refused like the final status.
    expect((await run(s, 'dev-a', ['claim', 'API-1', '--status', 'qa'])).doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: updateFix('dev-a') });
    const moved = await run(s, 'dev-a', ['claim', 'API-1', '--status', 'dev']);
    expect(moved.code).toBe(0);
    expect(moved.doc.warnings).toEqual(['API-1 was handed in; after this move it is not: pass it on or accept it with laneboard finish API-1 --result "<result>" instead, or the assignee hands it in again with finish']);
  });

  it('a task handed in to a status outside the checks goes through every check: rev passes it to code_review, not into done', async () => {
    const s = await reviewBoard();
    expect((await run(s, 'dev-a', ['finish', 'API-1', '--status', 'ready', '--result', 'r', '--no-commit'])).doc.data.status).toBe('ready');
    const first = await run(s, 'rev', ['finish', 'API-1', '--result', 'ok']);
    expect(first.doc.data).toMatchObject({ status: 'code_review', passed: true, from: 'ready' });
    expect((await run(s, 'orch', ['finish', 'API-1', '--result', 'qa ok'])).doc.data).toMatchObject({ status: 'qa', passed: true });
    expect((await run(s, 'rev', ['finish', 'API-1', '--result', 'accepted'])).doc.data).toMatchObject({ status: 'done', accepted: true, from: 'qa' });
  });

  it('the author of the work does not close it after unassign or a handover to another name (review.by empty)', async () => {
    const s = await reviewBoard([]);
    expect((await run(s, 'dev-a', ['update', 'API-1', '--unassign'])).code).toBe(0);
    const unassigned = await run(s, 'dev-a', ['update', 'API-1', '--status', 'done']);
    expect(unassigned.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: updateFix('dev-a') });
    expect((await run(s, 'dev-a', ['claim', 'API-1', '--status', 'done'])).doc.error.code).toBe('INVALID_VALUE');
    expect((await run(s, 'dev-a', ['update', 'API-1', '--assignee', 'other'])).code).toBe(0);
    expect((await run(s, 'dev-a', ['update', 'API-1', '--status', 'done'])).doc.error.code).toBe('INVALID_VALUE');
    expect((await row(s, 'API-1')).status).toBe('dev');
    // Somebody who never held it still closes it (review.by empty: anybody but the author).
    expect((await run(s, 'orch', ['update', 'API-1', '--status', 'done'])).doc.data.status).toBe('done');
  });

  it('a key of a newer laneboard inside review is kept and not read: no STORE_INVALID, a warning, written back by config', async () => {
    const s = await newStore({ prefix: 'API', statuses: FLOW });
    await run(s, 'orch', ['config', '--review-statuses', 'code_review,qa']);
    const file = path.join(s.dir, 'config.json');
    const conf = JSON.parse(configText(s));
    fs.writeFileSync(file, JSON.stringify({ ...conf, review: { ...conf.review, stage_by: { qa: ['qa-bot'] } } }, null, 2));
    expect((await run(s, 'orch', ['create', 'x', '--status', 'ready'])).code).toBe(0);
    const shown = await run(s, 'orch', ['config', '--reviewers', 'rev']);
    expect(shown.code).toBe(0);
    expect(shown.doc.warnings).toEqual([expect.stringContaining('keys this laneboard does not know (review.stage_by)')]);
    expect(JSON.parse(configText(s)).review).toEqual({ statuses: ['code_review', 'qa'], by: ['rev'], stage_by: { qa: ['qa-bot'] } });
    await run(s, 'orch', ['config', '--review-statuses', 'qa']);
    expect(JSON.parse(configText(s)).review).toEqual({ statuses: ['qa'], by: ['rev'], stage_by: { qa: ['qa-bot'] } });
  });
});

describe('review r2: the author of the work checks its task by no path; the path of finish follows the status', () => {
  const updateFix = (actor: string): string => `laneboard finish API-1 --status code_review --result "<what you did, how you checked it>" --as ${actor}`;
  const BY = ['rev', 'dev-a', 'orch'];

  // The author dev-a (in review.by) is refused every pass and close of API-1: finish, finish --status done/qa, update, claim.
  async function expectAuthorRefused(s: TestStore): Promise<void> {
    for (const argv of [
      ['finish', 'API-1', '--result', 'self check'],
      ['finish', 'API-1', '--status', 'done', '--result', 'self accept'],
      ['finish', 'API-1', '--status', 'qa', '--result', 'self check'],
      ['update', 'API-1', '--status', 'done'],
      ['update', 'API-1', '--status', 'qa'],
    ]) {
      const r = await run(s, 'dev-a', argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.doc.error, argv.join(' ')).toMatchObject({ code: 'INVALID_VALUE', fix: updateFix('dev-a') });
    }
    expect(await row(s, 'API-1')).toMatchObject({ status: 'code_review', assignee: 'dev-b', handed_in: true });
  }

  it('(1) dev-a takes the task, hands it over to dev-b, dev-b hands in: dev-a neither passes it on nor accepts it', async () => {
    const s = await reviewBoard(BY);
    expect((await run(s, 'dev-a', ['update', 'API-1', '--assignee', 'dev-b'])).code).toBe(0);
    expect((await run(s, 'dev-b', ['finish', 'API-1', '--result', 'work', '--no-commit'])).doc.data.status).toBe('code_review');
    await expectAuthorRefused(s);
    // A checker who never held it still passes it on.
    expect((await run(s, 'rev', ['finish', 'API-1', '--result', 'ok'])).doc.data).toMatchObject({ status: 'qa', passed: true, assignee: 'dev-b' });
  });

  it('(2) dev-a hands in itself, then hands the task over to dev-b, dev-b hands in again: dev-a is still refused', async () => {
    const s = await reviewBoard(BY);
    expect((await run(s, 'dev-a', ['finish', 'API-1', '--result', 'work', '--no-commit'])).doc.data.status).toBe('code_review');
    expect((await run(s, 'dev-a', ['update', 'API-1', '--assignee', 'dev-b'])).code).toBe(0);
    expect((await run(s, 'dev-b', ['finish', 'API-1', '--result', 'work 2', '--no-commit'])).doc.data.status).toBe('code_review');
    await expectAuthorRefused(s);
  });

  it('(3) the author hands in and unassigns: rev passes it on without becoming its holder, then accepts it; no dead end', async () => {
    const s = await reviewBoard(BY);
    await run(s, 'dev-a', ['finish', 'API-1', '--result', 'work', '--no-commit']);
    expect((await run(s, 'dev-a', ['update', 'API-1', '--unassign'])).code).toBe(0);
    // The author is refused a pass or a close on this path too (finish without --status would take it back and hand it in again).
    for (const to of ['qa', 'done']) {
      const r = await run(s, 'dev-a', ['finish', 'API-1', '--status', to, '--result', 'self check']);
      expect(r.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: "laneboard finish API-1 --status code_review --result 'self check' --as dev-a --json" });
    }
    expect(await row(s, 'API-1')).toMatchObject({ status: 'code_review', assignee: null });
    const pass = await run(s, 'rev', ['finish', 'API-1', '--result', 'review ok']);
    expect(pass.code).toBe(0);
    expect(pass.doc.data).toMatchObject({ status: 'qa', assignee: null, passed: true, from: 'code_review', commit: null });
    expect((await events(s, 'API-1')).filter((e) => e.type === 'assigned' && e.actor === 'rev')).toEqual([]);
    // The repeated pass stays a no-op (a lost reply); rev names the final status to accept.
    expect((await run(s, 'rev', ['finish', 'API-1', '--result', 'review ok'])).doc.data.status).toBe('qa');
    const accept = await run(s, 'rev', ['finish', 'API-1', '--status', 'done', '--result', 'qa ok']);
    expect(accept.code).toBe(0);
    expect(accept.doc.data).toMatchObject({ status: 'done', assignee: null, accepted: true, from: 'qa' });
  });

  it('(3b) by=rev alone: after unassign rev passes on with finish and orch is not needed; the next finish of rev accepts with --status', async () => {
    const s = await reviewBoard(['rev']);
    await run(s, 'dev-a', ['finish', 'API-1', '--result', 'work', '--no-commit']);
    await run(s, 'dev-a', ['update', 'API-1', '--unassign']);
    expect((await run(s, 'rev', ['finish', 'API-1', '--result', 'ok'])).doc.data).toMatchObject({ status: 'qa', assignee: null, passed: true });
    expect((await run(s, 'orch', ['finish', 'API-1', '--result', 'x'])).doc.error.code).toBe('ALREADY_CLAIMED');
    expect((await run(s, 'rev', ['finish', 'API-1', '--status', 'done', '--result', 'ok'])).doc.data).toMatchObject({ status: 'done', accepted: true });
  });

  it('(4) the normal path: dev-a hands in, rev passes code_review -> qa, orch accepts into done', async () => {
    const s = await reviewBoard(BY);
    expect((await run(s, 'dev-a', ['finish', 'API-1', '--result', 'work', '--no-commit'])).doc.data).toMatchObject({ status: 'code_review', assignee: 'dev-a' });
    expect((await run(s, 'rev', ['finish', 'API-1', '--result', 'ok'])).doc.data).toMatchObject({ status: 'qa', passed: true, from: 'code_review' });
    expect((await run(s, 'orch', ['finish', 'API-1', '--result', 'qa ok'])).doc.data).toMatchObject({ status: 'done', accepted: true, from: 'qa', assignee: 'dev-a' });
  });
});

describe('P1 criteria (9)-(10): config@1 stays until a key is on; an old board turns checks on by hand', () => {
  it('(9): a task handed in to review on a board without checks is accepted by finish after config --review-statuses review', async () => {
    const s = await newStore({ prefix: 'OLD' });
    await run(s, 'orch', ['create', 'Old work', '--status', 'todo', '--assignee', 'dev-a']);
    expect((await run(s, 'dev-a', ['finish', 'OLD-1', '--status', 'review', '--result', 'r', '--no-commit'])).doc.data.status).toBe('review');
    expect((await run(s, 'orch', ['config', '--review-statuses', 'review'])).code).toBe(0);
    expect((await run(s, 'orch', ['finish', 'OLD-1', '--result', 'accepted'])).doc.data).toMatchObject({ status: 'done', accepted: true, from: 'review' });
  });

  it('(10): without a new key config@1; checks or creators write config@2 (0.3.1: STORE_TOO_NEW); all off: config@1, byte for byte', async () => {
    const s = await newStore({ prefix: 'API', statuses: FLOW });
    const before = configText(s);
    expect(JSON.parse(before).schema).toBe(CONFIG_SCHEMA);
    await run(s, 'orch', ['config', '--statuses', FLOW.join(','), '--field', 'team:string']);
    expect(JSON.parse(configText(s)).schema).toBe(CONFIG_SCHEMA);
    const on = await run(s, 'orch', ['config', '--review-statuses', 'code_review,qa', '--reviewers', 'rev,orch', '--creators', 'orch']);
    expect(on.doc.data).toMatchObject({ review: { statuses: ['code_review', 'qa'], by: ['rev', 'orch'] }, create_by: ['orch'], changed: true });
    expect(on.doc.warnings).toEqual([expect.stringContaining('laneboard 0.3.1 refuses this board (STORE_TOO_NEW)')]);
    const v2 = JSON.parse(configText(s));
    expect(v2).toMatchObject({ schema: CONFIG_SCHEMA_V2, review: { statuses: ['code_review', 'qa'], by: ['rev', 'orch'] }, create_by: ['orch'] });
    // 0.3.1 refuses any config@N with N > 1 as STORE_TOO_NEW before it reads a key (0.3.1 src/core/config.ts validateConfig).
    expect(Number(/@(\d+)$/.exec(v2.schema)?.[1])).toBeGreaterThan(1);
    await run(s, 'orch', ['config', '--review-statuses', 'none']);
    expect(JSON.parse(configText(s)).schema).toBe(CONFIG_SCHEMA_V2);
    const off = await run(s, 'orch', ['config', '--creators', 'none']);
    expect(off.doc.warnings).toEqual([expect.stringContaining('config@1 again')]);
    const after = JSON.parse(configText(s));
    expect(after.schema).toBe(CONFIG_SCHEMA);
    expect(Object.keys(after)).not.toContain('review');
    expect(Object.keys(after)).not.toContain('create_by');
    await run(s, 'orch', ['config', '--drop-field', 'team']);
    expect(configText(s)).toBe(before);
  });

  it('config@2 keeps keys of a newer laneboard with a warning; config@1 with review is STORE_INVALID naming config@2', async () => {
    const s = await newStore({ prefix: 'API', statuses: FLOW });
    await run(s, 'orch', ['config', '--review-statuses', 'code_review']);
    const file = path.join(s.dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(configText(s)), stage_by: { qa: ['qa-bot'] } }, null, 2));
    expect((await run(s, 'orch', ['create', 'x', '--status', 'ready'])).code).toBe(0);
    const shown = await run(s, 'orch', ['config', '--reviewers', 'rev']);
    expect(shown.doc.warnings).toEqual([expect.stringContaining('keys this laneboard does not know (stage_by)')]);
    expect(JSON.parse(configText(s))).toMatchObject({ schema: CONFIG_SCHEMA_V2, review: { by: ['rev'] }, stage_by: { qa: ['qa-bot'] } });
    // Turning the known keys off keeps config@2 while the unknown key is there (config@1 would reject it).
    await run(s, 'orch', ['config', '--review-statuses', 'none']);
    expect(JSON.parse(configText(s))).toMatchObject({ schema: CONFIG_SCHEMA_V2, stage_by: { qa: ['qa-bot'] } });

    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(configText(s)), schema: CONFIG_SCHEMA, stage_by: undefined, review: { statuses: ['qa'] } }));
    const bad = await run(s, 'orch', ['list']);
    expect(bad.doc.error.code).toBe('STORE_INVALID');
    expect(bad.doc.error.fix).toContain(`set "schema": "${CONFIG_SCHEMA_V2}"`);
  });

  it('config checks the checks: a status of the board between the first and the final one; reviewers need checks', async () => {
    const s = await newStore({ prefix: 'API', statuses: FLOW });
    for (const [value, problem] of [
      ['backlog', 'starting status'],
      ['done', 'final status'],
      ['qa,qa', 'listed twice'],
      ['review', 'not a status of this board'],
    ]) {
      const r = await run(s, 'orch', ['config', '--review-statuses', value ?? '']);
      expect(r.doc.error?.code, value).toBe('INVALID_VALUE');
      if (value !== 'qa,qa') expect(r.doc.error.message, value).toContain(problem);
    }
    const noChecks = await run(s, 'orch', ['config', '--reviewers', 'rev']);
    expect(noChecks.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard config --review-statuses <status between the first and the final one> --reviewers rev' });
    expect(JSON.parse(configText(s)).schema).toBe(CONFIG_SCHEMA);
    await run(s, 'orch', ['config', '--review-statuses', 'code_review,qa']);
    const drop = await run(s, 'orch', ['config', '--statuses', 'backlog,ready,dev,code_review,done']);
    expect(drop.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard config --statuses backlog,ready,dev,code_review,done --review-statuses code_review' });
    expect((await run(s, 'orch', ['config', '--reviewers', 'bad name'])).doc.error.code).toBe('INVALID_VALUE');
  });
});

describe('owner TG 8723: a board without the new keys behaves as in 0.3.1 (ADR §22)', () => {
  it('finish of the assignee closes; another accepts only into the final status; update closes; no A17 warning; the orchestrator fix stays', async () => {
    const s = await newStore({ prefix: 'API', statuses: FLOW });
    const before = configText(s);
    await run(s, 'orch', ['create', 'One', '--status', 'dev', '--assignee', 'dev-a']);
    await run(s, 'orch', ['create', 'Two', '--status', 'dev', '--assignee', 'dev-a']);
    await run(s, 'orch', ['create', 'Three', '--status', 'dev', '--assignee', 'dev-a']);
    expect((await run(s, 'dev-a', ['finish', 'API-1', '--result', 'r', '--no-commit'])).doc.data).toMatchObject({ status: 'done', commit: null });
    expect((await run(s, 'dev-a', ['update', 'API-2', '--status', 'done'])).doc.data.status).toBe('done');
    // Not handed in: the 0.3.1 text with the orchestrator's update.
    const notHanded = await run(s, 'rev', ['finish', 'API-3', '--result', 'ok']);
    expect(notHanded.doc.error.message).toContain('close it as the orchestrator: laneboard update API-3 --status done --as rev');
    await run(s, 'dev-a', ['finish', 'API-3', '--status', 'code_review', '--result', 'r', '--no-commit']);
    const notFinal = await run(s, 'rev', ['finish', 'API-3', '--status', 'qa', '--result', 'ok']);
    expect(notFinal.doc.error.code).toBe('ALREADY_CLAIMED');
    const moved = await run(s, 'rev', ['update', 'API-3', '--status', 'qa']);
    expect(moved.doc.warnings).toEqual([]);
    expect(await row(s, 'API-3')).toMatchObject({ handed_in: false, in_work: true });
    await run(s, 'dev-a', ['finish', 'API-3', '--status', 'qa', '--result', 'r2', '--no-commit']);
    const accept = await run(s, 'dev-b', ['finish', 'API-3', '--result', 'ok']);
    expect(accept.doc.data).toEqual({ id: 'API-3', rev: accept.doc.data.rev, status: 'done', assignee: 'dev-a', commit: null, accepted: true });
    expect(configText(s)).toBe(before);
  });
});

describe('A-U5: init names setup before prime and the command that turns checks on', () => {
  it('init prints the setup line and the checks hint with review when the board has it', async () => {
    const root = tempDir();
    const r = await cli(['init', '--name', 'web', '--description', 'web shop'], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("checks: none, an assignee's finish closes its task; to hand in for a check first: laneboard config --review-statuses review [--reviewers <names>]\n");
    expect(r.stdout).toContain('setup: laneboard setup <claude-code|codex|cursor|gemini|opencode> connects your agent (hooks, MCP), once per project\nnext: laneboard prime');
    expect(JSON.parse(fs.readFileSync(path.join(root, '.laneboard', 'config.json'), 'utf8')).schema).toBe(CONFIG_SCHEMA);
    const two = tempDir();
    const small = await cli(['init', '--name', 'two', '--description', 'two statuses', '--statuses', 'todo,done'], { cwd: two });
    expect(small.stdout).not.toContain('checks:');
  });
});
