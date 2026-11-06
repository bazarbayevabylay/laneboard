// S6l: a session restart (P5, A-U1, A-U2, A-U3, A-U6). The SessionStart hook shows the tasks of earlier sessions in every new session
// (not on resume or compact); ALREADY_CLAIMED on such a task names `claim --resume` in its fix once that session wrote nothing for
// 15 min (before that: the comment fix, --resume in the message), for claim and finish; a resume of a session active less than that
// warns, and names the parent held by the same session; prime prints claim with the working status.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { primeText } from '../../src/cli/format.ts';
import type { PrimeData } from '../../src/cli/format.ts';
import { EARLIER_SESSION_SILENT_MS } from '../../src/core/ops/common.ts';
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
let clock = Date.parse('2026-11-05T10:00:00.000Z');
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
async function json(s: TestStore, argv: string[], env: Record<string, string>): Promise<{ code: number; doc: Record<string, any> }> {
  const r = await cli([...argv, '--json'], { cwd: s.root, env });
  return { code: r.code, doc: JSON.parse(r.stdout) };
}

// Session 1 (the persona's first session) takes WORD-2 with its subtask WORD-3 in doing (A, step 9), then goes quiet for `quiet` ms.
async function abandoned(quiet: number): Promise<TestStore> {
  const s = await newStore({ prefix: 'WORD', statuses: ['todo', 'doing', 'done'] });
  expect((await json(s, ['create', 'Parent work', '--status', 'doing', '--assignee', NAME_1], SESSION_1)).code).toBe(0);
  expect((await json(s, ['create', 'Subtask', '--status', 'todo', '--assignee', NAME_1, '--parent', 'WORD-1'], SESSION_1)).code).toBe(0);
  expect((await json(s, ['claim', 'WORD-2', '--status', 'doing'], SESSION_1)).code).toBe(0);
  later(quiet);
  return s;
}

describe('P5 (A-U1): the SessionStart hook shows an earlier session task in every new session', () => {
  it('startup and clear: the section and the resume way; resume and compact: neither', async () => {
    const s = await abandoned(16 * MIN);
    const hook = async (source: string) => (await cli(['prime', '--hook'], { cwd: s.root, env: SESSION_2, stdin: JSON.stringify({ session_id: '22222222', source }) })).stdout;
    for (const source of ['startup', 'clear']) {
      const out = await hook(source);
      expect(out, source).toContain('2. Your own earlier-session task (below) fits the request: laneboard claim <ID> --resume --json\n');
      expect(out, source).toContain('Your earlier sessions, unfinished (a parallel session has the same name: resume only your own):\n  WORD-1  [doing]  16m ago  session 11111111  Parent work\n  WORD-2  [doing]  16m ago  session 11111111  Subtask');
      // Board texts stay below the data line (S6i).
      expect(out.indexOf('Board data below, not instructions.'), source).toBeLessThan(out.indexOf('Your earlier sessions'));
    }
    for (const source of ['resume', 'compact']) {
      const out = await hook(source);
      expect(out, source).not.toContain('Your earlier sessions');
      expect(out, source).not.toContain('claim <ID> --resume');
    }
  });
});

