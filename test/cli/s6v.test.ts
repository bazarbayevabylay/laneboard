// S6v (UX run 3, B-U1): the fix of a refusal never changes what the caller meant. A checker that asks finish for a status before the
// one the task is in (back to an earlier check, a work status, the starting status) wants a return for rework: the fix is the
// documented return (a comment with its text, then update into the work status), runnable as printed, and never a finish that passes
// the task on or accepts it. Persona B's flow: dev -> code_review -> qa -> done, checkers rev, orch.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTemp, cli, CLI_SOURCE, newStore, tempDir } from '../helpers.ts';
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

// API-1 held by dev-2 and handed in to code_review; `toQa`: rev passed it on to qa.
async function handedIn(toQa: boolean): Promise<TestStore> {
  const s = await newStore({ prefix: 'API', statuses: FLOW });
  expect((await run(s, 'orch', ['config', '--review-statuses', 'code_review,qa', '--reviewers', 'rev,orch'])).code).toBe(0);
  expect((await run(s, 'orch', ['create', 'Add endpoint', '--status', 'ready'])).code).toBe(0);
  expect((await run(s, 'dev-2', ['claim', 'API-1', '--status', 'dev'])).code).toBe(0);
  expect((await run(s, 'dev-2', ['finish', 'API-1', '--result', 'work', '--no-commit'])).doc.data.status).toBe('code_review');
  if (toQa) expect((await run(s, 'rev', ['finish', 'API-1', '--status', 'qa', '--result', 'review ok'])).doc.data).toMatchObject({ status: 'qa', passed: true });
  return s;
}

// Run a fix as printed in a shell (rule 13), with `laneboard` on PATH running this source, in the store's folder.
function runFix(s: TestStore, fix: string): string {
  const bin = tempDir();
  fs.writeFileSync(path.join(bin, 'laneboard'), `#!/bin/sh\nexec "${process.execPath}" "${CLI_SOURCE}" "$@"\n`, { mode: 0o755 });
  return execFileSync('sh', ['-c', fix], { cwd: s.root, env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: tempDir() }, encoding: 'utf8' });
}

describe('S6v B-U1: a checker asking for an earlier status gets the return for rework, never an acceptance', () => {
  it('the repro: rev in qa, finish --status code_review "back: missing test" -> refused, the fix comments and moves to dev; run as printed, no acceptance', async () => {
    const s = await handedIn(true);
    const before = await task(s, 'API-1');
    const r = await run(s, 'rev', ['finish', 'API-1', '--status', 'code_review', '--result', 'back: missing test']);
    expect(r.code).toBe(2);
    expect(r.doc.error).toEqual({
      code: 'INVALID_VALUE',
      message:
        'API-1 is handed in and qa: a check passes it on to a later check or accepts it into done (code_review -> qa -> done), never into code_review; ' +
        'to return it for rework, comment why, then laneboard update API-1 --status dev (the assignee hands it in again with finish)',
      fix: "laneboard comment API-1 --as rev --json -- 'back: missing test' && laneboard update API-1 --status dev --as rev --json",
    });
    expect(await task(s, 'API-1')).toMatchObject({ status: 'qa', rev: before.rev });
    runFix(s, r.doc.error.fix);
    const after = await task(s, 'API-1');
    expect(after).toMatchObject({ status: 'dev', assignee: 'dev-2' });
    const tail = after.events.slice(-2);
    expect(tail[0]).toMatchObject({ type: 'commented', actor: 'rev', data: { text: 'back: missing test' } });
    expect(tail[1]).toMatchObject({ type: 'status', actor: 'rev', data: { from: 'qa', to: 'dev' } });
    expect(after.events.some((e: any) => e.type === 'status' && e.data.accepted === true)).toBe(false);
    // The rework loop goes on as documented: the assignee hands in again to the first check.
    expect((await run(s, 'dev-2', ['finish', 'API-1', '--result', 'test added', '--no-commit'])).doc.data).toMatchObject({ status: 'code_review' });
  });

  it('every status before the current one by a checker gets the return (an earlier check, a work status), never a finish fix', async () => {
    const s = await handedIn(true);
    for (const [to, work] of [
      ['code_review', 'dev'],
      ['dev', 'dev'],
      ['ready', 'ready'],
    ] as const) {
      const r = await run(s, 'orch', ['finish', 'API-1', '--status', to, '--result', 'no']);
      expect(r.code, to).toBe(2);
      expect(r.doc.error.fix, to).toBe(`laneboard comment API-1 --as orch --json -- no && laneboard update API-1 --status ${work} --as orch --json`);
      expect(r.doc.error.fix, to).not.toMatch(/finish|done|qa/);
    }
    expect(await task(s, 'API-1')).toMatchObject({ status: 'qa' });
  });

  it('in the first check a checker asking for the work status is not passed on to qa: the same return', async () => {
    const s = await handedIn(false);
    const r = await run(s, 'rev', ['finish', 'API-1', '--status', 'dev', '--result', "it's broken"]);
    expect(r.code).toBe(2);
    expect(r.doc.error.fix).toBe(`laneboard comment API-1 --as rev --json -- 'it'\\''s broken' && laneboard update API-1 --status dev --as rev --json`);
    runFix(s, r.doc.error.fix);
    const after = await task(s, 'API-1');
    expect(after.status).toBe('dev');
    expect(after.events.at(-2)).toMatchObject({ type: 'commented', data: { text: "it's broken" } });
  });

  it('the starting status (refused before any check) by a checker: back to the start with the comment, never --status done', async () => {
    const s = await handedIn(true);
    const r = await run(s, 'rev', ['finish', 'API-1', '--status', 'backlog', '--result', 'not now']);
    expect(r.code).toBe(2);
    expect(r.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: "laneboard comment API-1 --as rev --json -- 'not now' && laneboard update API-1 --status backlog --as rev --json" });
    expect(r.doc.error.message).toContain('back to the start: laneboard update API-1 --status backlog');
    runFix(s, r.doc.error.fix);
    expect(await task(s, 'API-1')).toMatchObject({ status: 'backlog' });
  });

  it('control: the current check is no pass (S6w I3: the fix reads the task), and the checker passes on and accepts by naming the next status', async () => {
    const s = await handedIn(false);
    const same = await run(s, 'rev', ['finish', 'API-1', '--status', 'code_review', '--result', 'ok']);
    expect(same.doc.error).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard get API-1 --json' });
    expect((await run(s, 'rev', ['finish', 'API-1', '--status', 'qa', '--result', 'ok'])).doc.data).toMatchObject({ status: 'qa', passed: true });
    expect((await run(s, 'orch', ['finish', 'API-1', '--status', 'done', '--result', 'qa ok'])).doc.data).toMatchObject({ status: 'done', accepted: true, from: 'qa' });
  });
});

