// LB-54, LB-57.4, LB-63.6 (0.4.1, slice A1): claim and comment.
// 54.1 claim --resume never takes a closed task of an earlier session (nor names --resume for it); 54.2 and 57.4 a claim without
// --status of a task the actor holds or takes back with --resume moves it from the first status into the work status; 54.3 --resume of a
// free task warns that it was a plain claim; 54.4 a task another session took back with --resume less than 15 min ago stays with it
// (the second of two parallel resumes is refused; a later resume, the next /clear, works with the warning); 54.5 a comment of a session that lost its task says so; 63.6 a name that
// may not check a task waiting for a check never takes it with update --assignee (claim never does).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTemp, cli, newStore } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

const BASE = 'claude-code@ann';
const SESSION_1 = { LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: '11111111-1a1a-4a1a-8a1a-000000000001' };
const SESSION_2 = { LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: '22222222-2b2b-4b2b-8b2b-000000000002' };
const SESSION_3 = { LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: '33333333-3c3c-4c3c-8c3c-000000000003' };
const NAME_1 = `${BASE}:11111111`;
const NAME_2 = `${BASE}:22222222`;
const NAME_3 = `${BASE}:33333333`;
const MIN = 60_000;

// Only Date is faked: the clock moves forward between the sessions, timers (the store lock) stay real.
let clock = Date.parse('2026-11-06T10:00:00.000Z');
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
});
afterEach(() => {
  vi.useRealTimers();
});
function later(ms: number): void {
  clock += ms;
  vi.setSystemTime(clock);
}

// Run the CLI with --json in `s` as `env`; the parsed envelope.
async function json(s: TestStore, argv: string[], env: Record<string, string> = {}): Promise<{ code: number; doc: Record<string, any> }> {
  const r = await cli([...argv, '--json'], { cwd: s.root, env });
  return { code: r.code, doc: JSON.parse(r.stdout) };
}

// A board todo, doing, done where session 1 created WORD-1 for itself in `status`, then went quiet for `quiet` ms.
async function earlierTask(status: string, quiet: number): Promise<TestStore> {
  const s = await newStore({ prefix: 'WORD', statuses: ['todo', 'doing', 'done'] });
  expect((await json(s, ['create', 'Earlier work', '--status', status, '--assignee', NAME_1], SESSION_1)).code).toBe(0);
  later(quiet);
  return s;
}

describe('LB-54.1: claim --resume never takes a closed task', () => {
  it('done by the earlier session: --resume and a plain claim are refused, nothing changes, no fix names --resume', async () => {
    const s = await earlierTask('doing', 0);
    expect((await json(s, ['finish', 'WORD-1', '--result', 'done', '--no-commit'], SESSION_1)).doc.data.status).toBe('done');
    later(16 * MIN);
    for (const argv of [['claim', 'WORD-1', '--resume'], ['claim', 'WORD-1']]) {
      const r = await json(s, argv, SESSION_2);
      expect(r.code, argv.join(' ')).toBe(4);
      expect(r.doc.error, argv.join(' ')).toMatchObject({ code: 'ALREADY_CLAIMED', details: { assignee: NAME_1 }, fix: `laneboard create "<short title of your work>" --status todo --assignee ${NAME_2} --json` });
      expect(r.doc.error.message, argv.join(' ')).toContain(`task WORD-1 is done: closed by ${NAME_1}, an earlier session of your default name; --resume takes back only unfinished work, so there is nothing to resume`);
      expect(r.doc.error.fix, argv.join(' ')).not.toContain('--resume');
    }
    expect((await json(s, ['get', 'WORD-1'], SESSION_2)).doc.data).toMatchObject({ status: 'done', assignee: NAME_1 });
  });

  it('reopened by update into the work status: --resume takes it back', async () => {
    const s = await earlierTask('done', 16 * MIN);
    expect((await json(s, ['update', 'WORD-1', '--status', 'doing', '--as', 'orch'])).code).toBe(0);
    later(16 * MIN);
    const r = await json(s, ['claim', 'WORD-1', '--resume'], SESSION_2);
    expect(r.code).toBe(0);
    expect(r.doc.data).toMatchObject({ status: 'doing', assignee: NAME_2, resumed_from: NAME_1 });
  });
});

