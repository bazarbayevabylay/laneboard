// S5b DoD through the CLI (ADR §28-§29): list --all-boards --open, card marks in view --json and in the terminal, the comment line of
// list, prime --all-boards (K10 grid), every new error's fix runs (K4); the prime rules budgets (review S5a MINOR 1) and the fixes of an
// unreadable store file (review S5a MINOR 2).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cliFix } from '../../src/cli/argv.ts';
import { list } from '../../src/cli/commands/list.ts';
import { OVERVIEW_MAX_CHARS, overviewText, PRIME_MAX_CHARS, RULES_MAX_CHARS, SHORT_RULES_MAX_CHARS, shortRules } from '../../src/cli/format.ts';
import { unreadableStoreFile } from '../../src/core/config.ts';
import { agentRules, createTask, finishTask, registerStore, STALE_AFTER_MS, updateTask } from '../../src/core/index.ts';
import type { OverviewBoard, OverviewCard } from '../../src/core/index.ts';
import { as, ceilingRules, cleanupTemp, cli, newStore, readStore, tempDir, writeRaw } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

// Split a printed `laneboard ...` fix into argv the way a shell would (as test/cli/lb18.test.ts).
function shellArgv(fix: string): string[] {
  expect(fix.startsWith('laneboard ')).toBe(true);
  const out = execFileSync('sh', ['-c', `printf '%s\\0' ${fix.slice('laneboard '.length)}`], { encoding: 'utf8' });
  return out.split('\0').slice(0, -1);
}

// Two registered boards in a fresh HOME: LB (the current one, todo..done) and WEB (backlog/doing/shipped), with open and final tasks.
async function machine(): Promise<{ home: string; lb: TestStore; web: TestStore }> {
  const home = tempDir();
  const lb = await newStore();
  const web = await newStore({ prefix: 'WEB', statuses: ['backlog', 'doing', 'shipped'] });
  await registerStore(home, lb.dir);
  await registerStore(home, web.dir);
  await createTask(as(lb, 'a'), { title: 'LB open', status: 'todo' });
  await createTask(as(lb, 'a'), { title: 'LB done', status: 'done' });
  await createTask(as(web, 'a'), { title: 'WEB open', status: 'doing', assignee: 'dev-1' });
  await createTask(as(web, 'a'), { title: 'WEB shipped', status: 'shipped' });
  return { home, lb, web };
}

describe('S5b DoD: list --all-boards', () => {
  it('--all-boards --open --json: tasks of both boards, data.boards of two, final ones left out', async () => {
    const { home, lb } = await machine();
    const r = await cli(['list', '--all-boards', '--open', '--json'], { cwd: lb.root, env: { HOME: home } });
    expect(r.code, r.stdout).toBe(0);
    const data = JSON.parse(r.stdout).data;
    expect(data.items.map((t: { id: string }) => t.id).sort()).toEqual(['LB-1', 'WEB-1']);
    expect(data.boards.map((b: { prefix: string }) => b.prefix)).toEqual(['LB', 'WEB']);
    const human = (await cli(['list', '--all-boards', '--open'], { cwd: lb.root, env: { HOME: home } })).stdout;
    expect(human).toContain('2 of 2 shown (scope active, boards: LB, WEB)');
  });

  it('a status no board knows: UNKNOWN_STATUS with the union of statuses as allowed', async () => {
    const { home, lb } = await machine();
    const r = await cli(['list', '--all-boards', '--status', 'nope', '--json'], { cwd: lb.root, env: { HOME: home } });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: 'UNKNOWN_STATUS', allowed: ['todo', 'in_progress', 'review', 'done', 'backlog', 'doing', 'shipped'] });
    const doing = JSON.parse((await cli(['list', '--all-boards', '--status', 'doing', '--json'], { cwd: lb.root, env: { HOME: home } })).stdout).data;
    expect(doing.items.map((t: { id: string }) => t.id)).toEqual(['WEB-1']);
  });

  it('without HOME: USAGE, the fix puts HOME before the same command, and it runs', async () => {
    const { home, lb } = await machine();
    const r = await cli(['list', '--all-boards', '--open', '--json'], { cwd: lb.root, env: {} });
    expect(r.code).toBe(2);
    const err = JSON.parse(r.stdout).error;
    expect(err).toMatchObject({ code: 'USAGE', fix: 'HOME=<your home directory> laneboard list --all-boards --open --json' });
    const run = await cli(shellArgv(err.fix.replace('HOME=<your home directory> ', '')), { cwd: lb.root, env: { HOME: home } });
    expect(run.code, run.stdout).toBe(0);
    expect(JSON.parse(run.stdout).data.total).toBe(2);
  });

  it('with --board: USAGE, the fix drops --board, and it runs', async () => {
    const { home, lb } = await machine();
    const r = await cli(['list', '--all-boards', '--board', 'WEB', '--json'], { cwd: lb.root, env: { HOME: home } });
    expect(r.code).toBe(2);
    const err = JSON.parse(r.stdout).error;
    expect(err).toMatchObject({ code: 'USAGE', fix: 'laneboard list --all-boards --json' });
    const run = await cli(shellArgv(err.fix), { cwd: lb.root, env: { HOME: home } });
    expect(run.code, run.stdout).toBe(0);
    expect(JSON.parse(run.stdout).data.total).toBe(4);
  });

  it('--label waiting-owner --all-boards finds the marked task of another board', async () => {
    const { home, lb, web } = await machine();
    await updateTask(as(web, 'orchestrator'), { id: 'WEB-1', add_labels: ['waiting-owner'] });
    const r = JSON.parse((await cli(['list', '--label', 'waiting-owner', '--all-boards', '--json'], { cwd: lb.root, env: { HOME: home } })).stdout);
    expect(r.data.items.map((t: { id: string }) => t.id)).toEqual(['WEB-1']);
  });
});

