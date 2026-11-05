// S6w (UX run 4, persona B: U1-U4): the invariants of a board with checks on every path, each refusal's fix run as printed (rule 13).
// I1: a task in a check is always handed in (update, claim, create, import never put it there). I2: a checker's finish names the next
// status, so a stale read never passes the next check. I3: no fix of a checker's refusal passes on or accepts a task. I4: the fix of
// `finish <ID> -- "- text"` keeps the text. Layouts: two checks; a work status between the checks; one check; a board without checks.
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

const TWO: Layout = { name: 'two checks', statuses: ['backlog', 'ready', 'dev', 'code_review', 'qa', 'done'], checks: ['code_review', 'qa'], work: 'dev', final: 'done' };
const BETWEEN: Layout = { name: 'work status between checks', statuses: ['backlog', 'dev', 'code_review', 'fixing', 'qa', 'done'], checks: ['code_review', 'qa'], work: 'dev', final: 'done' };
const ONE: Layout = { name: 'one check', statuses: ['todo', 'in_progress', 'review', 'done'], checks: ['review'], work: 'in_progress', final: 'done' };
const WITH_CHECKS = [TWO, BETWEEN, ONE];

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

// A board of `l` with checks (reviewers rev, orch; no reviewers on a board without checks) and API-1 claimed by dev-1 in its work status.
async function board(l: Layout, checks = true): Promise<TestStore> {
  const s = await newStore({ prefix: 'API', statuses: l.statuses });
  if (checks) expect((await run(s, 'orch', ['config', '--review-statuses', l.checks.join(','), '--reviewers', 'rev,orch'])).code).toBe(0);
  expect((await run(s, 'orch', ['create', 'Add endpoint', '--status', l.statuses[0] ?? ''])).code).toBe(0);
  expect((await run(s, 'dev-1', ['claim', 'API-1', '--status', l.work])).code).toBe(0);
  return s;
}

// `board` with API-1 handed in to the first check; `passes`: that many checks passed by rev with finish --status <next>.
async function waiting(l: Layout, passes = 0): Promise<TestStore> {
  const s = await board(l);
  expect((await run(s, 'dev-1', ['finish', 'API-1', '--result', 'work', '--no-commit'])).doc.data.status).toBe(l.checks[0]);
  for (let i = 0; i < passes; i++) {
    const next = l.checks[i + 1] ?? l.final;
    expect((await run(s, 'rev', ['finish', 'API-1', '--status', next, '--result', `check ${i + 1} ok`])).doc.data).toMatchObject({ status: next, passed: true });
  }
  return s;
}

// The two commands an unclear checker's refusal names: to pass the check, and to return the task for rework.
function namedCommands(message: string): { pass: string; back: string } {
  const m = /: (laneboard finish .+?); or return it for rework: (laneboard comment .+)$/.exec(message);
  expect(m, message).not.toBeNull();
  return { pass: m?.[1] ?? '', back: m?.[2] ?? '' };
}

describe('S6w I1: a task enters a check only handed in with finish (update, claim, create, import), on every layout', () => {
  for (const l of WITH_CHECKS) {
    it(`${l.name}: the holder's update or claim into any check is refused, its fix hands in; run as printed, the checkers see the task`, async () => {
      for (const check of l.checks) {
        for (const verb of ['update', 'claim']) {
          const s = await board(l);
          const before = await task(s, 'API-1');
          const r = await run(s, 'dev-1', [verb, 'API-1', '--status', check]);
          expect(r.code, `${verb} ${check}`).toBe(2);
          expect(r.doc.error, `${verb} ${check}`).toMatchObject({ code: 'INVALID_VALUE', fix: `laneboard finish API-1 --status ${l.checks[0]} --result "<what you did, how you checked it>" --as dev-1` });
          expect(await task(s, 'API-1'), `${verb} ${check}`).toMatchObject({ status: l.work, rev: before.rev });
          expect(sh(s, r.doc.error.fix)).toBe(0);
          expect(await row(s, 'API-1')).toMatchObject({ status: l.checks[0], handed_in: true });
          expect(await primeText(s, 'rev')).toContain(`Waiting for your check:\n  API-1  [${l.checks[0]}]`);
        }
      }
    });

    it(`${l.name}: anybody else moving a task in work into a check gets the comment to the holder; run as printed, nothing moves`, async () => {
      const s = await board(l);
      const r = await run(s, 'orch', ['update', 'API-1', '--status', l.checks[0] ?? '']);
      expect(r.code).toBe(2);
      expect(r.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: `laneboard comment API-1 "hand it in: laneboard finish API-1 --status ${l.checks[0]} --result <result>" --as orch` });
      expect(sh(s, r.doc.error.fix)).toBe(0);
      const after = await task(s, 'API-1');
      expect(after).toMatchObject({ status: l.work, assignee: 'dev-1' });
      expect(after.events.at(-1)).toMatchObject({ type: 'commented', actor: 'orch' });
    });

    it(`${l.name}: an unassigned task moved into a check by anybody: the fix is that name's hand-in with finish`, async () => {
      const s = await board(l);
      expect((await run(s, 'dev-1', ['update', 'API-1', '--unassign'])).code).toBe(0);
      const r = await run(s, 'dev-2', ['update', 'API-1', '--status', l.checks[0] ?? '']);
      expect(r.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: `laneboard finish API-1 --status ${l.checks[0]} --result "<what you did, how you checked it>" --as dev-2` });
      expect(sh(s, r.doc.error.fix)).toBe(0);
      expect(await row(s, 'API-1')).toMatchObject({ status: l.checks[0], assignee: 'dev-2', handed_in: true });
    });

    it(`${l.name}: create and import right into a check are refused; nothing is written`, async () => {
      const s = await board(l);
      for (const check of l.checks) {
        const created = await run(s, 'orch', ['create', 'In a check', '--status', check, '--assignee', 'dev-1']);
        expect(created.code, check).toBe(2);
        expect(created.doc.error.message, check).toContain(`on this board ${check} is a check`);
        const src = path.join(s.root, `src-${check}`);
        fs.mkdirSync(src);
        fs.writeFileSync(path.join(src, 'one.md'), `---\ntitle: Imported\nstage: ${check}\n---\nbody\n`);
        const imported = await run(s, 'orch', ['import', 'markdown', src, '--status-key', 'stage']);
        expect(imported.code, check).toBe(2);
        expect(JSON.stringify(imported.doc.error), check).toContain(`on this board ${check} is a check`);
      }
      expect((await run(s, 'orch', ['list', '--scope', 'all'])).doc.data.items.map((t: { id: string }) => t.id)).toEqual(['API-1']);
    });
  }

  for (const l of [TWO, BETWEEN]) {
    it(`${l.name}: a checker's update of a waiting task into another check is refused, the fix reads it; nothing moves (U2 b)`, async () => {
      for (const [passes, to] of [
        [0, 'qa'],
        [1, 'code_review'],
      ] as const) {
        const s = await waiting(l, passes);
        const before = await task(s, 'API-1');
        const r = await run(s, 'orch', ['update', 'API-1', '--status', to]);
        expect(r.code, to).toBe(2);
        expect(r.doc.error, to).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard get API-1' });
        const { pass, back } = namedCommands(r.doc.error.message);
        expect(pass, to).toContain(`laneboard finish API-1 --status ${passes === 0 ? 'qa' : 'done'} `);
        expect(back, to).toContain(`laneboard update API-1 --status ${l.work} --as orch`);
        expect(sh(s, r.doc.error.fix)).toBe(0);
        expect(await task(s, 'API-1'), to).toMatchObject({ status: before.status, rev: before.rev });
        expect((await row(s, 'API-1')).handed_in).toBe(true);
        // A name outside review.by gets the comment to the holder, never the commands of a check.
        const other = await run(s, 'dev-2', ['update', 'API-1', '--status', to]);
        expect(other.doc.error, to).toMatchObject({ code: 'ALREADY_CLAIMED', fix: 'laneboard comment API-1 "<note for dev-1>" --as dev-2' });
        expect(sh(s, other.doc.error.fix)).toBe(0);
        expect((await task(s, 'API-1')).status, to).toBe(before.status);
      }
    });
  }

  it('a board without checks is unchanged: update into code_review by anybody, no warning; another name accepts without --status', async () => {
    const s = await board(TWO, false);
    const moved = await run(s, 'orch', ['update', 'API-1', '--status', 'code_review']);
    expect(moved.code).toBe(0);
    expect(moved.doc.warnings).toEqual([]);
    expect((await run(s, 'dev-1', ['update', 'API-1', '--status', 'qa'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['finish', 'API-1', '--status', 'qa', '--result', 'r', '--no-commit'])).doc.data.status).toBe('qa');
    expect((await run(s, 'rev', ['finish', 'API-1', '--result', 'ok'])).doc.data).toMatchObject({ status: 'done', accepted: true });
    expect((await run(s, 'orch', ['create', 'Straight in', '--status', 'code_review'])).code).toBe(0);
  });
});

