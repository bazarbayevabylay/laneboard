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