describe('S5b DoD: cards in view --json and in the terminal, the comment line of list', () => {
  it('view --json: handed_in after the assignee finishes into review, stale past 4 h in work (not handed in, not todo), last_comment', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Handed', status: 'in_progress', assignee: 'dev-1' });
    await finishTask(as(s, 'dev-1'), { id: 'LB-1', result: 'Done: redirect fixed\nsecond line', status: 'review', no_commit: true });
    await createTask(as(s, 'a'), { title: 'Stuck', status: 'in_progress', assignee: 'dev-2' });
    await createTask(as(s, 'a'), { title: 'Todo assigned', status: 'todo', assignee: 'dev-3' });
    const doc = readStore(s.dir, 'active');
    for (const t of doc.tasks) t.updated_at = new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString();
    writeRaw(path.join(s.dir, 'active.json'), JSON.stringify(doc, null, 2));
    const view = JSON.parse((await cli(['view', '--json'], { cwd: s.root })).stdout).data;
    const card = (id: string) => view.columns.flatMap((c: { cards: Array<{ id: string }> }) => c.cards).find((c: { id: string }) => c.id === id);
    expect(card('LB-1')).toMatchObject({ handed_in: true, stale: false, last_comment: { text: 'Done: redirect fixed', result: true, actor: 'dev-1' } });
    expect(card('LB-2')).toMatchObject({ handed_in: false, in_work: true, stale: true, last_comment: null });
    expect(card('LB-3')).toMatchObject({ in_work: false, stale: false });
  });

  it('terminal: the holder line shows waiting-owner, ^parent, final/total children; the comment line under the card (= for a result)', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Parent', status: 'in_progress', assignee: 'orc', labels: ['waiting-owner'] });
    await createTask(as(s, 'a'), { title: 'Child', status: 'in_progress', assignee: 'dev-1', parent: 'LB-1' });
    await createTask(as(s, 'a'), { title: 'Child done', status: 'done', parent: 'LB-1' });
    await cli(['comment', 'LB-1', 'Asked the owner: which payment provider?', '--as', 'orc'], { cwd: s.root });
    await finishTask(as(s, 'dev-1'), { id: 'LB-2', result: 'Ready for review', status: 'review', no_commit: true });
    const wide = (await cli(['view'], { cwd: s.root, env: { COLUMNS: '200' } })).stdout;
    expect(wide).toMatch(/<1m · orc · waiting-owner · 1\/2/);
    expect(wide).toMatch(/<1m · dev-1 · \^LB-1/);
    expect(wide).toContain('  > Asked the owner: which payment provider?');
    expect(wide).toContain('  = Ready for review');
    const narrow = (await cli(['view'], { cwd: s.root, env: { COLUMNS: '60' } })).stdout;
    expect(narrow).toContain('    > Asked the owner: which payment');
    expect(narrow).toMatch(/LB-1 {2}<1m · orc · waiting-owner · 1\/2 {2}Parent/);
    const rows = (await cli(['list'], { cwd: s.root })).stdout.split('\n');
    const at = rows.findIndex((l) => l.startsWith('LB-1 '));
    expect(rows[at + 1]).toBe('    > Asked the owner: which payment provider?');
    expect(rows.some((l) => l === '    = Ready for review')).toBe(true);
  });
});

