// `laneboard prime [--hook]`: agent rules plus the agent's active tasks, at most 4000 characters, never fails as a hook.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agentRules, claimTask, createTask } from '../../src/core/index.ts';
import { PRIME_MAX_CHARS, primeText } from '../../src/cli/format.ts';
import type { PrimeData } from '../../src/cli/format.ts';
import { as, cleanupTemp, cli, newStore, tempDir, writeRaw } from '../helpers.ts';

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
      `${agentRules()}\n\nStore: ${s.dir} (prefix LB) - test: test board\nStatuses in order (final: done), active tasks: todo 1, in_progress 1, review 1, done 0\nFields (--field key=value): priority (number, 0 = highest)\nYour active tasks (dev-1), newest update first:\n  LB-3  [todo]  rev 1  Mine second\n  LB-1  [in_progress]  rev 2  Mine first\n`,
    );
    const json = JSON.parse((await cli(['prime', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout);
    expect(json).toMatchObject({ store: s.dir, prefix: 'LB', warnings: [] });
    expect(json.data).toMatchObject({ rules: agentRules(), agent: 'dev-1', store: s.dir, prefix: 'LB', store_warning: null, store_problem: null, first_status: 'todo', final_status: 'done', in_progress: 2, fields: { priority: { type: 'number', description: '0 = highest', example: 'priority=1' } } });
    expect(json.data.tasks.map((t: { id: string }) => t.id)).toEqual(['LB-3', 'LB-1']);
  });

  it('without an agent: counts, then the create command with the name placeholders and how to keep the name', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'x', status: 'done' });
    const r = await cli(['prime'], { cwd: s.root });
    expect(r.code).toBe(0);
    expect(
      r.stdout.endsWith(
        'Statuses in order (final: done), active tasks: todo 0, in_progress 0, review 0, done 1\nFields (--field key=value): priority (number, 0 = highest)\n' +
          'You have no task in progress (your name is not set). Create one now, with a name you keep for the whole session:\n' +
          '  laneboard create "<short title of your work>" --status todo --assignee <your-name> --as <your-name> --json\n' +
          'Then pass the same --as <your-name> on every command (or export LANEBOARD_AGENT=<your-name>).\n',
      ),
    ).toBe(true);
  });

  it('an agent with no task in progress gets the create command with the first status and its name, not "none"', async () => {
    const s = await newStore({ statuses: ['backlog', 'doing', 'shipped'] });
    // Only a finished task and somebody else's task: neither is work in progress for dev-1.
    await createTask(as(s, 'a'), { title: 'Old one', status: 'shipped', assignee: 'dev-1' });
    await createTask(as(s, 'a'), { title: 'Not mine', status: 'doing', assignee: 'dev-2' });
    const r = await cli(['prime', '--as', 'dev-1'], { cwd: s.root });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      'You have no task in progress. Create one now:\n' +
        '  laneboard create "<short title of your work>" --status backlog --assignee dev-1 --as dev-1 --json\n' +
        'Given a task id instead: laneboard claim <ID> --as dev-1 --json\n' +
        'Your active tasks (dev-1), newest update first:\n  LB-1  [shipped]  rev 1  Old one\n',
    );
    expect(r.stdout).not.toMatch(/: none\b/);
    const empty = await cli(['prime', '--hook'], { cwd: (await newStore()).root, env: { LANEBOARD_AGENT: 'dev-1' } });
    expect(empty.stdout.endsWith('You have no task in progress. Create one now:\n  laneboard create "<short title of your work>" --status todo --assignee dev-1 --as dev-1 --json\nGiven a task id instead: laneboard claim <ID> --as dev-1 --json\n')).toBe(true);
    expect(empty.stdout).not.toContain('none. Find work');
    expect(JSON.parse((await cli(['prime', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout).data).toMatchObject({ in_progress: 0, first_status: 'backlog', final_status: 'shipped' });
  });

  it('--edit-hook: a PostToolUse reminder when the agent has no task in progress, else nothing; always exit 0', async () => {
    const s = await newStore();
    const hook = (env: Record<string, string> = {}, cwd = s.root) => cli(['prime', '--edit-hook'], { cwd, env });
    const none = await hook({ LANEBOARD_AGENT: 'dev-1' });
    expect(none.code).toBe(0);
    expect(none.stderr).toBe('');
    expect(JSON.parse(none.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        // Facts, not orders (code.claude.com/docs/en/hooks: imperative context can trigger prompt-injection defenses).
        additionalContext: `laneboard: no task is in progress for dev-1 in store ${s.dir} (prefix LB). This project tracks every change in a laneboard task (agent rule 1); \`laneboard prime\` prints the create command.`,
      },
    });
    // Without a name any assigned task in progress counts; unassigned or finished ones do not.
    await createTask(as(s, 'a'), { title: 'unassigned', status: 'in_progress' });
    await createTask(as(s, 'a'), { title: 'finished', status: 'done', assignee: 'dev-1' });
    expect((await hook()).stdout).toContain('laneboard: no task is in progress in store');
    expect((await hook({ LANEBOARD_AGENT: 'dev-1' })).stdout).toContain('no task is in progress for dev-1');
    await createTask(as(s, 'a'), { title: 'mine', status: 'todo', assignee: 'dev-1' });
    for (const env of [{ LANEBOARD_AGENT: 'dev-1' }, {}] as Array<Record<string, string>>) {
      const quiet = await hook(env);
      expect(quiet).toEqual({ code: 0, stdout: '', stderr: '' });
    }
    expect((await hook({ LANEBOARD_AGENT: 'dev-2' })).stdout).toContain('no task is in progress for dev-2');
    // No store, a broken store, a bad name: nothing at all, exit 0.
    expect(await hook({}, tempDir())).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await hook({ LANEBOARD_AGENT: 'bad name!' })).toEqual({ code: 0, stdout: '', stderr: '' });
    writeRaw(`${s.dir}/active.json`, '{"schema":');
    expect(await hook({ LANEBOARD_AGENT: 'dev-1' })).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('--edit-hook in a nested project folder without its own store: never asks for a task in the parent store, names the situation', async () => {
    const s = await newStore();
    const agentB = path.join(s.root, 'agent-b');
    fs.mkdirSync(agentB);
    fs.writeFileSync(path.join(agentB, 'CLAUDE.md'), 'Agent B.\n');
    const r = await cli(['prime', '--edit-hook'], { cwd: agentB, env: { LANEBOARD_AGENT: 'dev-b' } });
    expect(r.code).toBe(0);
    const text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
    // A heuristic, so worded like the warning ("looks like", "unless"), not as a fact (review S2c).
    expect(text).toBe(
      `laneboard: the store in use, ${s.dir} (prefix LB), looks like another project's: ${agentB} has CLAUDE.md and no laneboard store of its own. ` +
        'Unless this folder is part of that project, its tasks belong on its own board; `laneboard boards --json` lists the boards on this machine with their descriptions.',
    );
    expect(text).not.toMatch(/create|claim/);
    // A plain subfolder of the same project (no marker in between) still gets the normal reminder.
    const sub = path.join(s.root, 'src');
    fs.mkdirSync(sub);
    expect((await cli(['prime', '--edit-hook'], { cwd: sub, env: { LANEBOARD_AGENT: 'dev-b' } })).stdout).toContain('no task is in progress for dev-b');
  });

  it('--edit-hook in a Claude Code worktree of the project (.claude/worktrees/<name>, .git file and CLAUDE.md): the normal reminder, no foreign-store note', async () => {
    const s = await newStore();
    fs.mkdirSync(path.join(s.root, '.git', 'worktrees', 'feat'), { recursive: true });
    const tree = path.join(s.root, '.claude', 'worktrees', 'feat');
    fs.mkdirSync(path.join(tree, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tree, '.git'), 'gitdir: ../../../.git/worktrees/feat\n');
    fs.writeFileSync(path.join(tree, 'CLAUDE.md'), 'Project rules (checked out).\n');
    for (const cwd of [tree, path.join(tree, 'src')]) {
      const r = await cli(['prime', '--edit-hook'], { cwd, env: { LANEBOARD_AGENT: 'dev-w' } });
      expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('no task is in progress for dev-w');
      expect(JSON.parse((await cli(['list', '--json'], { cwd })).stdout).warnings).toEqual([]);
    }
    // The same layout whose .git file points to another repository is a separate project.
    const other = tempDir();
    fs.mkdirSync(path.join(other, '.git', 'worktrees', 'feat'), { recursive: true });
    fs.writeFileSync(path.join(tree, '.git'), `gitdir: ${path.join(other, '.git', 'worktrees', 'feat')}\n`);
    expect(JSON.parse((await cli(['prime', '--edit-hook'], { cwd: tree, env: { LANEBOARD_AGENT: 'dev-w' } })).stdout).hookSpecificOutput.additionalContext).toContain('looks like another project');
  });

  it('--edit-hook with LANEBOARD_DIR of a parent project in a folder with its own store: names that store, never asks for a task in the pinned one', async () => {
    const s = await newStore();
    const agentB = path.join(s.root, 'agent-b');
    fs.mkdirSync(agentB);
    expect((await cli(['init', '--description', 'agent b'], { cwd: agentB })).code).toBe(0);
    const r = await cli(['prime', '--edit-hook'], { cwd: agentB, env: { LANEBOARD_AGENT: 'dev-b', LANEBOARD_DIR: s.dir } });
    const text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
    expect(text).toContain(`looks like another project's: ${agentB} has its own store ${path.join(agentB, '.laneboard')}.`);
    expect(text).not.toMatch(/create|claim/);
  });

  it('--edit-hook cannot be combined with --json or --hook', async () => {
    expect((await cli(['prime', '--edit-hook', '--json'], { cwd: tempDir() })).code).toBe(2);
    expect((await cli(['prime', '--edit-hook', '--hook'], { cwd: tempDir() })).code).toBe(2);
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

  it('no store: the hook prints one line without the rules; plain prime prints the rules; both point to the registry first, then to init with a description', async () => {
    const cwd = tempDir();
    const hook = await cli(['prime', '--hook'], { cwd });
    expect(hook.code).toBe(0);
    // The plugin hook runs in every project of the user: one neutral line, no task rule (owner's decision, S2d).
    expect(hook.stdout).toBe(
      `laneboard: no board found (no .laneboard directory in ${cwd} or any parent). If the user wants to track work here with laneboard: ` +
        'laneboard init --name <name> --description "<whose project, what work>" in the project root, then laneboard prime.\n',
    );
    expect(hook.stdout).not.toMatch(/MANDATORY|create|claim|task/i);
    const plain = await cli(['prime'], { cwd });
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain(agentRules());
    expect(plain.stdout).toContain('laneboard store: STORE_NOT_FOUND');
    expect(plain.stdout).toContain('find this project\'s board: laneboard boards --json (pick it by description and path), then pass --dir <its path> on every command');
    expect(plain.stdout).toContain('"<whose project, what work>", then laneboard prime');
    expect(plain.stdout).not.toContain('export LANEBOARD_DIR');
    expect(plain.stdout).toContain('laneboard init --name <name> --description "<whose project, what work>"');
    // A bare init (no name, no description) is never suggested.
    expect(plain.stdout).not.toMatch(/laneboard init(?! --(name|dir))/);
  });

  it('a broken store fails plain prime but is one line in the hook', async () => {
    const s = await newStore();
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
    agent_source: 'explicit',
    // The longest name and description a board may have, so the cap holds for every board.
    name: 'n'.repeat(60),
    description: 'd'.repeat(200),
    store: '/home/someone/projects/a-project-with-a-long-name/.laneboard',
    prefix: 'ABCDEFGHIJ',
    store_warning: null,
    store_problem: null,
    statuses: statuses.map((status) => ({ status, count: 0 })),
    first_status: statuses[0] ?? null,
    final_status: statuses.at(-1) ?? null,
    fields: { priority: { type: 'number', description: '0 = highest', example: 'priority=1' } },
    tasks: Array.from({ length: n }, (_, i) => ({ id: `LB-${i + 1}`, title: 'x'.repeat(len), status: 'todo', assignee: 'dev-1', labels: [], updated_at: '', updated_by: 'a', rev: 1, archived: false })),
    in_progress: n,
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
    // Everything before the first task line, as printed for an agent with tasks in progress.
    const head = primeText(data(1, 1)).slice(0, -'\n  LB-1  [todo]  rev 1  x'.length);
    expect(head.endsWith('Your active tasks (dev-1), newest update first:')).toBe(true);
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