describe('S6w I2: a checker names the next status; a stale read never passes the next check (U3)', () => {
  it('two checks, the repro: rev and orch see the same prime; rev runs its pass, orch runs the same stale command: refused, qa not skipped', async () => {
    const s = await waiting(TWO);
    const passLine = (text: string): string => /pass: (laneboard finish API-1 .+)$/m.exec(text)?.[1] ?? '';
    const revCmd = passLine(await primeText(s, 'rev'));
    const orchCmd = passLine(await primeText(s, 'orch'));
    expect(revCmd).toBe('laneboard finish API-1 --status qa --result "<result of your check>" --as rev --json');
    expect(orchCmd).toBe('laneboard finish API-1 --status qa --result "<result of your check>" --as orch --json');
    expect(sh(s, revCmd)).toBe(0);
    const passed = await task(s, 'API-1');
    expect(passed.status).toBe('qa');
    // The stale command of orch, as printed: refused; the task stays in qa, no result of orch.
    expect(sh(s, orchCmd)).toBe(2);
    expect(await task(s, 'API-1')).toMatchObject({ status: 'qa', rev: passed.rev });
    // The bare finish of the persona (no --status) is refused too, its fix only reads.
    const bare = await run(s, 'orch', ['finish', 'API-1', '--result', 'code review ok (orch)']);
    expect(bare.code).toBe(2);
    expect(bare.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard get API-1' });
    expect(bare.doc.error.message).toContain("a checker's finish names where it goes (--status done): it may have moved on since you read it");
    expect(sh(s, bare.doc.error.fix)).toBe(0);
    // A fresh prime names the next status: done.
    const fresh = passLine(await primeText(s, 'orch'));
    expect(fresh).toBe('laneboard finish API-1 --status done --result "<result of your check>" --as orch --json');
    expect(sh(s, fresh)).toBe(0);
    const done = await task(s, 'API-1');
    expect(done.status).toBe('done');
    expect(done.events.filter((e: any) => e.type === 'status').map((e: any) => [e.data.from, e.data.to])).toEqual([
      ['backlog', 'dev'],
      ['dev', 'code_review'],
      ['code_review', 'qa'],
      ['qa', 'done'],
    ]);
  });

  for (const l of WITH_CHECKS) {
    it(`${l.name}: without --status, with the current check or past the next one: refused, the fix reads; --status <next> passes`, async () => {
      const s = await waiting(l);
      const next = l.checks[1] ?? l.final;
      const tries: string[][] = [['finish', 'API-1', '--result', 'ok'], ['finish', 'API-1', '--status', l.checks[0] ?? '', '--result', 'ok']];
      if (next !== l.final) tries.push(['finish', 'API-1', '--status', l.final, '--result', 'ok']);
      const before = await task(s, 'API-1');
      for (const argv of tries) {
        const r = await run(s, 'rev', argv);
        expect(r.code, argv.join(' ')).toBe(2);
        expect(r.doc.error, argv.join(' ')).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard get API-1' });
        expect(namedCommands(r.doc.error.message).pass, argv.join(' ')).toBe(`laneboard finish API-1 --status ${next} --result "<result of your check>" --as rev`);
        expect(sh(s, r.doc.error.fix)).toBe(0);
      }
      expect(await task(s, 'API-1')).toMatchObject({ status: l.checks[0], rev: before.rev });
      expect((await run(s, 'rev', ['finish', 'API-1', '--status', next, '--result', 'ok'])).doc.data).toMatchObject({ status: next });
    });
  }

  it('work status between checks: from code_review the next status is qa (fixing is no check); prime prints it', async () => {
    const s = await waiting(BETWEEN);
    expect(await primeText(s, 'rev')).toContain('pass: laneboard finish API-1 --status qa --result "<result of your check>" --as rev --json');
    expect((await run(s, 'rev', ['prime'])).doc.data.roles.waiting).toMatchObject([{ id: 'API-1', next_status: 'qa' }]);
  });
});

describe('S6w I3: no fix of a checker refusal passes on or accepts; the message names both exact commands (U1)', () => {
  it('two checks, the repro: orch in qa, finish --status qa "qa failed: crash on submit" -> fix get; the return command runs as printed', async () => {
    const s = await waiting(TWO, 1);
    const before = await task(s, 'API-1');
    const r = await run(s, 'orch', ['finish', 'API-1', '--status', 'qa', '--result', 'qa failed: crash on submit']);
    expect(r.code).toBe(2);
    expect(r.doc.error).toEqual({
      code: 'INVALID_VALUE',
      message:
        'API-1 is handed in and waits in qa (code_review -> qa -> done); --status qa is the check it is in now; a checker\'s finish names where it goes (--status done). ' +
        'Read it first (laneboard get API-1), then either accept it into done: laneboard finish API-1 --status done --result "<result of your check>" --as orch; ' +
        "or return it for rework: laneboard comment API-1 --as orch -- 'qa failed: crash on submit' && laneboard update API-1 --status dev --as orch",
      fix: 'laneboard get API-1',
    });
    expect(sh(s, r.doc.error.fix)).toBe(0);
    expect(await task(s, 'API-1')).toMatchObject({ status: 'qa', rev: before.rev });
    // The pass named in the message never carries the failure text; the return does, and runs as printed.
    const { pass, back } = namedCommands(r.doc.error.message);
    expect(pass).not.toContain('failed');
    expect(sh(s, back)).toBe(0);
    const after = await task(s, 'API-1');
    expect(after).toMatchObject({ status: 'dev', assignee: 'dev-1' });
    expect(after.events.at(-2)).toMatchObject({ type: 'commented', actor: 'orch', data: { text: 'qa failed: crash on submit' } });
    expect(after.events.some((e: any) => e.type === 'status' && e.data.accepted === true)).toBe(false);
  });

  for (const l of WITH_CHECKS) {
    it(`${l.name}: finish --status <current check> "needs rework" in each check: fix get, never a pass; the named pass runs as printed`, async () => {
      for (const [i, check] of l.checks.entries()) {
        const s = await waiting(l, i);
        const before = await task(s, 'API-1');
        const r = await run(s, 'orch', ['finish', 'API-1', '--status', check, '--result=- needs rework: no tests']);
        expect(r.doc.error, check).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard get API-1' });
        expect(r.doc.error).not.toHaveProperty('input');
        expect(sh(s, r.doc.error.fix)).toBe(0);
        expect(await task(s, 'API-1'), check).toMatchObject({ status: check, rev: before.rev });
        const { pass, back } = namedCommands(r.doc.error.message);
        expect(back, check).toBe(`laneboard comment API-1 --as orch -- '- needs rework: no tests' && laneboard update API-1 --status ${l.work} --as orch`);
        const next = l.checks[i + 1] ?? l.final;
        expect(sh(s, pass), check).toBe(0);
        expect((await task(s, 'API-1')).status, check).toBe(next);
      }
    });

    it(`${l.name}: an explicit return (finish --status <work status>) keeps the S6v return fix, run as printed`, async () => {
      const s = await waiting(l);
      const r = await run(s, 'rev', ['finish', 'API-1', '--status', l.work, '--result', 'back: no tests']);
      expect(r.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: `laneboard comment API-1 --as rev -- 'back: no tests' && laneboard update API-1 --status ${l.work} --as rev` });
      expect(sh(s, r.doc.error.fix)).toBe(0);
      expect(await task(s, 'API-1')).toMatchObject({ status: l.work, assignee: 'dev-1' });
    });
  }
});

