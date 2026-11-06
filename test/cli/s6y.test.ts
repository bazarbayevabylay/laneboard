// S6y (UX run 6, persona B: U1, U2): two holes of I1 and I3 on a board with checks, each refusal's fix run as printed (rule 13).
// U1: the holder's finish into a status that is no check handed the task in where no checker saw it; now refused, the fix keeps the
// meaning (comment, then update into that status) and the message names the hand-in into a check; doctor reports older such hand-ins.
// U2: a checker's stale finish (or update into a check) of a task returned for rework got the fix "comment 'hand it in'", whose run
// buried the reason of the return in the author's prime; now the fix only reads the task and the message names who returned it and why.
// Layouts: two checks; a work status between the checks; one check; a board without checks (unchanged for U1).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTemp, cli, CLI_SOURCE, newStore, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

interface Layout {
  name: string;
  statuses: string[];
  checks: string[];
  // The status work goes on in before the checks (claim --status, the return for rework).
  work: string;
  final: string;
}

const TWO: Layout = { name: 'two checks', statuses: ['backlog', 'blocked', 'dev', 'code_review', 'qa', 'done'], checks: ['code_review', 'qa'], work: 'dev', final: 'done' };
const BETWEEN: Layout = { name: 'work status between checks', statuses: ['backlog', 'dev', 'code_review', 'fixing', 'qa', 'done'], checks: ['code_review', 'qa'], work: 'dev', final: 'done' };
const ONE: Layout = { name: 'one check', statuses: ['todo', 'in_progress', 'review', 'done'], checks: ['review'], work: 'in_progress', final: 'done' };
const WITH_CHECKS = [TWO, BETWEEN, ONE];

// The statuses a holder's finish may name that are neither a check nor final (finish never names the first one).
function workStatuses(l: Layout): string[] {
  return l.statuses.slice(1).filter((st) => !l.checks.includes(st) && st !== l.final);
}

// Run the CLI with --json in `s` as `actor`; the exit code and the parsed envelope.
async function run(s: TestStore, actor: string, argv: string[]): Promise<{ code: number; doc: Record<string, any> }> {
  const r = await cli([...argv, '--as', actor, '--json'], { cwd: s.root });
  return { code: r.code, doc: JSON.parse(r.stdout) };
}

// The task as `get` shows it, with its events.
async function task(s: TestStore, id: string): Promise<Record<string, any>> {
  return (await run(s, 'orch', ['get', id, '--events', '100'])).doc.data;
}

// The list row of `id` (handed_in mark).
async function row(s: TestStore, id: string): Promise<Record<string, any>> {
  return (await run(s, 'orch', ['list', '--scope', 'active'])).doc.data.items.find((t: { id: string }) => t.id === id);
}

