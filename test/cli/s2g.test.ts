// S2g: short replies of writes (LB-7), prime for subagents - free tasks, explicit names, the default-name hint (LB-8),
// the session part of a default name in the narrow view, the registry init fix (review S2f).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderBoard } from '../../src/cli/board-view.ts';
import { PRIME_MAX_CHARS, primeText } from '../../src/cli/format.ts';
import type { PrimeData } from '../../src/cli/format.ts';
import { agentRules, archiveTasks, claimTask, commentTask, createTask } from '../../src/core/index.ts';
import type { ListItem, ViewResult } from '../../src/core/index.ts';
import { callTool } from '../../src/mcp/tools.ts';
import { as, ceilingRules, cleanupTemp, cli, fixedStorePath, newStore } from '../helpers.ts';

afterAll(cleanupTemp);

// A default session name as Claude Code sessions get it (agent-name.ts).
const SESSION = { LANEBOARD_DEFAULT_AGENT: 'claude-code@Test-Person', CLAUDE_CODE_SESSION_ID: '1a2b3c4d-0000-4000-8000-000000000001' };
const DEFAULT_NAME = 'claude-code@Test-Person:1a2b3c4d';

describe('write replies are short (LB-7)', () => {
  it('every task write prints id, rev, status, assignee with --json and one line for people; --full gives the whole task', async () => {
    const s = await newStore();
    fs.writeFileSync(path.join(s.root, 'notes.txt'), 'some notes\n');
    const run = async (argv: string[]) => {
      const r = await cli(argv, { cwd: s.root });
      expect(r.code, r.stdout + r.stderr).toBe(0);
      return r;
    };
    const json = async (argv: string[]) => JSON.parse((await run([...argv, '--json'])).stdout);
    expect((await json(['create', 'Fix login', '--status', 'todo', '--as', 'a'])).data).toEqual({ id: 'LB-1', rev: 1, status: 'todo', assignee: null });
    expect((await json(['claim', 'LB-1', '--status', 'in_progress', '--as', 'dev-1'])).data).toEqual({ id: 'LB-1', rev: 2, status: 'in_progress', assignee: 'dev-1' });
    expect((await json(['update', 'LB-1', '--title', 'Fix the login', '--as', 'dev-1'])).data).toEqual({ id: 'LB-1', rev: 3, status: 'in_progress', assignee: 'dev-1' });
    expect((await json(['comment', 'LB-1', 'step', '--as', 'dev-1'])).data).toEqual({ id: 'LB-1', rev: 4, status: 'in_progress', assignee: 'dev-1' });
    const sha256 = 'af94040caa54ae89a0460096007629185ce8d17256b0ba0ed7691ef4500449bf';
    expect((await json(['attach', 'LB-1', 'notes.txt', '--as', 'dev-1'])).data).toEqual({ id: 'LB-1', rev: 5, status: 'in_progress', assignee: 'dev-1', attachment: { name: 'notes.txt', size: 11, sha256 } });
    expect((await json(['attach', 'LB-1', '--remove', 'notes.txt', '--as', 'dev-1'])).data).toEqual({ id: 'LB-1', rev: 6, status: 'in_progress', assignee: 'dev-1' });
    await run(['update', 'LB-1', '--status', 'done', '--as', 'dev-1']);
    await run(['archive', 'LB-1', '--as', 'dev-1']);
    expect((await json(['restore', 'LB-1', '--as', 'dev-1'])).data).toEqual({ id: 'LB-1', rev: 9, status: 'done', assignee: 'dev-1' });
    // The envelope keeps store, prefix and warnings.
    const created = await json(['create', 'For someone', '--status', 'todo', '--assignee', 'dev-2', '--as', 'a']);
    expect(created).toMatchObject({ ok: true, store: s.dir, prefix: 'LB', data: { id: 'LB-2', rev: 1, status: 'todo', assignee: 'dev-2' } });
    expect(created.warnings[0]).toMatch(/^LB-2 is assigned to dev-2, not to you \(a\)/);
    // People: one line with what changed and the state after it.
    expect((await run(['comment', 'LB-2', 'note', '--as', 'a'])).stdout).toBe('LB-2 commented (rev 2, todo, dev-2)\n');
    // 0.4.1 (LB-57.4): a claim of one's own task in the first status moves it into the work status.
    expect((await run(['claim', 'LB-2', '--as', 'dev-2'])).stdout).toBe('LB-2 claimed (rev 3, in_progress, dev-2)\n');
    expect((await run(['update', 'LB-2', '--unassign', '--as', 'a'])).stdout).toBe('LB-2 updated (rev 4, in_progress, unassigned)\n');
    // --full: the task as get shows it, in JSON and for people; get alone adds its parent and children (ADR §25).
    const full = await json(['comment', 'LB-2', 'more', '--as', 'a', '--full']);
    const got = await json(['get', 'LB-2']);
    const { parent_task, children, linked_tasks, ...task } = got.data;
    expect({ parent_task, children, linked_tasks }).toEqual({ parent_task: null, children: [], linked_tasks: [] });
    expect(full.data).toEqual(task);
    expect(full.data.events.at(-1)).toMatchObject({ type: 'commented', data: { text: 'more' } });
    const human = (await run(['comment', 'LB-2', 'last', '--as', 'a', '--full'])).stdout;
    expect(human).toMatch(/^LB-2 {2}For someone\n {2}status: in_progress · assignee: - · rev: 6 /);
    expect(human).toContain('commented  last');
    expect((await run(['create', 'x', '--status', 'todo', '--as', 'a', '--full', '--json'])).stdout).toContain('"events":[');
  });

  it('a comment on a task with 50 events: the reply does not grow with the task', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Busy task', status: 'todo', description: 'd'.repeat(500) });
    for (let i = 0; i < 49; i++) await commentTask(as(s, 'a'), { id: 'LB-1', text: `step ${i} of the work, with a sentence of detail` });
    const short = await cli(['comment', 'LB-1', 'one more', '--as', 'a', '--json'], { cwd: s.root });
    const long = await cli(['comment', 'LB-1', 'one more', '--as', 'a', '--json', '--full'], { cwd: s.root });
    // created + 49 comments = 50 events before the short reply, 51 before the full one.
    expect(JSON.parse(long.stdout).data.events).toHaveLength(52);
    expect(short.stdout.length).toBeLessThan(300);
    expect(long.stdout.length).toBeGreaterThan(20 * short.stdout.length);
  });

  it('MCP: task writes reply short unless full: true; full must be a boolean', async () => {
    const s = await newStore();
    fs.writeFileSync(path.join(s.root, 'notes.txt'), 'some notes\n');
    const env = { cwd: s.root, env: {} };
    const created = await callTool('task_create', { title: 'via MCP', status: 'todo', actor: 'm' }, env);
    expect(created.structuredContent).toEqual({ id: 'LB-1', rev: 1, status: 'todo', assignee: null });
    expect(JSON.parse(created.content[0]?.text ?? '')).toEqual(created.structuredContent);
    expect(JSON.parse(created.content[1]?.text ?? '')).toEqual({ store: s.dir, prefix: 'LB', warnings: [] });
    expect((await callTool('task_claim', { id: 'LB-1', actor: 'm' }, env)).structuredContent).toEqual({ id: 'LB-1', rev: 2, status: 'todo', assignee: 'm' });
    expect((await callTool('task_update', { id: 'LB-1', status: 'review', actor: 'm' }, env)).structuredContent).toEqual({ id: 'LB-1', rev: 3, status: 'review', assignee: 'm' });
    expect((await callTool('task_comment', { id: 'LB-1', text: 'x', actor: 'm' }, env)).structuredContent).toEqual({ id: 'LB-1', rev: 4, status: 'review', assignee: 'm' });
    const attached = await callTool('task_attach', { id: 'LB-1', path: path.join(s.root, 'notes.txt'), actor: 'm' }, env);
    expect(attached.structuredContent).toMatchObject({ id: 'LB-1', rev: 5, attachment: { name: 'notes.txt', size: 11 } });
    expect((await callTool('task_attach', { id: 'LB-1', remove: 'notes.txt', actor: 'm' }, env)).structuredContent).toEqual({ id: 'LB-1', rev: 6, status: 'review', assignee: 'm' });
    await archiveTasks(as(s, 'm'), { ids: ['LB-1'] });
    expect((await callTool('task_restore', { id: 'LB-1', actor: 'm' }, env)).structuredContent).toEqual({ id: 'LB-1', rev: 8, status: 'review', assignee: 'm' });
    const full = await callTool('task_comment', { id: 'LB-1', text: 'y', actor: 'm', full: true }, env);
    expect(full.structuredContent).toMatchObject({ id: 'LB-1', rev: 9, title: 'via MCP', archived: false });
    expect((full.structuredContent.events as unknown[]).length).toBe(9);
    const bad = await callTool('task_comment', { id: 'LB-1', text: 'z', actor: 'm', full: 'yes' }, env);
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toMatchObject({ code: 'INVALID_VALUE', message: 'full must be true or false, got "yes"' });
    // Reads take no `full`; archive and delete keep their own short replies.
    expect((await callTool('task_get', { id: 'LB-1', full: true }, env)).structuredContent).toMatchObject({ code: 'USAGE', message: 'unknown parameter: full' });
    expect((await callTool('task_archive', { ids: ['LB-1'], actor: 'm', full: true }, env)).structuredContent).toMatchObject({ code: 'USAGE', message: 'unknown parameter: full' });
  });
});