describe('S6w I4: the fix of finish with the result after -- keeps the text (U4)', () => {
  it('finish <ID> -- "- added f1.txt": the fix is --result=<text>, run as printed it hands in with that text', async () => {
    const s = await board(TWO);
    const r = await cli(['finish', 'API-1', '--as', 'dev-1', '--json', '--no-commit', '--', '- added f1.txt'], { cwd: s.root });
    expect(r.code).toBe(2);
    const fix = JSON.parse(r.stdout).error.fix as string;
    expect(fix).toBe("laneboard finish API-1 --as dev-1 --json --no-commit '--result=- added f1.txt'");
    expect(sh(s, fix)).toBe(0);
    const after = await task(s, 'API-1');
    expect(after.status).toBe('code_review');
    expect(after.events.find((e: any) => e.data.result === true)).toMatchObject({ actor: 'dev-1', data: { text: '- added f1.txt' } });
  });

  it('extra words without -- become the result too; a given --result keeps the old fix (the words are dropped)', async () => {
    const s = await board(ONE, false);
    const r = await cli(['finish', 'API-1', 'added', 'tests', '--as', 'dev-1', '--no-commit'], { cwd: s.root });
    expect(r.stderr).toContain("fix: laneboard finish API-1 --as dev-1 --no-commit '--result=added tests'");
    const given = await cli(['finish', 'API-1', '--result', 'r', '--as', 'dev-1', '--', 'more'], { cwd: s.root });
    expect(given.stderr).toContain('fix: laneboard finish API-1 --result r --as dev-1 --');
  });
});