// The text prime prints for `actor`.
async function primeText(s: TestStore, actor: string): Promise<string> {
  return (await cli(['prime', '--as', actor], { cwd: s.root })).stdout;
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

// `board` with API-1 handed in to the first check, then passed on by rev `passes` times.
async function waiting(l: Layout, passes = 0): Promise<TestStore> {
  const s = await board(l);
  expect((await run(s, 'dev-1', ['finish', 'API-1', '--result', 'work', '--no-commit'])).doc.data.status).toBe(l.checks[0]);
  for (let i = 0; i < passes; i++) {
    const next = l.checks[i + 1] ?? l.final;
    expect((await run(s, 'rev', ['finish', 'API-1', '--status', next, '--result', `check ${i + 1} ok`])).doc.data).toMatchObject({ status: next, passed: true });
  }
  return s;
}

// The hand-in command a U1 refusal names, for `actor` (who did the work runs it).
function namedHandIn(message: string, actor: string): string {
  const m = /to hand API-1 in: (laneboard finish .+?); to put it into/.exec(message);
  expect(m, message).not.toBeNull();
  return `${m?.[1] ?? ''} --as ${actor}`;
}

describe('S6y U1: on a board with checks the holder hands in only to a check', () => {
  for (const l of WITH_CHECKS) {
    it(`${l.name}: finish into a work status is refused, nothing written; the fix (comment, then update) puts it there not handed in`, async () => {
      for (const target of workStatuses(l)) {
        const s = await board(l);
        const before = await task(s, 'API-1');
        const r = await run(s, 'dev-1', ['finish', 'API-1', '--status', target, '--result', 'Form done, ready for review', '--no-commit']);
        expect(r.code, target).toBe(2);
        expect(r.doc.error, target).toMatchObject({
          code: 'INVALID_VALUE',
          fix: `laneboard comment API-1 --as dev-1 --json -- 'Form done, ready for review' && laneboard update API-1 --status ${target} --as dev-1 --json`,
        });
        expect(r.doc.error, target).not.toHaveProperty('input');
        expect(r.doc.error.message, target).toContain(`on this board ${target} is no check`);
        expect(r.doc.error.message, target).toContain(`laneboard finish API-1 --status ${l.checks[0]} --result`);
        expect(await task(s, 'API-1'), target).toMatchObject({ status: l.work, rev: before.rev });
        expect(sh(s, r.doc.error.fix), target).toBe(0);
        const after = await task(s, 'API-1');
        expect(after, target).toMatchObject({ status: target, assignee: 'dev-1' });
        expect(after.events.some((e: { type: string; actor: string; data: { text?: string } }) => e.type === 'commented' && e.actor === 'dev-1' && e.data.text === 'Form done, ready for review'), target).toBe(true);
        expect(await row(s, 'API-1'), target).toMatchObject({ status: target, handed_in: false });
        expect((await run(s, 'orch', ['doctor'])).code, target).toBe(0);
        // The hand-in the message names, run as printed by who did the work: the checkers see the task.
        expect(sh(s, namedHandIn(r.doc.error.message, 'dev-1')), target).toBe(0);
        expect(await row(s, 'API-1'), target).toMatchObject({ status: l.checks[0], handed_in: true });
        expect(await primeText(s, 'rev'), target).toContain(`Waiting for your check:\n  API-1  [${l.checks[0]}]`);
      }
    });

    it(`${l.name}: the author's finish of a waiting task into a work status is refused too; the fix moves it there, not handed in`, async () => {
      const s = await waiting(l);
      const r = await run(s, 'dev-1', ['finish', 'API-1', '--status', l.work, '--result', 'more work needed']);
      expect(r.code).toBe(2);
      expect(r.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: `laneboard comment API-1 --as dev-1 --json -- 'more work needed' && laneboard update API-1 --status ${l.work} --as dev-1 --json` });
      expect(await row(s, 'API-1')).toMatchObject({ status: l.checks[0], handed_in: true });
      expect(sh(s, r.doc.error.fix)).toBe(0);
      expect(await row(s, 'API-1')).toMatchObject({ status: l.work, handed_in: false });
    });

    it(`${l.name}: an unassigned task finished into a work status by anybody: the same refusal, nothing written`, async () => {
      const s = await board(l);
      expect((await run(s, 'dev-1', ['update', 'API-1', '--unassign'])).code).toBe(0);
      const before = await task(s, 'API-1');
      const r = await run(s, 'dev-2', ['finish', 'API-1', '--status', l.work, '--result', 'r', '--no-commit']);
      expect(r.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: `laneboard comment API-1 --as dev-2 --json -- r && laneboard update API-1 --status ${l.work} --as dev-2 --json` });
      expect(await task(s, 'API-1')).toMatchObject({ assignee: null, rev: before.rev });
    });
  }

  it('a board without checks is unchanged: finish into a status that is not final hands the task in', async () => {
    const s = await board(ONE, false);
    const r = await run(s, 'dev-1', ['finish', 'API-1', '--status', 'in_progress', '--result', 'r', '--no-commit']);
    expect(r.code).toBe(0);
    expect(await row(s, 'API-1')).toMatchObject({ status: 'in_progress', handed_in: true });
  });

  it('older hand-ins outside the checks: config turning checks on warns, doctor reports them (exit 6) with the hand-in; run as printed, healthy', async () => {
    const s = await board(TWO, false);
    expect((await run(s, 'dev-1', ['finish', 'API-1', '--status', 'blocked', '--result', 'ready for review', '--no-commit'])).doc.data.status).toBe('blocked');
    const handIn = 'laneboard finish API-1 --status code_review --result "<what you did, how you checked it>" --as dev-1';
    const conf = await run(s, 'orch', ['config', '--review-statuses', 'code_review,qa', '--reviewers', 'rev,orch']);
    expect(conf.code).toBe(0);
    expect(conf.doc.warnings).toContain(`tasks handed in to a status that is no check, so no checker sees them; the holder of each hands it in to a check (an unassigned one: who did its work): API-1 (blocked, held by dev-1): ${handIn}`);
    const doctor = await run(s, 'orch', ['doctor']);
    expect(doctor.code).toBe(6);
    const check = doctor.doc.data.checks.find((c: { name: string }) => c.name === 'checks');
    expect(check).toMatchObject({ ok: false });
    expect(check.message).toContain(`API-1 (blocked, held by dev-1): ${handIn}`);
    expect(await primeText(s, 'rev')).not.toContain('API-1');
    expect(sh(s, handIn)).toBe(0);
    expect(await row(s, 'API-1')).toMatchObject({ status: 'code_review', handed_in: true });
    expect((await run(s, 'orch', ['doctor'])).code).toBe(0);
    expect(await primeText(s, 'rev')).toContain('Waiting for your check:\n  API-1  [code_review]');
  });
});

