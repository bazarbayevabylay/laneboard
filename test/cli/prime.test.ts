// `laneboard prime [--hook]`: agent rules plus the agent's active tasks, at most 4000 characters, never fails as a hook.
import { afterAll, describe, expect, it } from 'vitest';
import { agentRules, claimTask, createTask } from '../../src/core/index.ts';
import { PRIME_MAX_CHARS } from '../../src/cli/format.ts';
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
      `${agentRules()}\n\nActive tasks per status: todo 1, in_progress 1, review 1, done 0\nYour active tasks (dev-1), newest update first:\n  LB-3  [todo]  rev 1  Mine second\n  LB-1  [in_progress]  rev 2  Mine first\n`,
    );
    const json = JSON.parse((await cli(['prime', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout);
    expect(json.data).toMatchObject({ rules: agentRules(), agent: 'dev-1', store_problem: null });
    expect(json.data.tasks.map((t: { id: string }) => t.id)).toEqual(['LB-3', 'LB-1']);
  });

  it('without an agent: counts and how to set the name', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'x', status: 'done' });
    const r = await cli(['prime'], { cwd: s.root });
    expect(r.code).toBe(0);
    expect(r.stdout.endsWith('Active tasks per status: todo 0, in_progress 0, review 0, done 1\nSet your name to see your tasks: export LANEBOARD_AGENT=<your-name> (or pass --as <your-name>).\n')).toBe(true);
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

  it('no store: rules and the init hint, exit 0 (hook and plain)', async () => {
    const cwd = tempDir();
    for (const argv of [['prime', '--hook'], ['prime']]) {
      const r = await cli(argv, { cwd });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(agentRules());
      expect(r.stdout).toContain('laneboard store: STORE_NOT_FOUND');
      expect(r.stdout).toContain('fix: laneboard init');
    }
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
});
