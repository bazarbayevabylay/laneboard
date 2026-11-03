// `laneboard prime [--hook]`: agent rules plus the agent's active tasks, at most 4000 characters, never fails as a hook.
import { afterAll, describe, expect, it } from 'vitest';
import { agentRules, claimTask, createTask } from '../../src/core/index.ts';
import { PRIME_MAX_CHARS, primeText } from '../../src/cli/format.ts';
import type { PrimeData } from '../../src/cli/format.ts';
import { as, cleanupTemp, cli, newStore, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

describe('prime', () => {
  it('with LANEBOARD_AGENT: rules, counts, and the agent active tasks newest first', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Mine first', status: 'todo', assignee: 'dev-1' });
    await createTask(as(s, 'a'), { title: 'Not mine', status: 'review', assignee: 'dev-2' });
    await claimTask(as(s, 'dev-1'), { id: 'LB-1', status: 'in_progress' });
    await createTask(as(s, 'a'), { title: 'Mine second', status: 'todo', assignee: 'dev-1' });
    const r = await cli(['prime', '--hook'], { cwd: s.root, env: { LANEBOARD_AGENT: 'dev-1' } });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(
      `${agentRules()}\n\nStatuses in order (final: done), active tasks: todo 1, in_progress 1, review 1, done 0\nFields (--field key=value): priority (number, 0 = highest)\nYour active tasks (dev-1), newest update first:\n  LB-3  [todo]  rev 1  Mine second\n  LB-1  [in_progress]  rev 2  Mine first\n`,
    );
    const json = JSON.parse((await cli(['prime', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout);
    expect(json.data).toMatchObject({ rules: agentRules(), agent: 'dev-1', store_problem: null, final_status: 'done', fields: { priority: { type: 'number', description: '0 = highest', example: 'priority=1' } } });
    expect(json.data.tasks.map((t: { id: string }) => t.id)).toEqual(['LB-3', 'LB-1']);
  });

  it('without an agent: counts and how to set the name', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'x', status: 'done' });
    const r = await cli(['prime'], { cwd: s.root });
    expect(r.code).toBe(0);
    expect(r.stdout.endsWith('Statuses in order (final: done), active tasks: todo 0, in_progress 0, review 0, done 1\nFields (--field key=value): priority (number, 0 = highest)\nSet your name to see your tasks: export LANEBOARD_AGENT=<your-name> (or pass --as <your-name>).\n')).toBe(true);
  });

  it(`--hook stays within ${PRIME_MAX_CHARS} characters and points to the rest`, async () => {
    const s = await newStore();
    for (let i = 0; i < 120; i++) await createTask(as(s, 'a'), { title: `Task number ${i} with a fairly long title to fill the hook output quickly`, status: 'todo', assignee: 'dev-1' });
    const r = await cli(['prime', '--hook'], { cwd: s.root, env: { LANEBOARD_AGENT: 'dev-1' } });
    expect(r.code).toBe(0);
    const text = r.stdout.trimEnd();
    expect(text.length).toBeLessThanOrEqual(PRIME_MAX_CHARS);
    expect(text.startsWith(agentRules())).toBe(true);
    const more = /\n\.\.\. (\d+) more: laneboard list --assignee dev-1 --json$/.exec(text);
    expect(more).not.toBeNull();
    const shown = text.split('\n').filter((l) => /^ {2}LB-\d+ /.test(l)).length;
    expect(shown + Number(more?.[1])).toBe(120);
  });

  it('no store: the hook prints one line without the rules; plain prime prints the rules; neither tells the agent to init', async () => {
    const cwd = tempDir();
    const hook = await cli(['prime', '--hook'], { cwd });
    expect(hook.code).toBe(0);
    expect(hook.stdout).toBe(`laneboard: no .laneboard directory in ${cwd} or any parent (STORE_NOT_FOUND); if this project has a store: export LANEBOARD_DIR=<abs>/.laneboard; do not run laneboard init unless the user asks\n`);
    const plain = await cli(['prime'], { cwd });
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain(agentRules());
    expect(plain.stdout).toContain('laneboard store: STORE_NOT_FOUND');
    expect(plain.stdout).toContain('do not run laneboard init unless the user asks');
    expect(plain.stdout).not.toContain('fix: laneboard init');
  });

  it('a broken store fails plain prime but is one line in the hook', async () => {
    const s = await newStore();
    const { writeRaw } = await import('../helpers.ts');
    writeRaw(`${s.dir}/active.json`, '{"schema":');
    expect((await cli(['prime'], { cwd: s.root })).code).toBe(6);
    const hook = await cli(['prime', '--hook'], { cwd: s.root });
    expect(hook.code).toBe(0);
    expect(hook.stdout).toContain('laneboard store: STORE_INVALID');
  });

  it('--hook cannot be combined with --json', async () => {
    const r = await cli(['prime', '--hook', '--json'], { cwd: tempDir() });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error.code).toBe('USAGE');
  });

  // A summary with `n` tasks whose titles are `len` characters long.
  const data = (n: number, len: number, statuses = ['todo', 'in_progress', 'review', 'done']): PrimeData => ({
    rules: agentRules(),
    agent: 'dev-1',
    store_problem: null,
    statuses: statuses.map((status) => ({ status, count: 0 })),
    final_status: statuses.at(-1) ?? null,
    fields: { priority: { type: 'number', description: '0 = highest', example: 'priority=1' } },
    tasks: Array.from({ length: n }, (_, i) => ({ id: `LB-${i + 1}`, title: 'x'.repeat(len), status: 'todo', assignee: 'dev-1', labels: [], updated_at: '', updated_by: 'a', rev: 1, archived: false })),
  });

  it(`never exceeds ${PRIME_MAX_CHARS} characters and the footer counts exactly the tasks left out, for every title length`, () => {
    for (const n of [9, 10, 11, 99, 100, 101, 400]) {
      for (let len = 1; len <= 160; len++) {
        const text = primeText(data(n, len));
        expect(text.length, `n=${n} len=${len}`).toBeLessThanOrEqual(PRIME_MAX_CHARS);
        const shown = text.split('\n').filter((l) => /^ {2}LB-\d+ /.test(l)).length;
        const more = /\n\.\.\. (\d+) more: laneboard list --assignee dev-1 --json$/.exec(text);
        expect(shown + Number(more?.[1] ?? 0), `n=${n} len=${len}`).toBe(n);
      }
    }
  });

  it('a task line that would end exactly one character past the footer room is moved to the footer', () => {
    const footer = (n: number): number => `\n... ${n} more: laneboard list --assignee dev-1 --json`.length;
    const head = primeText(data(0, 1)).replace(/Your active tasks \(dev-1\): none\. Find work: laneboard list --unassigned --json$/, 'Your active tasks (dev-1), newest update first:');
    // Two tasks: the first line is sized so that it plus the footer for the second is PRIME_MAX_CHARS + 1.
    const fixed = '\n  LB-1  [todo]  rev 1  '.length;
    const len = PRIME_MAX_CHARS + 1 - head.length - fixed - footer(1);
    const text = primeText({ ...data(2, 1), tasks: [{ ...data(1, len).tasks[0]!, id: 'LB-1' }, { ...data(1, 1).tasks[0]!, id: 'LB-2' }] });
    expect(text.length).toBeLessThanOrEqual(PRIME_MAX_CHARS);
    expect(text.endsWith('\n... 2 more: laneboard list --assignee dev-1 --json')).toBe(true);
  });

  it('150 long status names: every form stays within the cap and still names the final status', async () => {
    const statuses = Array.from({ length: 150 }, (_, i) => `status_with_a_long_name_${i}`);
    const forms = [data(30, 60, statuses), { ...data(0, 1, statuses), agent: null }, data(0, 1, statuses)];
    for (const d of forms) {
      const text = primeText(d);
      expect(text.length).toBeLessThanOrEqual(PRIME_MAX_CHARS);
      expect(text.startsWith(agentRules())).toBe(true);
      expect(text).toContain('Statuses in order (final: status_with_a_long_name_149)');
    }
    const s = await newStore({ statuses });
    await createTask(as(s, 'a'), { title: 'x', status: 'status_with_a_long_name_0', assignee: 'dev-1' });
    const r = await cli(['prime', '--hook'], { cwd: s.root, env: { LANEBOARD_AGENT: 'dev-1' } });
    expect(r.stdout.trimEnd().length).toBeLessThanOrEqual(PRIME_MAX_CHARS);
    expect(r.stdout).toContain('  LB-1  [status_with_a_long_name_0]  rev 1  x');
  });
});