// rev returns API-1 for rework the documented way (README "Return for rework"): the comment, then update into the work status.
async function returned(s: TestStore, l: Layout, reason = 'Empty state text missing i18n'): Promise<void> {
  expect(sh(s, `laneboard comment API-1 --as rev -- '${reason}' && laneboard update API-1 --status ${l.work} --as rev`)).toBe(0);
}

describe('S6y U2: a stale check of a task returned for rework reads it; the author sees the reason of the return', () => {
  for (const l of WITH_CHECKS) {
    for (let passes = 0; passes < l.checks.length; passes++) {
      const from = l.checks[passes] ?? '';
      it(`${l.name}: returned from ${from}, orch's stale finish / update into a check: fix get (run: no change), message names rev and why`, async () => {
        const s = await waiting(l, passes);
        await returned(s, l);
        const before = await task(s, 'API-1');
        const next = l.checks[passes + 1] ?? l.final;
        // Exit codes: ALREADY_CLAIMED 4, INVALID_VALUE 2 (as before, only the message and the fix are new).
        const attempts: Array<[string, string[], string, number]> = [
          ['finish', ['finish', 'API-1', '--status', next, '--result', 'CR ok'], 'ALREADY_CLAIMED', 4],
          ['finish without --status', ['finish', 'API-1', '--result', 'CR ok'], 'ALREADY_CLAIMED', 4],
          // ALREADY_CLAIMED as finish (slice A2, LB-63.1: was INVALID_VALUE, exit 2).
          ['update into a check', ['update', 'API-1', '--status', from], 'ALREADY_CLAIMED', 4],
        ];
        for (const [what, argv, code, exit] of attempts) {
          const r = await run(s, 'orch', argv);
          expect(r.code, what).toBe(exit);
          expect(r.doc.error, what).toMatchObject({ code, fix: 'laneboard get API-1 --json' });
          expect(r.doc.error.message, what).toMatch(new RegExp(`^API-1 was returned for rework by rev at \\S+ \\(${from} -> ${l.work}\\), reason: "Empty state text missing i18n"; it is ${l.work} with dev-1 and not handed in`));
          expect(r.doc.error.message, what).not.toContain('hand it in:');
          expect(sh(s, r.doc.error.fix), what).toBe(0);
        }
        expect(await task(s, 'API-1')).toMatchObject({ status: l.work, rev: before.rev });
        expect(await primeText(s, 'dev-1')).toContain('last comment by rev: > Empty state text missing i18n');
      });
    }

    it(`${l.name}: the checker that returned it runs its own stale pass: "by you"; a return with no comment says so`, async () => {
      const s = await waiting(l);
      expect((await run(s, 'rev', ['update', 'API-1', '--status', l.work])).code).toBe(0);
      const r = await run(s, 'rev', ['finish', 'API-1', '--status', l.checks[1] ?? l.final, '--result', 'ok']);
      expect(r.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', fix: 'laneboard get API-1 --json' });
      expect(r.doc.error.message).toContain(`API-1 was returned for rework by you at `);
      expect(r.doc.error.message).toContain(`(${l.checks[0]} -> ${l.work}), with no comment;`);
    });

    it(`${l.name}: control: a task in work never handed in keeps the comment to the holder (A14)`, async () => {
      const s = await board(l);
      const r = await run(s, 'orch', ['finish', 'API-1', '--status', l.checks[1] ?? l.final, '--result', 'ok']);
      expect(r.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', fix: `laneboard comment API-1 "hand it in: laneboard finish API-1 --status ${l.checks[0]} --result <result>" --as orch --json` });
    });

    it(`${l.name}: the author handed it in again after the return: the check passes it as usual`, async () => {
      const s = await waiting(l);
      await returned(s, l);
      expect((await run(s, 'dev-1', ['finish', 'API-1', '--result', 'i18n added', '--no-commit'])).doc.data.status).toBe(l.checks[0]);
      expect((await run(s, 'orch', ['finish', 'API-1', '--status', l.checks[1] ?? l.final, '--result', 'ok'])).doc.data.status).toBe(l.checks[1] ?? l.final);
    });
  }

  it('the reason is the returner\'s own comment, not a newer comment of another name before the move', async () => {
    const s = await waiting(TWO);
    expect(sh(s, "laneboard comment API-1 --as rev -- 'Empty state text missing i18n' && laneboard comment API-1 --as orch -- 'FYI: release on Friday' && laneboard update API-1 --status dev --as rev")).toBe(0);
    const r = await run(s, 'orch', ['finish', 'API-1', '--status', 'qa', '--result', 'CR ok']);
    expect(r.doc.error.message).toContain('by rev at ');
    expect(r.doc.error.message).toContain('reason: "Empty state text missing i18n"');
  });

  it('a board without checks: a stale acceptance of a returned task gets the read and the reason, not the "hand it in" comment', async () => {
    const s = await board(ONE, false);
    expect((await run(s, 'dev-1', ['finish', 'API-1', '--status', 'review', '--result', 'r', '--no-commit'])).doc.data.status).toBe('review');
    await returned(s, ONE, 'missing test');
    const r = await run(s, 'orch', ['finish', 'API-1', '--result', 'ok']);
    expect(r.code).toBe(4);
    expect(r.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', fix: 'laneboard get API-1 --json' });
    expect(r.doc.error.message).toMatch(/^API-1 was returned for rework by rev at \S+ \(review -> in_progress\), reason: "missing test";/);
    expect(sh(s, r.doc.error.fix)).toBe(0);
    expect((await task(s, 'API-1')).events.at(-1)).toMatchObject({ type: 'status', actor: 'rev' });
  });
});

// Review r1 of S6y: the return is found by walking back to the last hand-in or pass, not only while it is the newest status event.
describe('S6y r1: a return for rework since the last hand-in, whatever the author did since', () => {
  // The two-check board and the one-check board, each with a status the author parks the task in (blocked / todo).
  const PARKED: Array<[Layout, string]> = [[TWO, 'blocked'], [ONE, 'todo']];
  for (const [l, parked] of PARKED) {
    it(`${l.name}: returned, the author moves it to ${parked} (and back to work): a stale finish / update into a check still reads it`, async () => {
      const s = await waiting(l);
      await returned(s, l);
      const next = l.checks[1] ?? l.final;
      for (const move of [parked, l.work]) {
        expect((await run(s, 'dev-1', ['update', 'API-1', '--status', move])).code, move).toBe(0);
        const before = await task(s, 'API-1');
        const attempts: Array<[string, string[], string]> = [
          ['finish', ['finish', 'API-1', '--status', next, '--result', 'CR ok'], 'ALREADY_CLAIMED'],
          ['update into a check', ['update', 'API-1', '--status', l.checks[0] ?? ''], 'ALREADY_CLAIMED'],
        ];
        for (const [what, argv, code] of attempts) {
          const r = await run(s, 'orch', argv);
          expect(r.doc.error, `${move} ${what}`).toMatchObject({ code, fix: 'laneboard get API-1 --json' });
          expect(r.doc.error.message, `${move} ${what}`).toMatch(
            new RegExp(`^API-1 was returned for rework by rev at \\S+ \\(${l.checks[0]} -> ${l.work}\\), reason: "Empty state text missing i18n"; it is ${move} with dev-1 and not handed in`),
          );
          expect(sh(s, r.doc.error.fix), `${move} ${what}`).toBe(0);
        }
        expect(await task(s, 'API-1'), move).toMatchObject({ status: move, rev: before.rev });
        expect(await primeText(s, 'dev-1'), move).toContain('last comment by rev: > Empty state text missing i18n');
      }
      // Handed in again: the return is over, the check passes it as usual.
      expect((await run(s, 'dev-1', ['finish', 'API-1', '--result', 'i18n added', '--no-commit'])).doc.data.status).toBe(l.checks[0]);
      expect((await run(s, 'orch', ['finish', 'API-1', '--status', next, '--result', 'ok'])).doc.data.status).toBe(next);
    });
  }

  it('the author\'s own move out of the check is no return: the stale check gets the comment to hand it in (A14), not "returned by dev-1"', async () => {
    const s = await waiting(TWO);
    expect((await run(s, 'dev-1', ['update', 'API-1', '--status', 'dev'])).code).toBe(0);
    const r = await run(s, 'orch', ['finish', 'API-1', '--status', 'qa', '--result', 'CR ok']);
    expect(r.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', fix: 'laneboard comment API-1 "hand it in: laneboard finish API-1 --status code_review --result <result>" --as orch --json' });
    expect(r.doc.error.message).not.toContain('returned for rework');
    const u = await run(s, 'orch', ['update', 'API-1', '--status', 'code_review']);
    expect(u.doc.error.message).not.toContain('returned for rework');
    expect(u.doc.error.fix).toContain('hand it in:');
  });

  it('the returner moves it first and comments after: the reason is that comment, not "with no comment"', async () => {
    const s = await waiting(TWO);
    expect(sh(s, "laneboard update API-1 --status dev --as rev && laneboard comment API-1 --as rev -- 'Empty state text missing i18n'")).toBe(0);
    expect((await run(s, 'dev-1', ['update', 'API-1', '--status', 'blocked'])).code).toBe(0);
    const r = await run(s, 'orch', ['finish', 'API-1', '--status', 'qa', '--result', 'CR ok']);
    expect(r.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', fix: 'laneboard get API-1 --json' });
    expect(r.doc.error.message).toContain('(code_review -> dev), reason: "Empty state text missing i18n";');
    expect(r.doc.error.message).not.toContain('with no comment');
  });

  for (const moved of ['backlog', 'blocked']) {
    it(`r2: rev returned it with a reason, orch moves it to ${moved}: the stale pass still reads it, the author keeps rev's reason`, async () => {
      const s = await waiting(TWO);
      await returned(s, TWO);
      expect((await run(s, 'orch', ['update', 'API-1', '--status', moved])).code).toBe(0);
      const r = await run(s, 'orch', ['finish', 'API-1', '--status', 'qa', '--result', 'CR ok']);
      expect(r.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', fix: 'laneboard get API-1 --json' });
      expect(r.doc.error.message).toMatch(new RegExp(`^API-1 was returned for rework by rev at \\S+ \\(code_review -> dev\\), reason: "Empty state text missing i18n"; it is ${moved} with dev-1`));
      expect(sh(s, r.doc.error.fix)).toBe(0);
      expect(await primeText(s, 'dev-1')).toContain('last comment by rev: > Empty state text missing i18n');
    });
  }

  it('r2: a return with no reason ends with a later move by another name; orch moving it back into a check ends one with a reason too', async () => {
    const s = await waiting(TWO);
    expect((await run(s, 'rev', ['update', 'API-1', '--status', 'dev'])).code).toBe(0);
    expect((await run(s, 'orch', ['update', 'API-1', '--status', 'blocked'])).code).toBe(0);
    const r = await run(s, 'rev', ['finish', 'API-1', '--status', 'qa', '--result', 'ok']);
    expect(r.doc.error.message).not.toContain('returned for rework');
    expect(r.doc.error.fix).toContain('hand it in:');
    const t = await board(ONE, false);
    expect((await run(t, 'dev-1', ['finish', 'API-1', '--status', 'review', '--result', 'r', '--no-commit'])).code).toBe(0);
    await returned(t, ONE, 'missing test');
    expect((await run(t, 'orch', ['update', 'API-1', '--status', 'review'])).code).toBe(0);
    const u = await run(t, 'orch', ['finish', 'API-1', '--result', 'ok']);
    expect(u.doc.error.message).not.toContain('returned for rework');
    expect(u.doc.error.fix).toContain('hand it in:');
  });

  it('an acceptance after the last hand-in, then the author reopens it: no return for rework (the comment to hand it in, A14)', async () => {
    const s = await waiting(ONE);
    expect((await run(s, 'rev', ['finish', 'API-1', '--status', 'done', '--result', 'ok'])).doc.data.status).toBe('done');
    expect((await run(s, 'dev-1', ['update', 'API-1', '--status', 'in_progress'])).code).toBe(0);
    const r = await run(s, 'rev', ['finish', 'API-1', '--status', 'done', '--result', 'ok']);
    expect(r.doc.error.message).not.toContain('returned for rework');
    expect(r.doc.error.fix).toContain('hand it in:');
  });

  it('a comment of the returner from before the last hand-in is no reason: "with no comment"', async () => {
    const s = await board(TWO);
    expect((await run(s, 'rev', ['comment', 'API-1', 'old note before the hand-in'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['finish', 'API-1', '--result', 'work', '--no-commit'])).code).toBe(0);
    expect((await run(s, 'rev', ['update', 'API-1', '--status', 'dev'])).code).toBe(0);
    const r = await run(s, 'orch', ['finish', 'API-1', '--status', 'qa', '--result', 'CR ok']);
    expect(r.doc.error.message).toContain('(code_review -> dev), with no comment;');
  });

  for (const l of WITH_CHECKS) {
    it(`${l.name}: the author's finish into a work status of a task waiting in a check says it is handed in already, names no hand-in`, async () => {
      const s = await waiting(l);
      const r = await run(s, 'dev-1', ['finish', 'API-1', '--status', l.work, '--result', 'more work needed']);
      expect(r.code).toBe(2);
      expect(r.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: `laneboard comment API-1 --as dev-1 --json -- 'more work needed' && laneboard update API-1 --status ${l.work} --as dev-1 --json` });
      expect(r.doc.error.message).toMatch(new RegExp(`^API-1 is handed in already and waits in ${l.checks[0]} for the check of rev, orch \\(`));
      expect(r.doc.error.message).toContain(`to put it into ${l.work} with your result, out of the checkers' queue (the hand-in is gone): comment, then laneboard update API-1 --status ${l.work}`);
      expect(r.doc.error.message).not.toContain('to hand API-1 in');
      expect(r.doc.error.message).not.toContain('laneboard finish API-1 --status');
    });
  }

  it('control: the holder\'s finish into a work status of a task in work (not handed in) still names the hand-in', async () => {
    const s = await board(TWO);
    const r = await run(s, 'dev-1', ['finish', 'API-1', '--status', 'blocked', '--result', 'r', '--no-commit']);
    expect(r.doc.error.message).toContain('to hand API-1 in: laneboard finish API-1 --status code_review --result');
    expect(r.doc.error.message).not.toContain('handed in already');
  });
});