// Review r1: a work status that lies between two checks is a return for rework too, wherever it is; a result that starts with "-"
// goes after `--` in the fix, so the comment never reads it as an option.
describe('S6v review r1: a work status between the checks, and a result that starts with "-"', () => {
  const LOOP = ['backlog', 'dev', 'code_review', 'fixing', 'qa', 'done'];

  // API-1 of dev-2 handed in to code_review on the board backlog -> dev -> code_review -> fixing -> qa -> done (checks code_review, qa).
  async function inReview(): Promise<TestStore> {
    const s = await newStore({ prefix: 'API', statuses: LOOP });
    expect((await run(s, 'orch', ['config', '--review-statuses', 'code_review,qa', '--reviewers', 'rev,orch'])).code).toBe(0);
    expect((await run(s, 'orch', ['create', 'Add endpoint', '--status', 'backlog'])).code).toBe(0);
    expect((await run(s, 'dev-2', ['claim', 'API-1', '--status', 'dev'])).code).toBe(0);
    expect((await run(s, 'dev-2', ['finish', 'API-1', '--result', 'work', '--no-commit'])).doc.data.status).toBe('code_review');
    return s;
  }

  it('the repro: rev in code_review, finish --status fixing "back: fix lint" -> the return into fixing, run as printed, never passed on to qa', async () => {
    const s = await inReview();
    const r = await run(s, 'rev', ['finish', 'API-1', '--status', 'fixing', '--result', 'back: fix lint']);
    expect(r.code).toBe(2);
    expect(r.doc.error).toEqual({
      code: 'INVALID_VALUE',
      message:
        'API-1 is handed in and code_review: a check passes it on to a later check or accepts it into done (code_review -> qa -> done), never into fixing; ' +
        'to return it for rework, comment why, then laneboard update API-1 --status fixing (the assignee hands it in again with finish)',
      fix: "laneboard comment API-1 --as rev --json -- 'back: fix lint' && laneboard update API-1 --status fixing --as rev --json",
    });
    runFix(s, r.doc.error.fix);
    const after = await task(s, 'API-1');
    expect(after).toMatchObject({ status: 'fixing', assignee: 'dev-2' });
    expect(after.events.at(-2)).toMatchObject({ type: 'commented', actor: 'rev', data: { text: 'back: fix lint' } });
    expect(after.events.at(-1)).toMatchObject({ type: 'status', actor: 'rev', data: { from: 'code_review', to: 'fixing' } });
    expect(after.events.some((e: any) => e.type === 'status' && (e.data.passed === true || e.data.accepted === true))).toBe(false);
  });

  it('from qa the work status between the checks is the same return (before the current one), never an acceptance', async () => {
    const s = await inReview();
    expect((await run(s, 'rev', ['finish', 'API-1', '--status', 'qa', '--result', 'review ok'])).doc.data).toMatchObject({ status: 'qa', passed: true });
    const r = await run(s, 'orch', ['finish', 'API-1', '--status', 'fixing', '--result', 'no']);
    expect(r.doc.error.fix).toBe('laneboard comment API-1 --as orch --json -- no && laneboard update API-1 --status fixing --as orch --json');
  });

  it('a result that starts with "-" runs as printed: the comment keeps the text, the task goes back to the work status', async () => {
    for (const text of ['- missing test', '-1 test fails', '--broken']) {
      const s = await handedIn(false);
      const r = await run(s, 'rev', ['finish', 'API-1', '--status', 'dev', `--result=${text}`]);
      expect(r.code, text).toBe(2);
      expect(r.doc.error.fix, text).toMatch(/^laneboard comment API-1 --as rev --json -- \S.* && laneboard update API-1 --status dev --as rev --json$/);
      runFix(s, r.doc.error.fix);
      const after = await task(s, 'API-1');
      expect(after.status, text).toBe('dev');
      expect(after.events.at(-2), text).toMatchObject({ type: 'commented', actor: 'rev', data: { text } });
    }
  });
});