describe('prime for subagents (LB-8)', () => {
  it('lists free tasks (no assignee, not final, not archived) by priority with the claim command', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Free low', status: 'todo', fields: { priority: 2 } });
    await createTask(as(s, 'a'), { title: 'Free top', status: 'review', fields: { priority: 0 } });
    await createTask(as(s, 'a'), { title: 'Taken', status: 'todo', assignee: 'dev-2' });
    await createTask(as(s, 'a'), { title: 'Finished', status: 'done' });
    await createTask(as(s, 'a'), { title: 'Archived', status: 'todo' });
    await archiveTasks(as(s, 'a'), { ids: ['LB-5'] });
    await createTask(as(s, 'a'), { title: 'Free none', status: 'in_progress' });
    // Rewritten in S3 (review S2g MINOR 3): without a task in progress one numbered order of ways carries the claim command.
    const r = await cli(['prime', '--as', 'dev-1'], { cwd: s.root });
    expect(r.stdout).toContain(
      'You have no task in progress. Start one the first way that fits:\n1. The request names a task id: laneboard claim <ID> --status in_progress --as dev-1 --json\n' +
        '2. A free task below fits the request: as in 1.\n3. Otherwise create one:\n' +
        '  laneboard create "<short title of your work>" --status todo --assignee dev-1 --as dev-1 --json\n',
    );
    expect(r.stdout.endsWith('\nFree tasks (no assignee):\n  LB-2  [review]  rev 1  Free top\n  LB-1  [todo]  rev 1  Free low\n  LB-6  [in_progress]  rev 1  Free none\n')).toBe(true);
    const json = JSON.parse((await cli(['prime', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout).data;
    expect(json.unassigned.map((t: ListItem) => t.id)).toEqual(['LB-2', 'LB-1', 'LB-6']);
    expect(json.unassigned_total).toBe(3);
    // The claim command carries the name the way the other commands of prime do.
    expect((await cli(['prime'], { cwd: s.root })).stdout).toContain('1. The request names a task id: laneboard claim <ID> --status in_progress --as <your-name> --json\n2. A free task below fits the request: as in 1.\n');
    expect((await cli(['prime'], { cwd: s.root, env: SESSION })).stdout).toContain('1. The request names a task id: laneboard claim <ID> --status in_progress --json\n2. A free task below fits the request: as in 1.\n');
    expect((await cli(['prime', '--dir', s.dir, '--as', 'dev-1'], { cwd: s.root })).stdout).toContain(`1. The request names a task id: laneboard claim <ID> --status in_progress --as dev-1 --dir ${s.dir} --json\n2. A free task below fits the request: as in 1.\n`);
    // With a task in progress there are no numbered ways: the free header carries the command.
    await createTask(as(s, 'a'), { title: 'Mine', status: 'in_progress', assignee: 'dev-1' });
    const busy = (await cli(['prime', '--as', 'dev-1'], { cwd: s.root })).stdout;
    expect(busy).toContain('\nFree tasks (no assignee); take one: laneboard claim <ID> --status in_progress --as dev-1 --json\n  LB-2  [review]');
    expect(busy).not.toContain('first way that fits');
  });

  // Rewritten in S5b (review S5a MINOR 1): the cap of 10 is checked apart from the rules and the store path (both have budget tests:
  // a longer rule or a longer tmpdir leaves less room, and then fewer free tasks are listed); at the rules ceiling and through the CLI
  // the footer still counts exactly the tasks not shown.
  it('more than 10 free tasks: the rest in a footer; none free: no section', async () => {
    const s = await newStore();
    expect((await cli(['prime', '--as', 'dev-1'], { cwd: s.root })).stdout).not.toContain('Free tasks');
    for (let i = 1; i <= 12; i++) await createTask(as(s, 'a'), { title: `Task ${i}`, status: 'todo' });
    const footer = '... 2 more: laneboard list --unassigned --status todo --status in_progress --status review --json';
    const data = JSON.parse((await cli(['prime', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout).data as PrimeData;
    expect(data).toMatchObject({ unassigned_total: 12 });
    expect(data.unassigned).toHaveLength(10);
    const capped = primeText({ ...data, rules: 'laneboard agent rules', store: fixedStorePath() });
    expect(capped.split('\n').filter((l) => /^ {2}LB-\d+ /.test(l))).toHaveLength(10);
    expect(capped.endsWith(`\n  LB-3  [todo]  rev 1  Task 3\n${footer}`)).toBe(true);
    const shownPlusMore = (text: string): number => {
      const more = /\n\.\.\. (\d+) more: laneboard list --unassigned --status todo --status in_progress --status review --json\n?$/.exec(text);
      return text.split('\n').filter((l) => /^ {2}LB-\d+ /.test(l)).length + Number(more?.[1] ?? 0);
    };
    expect(shownPlusMore(primeText({ ...data, rules: ceilingRules(), store: fixedStorePath() }))).toBe(12);
    expect(shownPlusMore((await cli(['prime', '--as', 'dev-1'], { cwd: s.root })).stdout)).toBe(12);
  });

  it('--as and LANEBOARD_AGENT list the tasks of that name, not those of the session default name', async () => {
    const s = await newStore();
    await createTask(as(s, DEFAULT_NAME), { title: 'Parent work', status: 'in_progress', assignee: DEFAULT_NAME });
    await createTask(as(s, 'a'), { title: 'Sub work', status: 'todo' });
    await claimTask(as(s, 'backend-dev'), { id: 'LB-2', status: 'in_progress' });
    for (const r of [await cli(['prime', '--as', 'backend-dev'], { cwd: s.root, env: SESSION }), await cli(['prime'], { cwd: s.root, env: { ...SESSION, LANEBOARD_AGENT: 'backend-dev' } })]) {
      expect(r.stdout).toContain('Your active tasks (backend-dev), newest update first:\n  LB-2  [in_progress]  rev 2  Sub work');
      expect(r.stdout).not.toContain('Parent work');
      expect(r.stdout).not.toContain('Subagent or parallel worker?');
    }
  });

  // Rewritten in S3 (review S2g MINOR 2): the line comes always under the session default name, before any command.
  it('a session default name: the subagent line comes first, with or without tasks; an explicit name gets none', async () => {
    const s = await newStore();
    const hint =
      `Your name: session default ${DEFAULT_NAME} (no --as needed). Subagent or parallel worker? It is your parent's name: ` +
      'run laneboard prime --as <your-own-name> and pass that --as on every command.';
    // No task of the default name yet: the line still comes before the create command.
    expect((await cli(['prime'], { cwd: s.root, env: SESSION })).stdout).toContain(`${hint}\nYou have no task in progress. Create one now:\n  laneboard create`);
    await createTask(as(s, DEFAULT_NAME), { title: 'Parent work', status: 'in_progress', assignee: DEFAULT_NAME });
    await createTask(as(s, 'a'), { title: 'For the subagent', status: 'todo' });
    const r = await cli(['prime'], { cwd: s.root, env: SESSION });
    expect(r.stdout).toContain(
      `${hint}\nYour active tasks (${DEFAULT_NAME}), newest update first:\n  LB-1  [in_progress]  rev 1  Parent work\nFree tasks (no assignee); take one: laneboard claim <ID> --status in_progress --json\n  LB-2  [todo]  rev 1  For the subagent\n`,
    );
    // The same tasks under an explicit name are that agent's own: no line.
    expect((await cli(['prime', '--as', DEFAULT_NAME.replace(':1a2b3c4d', ':ffffffff')], { cwd: s.root, env: SESSION })).stdout).not.toContain('Subagent or parallel worker');
  });

  // A prime summary with `own` tasks of the agent, `free` free tasks (10 listed at most) and `earlier` tasks of earlier sessions
  // (5 listed at most, `earlier` counted), titles `len` characters long.
  const data = (own: number, free: number, len: number, earlier = 0): PrimeData => {
    const item = (i: number, assignee: string | null): ListItem => ({ id: `LB-${i}`, title: 'x'.repeat(len), status: 'todo', assignee, labels: [], parent: null, last_comment: null, updated_at: '', updated_by: 'a', rev: 1, archived: false });
    return {
      rules: ceilingRules(),
      agent: DEFAULT_NAME,
      agent_source: 'default',
      name: 'n'.repeat(60),
      description: 'd'.repeat(200),
      store: '/home/someone/projects/a-project-with-a-long-name/.laneboard',
      prefix: 'ABCDEFGHIJ',
      store_warning: null,
      store_problem: null,
      statuses: ['todo', 'in_progress', 'review', 'done'].map((status) => ({ status, count: 0 })),
      first_status: 'todo',
      final_status: 'done',
      open_statuses: ['todo', 'in_progress', 'review'],
      fields: { priority: { type: 'number', description: '0 = highest', example: 'priority=1' } },
      tasks: Array.from({ length: own }, (_, i) => item(i + 1, DEFAULT_NAME)),
      in_progress: own,
      unassigned: Array.from({ length: Math.min(free, 10) }, (_, i) => item(own + i + 1, null)),
      unassigned_total: free,
      session_base: 'claude-code@Test-Person',
      resumable: Array.from({ length: Math.min(earlier, 5) }, (_, i) => item(own + free + i + 1, 'claude-code@Test-Person:aaaa1111')),
      resumable_total: earlier,
    };
  };

  it(`with own and free tasks prime stays within ${PRIME_MAX_CHARS} characters, keeps the hint and the free header, and both footers count right`, () => {
    // Rewritten in S3: the session line is always there, the free footer names the open statuses, earlier-session tasks added.
    // S6x A-U1: more earlier-session tasks than listed (12, 400): the footer counts them all and names the command that lists them.
    for (const [own, free, earlier] of [[1, 1, 0], [30, 50, 0], [400, 12, 0], [0, 400, 0], [0, 1, 1], [0, 400, 5], [0, 0, 5], [0, 0, 12], [0, 400, 400]] as const) {
      for (const len of [1, 40, 120, 200]) {
        const d = data(own, free, len, earlier);
        const text = primeText(d);
        const where = `own=${own} free=${free} earlier=${earlier} len=${len}`;
        expect(text.length, where).toBeLessThanOrEqual(PRIME_MAX_CHARS);
        expect(text.includes('Subagent or parallel worker? It is your parent'), where).toBe(true);
        if (free) expect(text, where).toContain(own ? 'Free tasks (no assignee); take one: laneboard claim <ID> --status in_progress --json' : '. A free task below fits the request: as in 1.\n');
        if (free) expect(text, where).toContain('\nFree tasks (no assignee)');
        if (earlier) expect(text, where).toContain('earlier-session task (below) fits the request: laneboard claim <ID> --resume --json\n');
        const [beforeFree = '', freePart = ''] = text.split('Free tasks (no assignee)');
        const [mine = '', earlierPart = ''] = beforeFree.split('\nYour earlier sessions');
        const count = (part: string) => part.split('\n').filter((l) => /^ {2}LB-\d+ /.test(l)).length;
        const footer = (part: string, re: RegExp) => Number(re.exec(part)?.[1] ?? 0);
        expect(count(mine) + footer(mine, /\n\.\.\. (\d+) more: laneboard list --assignee /), where).toBe(own);
        expect(count(earlierPart) + footer(earlierPart, new RegExp(`\\n\\.\\.\\. (\\d+) more \\(${earlier} in all\\): laneboard list --sessions-of claude-code@Test-Person --json(?:\\n|$)`)), where).toBe(earlier);
        expect(count(freePart) + footer(freePart, /\n\.\.\. (\d+) more: laneboard list --unassigned --status todo --status in_progress --status review --json$/), where).toBe(free);
      }
    }
  });

  it("no free-task claim command under a warning that the store looks like another project's", () => {
    const text = primeText({ ...data(0, 3, 5), store_warning: 'the store looks like another project' });
    expect(text).not.toContain('Free tasks');
    expect(text).not.toContain('take one: laneboard claim');
  });
});

describe('narrow view keeps the session part of a default name (review S2f)', () => {
  it('list mode: the holder gets the room after the id, so `:<session>` is not cut', () => {
    const now = new Date().toISOString();
    const card = (id: string) => ({ id, title: 'A title that is long enough to be cut', assignee: 'claude-code@abylaybazarbayev:f92f65da', labels: [], status_since: now, rev: 1, last_comment: null, parent: null, children: { total: 0, final: 0 }, updated_at: now, handed_in: false, in_work: false, stale: false });
    const d: ViewResult = {
      name: 'b',
      description: null,
      prefix: 'LANE',
      columns: ['todo', 'in_progress', 'review', 'done'].map((status) => ({ status, known: true, cards: status === 'todo' ? [card('LANE-12')] : [], more: 0 })),
      shown: 1,
      total: 1,
      final_status: 'done',
      final_shown: 0,
      final_total: 0,
    };
    for (const width of [40, 36]) {
      const line = renderBoard(d, { width, color: false, now: new Date(), store: '/s', filters: [] }).split('\n').find((l) => l.includes('LANE-12')) ?? '';
      expect(line.length, `width ${width}`).toBeLessThanOrEqual(width);
      expect(line, `width ${width}`).toMatch(/^ {2}LANE-12 {2}<1m · \S*…:f92f65da/);
    }
  });
});