// Review r1 of S6w: a new holder keeps the hand-in (R1), config turning a status with tasks in work into a check (R2), the A17 warning
// names commands that run (R3), the fix of a move of a closed task into a check reopens it first (R4). Every named command run in sh.
describe('S6w review r1', () => {
  // The pass line prime prints for `actor` under API-1, or ''.
  const passLine = async (s: TestStore, actor: string): Promise<string> => /pass: (laneboard finish API-1 .+)$/m.exec(await primeText(s, actor))?.[1] ?? '';

  for (const l of WITH_CHECKS) {
    it(`${l.name}: R1 update --assignee of a waiting task keeps it handed in: in the checkers' queue, prime's pass runs; the new holder is an author`, async () => {
      for (let passes = 0; passes < l.checks.length; passes++) {
        const s = await waiting(l, passes);
        const check = l.checks[passes] ?? '';
        const next = l.checks[passes + 1] ?? l.final;
        // rev passed it into a later check, so orch makes that one (passedBy: the passer's own queue skips it).
        const checker = passes === 0 ? 'rev' : 'orch';
        const moved = await run(s, 'orch', ['update', 'API-1', '--assignee', 'dev-2']);
        expect(moved.code, check).toBe(0);
        expect(await row(s, 'API-1'), check).toMatchObject({ status: check, assignee: 'dev-2', handed_in: true });
        expect(await primeText(s, checker), check).toContain(`Waiting for your check:\n  API-1  [${check}]`);
        expect((await run(s, 'orch', ['doctor'])).doc.data.checks.find((c: { name: string }) => c.name === 'checks'), check).toMatchObject({ ok: true });
        // The new holder never passes on or accepts the task (S6j author rule): it waits for the check.
        const own = await run(s, 'dev-2', ['finish', 'API-1', '--status', next, '--result', 'mine']);
        expect(own.code, check).toBe(2);
        expect(own.doc.error.message, check).toContain('is handed in already');
        const pass = await passLine(s, checker);
        expect(pass, check).toBe(`laneboard finish API-1 --status ${next} --result "<result of your check>" --as ${checker} --json`);
        expect(sh(s, pass), check).toBe(0);
        expect((await task(s, 'API-1')).status, check).toBe(next);
      }
    });

    it(`${l.name}: R1 an unassigned waiting task stays handed in; a checker's claim is refused (S6w r2), both checkers still pass it`, async () => {
      const s = await waiting(l);
      expect((await run(s, 'dev-1', ['update', 'API-1', '--unassign'])).code).toBe(0);
      expect(await row(s, 'API-1')).toMatchObject({ status: l.checks[0], assignee: null, handed_in: true });
      const claimed = await run(s, 'orch', ['claim', 'API-1']);
      expect(claimed.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard get API-1' });
      expect(await row(s, 'API-1')).toMatchObject({ status: l.checks[0], assignee: null, handed_in: true });
      expect(await primeText(s, 'rev')).toContain(`Waiting for your check:\n  API-1  [${l.checks[0]}]`);
      expect(await primeText(s, 'orch')).toContain(`Waiting for your check:\n  API-1  [${l.checks[0]}]`);
      const next = l.checks[1] ?? l.final;
      expect(sh(s, await passLine(s, 'rev'))).toBe(0);
      expect((await task(s, 'API-1')).status).toBe(next);
    });
  }

  it('R1 a board without checks keeps LB-9: a task given to another name after its hand-in is handed in again before somebody else accepts', async () => {
    const s = await board(ONE, false);
    expect((await run(s, 'dev-1', ['finish', 'API-1', '--status', 'review', '--result', 'r', '--no-commit'])).code).toBe(0);
    expect((await run(s, 'orch', ['update', 'API-1', '--assignee', 'dev-2'])).code).toBe(0);
    expect((await row(s, 'API-1')).handed_in).toBe(false);
    expect((await run(s, 'orch', ['finish', 'API-1', '--result', 'ok'])).code).toBe(4);
  });

  it('R2 config turns a status with a task in work into a check: a warning names the task and its holder\'s hand-in; doctor reports it; run, the checkers see it', async () => {
    const s = await newStore({ prefix: 'API', statuses: ['todo', 'dev', 'code_review', 'qa', 'done'] });
    expect((await run(s, 'orch', ['config', '--review-statuses', 'code_review', '--reviewers', 'rev,orch'])).code).toBe(0);
    expect((await run(s, 'orch', ['create', 'In qa', '--status', 'todo', '--assignee', 'dev-1'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['update', 'API-1', '--status', 'qa'])).code).toBe(0);
    expect((await run(s, 'orch', ['create', 'Unassigned in qa', '--status', 'qa'])).code).toBe(0);
    const conf = await run(s, 'orch', ['config', '--review-statuses', 'code_review,qa']);
    expect(conf.code).toBe(0);
    const hand = 'laneboard finish API-1 --status qa --result "<what you did, how you checked it>" --as dev-1';
    const text =
      'tasks in a check that are not handed in, so no checker sees them; the holder of each hands it in (an unassigned one: who did its work): ' +
      `API-1 (qa, held by dev-1): ${hand}; API-2 (qa, unassigned): laneboard finish API-2 --status qa --result "<what you did, how you checked it>"`;
    expect(conf.doc.warnings).toEqual([text]);
    const sick = await run(s, 'orch', ['doctor']);
    expect(sick.code).toBe(6);
    expect(sick.doc.data.checks.find((c: { name: string }) => c.name === 'checks')).toEqual({ name: 'checks', ok: false, fixed: false, message: text });
    expect(sh(s, hand)).toBe(0);
    expect(sh(s, 'laneboard finish API-2 --status qa --result "<what you did, how you checked it>" --as dev-3')).toBe(0);
    expect(await row(s, 'API-1')).toMatchObject({ status: 'qa', handed_in: true });
    expect(await primeText(s, 'rev')).toContain('Waiting for your check:');
    expect((await run(s, 'rev', ['prime'])).doc.data.roles.waiting.map((w: { id: string }) => w.id).sort()).toEqual(['API-1', 'API-2']);
    const well = await run(s, 'orch', ['doctor']);
    expect(well.code).toBe(0);
    expect(well.doc.data.checks.find((c: { name: string }) => c.name === 'checks')).toEqual({ name: 'checks', ok: true, fixed: false, message: 'every task in a check is handed in' });
  });

  // `waiting` with every check passed and the last one accepted by orch: API-1 is closed.
  const closedTask = async (l: Layout): Promise<TestStore> => {
    const s = await waiting(l, l.checks.length - 1);
    expect((await run(s, 'orch', ['finish', 'API-1', '--status', l.final, '--result', 'accepted'])).doc.data).toMatchObject({ status: l.final, accepted: true });
    return s;
  };

  for (const l of WITH_CHECKS) {
    it(`${l.name}: R3 the A17 warning names commands that run: the holder's hand-in after a return, the comment after a close by update`, async () => {
      const s = await waiting(l);
      const back = await run(s, 'rev', ['update', 'API-1', '--status', l.work]);
      expect(back.code).toBe(0);
      const warning = back.doc.warnings[0] as string;
      expect(warning).not.toMatch(/laneboard finish API-1 --result/);
      const handIn = /handed in again: (laneboard finish .+)$/.exec(warning)?.[1] ?? '';
      expect(handIn).toBe(`laneboard finish API-1 --status ${l.checks[0]} --result "<what you did, how you checked it>" --as dev-1`);
      expect(sh(s, handIn)).toBe(0);
      expect(await row(s, 'API-1')).toMatchObject({ status: l.checks[0], handed_in: true });
      const closed = await run(s, 'orch', ['update', 'API-1', '--status', l.final]);
      expect(closed.code).toBe(0);
      const note = closed.doc.warnings.find((w: string) => w.includes('was handed in')) as string;
      expect(note).toContain(`a check passes it on or accepts it with finish --status ${l.checks[1] ?? l.final}, not by a move`);
      const comment = /record the result with (laneboard comment .+)$/.exec(note)?.[1] ?? '';
      expect(comment).toBe('laneboard comment API-1 "<result of your check>"');
      expect(sh(s, `${comment} --as orch`)).toBe(0);
      expect((await task(s, 'API-1')).events.at(-1)).toMatchObject({ type: 'commented', actor: 'orch' });
    });

    it(`${l.name}: R4 a closed task moved into a check: the fix reopens it into ${l.work}, then hands it in; run as printed, the checkers see it`, async () => {
      for (const check of l.checks) {
        const s = await closedTask(l);
        const before = await task(s, 'API-1');
        const r = await run(s, 'dev-1', ['update', 'API-1', '--status', check]);
        expect(r.code, check).toBe(2);
        expect(r.doc.error.fix, check).toBe(
          `laneboard update API-1 --status ${l.work} --as dev-1 && laneboard finish API-1 --status ${l.checks[0]} --result "<what you did, how you checked it>" --as dev-1`,
        );
        expect(await task(s, 'API-1'), check).toMatchObject({ status: l.final, rev: before.rev });
        expect(sh(s, r.doc.error.fix), check).toBe(0);
        expect(await row(s, 'API-1'), check).toMatchObject({ status: l.checks[0], assignee: 'dev-1', handed_in: true });
        expect(await primeText(s, 'rev'), check).toContain(`Waiting for your check:\n  API-1  [${l.checks[0]}]`);
      }
    });
  }

  it('R4 somebody else moving a closed task into a check: the comment asks the holder to reopen and hand it in; run as printed, nothing moves', async () => {
    const s = await closedTask(ONE);
    const r = await run(s, 'dev-2', ['update', 'API-1', '--status', 'review']);
    expect(r.doc.error).toMatchObject({
      code: 'INVALID_VALUE',
      fix: 'laneboard comment API-1 "hand it in: laneboard update API-1 --status in_progress && laneboard finish API-1 --status review --result <result>" --as dev-2',
    });
    expect(sh(s, r.doc.error.fix)).toBe(0);
    expect(await task(s, 'API-1')).toMatchObject({ status: 'done', assignee: 'dev-1' });
  });
});

describe('S6w review r2: nobody claims a task that waits for a check; no free task waits for one; no checker left names the owner\'s way out', () => {
  // The task's status, assignee and rev: what a refused write must leave as it was.
  const state = async (s: TestStore): Promise<Record<string, unknown>> => {
    const t = await task(s, 'API-1');
    return { status: t.status, assignee: t.assignee, rev: t.rev };
  };

  for (const l of WITH_CHECKS) {
    it(`${l.name}: (a) a checker's claim of a waiting task, held or unassigned, with or without --status: fix get (run: no change), the named pass runs`, async () => {
      for (const unassigned of [false, true]) {
        for (let passes = 0; passes < l.checks.length; passes++) {
          const s = await waiting(l, passes);
          if (unassigned) expect((await run(s, 'dev-1', ['update', 'API-1', '--unassign'])).code).toBe(0);
          const next = l.checks[passes + 1] ?? l.final;
          const where = `${unassigned ? 'unassigned' : 'held'} in ${l.checks[passes] ?? ''}`;
          const before = await state(s);
          let message = '';
          for (const checker of ['rev', 'orch']) {
            for (const argv of [['claim', 'API-1'], ['claim', 'API-1', '--status', l.work], ['claim', 'API-1', '--status', l.final]]) {
              const r = await run(s, checker, argv);
              expect(r.code, `${where} ${checker} ${argv.join(' ')}`).toBe(2);
              expect(r.doc.error, `${where} ${checker} ${argv.join(' ')}`).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard get API-1' });
              expect(r.doc.error.message).toContain('claim never takes a task that waits for a check: a check needs no claim');
              expect(sh(s, `${r.doc.error.fix as string} --as ${checker}`), where).toBe(0);
              expect(await state(s), `${where} ${checker} ${argv.join(' ')}`).toEqual(before);
              if (checker === 'orch') message = r.doc.error.message as string;
            }
          }
          const { pass, back } = namedCommands(message);
          expect(pass, where).toBe(`laneboard finish API-1 --status ${next} --result "<result of your check>" --as orch`);
          expect(back, where).toContain(`laneboard update API-1 --status ${l.work} --as orch`);
          expect(sh(s, pass), where).toBe(0);
          expect(await task(s, 'API-1'), where).toMatchObject({ status: next });
        }
      }
    });

    it(`${l.name}: (a) the author's claim gets "handed in already", anybody else's the comment (ALREADY_CLAIMED when held); run as printed, nothing moves`, async () => {
      for (const unassigned of [false, true]) {
        const s = await waiting(l);
        if (unassigned) expect((await run(s, 'dev-1', ['update', 'API-1', '--unassign'])).code).toBe(0);
        const before = await state(s);
        const own = await run(s, 'dev-1', ['claim', 'API-1', '--status', l.work]);
        expect(own.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard comment API-1 "<note for the check>" --as dev-1' });
        expect(own.doc.error.message).toContain('is handed in already');
        const other = await run(s, 'dev-2', ['claim', 'API-1']);
        expect(other.doc.error).toMatchObject({ code: unassigned ? 'INVALID_VALUE' : 'ALREADY_CLAIMED', fix: 'laneboard comment API-1 "<note for the check>" --as dev-2' });
        expect(other.doc.error.message).toContain(`waits in ${l.checks[0] ?? ''} for the check of rev, orch`);
        expect(other.doc.error.message).toContain('claim never takes a task that waits for a check');
        expect(sh(s, own.doc.error.fix)).toBe(0);
        expect(sh(s, other.doc.error.fix)).toBe(0);
        const after = await state(s);
        expect({ ...after, rev: before.rev }).toEqual(before);
        expect((await task(s, 'API-1')).events.slice(-2).map((e: { type: string }) => e.type)).toEqual(['commented', 'commented']);
      }
    });
  }

  it('(b) an unassigned waiting task is in "Waiting for your check", never among the free tasks (prime text and JSON, every name)', async () => {
    const s = await waiting(TWO);
    expect((await run(s, 'dev-1', ['update', 'API-1', '--unassign'])).code).toBe(0);
    // Only the waiting task is unassigned: no free-task section, no "free task" way.
    for (const name of ['rev', 'dev-2']) {
      const text = await primeText(s, name);
      expect(text, name).not.toContain('Free tasks');
      expect(text, name).not.toContain('A free task below');
      expect((await run(s, name, ['prime'])).doc.data, name).toMatchObject({ unassigned: [], unassigned_total: 0 });
    }
    expect(await primeText(s, 'rev')).toContain('Waiting for your check:\n  API-1  [code_review]');
    expect((await run(s, 'orch', ['create', 'Free one', '--status', 'backlog'])).code).toBe(0);
    const text = await primeText(s, 'rev');
    expect(text).toContain('Free tasks (no assignee):\n  API-2  [backlog]');
    expect(text.slice(text.indexOf('Free tasks'))).not.toContain('API-1');
    expect((await run(s, 'rev', ['prime'])).doc.data.unassigned.map((t: { id: string }) => t.id)).toEqual(['API-2']);
  });

  // TWO with rev the only checker; API-1 handed in by dev-1, then given by orch to rev (allowed: S6w r1), so rev is an author of it.
  const soleChecker = async (): Promise<TestStore> => {
    const s = await newStore({ prefix: 'API', statuses: TWO.statuses });
    expect((await run(s, 'orch', ['config', '--review-statuses', 'code_review,qa', '--reviewers', 'rev'])).code).toBe(0);
    expect((await run(s, 'orch', ['create', 'Add endpoint', '--status', 'backlog'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['claim', 'API-1', '--status', 'dev'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['finish', 'API-1', '--result', 'work', '--no-commit'])).code).toBe(0);
    expect((await run(s, 'orch', ['update', 'API-1', '--assignee', 'rev'])).code).toBe(0);
    return s;
  };
  const ADD = 'laneboard config --reviewers "rev,<another checker>"';

  it('(c) no checker left: the refusals, prime of every name and doctor name the owner\'s config --reviewers; run with a name, it passes', async () => {
    const s = await soleChecker();
    const before = await state(s);
    const own = await run(s, 'rev', ['finish', 'API-1', '--status', 'qa', '--result', 'cr ok']);
    expect(own.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard comment API-1 "<note for the check>" --as rev' });
    expect(own.doc.error.message).toContain('for the check of nobody: every checker in config review.by worked on it');
    expect(own.doc.error.message).toContain(`; no checker is left for it, so the owner adds one: ${ADD}`);
    const claim = await run(s, 'orch', ['claim', 'API-1']);
    expect(claim.doc.error).toMatchObject({ code: 'ALREADY_CLAIMED', fix: 'laneboard comment API-1 "<note for the check>" --as orch' });
    expect(claim.doc.error.message).toContain(`so the owner adds one: ${ADD}`);
    expect(sh(s, own.doc.error.fix)).toBe(0);
    expect(sh(s, claim.doc.error.fix)).toBe(0);
    expect({ ...(await state(s)), rev: before.rev }).toEqual(before);
    for (const name of ['rev', 'orch', 'dev-1']) {
      expect(await primeText(s, name), name).toContain(`No checker left for API-1 (every checker in review.by worked on it): the owner adds one: ${ADD}`);
      expect((await run(s, name, ['prime'])).doc.data.roles.no_checker, name).toEqual({ ids: ['API-1'], fix: ADD });
    }
    const sick = await run(s, 'orch', ['doctor']);
    expect(sick.code).toBe(6);
    expect(sick.doc.data.checks.find((c: { name: string }) => c.name === 'checks')).toEqual({
      name: 'checks',
      ok: false,
      fixed: false,
      message: `tasks waiting in a check that no checker may check (every name in config review.by worked on them): API-1 (code_review); the owner adds a checker: ${ADD}`,
    });
    expect(sh(s, ADD.replace('<another checker>', 'lead'))).toBe(0);
    expect((await run(s, 'lead', ['prime'])).doc.data.roles.no_checker).toBeNull();
    expect(await primeText(s, 'rev')).not.toContain('No checker left');
    const pass = /pass: (laneboard finish API-1 .+)$/m.exec(await primeText(s, 'lead'))?.[1] ?? '';
    expect(pass).toBe('laneboard finish API-1 --status qa --result "<result of your check>" --as lead --json');
    expect(sh(s, pass)).toBe(0);
    expect(await task(s, 'API-1')).toMatchObject({ status: 'qa' });
    expect((await run(s, 'orch', ['doctor'])).code).toBe(0);
  });

  it('(c) a board where review.by is not set always has a checker (anybody but the author): no line, doctor healthy', async () => {
    const s = await newStore({ prefix: 'API', statuses: ONE.statuses });
    expect((await run(s, 'orch', ['config', '--review-statuses', 'review'])).code).toBe(0);
    expect((await run(s, 'orch', ['create', 'Add endpoint', '--status', 'todo'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['claim', 'API-1', '--status', 'in_progress'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['finish', 'API-1', '--result', 'work', '--no-commit'])).code).toBe(0);
    expect((await run(s, 'orch', ['update', 'API-1', '--assignee', 'rev'])).code).toBe(0);
    expect((await run(s, 'dev-2', ['prime'])).doc.data.roles.no_checker).toBeNull();
    expect((await run(s, 'orch', ['doctor'])).code).toBe(0);
  });

  it('(d) the only checker passed code_review: qa stays in its prime and task_prime with the pass to done, marked; with another checker it is that one\'s', async () => {
    for (const by of ['rev', 'rev,orch']) {
      const s = await newStore({ prefix: 'API', statuses: TWO.statuses });
      expect((await run(s, 'orch', ['config', '--review-statuses', 'code_review,qa', '--reviewers', by])).code).toBe(0);
      expect((await run(s, 'orch', ['create', 'Add endpoint', '--status', 'backlog'])).code).toBe(0);
      expect((await run(s, 'dev-1', ['claim', 'API-1', '--status', 'dev'])).code).toBe(0);
      expect((await run(s, 'dev-1', ['finish', 'API-1', '--result', 'work', '--no-commit'])).code).toBe(0);
      expect((await run(s, 'rev', ['finish', 'API-1', '--status', 'qa', '--result', 'cr ok'])).doc.data).toMatchObject({ status: 'qa', passed: true });
      const text = await primeText(s, 'rev');
      const waits = (await run(s, 'rev', ['prime'])).doc.data.roles.waiting;
      if (by === 'rev') {
        expect(text).toMatch(/Waiting for your check:\n {2}API-1 {2}\[qa\] {2}rev \d+ {2}Add endpoint {2}\(you passed the previous check\)\n/);
        expect(waits).toEqual([expect.objectContaining({ id: 'API-1', next_status: 'done', passed_by_you: true })]);
        const pass = /pass: (laneboard finish API-1 .+)$/m.exec(text)?.[1] ?? '';
        expect(pass).toBe('laneboard finish API-1 --status done --result "<result of your check>" --as rev --json');
        expect(sh(s, pass)).toBe(0);
        expect(await task(s, 'API-1')).toMatchObject({ status: 'done' });
      } else {
        expect(text).not.toContain('Waiting for your check');
        expect(waits).toEqual([]);
        const other = await primeText(s, 'orch');
        expect(other).toContain('Waiting for your check:\n  API-1  [qa]');
        expect(other).not.toContain('you passed the previous check');
        expect((await run(s, 'orch', ['prime'])).doc.data.roles.waiting).toEqual([expect.objectContaining({ id: 'API-1', passed_by_you: false })]);
      }
    }
  });

  it('MINOR: a checker\'s finish of a task in a check that is not handed in: "only a handed-in task" (the hand-in is the task\'s)', async () => {
    const s = await newStore({ prefix: 'API', statuses: ['todo', 'dev', 'code_review', 'qa', 'done'] });
    expect((await run(s, 'orch', ['config', '--review-statuses', 'code_review', '--reviewers', 'rev,orch'])).code).toBe(0);
    expect((await run(s, 'orch', ['create', 'In qa', '--status', 'todo', '--assignee', 'dev-1'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['update', 'API-1', '--status', 'qa'])).code).toBe(0);
    expect((await run(s, 'orch', ['config', '--review-statuses', 'code_review,qa'])).code).toBe(0);
    const r = await run(s, 'rev', ['finish', 'API-1', '--status', 'done', '--result', 'ok']);
    expect(r.doc.error.code).toBe('ALREADY_CLAIMED');
    expect(r.doc.error.message).toContain('not handed in with finish; a check passes on or accepts only a handed-in task (laneboard finish API-1 --status qa)');
  });
});

describe('S6w review r3: the author in any session of its default name; the free footer says what it lists; no checker left warns', () => {
  const BASE = 'claude-code@ann';
  const SESSION_A = { LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: 'aaaa1111-1a1a-4a1a-8a1a-000000000001' };
  const SESSION_B = { LANEBOARD_DEFAULT_AGENT: BASE, CLAUDE_CODE_SESSION_ID: 'bbbb2222-2b2b-4b2b-8b2b-000000000002' };
  const NAME_A = `${BASE}:aaaa1111`;
  const NAME_B = `${BASE}:bbbb2222`;

  // Run the CLI with --json under the session default name of `env` (no --as); the exit code and the parsed envelope.
  const runIn = async (s: TestStore, env: Record<string, string>, argv: string[]): Promise<{ code: number; doc: Record<string, any> }> => {
    const r = await cli([...argv, '--json'], { cwd: s.root, env });
    return { code: r.code, doc: JSON.parse(r.stdout) };
  };
  const state = async (s: TestStore): Promise<Record<string, unknown>> => {
    const t = await task(s, 'API-1');
    return { status: t.status, assignee: t.assignee, rev: t.rev };
  };

  for (const l of WITH_CHECKS) {
    for (const by of ['', 'rev,orch', `rev,${NAME_B}`]) {
      it(`${l.name}, review.by "${by}": session A handed in; session B neither resumes, checks nor sees it as a check; rev passes; after a return B resumes`, async () => {
        const s = await newStore({ prefix: 'API', statuses: l.statuses });
        expect((await run(s, 'orch', ['config', '--review-statuses', l.checks.join(','), ...(by ? ['--reviewers', by] : [])])).code).toBe(0);
        expect((await run(s, 'orch', ['create', 'Add endpoint', '--status', l.statuses[0] ?? ''])).code).toBe(0);
        expect((await runIn(s, SESSION_A, ['claim', 'API-1', '--status', l.work])).doc.data.assignee).toBe(NAME_A);
        expect((await runIn(s, SESSION_A, ['finish', 'API-1', '--result', 'work', '--no-commit'])).doc.data).toMatchObject({ status: l.checks[0], assignee: NAME_A });
        const before = await state(s);
        // (a), (c): prime of session B lists it neither to resume nor to check.
        const prime = (await runIn(s, SESSION_B, ['prime'])).doc.data;
        expect(prime.agent).toBe(NAME_B);
        expect(prime.resumable).toEqual([]);
        expect(prime.roles.waiting).toEqual([]);
        const text = (await cli(['prime'], { cwd: s.root, env: SESSION_B })).stdout;
        expect(text).not.toContain('API-1');
        expect(text).not.toContain('Your earlier sessions');
        expect(text).not.toContain('Waiting for your check');
        // (b): every way of session B is the author's "handed in already", never an invitation to check; the fix runs, nothing moves.
        const next = l.checks[1] ?? l.final;
        for (const argv of [['claim', 'API-1', '--resume'], ['claim', 'API-1'], ['finish', 'API-1', '--status', next, '--result', 'ok'], ['finish', 'API-1', '--result', 'ok'], ['update', 'API-1', '--status', l.final]]) {
          const r = await runIn(s, SESSION_B, argv);
          expect(r.code, argv.join(' ')).toBe(2);
          expect(r.doc.error, argv.join(' ')).toMatchObject({ code: 'INVALID_VALUE', fix: `laneboard comment API-1 "<note for the check>" --as ${NAME_B}` });
          expect(r.doc.error.message, argv.join(' ')).toContain(`API-1 is handed in already and waits in ${l.checks[0] ?? ''}`);
          expect(r.doc.error.message, argv.join(' ')).not.toContain('laneboard finish');
          expect(sh(s, r.doc.error.fix), argv.join(' ')).toBe(0);
          expect({ ...(await state(s)), rev: before.rev }, argv.join(' ')).toEqual(before);
        }
        // Somebody else still checks it: rev's prime offers the pass, which runs.
        const pass = /pass: (laneboard finish API-1 .+)$/m.exec(await primeText(s, 'rev'))?.[1] ?? '';
        expect(pass).toBe(`laneboard finish API-1 --status ${next} --result "<result of your check>" --as rev --json`);
        expect(sh(s, pass)).toBe(0);
        expect(await task(s, 'API-1')).toMatchObject({ status: next });
        // A return for rework makes it work again: session B finds it to resume and takes it back (claim --resume as before).
        expect((await run(s, 'rev', ['update', 'API-1', '--status', l.work])).code).toBe(0);
        expect((await runIn(s, SESSION_B, ['prime'])).doc.data.resumable.map((t: { id: string }) => t.id)).toEqual(['API-1']);
        const resumed = await runIn(s, SESSION_B, ['claim', 'API-1', '--resume']);
        expect(resumed.code).toBe(0);
        expect(resumed.doc.data).toMatchObject({ assignee: NAME_B, resumed_from: NAME_A });
      });
    }
  }

  it('(b) control: an explicit name of the session form and a name of another base are no author; the session that only checked is none either', async () => {
    const s = await newStore({ prefix: 'API', statuses: TWO.statuses });
    expect((await run(s, 'orch', ['config', '--review-statuses', 'code_review,qa'])).code).toBe(0);
    expect((await run(s, 'orch', ['create', 'Add endpoint', '--status', 'backlog'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['claim', 'API-1', '--status', 'dev'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['finish', 'API-1', '--result', 'work', '--no-commit'])).code).toBe(0);
    // Session A checks code_review (a pass is no work on the task); session B then checks qa: both are checkers, not authors.
    expect((await runIn(s, SESSION_A, ['finish', 'API-1', '--status', 'qa', '--result', 'cr ok'])).doc.data).toMatchObject({ status: 'qa', passed: true });
    expect((await runIn(s, SESSION_B, ['prime'])).doc.data.roles.waiting.map((t: { id: string }) => t.id)).toEqual(['API-1']);
    // An explicit name that looks like a session of the base does not make B an author of a task it handed in.
    expect((await run(s, 'orch', ['create', 'Second', '--status', 'backlog'])).code).toBe(0);
    expect((await run(s, `${BASE}:cccc3333`, ['claim', 'API-2', '--status', 'dev'])).code).toBe(0);
    expect((await run(s, `${BASE}:cccc3333`, ['finish', 'API-2', '--result', 'work', '--no-commit'])).code).toBe(0);
    expect((await runIn(s, SESSION_B, ['prime'])).doc.data.roles.waiting.map((t: { id: string }) => t.id)).toEqual(['API-1', 'API-2']);
    expect((await runIn(s, SESSION_B, ['finish', 'API-2', '--status', 'qa', '--result', 'cr ok'])).doc.data).toMatchObject({ status: 'qa', passed: true });
  });

  it('(2) the free footer: a board with checks says its command lists the waiting tasks too, and prints what it says; without checks no note', async () => {
    for (const checks of [true, false]) {
      const s = await newStore({ prefix: 'API', statuses: TWO.statuses });
      if (checks) expect((await run(s, 'orch', ['config', '--review-statuses', 'code_review,qa'])).code).toBe(0);
      for (let i = 1; i <= 11; i++) expect((await run(s, 'orch', ['create', `free ${i}`, '--status', 'backlog'])).code).toBe(0);
      for (const id of ['API-12', 'API-13']) {
        expect((await run(s, 'orch', ['create', 'work', '--status', 'backlog'])).code).toBe(0);
        expect((await run(s, 'dev-1', ['claim', id, '--status', 'dev'])).code).toBe(0);
        expect((await run(s, 'dev-1', ['finish', id, '--status', 'code_review', '--result', 'work', '--no-commit'])).code).toBe(0);
        expect((await run(s, 'dev-1', ['update', id, '--unassign'])).code).toBe(0);
      }
      const text = await primeText(s, 'dev-2');
      const free = text.slice(text.indexOf('Free tasks'));
      const [, more, footer = ''] = /^\.\.\. (\d+) more: (.*)$/m.exec(free) ?? [];
      // The count is the free tasks the section does not show (prime may show fewer than 10 to keep its budget); without checks the two
      // unassigned tasks in code_review are free work.
      expect((free.match(/^ {2}API-\d+ {2}\[/gm) ?? []).length + Number(more)).toBe(checks ? 11 : 13);
      const note = '(also lists tasks waiting for a check, handed_in true) ';
      expect(footer.startsWith(note), footer).toBe(checks);
      const command = footer.replace(note, '').replace(/^laneboard /, '').replace(' --json', '').split(' ');
      const rows = (await run(s, 'dev-2', command)).doc.data.items as Array<{ id: string; handed_in: boolean }>;
      // The free tasks; with checks the two waiting tasks are printed too, marked handed_in.
      expect(rows.filter((t) => !t.handed_in || !checks)).toHaveLength(checks ? 11 : 13);
      expect(rows.filter((t) => t.handed_in && checks).map((t) => t.id).sort()).toEqual(checks ? ['API-12', 'API-13'] : []);
    }
  });

  it('(3) config --reviewers that leaves a waiting task no checker, and a hand-in when review.by is only the author: a warning with the owner\'s config --reviewers', async () => {
    const s = await newStore({ prefix: 'API', statuses: TWO.statuses });
    expect((await run(s, 'orch', ['config', '--review-statuses', 'code_review,qa', '--reviewers', 'rev'])).code).toBe(0);
    expect((await run(s, 'orch', ['create', 'Add endpoint', '--status', 'backlog'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['claim', 'API-1', '--status', 'dev'])).code).toBe(0);
    const handIn = await run(s, 'dev-1', ['finish', 'API-1', '--result', 'work', '--no-commit']);
    expect(handIn.doc.warnings.join('\n')).not.toContain('no checker may check');
    const cfg = await run(s, 'orch', ['config', '--reviewers', 'dev-1']);
    expect(cfg.code).toBe(0);
    const stuck = `tasks waiting in a check that no checker may check (every name in config review.by worked on them): API-1 (code_review); the owner adds a checker: laneboard config --reviewers "dev-1,<another checker>"`;
    expect(cfg.doc.warnings).toContain(stuck);
    // A hand-in while review.by is only its author: written, with the same warning; the named command, run with a name, clears it.
    expect((await run(s, 'orch', ['create', 'Second', '--status', 'backlog'])).code).toBe(0);
    expect((await run(s, 'dev-1', ['claim', 'API-2', '--status', 'dev'])).code).toBe(0);
    const second = await run(s, 'dev-1', ['finish', 'API-2', '--result', 'work', '--no-commit']);
    expect(second.code).toBe(0);
    expect(second.doc.data).toMatchObject({ status: 'code_review' });
    expect(second.doc.warnings).toContain(stuck.replace('API-1 (code_review)', 'API-2 (code_review)'));
    // Handed in again with a new result after rework: the warning again.
    const again = await run(s, 'dev-1', ['finish', 'API-2', '--result', 'work v2', '--no-commit']);
    expect(again.doc.warnings).toContain(stuck.replace('API-1 (code_review)', 'API-2 (code_review)'));
    const fixed = await run(s, 'orch', ['config', '--reviewers', 'dev-1,rev']);
    expect(fixed.doc.warnings.join('\n')).not.toContain('no checker may check');
    expect((await run(s, 'orch', ['doctor'])).code).toBe(0);
    // A change of the checks that leaves a checker: no warning (control).
    expect((await run(s, 'orch', ['config', '--reviewers', 'rev'])).doc.warnings.join('\n')).not.toContain('no checker may check');
  });
});