describe('LB-54.2, LB-57.4: a claim without --status of an own or resumed task in the first status moves it into the work status', () => {
  it('claim --resume of an earlier session task in todo: doing', async () => {
    const s = await earlierTask('todo', 16 * MIN);
    const r = await json(s, ['claim', 'WORD-1', '--resume'], SESSION_2);
    expect(r.code).toBe(0);
    expect(r.doc.data).toMatchObject({ status: 'doing', assignee: NAME_2, resumed_from: NAME_1 });
  });

  it('claim of one\'s own task in todo: doing, no "no changes"; a second claim: no changes', async () => {
    const s = await newStore({ prefix: 'WORD', statuses: ['todo', 'doing', 'done'] });
    expect((await json(s, ['create', 'Mine', '--status', 'todo', '--assignee', 'dev-1', '--as', 'orch'])).code).toBe(0);
    const r = await json(s, ['claim', 'WORD-1', '--as', 'dev-1']);
    expect(r.code).toBe(0);
    expect(r.doc.data).toMatchObject({ status: 'doing', assignee: 'dev-1' });
    expect(r.doc.warnings).toEqual([]);
    expect((await json(s, ['claim', 'WORD-1', '--as', 'dev-1'])).doc.warnings).toEqual(['no changes: WORD-1 is already claimed by dev-1']);
  });

  it('a free task keeps its status (a plain claim, assignee := you); --status wins; an own task past the first status keeps it', async () => {
    const s = await newStore({ prefix: 'WORD', statuses: ['todo', 'doing', 'blocked', 'done'] });
    expect((await json(s, ['create', 'Free', '--status', 'todo', '--as', 'orch'])).code).toBe(0);
    expect((await json(s, ['create', 'Mine', '--status', 'todo', '--assignee', 'dev-1', '--as', 'orch'])).code).toBe(0);
    expect((await json(s, ['create', 'Blocked', '--status', 'blocked', '--assignee', 'dev-1', '--as', 'orch'])).code).toBe(0);
    expect((await json(s, ['claim', 'WORD-1', '--as', 'dev-1'])).doc.data).toMatchObject({ status: 'todo', assignee: 'dev-1' });
    expect((await json(s, ['claim', 'WORD-2', '--status', 'blocked', '--as', 'dev-1'])).doc.data).toMatchObject({ status: 'blocked' });
    const blocked = await json(s, ['claim', 'WORD-3', '--as', 'dev-1']);
    expect(blocked.doc.data).toMatchObject({ status: 'blocked', assignee: 'dev-1' });
    expect(blocked.doc.warnings).toEqual(['no changes: WORD-3 is already claimed by dev-1']);
  });

  it('a board with checks: the status before the first check; two statuses (the second is final): the first stays', async () => {
    const s = await newStore({ prefix: 'API', statuses: ['todo', 'in_progress', 'review', 'done'] });
    expect((await json(s, ['config', '--review-statuses', 'review', '--as', 'orch'])).code).toBe(0);
    expect((await json(s, ['create', 'Endpoint', '--status', 'todo', '--assignee', 'dev-1', '--as', 'orch'])).code).toBe(0);
    expect((await json(s, ['claim', 'API-1', '--as', 'dev-1'])).doc.data).toMatchObject({ status: 'in_progress', assignee: 'dev-1' });
    const two = await newStore({ prefix: 'TWO', statuses: ['open', 'closed'] });
    expect((await json(two, ['create', 'Plain', '--status', 'open', '--assignee', 'dev-1', '--as', 'orch'])).code).toBe(0);
    expect((await json(two, ['claim', 'TWO-1', '--as', 'dev-1'])).doc.data).toMatchObject({ status: 'open', assignee: 'dev-1' });
  });
});