// A synthetic overview: `boards` boards × `tasks` cards, three of them urgent per board (waiting-owner, handed in, stale), some children,
// comments of `comment` characters (0: none).
function overview(boards: number, tasks: number, comment: number): OverviewBoard[] {
  const at = new Date().toISOString();
  return Array.from({ length: boards }, (_, b) => {
    const prefix = `B${b + 1}`;
    const cards: OverviewCard[] = Array.from({ length: tasks }, (_, i) => ({
      id: `${prefix}-${i + 1}`,
      status: i % 2 ? 'in_progress' : 'todo',
      title: `Task ${i + 1} of board ${b + 1} with a title long enough to be cut at fifty characters`,
      assignee: i % 3 ? `claude-code@someone:${String(i).padStart(8, '0')}` : null,
      labels: i === 0 ? ['waiting-owner'] : [],
      status_since: at,
      rev: 1,
      last_comment: comment ? { at, actor: 'dev', text: 'c'.repeat(comment), result: i === 1 } : null,
      parent: i > 3 && i % 4 === 0 ? `${prefix}-${i}` : null,
      children: { total: 0, final: 0 },
      updated_at: at,
      handed_in: i === 1,
      in_work: i === 2 || i === 3,
      stale: i === 2,
    }));
    return { prefix, name: `board-${b + 1}`, path: `/p/${prefix}/.laneboard`, current: b === 0, problem: null, counts: [{ status: 'todo', count: tasks }, { status: 'done', count: 2 }], final_status: 'done', final_total: 2, cards };
  });
}