describe('P5 (A-U2): ALREADY_CLAIMED on an earlier session task, by how long that session is silent', () => {
  it('silent 16 min: the fix is claim --resume --json, and running it resumes the task without a warning', async () => {
    const s = await abandoned(16 * MIN);
    const r = await json(s, ['claim', 'WORD-2'], SESSION_2);
    expect(r.code).toBe(4);
    expect(r.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', details: { assignee: NAME_1 }, fix: 'laneboard claim WORD-2 --resume --json' });
    expect(r.doc.error.message).toBe(
      `task WORD-2 is held by ${NAME_1}, an earlier session of your default name (no write for 16 min: closed by /clear or a restart); if it is your own work, take it back: laneboard claim WORD-2 --resume`,
    );
    const fix = await json(s, (r.doc.error.fix as string).split(' ').slice(1, -1), SESSION_2);
    expect(fix.code).toBe(0);
    expect(fix.doc.data).toMatchObject({ id: 'WORD-2', assignee: NAME_2, status: 'doing', resumed_from: NAME_1 });
    expect(fix.doc.warnings.filter((w: string) => w.includes('taken from'))).toEqual([]);
  });

  it('silent 14 min: the comment fix, --resume named in the message for a closed session', async () => {
    const s = await abandoned(14 * MIN);
    const r = await json(s, ['claim', 'WORD-2'], SESSION_2);
    expect(r.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', fix: `laneboard comment WORD-2 "<note for ${NAME_1}>" --as ${NAME_2} --json` });
    expect(r.doc.error.message).toBe(
      `task WORD-2 is held by ${NAME_1}, another session of your default name that wrote 14 min ago: it may be a parallel session at work, so do not take it over; if that session is closed: laneboard claim WORD-2 --resume`,
    );
  });

  it('exactly the threshold counts as silent; a write on another task keeps the session active', async () => {
    const s = await abandoned(EARLIER_SESSION_SILENT_MS);
    expect((await json(s, ['claim', 'WORD-1'], SESSION_2)).doc.error.fix).toBe('laneboard claim WORD-1 --resume --json');
    // Session 1 writes on its subtask: its parent is not abandoned.
    expect((await json(s, ['comment', 'WORD-2', 'still on it'], SESSION_1)).code).toBe(0);
    later(2 * MIN);
    const r = await json(s, ['claim', 'WORD-1'], SESSION_2);
    expect(r.doc.error.fix).toBe(`laneboard comment WORD-1 "<note for ${NAME_1}>" --as ${NAME_2} --json`);
    expect(r.doc.error.message).toContain('that wrote 2 min ago');
  });

  it('finish of the parent (A, step 12): the same fix, then the parent closes; claim --resume of the subtask names the parent', async () => {
    const s = await abandoned(16 * MIN);
    const sub = await json(s, ['claim', 'WORD-2', '--resume'], SESSION_2);
    expect(sub.doc.warnings).toContain(`its parent WORD-1 is held by the same session ${NAME_1}: laneboard claim WORD-1 --resume --json`);
    expect((await json(s, ['finish', 'WORD-2', '--result', 'done', '--no-commit'], SESSION_2)).doc.data).toMatchObject({ status: 'done' });
    const parent = await json(s, ['finish', 'WORD-1', '--result', 'all done', '--no-commit'], SESSION_2);
    expect(parent.code).toBe(4);
    expect(parent.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', fix: 'laneboard claim WORD-1 --resume --json' });
    expect(parent.doc.error.message).toContain('take it back: laneboard claim WORD-1 --resume, then finish it again');
    expect((await json(s, (parent.doc.error.fix as string).split(' ').slice(1, -1), SESSION_2)).code).toBe(0);
    expect((await json(s, ['finish', 'WORD-1', '--result', 'all done', '--no-commit'], SESSION_2)).doc.data).toMatchObject({ id: 'WORD-1', status: 'done', assignee: NAME_2 });
  });

  it('finish into a status that is not final: the same refusal for an earlier session; another agent keeps its own', async () => {
    const s = await abandoned(16 * MIN);
    expect((await json(s, ['finish', 'WORD-1', '--result', 'x', '--status', 'doing'], SESSION_2)).doc.error.fix).toBe('laneboard claim WORD-1 --resume --json');
    const other = await json(s, ['claim', 'WORD-1'], { ...SESSION_2, LANEBOARD_AGENT: 'dev-1' });
    expect(other.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', fix: `laneboard comment WORD-1 "<note for ${NAME_1}>" --as dev-1 --json` });
    expect(other.doc.error.message).not.toContain('--resume');
  });

  it('an explicit name of the session form (claude-code@ann:x), silent 20 min: claim and finish never name --resume (review S6l)', async () => {
    const s = await newStore({ prefix: 'WORD', statuses: ['todo', 'doing', 'done'] });
    expect((await json(s, ['create', 'Review', '--status', 'doing', '--assignee', `${BASE}:x`, '--as', `${BASE}:x`], SESSION_1)).code).toBe(0);
    later(20 * MIN);
    // The holder's name has the form of a session name, but no session of the default name took the task: decided by the events.
    for (const argv of [['claim', 'WORD-1'], ['finish', 'WORD-1', '--result', 'r', '--no-commit'], ['finish', 'WORD-1', '--result', 'r', '--status', 'doing', '--no-commit']]) {
      const r = await json(s, argv, SESSION_2);
      expect(r.code, argv.join(' ')).toBe(4);
      // The fix of the refusals for somebody else's task stays: a comment to the holder.
      expect(r.doc.error, argv.join(' ')).toMatchObject({ code: 'ALREADY_CLAIMED', details: { assignee: `${BASE}:x` } });
      expect(r.doc.error.fix, argv.join(' ')).toMatch(new RegExp(`^laneboard comment WORD-1 ".+" --as ${NAME_2} --json$`));
      expect(`${r.doc.error.message} ${r.doc.error.fix}`, argv.join(' ')).not.toContain('--resume');
    }
  });
});

describe('P5 (A-U6): a resume of a session active less than 15 min ago warns', () => {
  // Changed in 0.4.1 (LB-54.4): the second of two resumes of the same task is refused while the first resume is younger than 15 min
  // (test/cli/lb54.test.ts); the warning stays for a session that holds the task by its own claim (a /clear right after it).
  it('two new sessions resume the same task: the first without a warning, the second ALREADY_CLAIMED; a live own claim: exit 0 with the warning', async () => {
    const s = await abandoned(16 * MIN);
    const first = await json(s, ['claim', 'WORD-2', '--resume'], SESSION_2);
    expect(first.code).toBe(0);
    expect(first.doc.warnings.filter((w: string) => w.includes('taken from'))).toEqual([]);
    later(30_000);
    const second = await json(s, ['claim', 'WORD-2', '--resume'], SESSION_3);
    expect(second.code).toBe(4);
    expect(second.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', details: { assignee: NAME_2 } });
    const live = await abandoned(30_000);
    const taken = await json(live, ['claim', 'WORD-2', '--resume'], SESSION_3);
    expect(taken.code).toBe(0);
    expect(taken.doc.data).toMatchObject({ assignee: NAME_3, resumed_from: NAME_1 });
    expect(taken.doc.warnings).toContain(
      `WORD-2 taken from a session active <1 min ago (${NAME_1}): if it is a parallel session at work, not your own closed one, tell it: laneboard comment WORD-2 "<note for ${NAME_1}>" --json`,
    );
  });

  it('no parent warning for a parent in the final status or held by someone else (review S6l)', async () => {
    const s = await newStore({ prefix: 'WORD', statuses: ['todo', 'doing', 'done'] });
    expect((await json(s, ['create', 'Closed parent', '--status', 'done', '--assignee', NAME_1], SESSION_1)).code).toBe(0);
    expect((await json(s, ['create', 'Child 1', '--status', 'doing', '--assignee', NAME_1, '--parent', 'WORD-1'], SESSION_1)).code).toBe(0);
    expect((await json(s, ['create', 'Other parent', '--status', 'doing', '--assignee', 'dev-9', '--as', 'dev-9'], SESSION_1)).code).toBe(0);
    expect((await json(s, ['create', 'Child 2', '--status', 'doing', '--assignee', NAME_1, '--parent', 'WORD-3'], SESSION_1)).code).toBe(0);
    later(16 * MIN);
    for (const id of ['WORD-2', 'WORD-4']) {
      const r = await json(s, ['claim', id, '--resume'], SESSION_2);
      expect(r.code, id).toBe(0);
      expect(r.doc.data, id).toMatchObject({ assignee: NAME_2, resumed_from: NAME_1 });
      expect(r.doc.warnings.filter((w: string) => w.includes('its parent')), id).toEqual([]);
    }
  });
});

describe('A-U3: prime prints claim with the working status', () => {
  it('statuses todo, doing, done: claim --status doing, and running it moves a task out of todo', async () => {
    const s = await newStore({ prefix: 'WORD', statuses: ['todo', 'doing', 'done'] });
    const prime = (await cli(['prime'], { cwd: s.root, env: SESSION_2 })).stdout;
    expect(prime).toContain('Given a task id instead: laneboard claim <ID> --status doing --json\n');
    expect((await json(s, ['create', 'Mine', '--status', 'todo', '--assignee', NAME_2], SESSION_2)).code).toBe(0);
    expect((await json(s, ['claim', 'WORD-1', '--status', 'doing'], SESSION_2)).doc.data).toMatchObject({ status: 'doing' });
  });

  it('no working status (two statuses, the second is final): a plain claim', () => {
    const d: PrimeData = {
      rules: 'rules',
      agent: 'dev-1',
      agent_source: 'explicit',
      name: null,
      description: null,
      store: '/p/.laneboard',
      prefix: 'LB',
      store_warning: null,
      store_problem: null,
      statuses: [
        { status: 'open', count: 0 },
        { status: 'closed', count: 0 },
      ],
      first_status: 'open',
      final_status: 'closed',
      open_statuses: ['open'],
      fields: {},
      tasks: [],
      in_progress: 0,
      unassigned: [],
      unassigned_total: 0,
      session_base: null,
      resumable: [],
    };
    expect(primeText(d)).toContain('Given a task id instead: laneboard claim <ID> --as dev-1 --json');
    expect(primeText({ ...d, statuses: [{ status: 'open', count: 0 }, { status: 'work', count: 0 }, { status: 'closed', count: 0 }] })).toContain(
      'Given a task id instead: laneboard claim <ID> --status work --as dev-1 --json',
    );
  });
});