describe('LB-54.3: --resume of a free task warns that it was a plain claim', () => {
  it('free task: exit 0, claimed, the warning; an earlier session task: no such warning', async () => {
    const s = await newStore({ prefix: 'WORD', statuses: ['todo', 'doing', 'done'] });
    expect((await json(s, ['create', 'Nobody\'s', '--status', 'todo', '--as', 'orch'])).code).toBe(0);
    const r = await json(s, ['claim', 'WORD-1', '--resume'], SESSION_2);
    expect(r.code).toBe(0);
    expect(r.doc.data).toMatchObject({ assignee: NAME_2, status: 'todo' });
    expect(r.doc.data.resumed_from).toBeUndefined();
    expect(r.doc.warnings).toEqual([
      'WORD-1 had no assignee, so --resume took it as a plain claim: it is no task of an earlier session of yours; make sure it is the work you were asked to do',
    ]);
    const t = await earlierTask('doing', 16 * MIN);
    expect((await json(t, ['claim', 'WORD-1', '--resume'], SESSION_2)).doc.warnings).toEqual([]);
  });
});

describe('LB-54.4: a task taken back with --resume less than 15 min ago stays with that session', () => {
  it('two new sessions resume the same task: the second is refused; once that resume is 15 min old, it resumes', async () => {
    const s = await earlierTask('doing', 16 * MIN);
    expect((await json(s, ['claim', 'WORD-1', '--resume'], SESSION_2)).doc.data).toMatchObject({ assignee: NAME_2, resumed_from: NAME_1 });
    later(30_000);
    for (const argv of [['claim', 'WORD-1', '--resume'], ['claim', 'WORD-1']]) {
      const r = await json(s, argv, SESSION_3);
      expect(r.code, argv.join(' ')).toBe(4);
      expect(r.doc.error, argv.join(' ')).toMatchObject({ code: 'ALREADY_CLAIMED', details: { assignee: NAME_2 }, fix: `laneboard comment WORD-1 "<note for ${NAME_2}>" --as ${NAME_3}` });
      expect(r.doc.error.message, argv.join(' ')).toBe(
        `task WORD-1 was taken back with claim --resume by ${NAME_2}, another session of your default name, <1 min ago: a task resumed within 15 min stays with the session that took it, as another one may be a parallel session at work, so do not take it over; if that session is closed, the task can be resumed once its resume is 15 min old: laneboard claim WORD-1 --resume`,
      );
    }
    expect((await json(s, ['get', 'WORD-1'], SESSION_3)).doc.data.assignee).toBe(NAME_2);
    later(16 * MIN);
    const r = await json(s, ['claim', 'WORD-1', '--resume'], SESSION_3);
    expect(r.code).toBe(0);
    expect(r.doc.data).toMatchObject({ assignee: NAME_3, resumed_from: NAME_2 });
  });

  it('the resume is 14 min old and its session wrote just now: still refused (the age of the resume counts, not the last write)', async () => {
    const s = await earlierTask('doing', 16 * MIN);
    expect((await json(s, ['claim', 'WORD-1', '--resume'], SESSION_2)).code).toBe(0);
    later(14 * MIN);
    expect((await json(s, ['comment', 'WORD-1', 'still at it'], SESSION_2)).code).toBe(0);
    const r = await json(s, ['claim', 'WORD-1', '--resume'], SESSION_3);
    expect(r.code).toBe(4);
    expect(r.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', details: { assignee: NAME_2 } });
    expect(r.doc.error.message).toContain(`by ${NAME_2}, another session of your default name, 14 min ago`);
  });

  // Review A1 r1 (MAJOR): the second /clear of a long task. S2 took it back with --resume long ago and wrote a minute ago; S3 is the
  // next session after a /clear, and the SessionStart hook offers it `claim --resume`: exit 0 with the warning, as on 0.4.0.
  it('S1 -> S2 claim --resume -> S2 comment -> S3 claim --resume (a second /clear): exit 0 with the warning', async () => {
    const s = await earlierTask('doing', 16 * MIN);
    expect((await json(s, ['claim', 'WORD-1', '--resume'], SESSION_2)).doc.data).toMatchObject({ assignee: NAME_2, resumed_from: NAME_1 });
    later(40 * MIN);
    expect((await json(s, ['comment', 'WORD-1', 'step done'], SESSION_2)).code).toBe(0);
    later(1 * MIN);
    const r = await json(s, ['claim', 'WORD-1', '--resume'], SESSION_3);
    expect(r.code).toBe(0);
    expect(r.doc.data).toMatchObject({ status: 'doing', assignee: NAME_3, resumed_from: NAME_2 });
    expect(r.doc.warnings).toEqual([
      `WORD-1 taken from a session active 1 min ago (${NAME_2}): if it is a parallel session at work, not your own closed one, tell it: laneboard comment WORD-1 "<note for ${NAME_2}>"`,
    ]);
  });

  it('a live session that holds the task by its own claim: --resume still works, with the warning (a /clear right after the claim)', async () => {
    const s = await earlierTask('doing', 30_000);
    const r = await json(s, ['claim', 'WORD-1', '--resume'], SESSION_2);
    expect(r.code).toBe(0);
    expect(r.doc.data).toMatchObject({ assignee: NAME_2, resumed_from: NAME_1 });
    expect(r.doc.warnings.join('\n')).toContain(`WORD-1 taken from a session active <1 min ago (${NAME_1})`);
  });
});

describe('LB-54.5: a comment of a session that lost its task says so', () => {
  it('taken over by --resume: the old session\'s comment is written with the warning; the new holder\'s comment: none', async () => {
    const s = await earlierTask('doing', 16 * MIN);
    expect((await json(s, ['claim', 'WORD-1', '--resume'], SESSION_2)).code).toBe(0);
    later(2 * MIN);
    const old = await json(s, ['comment', 'WORD-1', 'still working'], SESSION_1);
    expect(old.code).toBe(0);
    expect(old.doc.warnings).toEqual([
      `WORD-1 is no longer yours: ${NAME_2} took it over with claim --resume 2 min ago; your comment is written, but stop work on it unless it is given back (ask ${NAME_2} or the orchestrator)`,
    ]);
    expect((await json(s, ['comment', 'WORD-1', 'mine now'], SESSION_2)).doc.warnings).toEqual([]);
  });

  it('given to another name or unassigned by the orchestrator: the old holder is told; the orchestrator and others are not', async () => {
    const s = await newStore({ prefix: 'WORD', statuses: ['todo', 'doing', 'done'] });
    expect((await json(s, ['create', 'Work', '--status', 'doing', '--assignee', 'dev-1', '--as', 'orch'])).code).toBe(0);
    expect((await json(s, ['update', 'WORD-1', '--assignee', 'dev-2', '--as', 'orch'])).code).toBe(0);
    expect((await json(s, ['comment', 'WORD-1', 'note', '--as', 'dev-1'])).doc.warnings).toEqual([
      'WORD-1 is no longer yours: orch gave it to dev-2 <1 min ago; your comment is written, but stop work on it unless it is given back (ask dev-2 or the orchestrator)',
    ]);
    expect((await json(s, ['comment', 'WORD-1', 'note', '--as', 'orch'])).doc.warnings).toEqual([]);
    expect((await json(s, ['comment', 'WORD-1', 'note', '--as', 'dev-3'])).doc.warnings).toEqual([]);
    expect((await json(s, ['update', 'WORD-1', '--unassign', '--as', 'orch'])).code).toBe(0);
    expect((await json(s, ['comment', 'WORD-1', 'note', '--as', 'dev-2'])).doc.warnings).toEqual([
      'WORD-1 is no longer yours: orch unassigned it <1 min ago; your comment is written, but stop work on it unless it is given back (ask the orchestrator)',
    ]);
    // Given away by the holder itself: no warning.
    expect((await json(s, ['claim', 'WORD-1', '--as', 'dev-4'])).code).toBe(0);
    expect((await json(s, ['update', 'WORD-1', '--assignee', 'dev-5', '--as', 'dev-4'])).code).toBe(0);
    expect((await json(s, ['comment', 'WORD-1', 'handed over', '--as', 'dev-4'])).doc.warnings).toEqual([]);
  });
});

describe('LB-63.6: a name that may not check a task waiting for a check never takes it with update', () => {
  // ONE check (review) with reviewers `by`; API-1 handed in by dev-1.
  async function waiting(by: string): Promise<TestStore> {
    const s = await newStore({ prefix: 'API', statuses: ['todo', 'in_progress', 'review', 'done'] });
    expect((await json(s, ['config', '--review-statuses', 'review', '--reviewers', by, '--as', 'orch'])).code).toBe(0);
    expect((await json(s, ['create', 'Add endpoint', '--status', 'todo', '--as', 'orch'])).code).toBe(0);
    expect((await json(s, ['claim', 'API-1', '--status', 'in_progress', '--as', 'dev-1'])).code).toBe(0);
    expect((await json(s, ['finish', 'API-1', '--result', 'work', '--no-commit', '--as', 'dev-1'])).doc.data.status).toBe('review');
    return s;
  }
  const MESSAGE =
    'API-1 is handed in and waits in review for the check of r1 (review -> done): you may not check it (config review.by: r1), so you never take it: ' +
    'update --assignee takes no task that waits for a check, as claim does not; a note for the checkers is a comment';

  it('update --assignee itself, alone or with --status: ALREADY_CLAIMED, nothing changes; then update --status of a task it does not hold is no takeover', async () => {
    const s = await waiting('r1');
    for (const argv of [['update', 'API-1', '--assignee', 'x'], ['update', 'API-1', '--status', 'in_progress', '--assignee', 'x']]) {
      const r = await json(s, [...argv, '--as', 'x']);
      expect(r.code, argv.join(' ')).toBe(4);
      expect(r.doc.error, argv.join(' ')).toMatchObject({ code: 'ALREADY_CLAIMED', message: MESSAGE, details: { assignee: 'dev-1' }, fix: 'laneboard comment API-1 "<note for the check>" --as x' });
    }
    expect((await json(s, ['get', 'API-1'])).doc.data).toMatchObject({ status: 'review', assignee: 'dev-1' });
    // update --status alone never moves the assignee: the task stays dev-1's. Whether x may move it at all (a return for rework by
    // another hand) is slice A2's (LB-63.6 stays open), so the exit code is not asserted here.
    await json(s, ['update', 'API-1', '--status', 'in_progress', '--as', 'x']);
    expect((await json(s, ['get', 'API-1'])).doc.data.assignee).toBe('dev-1');
  });

  it('unassigned while waiting: INVALID_VALUE with the same message', async () => {
    const s = await waiting('r1');
    expect((await json(s, ['update', 'API-1', '--unassign', '--as', 'orch'])).code).toBe(0);
    const r = await json(s, ['update', 'API-1', '--assignee', 'x', '--as', 'x']);
    expect(r.code).toBe(2);
    expect(r.doc.error).toMatchObject({ code: 'INVALID_VALUE', message: MESSAGE });
  });

  it('still allowed: the orchestrator gives it to another name, a checker takes it (B-U2 warning), its author takes it back', async () => {
    const s = await waiting('r1');
    expect((await json(s, ['update', 'API-1', '--assignee', 'dev-2', '--as', 'orch'])).code).toBe(0);
    expect((await json(s, ['update', 'API-1', '--assignee', 'dev-1', '--as', 'dev-1'])).code).toBe(0);
    const checker = await json(s, ['update', 'API-1', '--assignee', 'r1', '--as', 'r1']);
    expect(checker.code).toBe(0);
    expect(checker.doc.warnings.join('\n')).toContain('a holder is an author of the work and never checks it');
  });
});
