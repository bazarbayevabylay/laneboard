// LB-11 (review S4b tails): the hand-in fix and message list the statuses a task can be handed in to, the message names the orchestrator's update;
// the CLI line of a hand-in says "handed in". The footer note (b) is checked in s4b.test.ts.
import { afterAll, describe, expect, it } from 'vitest';
import { claimTask, createTask } from '../../src/core/index.ts';
import { as, cleanupTemp, cli, newStore } from '../helpers.ts';

afterAll(cleanupTemp);

describe('LB-11: hand-in texts that a weak model runs literally', () => {
  it('(a, d) acceptance of a task in work: the fix is one comment command with the hand-in statuses; the message names update to the final one', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Working', status: 'todo', assignee: 'dev-1' });
    await claimTask(as(s, 'dev-1'), { id: 'LB-1', status: 'in_progress' });
    const r = await cli(['finish', 'LB-1', '--result', 'x', '--as', 'orch', '--json'], { cwd: s.root });
    expect(r.code).toBe(4);
    const { fix, message } = JSON.parse(r.stdout).error as { fix: string; message: string };
    // Rule 13: the fix is exactly one command, run as is.
    expect(fix).toBe('laneboard comment LB-1 "hand it in: laneboard finish LB-1 --status <one of: in_progress, review> --result <result>" --as orch --json');
    expect(message).toContain('(laneboard finish LB-1 --status <one of: in_progress, review>)');
    expect(message).toMatch(/close it as the orchestrator: laneboard update LB-1 --status done --as orch$/);
  });

  it('(a) one non-final finish status: named as it is', async () => {
    const s = await newStore({ statuses: ['todo', 'doing', 'done'] });
    await createTask(as(s, 'a'), { title: 'T', status: 'todo', assignee: 'dev-1' });
    const r = await cli(['finish', 'LB-1', '--result', 'x', '--as', 'orch', '--json'], { cwd: s.root });
    expect(JSON.parse(r.stdout).error.fix).toContain('laneboard finish LB-1 --status doing --result <result>');
  });

  it('(c) the assignee\'s finish into a status that is not final prints "handed in"; into the final one "finished"', async () => {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'A', status: 'in_progress', assignee: 'dev-1' });
    await createTask(as(s, 'a'), { title: 'B', status: 'in_progress', assignee: 'dev-1' });
    const handed = await cli(['finish', 'LB-1', '--result', 'ok', '--status', 'review', '--no-commit', '--as', 'dev-1'], { cwd: s.root });
    expect(handed.stdout).toBe('LB-1 handed in (rev 2, review, dev-1); no commit linked\n');
    const closed = await cli(['finish', 'LB-2', '--result', 'ok', '--no-commit', '--as', 'dev-1'], { cwd: s.root });
    expect(closed.stdout).toBe('LB-2 finished (rev 2, done, dev-1); no commit linked\n');
  });
});