describe('K10 (ADR §29): the all-boards section stays within its budget and never drops a board header', () => {
  it('grid: boards 1/5/20 × tasks 0/10/60 × comments 0/120 characters', () => {
    for (const boards of [1, 5, 20]) {
      for (const tasks of [0, 10, 60]) {
        for (const comment of [0, 120]) {
          const data = overview(boards, tasks, comment);
          const text = overviewText(data);
          const where = `boards=${boards} tasks=${tasks} comment=${comment}`;
          expect(text.length, where).toBeLessThanOrEqual(OVERVIEW_MAX_CHARS);
          const lines = text.split('\n');
          expect(lines[0], where).toBe('Boards (not final; all: laneboard list --all-boards --open --json):');
          for (const b of data) expect(lines.some((l) => l.startsWith(`${b.prefix} ${b.name}${b.current ? ' (this board)' : ''}: todo ${tasks}; done 2`)), `${where} ${b.prefix}`).toBe(true);
          // The urgent ones are named on every step, the last one included (ids only).
          for (const b of data) {
            for (const urgent of tasks ? ['-1', '-2', '-3'] : []) expect(text, `${where} ${b.prefix}${urgent}`).toMatch(new RegExp(`\\b${b.prefix}${urgent}\\b`));
          }
        }
      }
    }
  });

  it('the squeeze order: comments of open lines go first, then open lines become a view command, then all comments, titles, ids only', () => {
    const one = overview(1, 10, 120);
    const full = overviewText(one);
    expect(full).toContain('  waiting-owner B1-1 [todo] - <1m: Task 1 of board 1 with a title long enough to be … | ');
    expect(full).toContain('  handed in B1-2 [in_progress] someone:00000001 <1m: Task 2');
    expect(full).toContain('| = cccc');
    expect(full).toContain('    open B1-5 [todo] someone:00000004 <1m: Task 5');
    const step = (budget: number): string => overviewText(one, new Date(), budget);
    expect(step(full.length - 1)).not.toMatch(/^ {2,}open .* \| /m);
    expect(step(full.length - 1)).toMatch(/^ {2}stale .* \| c/m);
    const noOpen = step(1200);
    expect(noOpen).toContain('  ... 6 more: laneboard view --board B1');
    expect(noOpen).not.toMatch(/^ +open /m);
    expect(step(500)).toBe(
      [
        'Boards (not final; all: laneboard list --all-boards --open --json):',
        'B1 board-1 (this board): todo 10; done 2',
        '  waiting-owner B1-1 [todo] - <1m: Task 1 of board 1 with a titl…',
        '  handed in B1-2 [in_progress] someone:00000001 <1m: Task 2 of board 1 with a titl…',
        '  stale B1-3 [todo] someone:00000002 <1m: Task 3 of board 1 with a titl…',
        '  in work B1-4 [in_progress] - <1m: Task 4 of board 1 with a titl…',
        '  ... 6 more: laneboard view --board B1',
      ].join('\n'),
    );
    expect(step(200)).toBe(['Boards (not final; all: laneboard list --all-boards --open --json):', 'B1 board-1 (this board): todo 10; done 2', '  waiting-owner: B1-1 · handed in: B1-2 · stale: B1-3'].join('\n'));
  });

  it('CLI: prime --all-boards --hook prints the usual prime and the section (each board header), --json has boards; no HOME: one line', async () => {
    const { home, lb, web } = await machine();
    await updateTask(as(web, 'orchestrator'), { id: 'WEB-1', add_labels: ['waiting-owner'] });
    const r = await cli(['prime', '--hook', '--all-boards', '--as', 'orchestrator'], { cwd: lb.root, env: { HOME: home } });
    expect(r.code, r.stderr).toBe(0);
    const [own, section] = r.stdout.trimEnd().split('\n\nBoards (not final');
    expect((own ?? '').length).toBeLessThanOrEqual(PRIME_MAX_CHARS);
    expect(`Boards (not final${section}`.length).toBeLessThanOrEqual(OVERVIEW_MAX_CHARS);
    expect(section).toContain('\nLB test (this board): todo 1, in_progress 0, review 0; done 1\n  open LB-1 [todo] - <1m: LB open');
    expect(section).toContain('\nWEB test: backlog 0, doing 1; shipped 1\n  waiting-owner WEB-1 [doing] dev-1 <1m: WEB open');
    const json = JSON.parse((await cli(['prime', '--all-boards', '--as', 'orchestrator', '--json'], { cwd: lb.root, env: { HOME: home } })).stdout);
    expect(json.data.boards.map((b: { prefix: string; current: boolean }) => [b.prefix, b.current])).toEqual([
      ['LB', true],
      ['WEB', false],
    ]);
    expect(json.data.boards[1].cards[0]).toMatchObject({ id: 'WEB-1', status: 'doing', labels: ['waiting-owner'] });
    const bare = await cli(['prime', '--hook', '--all-boards', '--as', 'orchestrator'], { cwd: lb.root, env: {} });
    expect(bare.code).toBe(0);
    expect(bare.stdout.trimEnd().endsWith('\n\nall boards: HOME is not set')).toBe(true);
  });

  it('prime --edit-hook --all-boards: USAGE, the fix drops --all-boards, and it runs', async () => {
    const { home, lb } = await machine();
    const r = await cli(['prime', '--edit-hook', '--all-boards'], { cwd: lb.root, env: { HOME: home } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('fix: laneboard prime --edit-hook\n');
    expect((await cli(shellArgv('laneboard prime --edit-hook'), { cwd: lb.root, env: { HOME: home } })).code).toBe(0);
  });
});

describe('review S5a MINOR 1: the rules have their own budgets inside prime', () => {
  it(`the rules fit RULES_MAX_CHARS (${RULES_MAX_CHARS}) and, with their short forms, SHORT_RULES_MAX_CHARS (${SHORT_RULES_MAX_CHARS})`, () => {
    const why = 'shorten the rule (or its short form) in src/core/agent-rules.md, or raise the budget in src/cli/format.ts and ADR-0001 §29';
    expect(agentRules().length, why).toBeLessThanOrEqual(RULES_MAX_CHARS);
    expect(shortRules(agentRules()).length, why).toBeLessThanOrEqual(SHORT_RULES_MAX_CHARS);
    // The prime grids run at the ceiling: both budgets reachable at once (ceilingRules throws otherwise).
    expect(ceilingRules()).toHaveLength(RULES_MAX_CHARS);
  });
});

describe('review S5a MINOR 2: an unreadable store file gets the fix for its cause', () => {
  it('no permission on the .laneboard directory: the fix gives it back to the directory and the file, and it runs', async () => {
    const s = await newStore();
    fs.chmodSync(s.dir, 0o600);
    try {
      const r = await cli(['list', '--json'], { cwd: s.root });
      expect(r.code).toBe(6);
      const err = JSON.parse(r.stdout).error;
      expect(err.code).toBe('STORE_INVALID');
      expect(err.fix).toMatch(new RegExp(`^chmod u\\+rwx ${s.dir} && chmod u\\+rw ${s.dir}/(config|active)\\.json$`));
      execFileSync('sh', ['-c', err.fix]);
    } finally {
      fs.chmodSync(s.dir, 0o755);
    }
    expect((await cli(['list', '--json'], { cwd: s.root })).code).toBe(0);
  });

  it('a passing error (EMFILE, no code): INTERNAL, the file is not damaged, the CLI fix is the same command; never a restore', () => {
    for (const code of ['EMFILE', 'ENFILE', 'EAGAIN', 'ENOMEM', undefined]) {
      const err = unreadableStoreFile('/p/.laneboard/active.json', 'active.json', { code });
      expect(err.code).toBe('INTERNAL');
      expect(err.message).toBe(`active.json cannot be read right now (${code ?? 'UNKNOWN'}): /p/.laneboard/active.json; the file is not damaged`);
      expect(err.fix).not.toMatch(/restore/);
      const argv = ['list', '--status', 'todo', '--json'];
      expect(cliFix(err, argv, list, { json: { type: 'boolean' }, ...list.options })).toBe('laneboard list --status todo --json');
    }
    for (const code of ['EISDIR', 'ENOTDIR', 'EIO']) expect(unreadableStoreFile('/p/a.json', 'a.json', { code }).fix).toMatch(/^restore \/p\/a\.json/);
  });
});
