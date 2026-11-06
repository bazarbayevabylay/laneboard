// S6z (UX run 7, persona B: U1, U2, U5) on a board with checks, each printed command run in sh (rule 13).
// U1: a return for rework with no reason showed the author an old comment from before the last hand-in (already fixed) as the reason;
// now the author's feedback (prime, prime --json roles.feedback, the SessionStart hook) comes from reworkReturn only: the returner's
// comments since the last hand-in, or "returned for rework by <name> at <time> with no reason"; the returner gets a warning with the
// comment that adds the reason. U2: the return command in the message of a stale check carries a placeholder, never the result of the
// check. U5: the hook shows the reason of a return under a task of an earlier session, as prime does under an own task.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PRIME_MAX_CHARS } from '../../src/cli/format.ts';
import { cleanupTemp, cli, CLI_SOURCE, newStore, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

interface Layout {
  name: string;
  statuses: string[];
  checks: string[];
  work: string;
  final: string;
}

const TWO: Layout = { name: 'two checks', statuses: ['backlog', 'blocked', 'dev', 'code_review', 'qa', 'done'], checks: ['code_review', 'qa'], work: 'dev', final: 'done' };
const ONE: Layout = { name: 'one check', statuses: ['todo', 'in_progress', 'review', 'done'], checks: ['review'], work: 'in_progress', final: 'done' };

const PLACEHOLDER = "'<why it goes back>'";
const NO_REASON = /returned for rework by (\S+) at (\S+) with no reason - ask them or see laneboard get API-1/;

// Run the CLI with --json in `s` as `actor`; the exit code and the parsed envelope.
async function run(s: TestStore, actor: string, argv: string[], env: Record<string, string> = {}): Promise<{ code: number; doc: Record<string, any> }> {
  const r = await cli([...argv, ...(actor === '' ? [] : ['--as', actor]), '--json'], { cwd: s.root, env });
  return { code: r.code, doc: JSON.parse(r.stdout) };
}

// The text prime prints for `actor`.
async function primeText(s: TestStore, actor: string): Promise<string> {
  return (await cli(['prime', '--as', actor], { cwd: s.root })).stdout;
}

// prime --json roles.feedback of `actor`.
async function feedback(s: TestStore, actor: string): Promise<unknown[]> {
  return (await run(s, actor, ['prime'])).doc.data.roles.feedback;
}

// Run a command line as printed in a shell, with `laneboard` on PATH running this source, in the store's folder; its exit code.
function sh(s: TestStore, line: string): number {
  const bin = tempDir();
  fs.writeFileSync(path.join(bin, 'laneboard'), `#!/bin/sh\nexec "${process.execPath}" "${CLI_SOURCE}" "$@"\n`, { mode: 0o755 });
  try {
    execFileSync('sh', ['-c', line], { cwd: s.root, env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: tempDir() }, encoding: 'utf8', stdio: 'pipe' });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

// A board of `l` with checks (reviewers rev, orch; none when `checks` is false) and API-1 claimed by dev-1 in its work status.
async function board(l: Layout, checks = true): Promise<TestStore> {
  const s = await newStore({ prefix: 'API', statuses: l.statuses });
  if (checks) expect((await run(s, 'orch', ['config', '--review-statuses', l.checks.join(','), '--reviewers', 'rev,orch'])).code).toBe(0);
  expect((await run(s, 'orch', ['create', 'Add endpoint', '--status', l.statuses[0] ?? ''])).code).toBe(0);
  expect((await run(s, 'dev-1', ['claim', 'API-1', '--status', l.work])).code).toBe(0);
  return s;
}

// The run 7 repro up to the second hand-in: rev returned API-1 with reason R1, dev-1 fixed it and handed it in again.
async function secondRound(l: Layout): Promise<TestStore> {
  const s = await board(l);
  expect((await run(s, 'dev-1', ['finish', 'API-1', '--result', 'work', '--no-commit'])).code).toBe(0);
  expect((await run(s, 'rev', ['comment', 'API-1', 'R1: negative totals not rounded'])).code).toBe(0);
  expect((await run(s, 'rev', ['update', 'API-1', '--status', l.work])).code).toBe(0);
  expect((await run(s, 'dev-1', ['finish', 'API-1', '--status', l.checks[0] ?? '', '--result', 'rounded the totals', '--no-commit'])).code).toBe(0);
  return s;
}

// The warnings of a write that are about a return with no reason.
function noReasonWarnings(doc: Record<string, any>): string[] {
  return ((doc.warnings ?? []) as string[]).filter((w) => w.includes('no reason'));
}

describe('S6z U1: the reason of a return for rework comes only from the returner since the last hand-in', () => {
  for (const l of [TWO, ONE]) {
    it(`${l.name}: the repro - orch returns the fixed task with no comment: prime says "no reason", never R1; the warning's comment adds the reason`, async () => {
      const s = await secondRound(l);
      const r = await run(s, 'orch', ['update', 'API-1', '--status', l.work]);
      expect(r.code).toBe(0);
      const warned = noReasonWarnings(r.doc);
      expect(warned).toEqual([
        `API-1 went back for rework with no reason from you: dev-1's prime says it was returned with no reason; add the reason (shown to dev-1 until the next hand-in): laneboard comment API-1 --as orch --json -- ${PLACEHOLDER}`,
      ]);
      const text = await primeText(s, 'dev-1');
      expect(text).not.toContain('R1');
      expect(text).toMatch(new RegExp(`  API-1  \\[${l.work}\\].*\\n    ${NO_REASON.source}\n`));
      expect(NO_REASON.exec(text)?.[1]).toBe('orch');
      expect(await feedback(s, 'dev-1')).toEqual([{ id: 'API-1', comment: null, returned: { by: 'orch', at: expect.any(String) } }]);
      // The read it names runs as printed.
      expect(sh(s, 'laneboard get API-1 --as dev-1')).toBe(0);
      // The warning's command with the placeholder replaced: from now on that is the reason.
      const command = warned[0]?.slice(warned[0].indexOf('laneboard comment')) ?? '';
      expect(sh(s, command.replace(PLACEHOLDER, "'totals still off by one cent'"))).toBe(0);
      const after = await primeText(s, 'dev-1');
      expect(after).toContain('    last comment by orch: > totals still off by one cent');
      expect(after).not.toMatch(NO_REASON);
      expect(await feedback(s, 'dev-1')).toEqual([
        { id: 'API-1', comment: expect.objectContaining({ actor: 'orch', text: 'totals still off by one cent' }), returned: { by: 'orch', at: expect.any(String) } },
      ]);
    });
  }

  it('a return with its reason (comment, then update) gives no warning; the second round shows the new reason, not R1', async () => {
    const s = await secondRound(TWO);
    expect((await run(s, 'rev', ['comment', 'API-1', 'R2: rounding breaks the zero total'])).code).toBe(0);
    const r = await run(s, 'rev', ['update', 'API-1', '--status', 'dev']);
    expect(r.code).toBe(0);
    expect(noReasonWarnings(r.doc)).toEqual([]);
    const text = await primeText(s, 'dev-1');
    expect(text).toContain('    last comment by rev: > R2: rounding breaks the zero total');
    expect(text).not.toContain('R1');
  });

  it('rev\'s note before the hand-in and its pass result are no reason of orch\'s return from qa: "no reason" by orch', async () => {
    const s = await board(TWO);
    expect((await run(s, 'rev', ['comment', 'API-1', 'old note before the hand-in'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['finish', 'API-1', '--result', 'work', '--no-commit'])).code).toBe(0);
    expect((await run(s, 'rev', ['finish', 'API-1', '--status', 'qa', '--result', 'Code ok'])).code).toBe(0);
    const r = await run(s, 'orch', ['update', 'API-1', '--status', 'dev']);
    expect(noReasonWarnings(r.doc)).toHaveLength(1);
    const text = await primeText(s, 'dev-1');
    expect(text).not.toContain('old note');
    expect(text).not.toContain('Code ok');
    expect(NO_REASON.exec(text)?.[1]).toBe('orch');
  });

  it('the reason is the returner\'s: another name\'s later comment does not replace it, and the returner\'s comment after the move counts', async () => {
    const s = await secondRound(TWO);
    expect((await run(s, 'orch', ['update', 'API-1', '--status', 'dev'])).code).toBe(0);
    expect((await run(s, 'rev', ['comment', 'API-1', 'fyi: rev looked too'])).code).toBe(0);
    expect(NO_REASON.exec(await primeText(s, 'dev-1'))?.[1]).toBe('orch');
    expect((await run(s, 'orch', ['comment', 'API-1', 'the zero total is wrong'])).code).toBe(0);
    expect(await primeText(s, 'dev-1')).toContain('    last comment by orch: > the zero total is wrong');
  });

  it('a no-reason return that ended (orch parks it in blocked) and a re-hand-in show no old comment; a task never handed in still shows the newest one', async () => {
    const s = await secondRound(TWO);
    expect((await run(s, 'orch', ['update', 'API-1', '--status', 'dev'])).code).toBe(0);
    expect((await run(s, 'orch', ['update', 'API-1', '--status', 'blocked'])).code).toBe(0);
    expect(await primeText(s, 'dev-1')).not.toContain('R1');
    expect(await feedback(s, 'dev-1')).toEqual([]);
    // Handed in again: waiting in the check, the comments of the earlier rounds are history.
    expect((await run(s, 'dev-1', ['update', 'API-1', '--status', 'dev'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['finish', 'API-1', '--status', 'code_review', '--result', 'again', '--no-commit'])).code).toBe(0);
    expect(await feedback(s, 'dev-1')).toEqual([]);
    // Control: a note on a task never handed in is shown as before.
    expect((await run(s, 'orch', ['create', 'Other', '--status', 'dev', '--assignee', 'dev-1'])).code).toBe(0);
    expect((await run(s, 'orch', ['comment', 'API-2', 'start with the schema'])).code).toBe(0);
    expect(await feedback(s, 'dev-1')).toEqual([{ id: 'API-2', comment: expect.objectContaining({ actor: 'orch', text: 'start with the schema' }), returned: null }]);
    expect(await primeText(s, 'dev-1')).toContain('    last comment by orch: > start with the schema');
  });

  it('no warning: a move that is no return (the author\'s own, a task never handed in), and a board without checks', async () => {
    const s = await board(TWO);
    const own = await run(s, 'dev-1', ['update', 'API-1', '--status', 'blocked']);
    expect(noReasonWarnings(own.doc)).toEqual([]);
    const never = await run(s, 'orch', ['update', 'API-1', '--status', 'dev']);
    expect(noReasonWarnings(never.doc)).toEqual([]);
    expect((await run(s, 'dev-1', ['finish', 'API-1', '--result', 'work', '--no-commit'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['update', 'API-1', '--status', 'dev'])).code).toBe(0);
    expect(await feedback(s, 'dev-1')).toEqual([]);
    const plain = await board(TWO, false);
    expect((await run(plain, 'dev-1', ['finish', 'API-1', '--status', 'code_review', '--result', 'work', '--no-commit'])).code).toBe(0);
    const back = await run(plain, 'rev', ['update', 'API-1', '--status', 'dev']);
    expect(back.code).toBe(0);
    expect(noReasonWarnings(back.doc)).toEqual([]);
  });

  it('prime --dir: the read named in the no-reason line carries --dir', async () => {
    const s = await secondRound(ONE);
    expect((await run(s, 'orch', ['update', 'API-1', '--status', 'in_progress'])).code).toBe(0);
    const text = (await cli(['prime', '--as', 'dev-1', '--dir', s.dir], { cwd: tempDir() })).stdout;
    expect(text).toMatch(/with no reason - ask them or see laneboard get API-1 --dir \S+/);
  });
});

describe('S6z U2: the return command in a stale check\'s message carries a placeholder, never the result', () => {
  it('the repro: rev passed API-1 to qa; orch\'s stale finish --status qa "Code ok (orch)": fix get, the return names <why it goes back>', async () => {
    const s = await board(TWO);
    expect((await run(s, 'dev-1', ['finish', 'API-1', '--result', 'work', '--no-commit'])).code).toBe(0);
    expect((await run(s, 'rev', ['finish', 'API-1', '--status', 'qa', '--result', 'CR ok (rev)'])).code).toBe(0);
    const r = await run(s, 'orch', ['finish', 'API-1', '--status', 'qa', '--result', 'Code ok (orch)']);
    expect(r.code).toBe(2);
    expect(r.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard get API-1 --json' });
    expect(r.doc.error.message).toContain(`or return it for rework: laneboard comment API-1 --as orch --json -- ${PLACEHOLDER} && laneboard update API-1 --status dev --as orch --json`);
    expect(r.doc.error.message).not.toContain('Code ok');
    expect(sh(s, r.doc.error.fix as string)).toBe(0);
  });
});

describe('S6z U5: the SessionStart hook shows the reason of a return under an earlier session\'s task', () => {
  const BASE = 'claude-code@ann';
  const SESSION_1 = { LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: '11111111-1a1a-4a1a-8a1a-000000000001' };
  const SESSION_2 = { LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: '22222222-2b2b-4b2b-8b2b-000000000002' };

  // A board with checks where session 1 claimed and handed in `n` tasks; rev commented `reason(i)` (none when it returns undefined) and
  // returned each; session 1 then ended.
  // `title`: characters of the t's in each title (the budget test keeps 150; the repro leaves room for S7a r1's named-roles line).
  async function returned(n: number, reason: (i: number) => string | undefined, title = 150): Promise<TestStore> {
    const s = await newStore({ prefix: 'API', statuses: ONE.statuses });
    expect((await run(s, 'orch', ['config', '--review-statuses', 'review', '--reviewers', 'rev'])).code).toBe(0);
    for (let i = 1; i <= n; i++) {
      expect((await run(s, 'orch', ['create', `Task ${i} ${'t'.repeat(title)}`, '--status', 'todo'])).code).toBe(0);
      expect((await run(s, '', ['claim', `API-${i}`, '--status', 'in_progress'], SESSION_1)).code).toBe(0);
      expect((await run(s, '', ['finish', `API-${i}`, '--result', 'work', '--no-commit'], SESSION_1)).code).toBe(0);
      const why = reason(i);
      if (why !== undefined) expect((await run(s, 'rev', ['comment', `API-${i}`, why])).code).toBe(0);
      expect((await run(s, 'rev', ['update', `API-${i}`, '--status', 'in_progress'])).code).toBe(0);
    }
    return s;
  }

  // The hook text of a new session (startup).
  async function hook(s: TestStore): Promise<string> {
    return (await cli(['prime', '--hook'], { cwd: s.root, env: SESSION_2, stdin: JSON.stringify({ source: 'startup' }) })).stdout;
  }

  it('the repro: the resumable task carries rev\'s reason; a return with no reason says so; JSON feedback has both', async () => {
    const s = await returned(2, (i) => (i === 1 ? 'Empty state text missing i18n' : undefined), 80);
    const out = await hook(s);
    expect(out).toContain('Your earlier sessions, unfinished');
    expect(out).toMatch(/\n {2}API-1 {2}\[in_progress\] {2}\S+ ago {2}session 11111111 {2}Task 1 t+\n {4}last comment by rev: > Empty state text missing i18n\n/);
    expect(out).toMatch(/\n {2}API-2 {2}\[in_progress\] .*\n {4}returned for rework by rev at \S+ with no reason - ask them or see laneboard get API-2\n/);
    const roles = (await run(s, '', ['prime'], SESSION_2)).doc.data.roles;
    expect(roles.feedback).toEqual([
      { id: 'API-1', comment: expect.objectContaining({ actor: 'rev', text: 'Empty state text missing i18n' }), returned: { by: 'rev', at: expect.any(String) } },
      { id: 'API-2', comment: null, returned: { by: 'rev', at: expect.any(String) } },
    ]);
    // The task was held by session 1: the resume still works, and the reason is the one the hook showed.
    expect((await run(s, '', ['claim', 'API-1', '--resume'], SESSION_2)).code).toBe(0);
    expect(await primeText(s, `${BASE}:22222222`)).toContain('last comment by rev: > Empty state text missing i18n');
  });

  it('within PRIME_MAX_CHARS: 7 returned tasks with long reasons and long titles; the oldest line and its reason stay', async () => {
    const s = await returned(7, (i) => `${i}: ${'reason '.repeat(60)}`);
    const out = await hook(s);
    // The CLI ends the text with a newline.
    expect(out.replace(/\n$/, '').length).toBeLessThanOrEqual(PRIME_MAX_CHARS);
    expect(out).toMatch(/\n {2}API-1 {2}\[in_progress\] .*\n {4}last comment by rev: > 1: reason/);
    expect(out).toContain('more (7 in all): laneboard list --sessions-of');
    // r1: the feedback covers the listed resumable only (SUMMARY_RESUMABLE_MAX), never all seven.
    const data = (await run(s, '', ['prime'], SESSION_2)).doc.data;
    const listed = (data.resumable as Array<{ id: string }>).map((t) => t.id);
    expect(listed).toEqual(['API-1', 'API-2', 'API-3', 'API-4', 'API-5']);
    expect((data.roles.feedback as Array<{ id: string }>).map((f) => f.id)).toEqual(listed);
  });

  it('r1: an earlier session\'s own note on its task is no feedback (the task\'s holder is the reader\'s name); another name\'s note is', async () => {
    const s = await newStore({ prefix: 'API', statuses: ONE.statuses });
    expect((await run(s, 'orch', ['config', '--review-statuses', 'review', '--reviewers', 'rev'])).code).toBe(0);
    expect((await run(s, 'orch', ['create', 'Add endpoint', '--status', 'todo'])).code).toBe(0);
    expect((await run(s, '', ['claim', 'API-1', '--status', 'in_progress'], SESSION_1)).code).toBe(0);
    expect((await run(s, '', ['comment', 'API-1', 'wip: my own note'], SESSION_1)).code).toBe(0);
    const out = await hook(s);
    expect(out).toMatch(/\n {2}API-1 {2}\[in_progress\] .*session 11111111 {2}Add endpoint\n/);
    expect(out).not.toContain('wip: my own note');
    expect((await run(s, '', ['prime'], SESSION_2)).doc.data.roles.feedback).toEqual([]);
    // Control: a note of another name on the same task is feedback, and the own note stays out.
    expect((await run(s, 'rev', ['comment', 'API-1', 'start with the schema'])).code).toBe(0);
    const again = await hook(s);
    expect(again).toMatch(/\n {2}API-1 {2}\[in_progress\] .*\n {4}last comment by rev: > start with the schema\n/);
    expect(again).not.toContain('wip: my own note');
    expect((await run(s, '', ['prime'], SESSION_2)).doc.data.roles.feedback).toEqual([
      { id: 'API-1', comment: expect.objectContaining({ actor: 'rev', text: 'start with the schema' }), returned: null },
    ]);
  });
});

describe('S6z r1: the refusal of a stale check of a returned task says what reaches the holder\'s prime', () => {
  it('another name\'s stale pass: its note would not reach prime (and does not); the returner\'s own: its comment becomes the reason', async () => {
    const s = await board(TWO);
    expect((await run(s, 'dev-1', ['finish', 'API-1', '--result', 'work', '--no-commit'])).code).toBe(0);
    expect((await run(s, 'rev', ['comment', 'API-1', 'R1: totals'])).code).toBe(0);
    expect((await run(s, 'rev', ['update', 'API-1', '--status', 'dev'])).code).toBe(0);
    const other = await run(s, 'orch', ['finish', 'API-1', '--status', 'qa', '--result', 'ok']);
    expect(other.code).not.toBe(0);
    expect(other.doc.error.fix).toBe('laneboard get API-1 --json');
    expect(other.doc.error.message).toContain(
      "when dev-1 hands it in again; under it dev-1's prime shows only what rev commented since the hand-in, never a note from you, so the fix only reads the task",
    );
    expect(other.doc.error.message).not.toContain('bury');
    // What the message says: orch's note does not replace rev's reason in dev-1's prime.
    expect((await run(s, 'orch', ['comment', 'API-1', 'hand it in: please'])).code).toBe(0);
    expect(await primeText(s, 'dev-1')).toContain('    last comment by rev: > R1: totals');
    const own = await run(s, 'rev', ['finish', 'API-1', '--status', 'qa', '--result', 'ok']);
    expect(own.doc.error.fix).toBe('laneboard get API-1 --json');
    expect(own.doc.error.message).toContain("when dev-1 hands it in again; a comment from you now would become the reason in dev-1's prime, so the fix only reads the task");
    expect(own.doc.error.message).not.toContain('bury');
    // And the returner's comment does become the reason.
    expect((await run(s, 'rev', ['comment', 'API-1', 'R2: rounding too'])).code).toBe(0);
    expect(await primeText(s, 'dev-1')).toContain('    last comment by rev: > R2: rounding too');
  });
});
