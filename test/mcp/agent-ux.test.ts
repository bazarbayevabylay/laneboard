// 0.5.0, from the lb-tokens experiment: the MCP instructions name tools, not CLI commands (Haiku with MCP only tried the CLI three
// times); task_prime no longer repeats them (~3.9k characters per call) unless asked; task_finish does not push to status review on a
// board without checks; task_claim says how to comment a step and task_finish takes add_links (an agent passed it).
import crypto from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { agentRules, mcpRuleForms } from '../../src/core/index.ts';
import { callTool, MCP_RULES_PREAMBLE, mcpRules, PRIME_RULES_POINTER, TOOLS } from '../../src/mcp/tools.ts';
import type { ToolEnv, ToolResult } from '../../src/mcp/tools.ts';
import { cleanupTemp, newStore, readStore } from '../helpers.ts';

afterAll(cleanupTemp);

// The data part and the warnings of a tool reply.
function reply(r: ToolResult): { data: Record<string, any>; warnings: string[] } {
  return { data: JSON.parse(r.content[0]?.text ?? '{}'), warnings: (JSON.parse(r.content[1]?.text ?? '{}') as { warnings?: string[] }).warnings ?? [] };
}

// A board todo, in_progress, done with LB-1 in todo; the server env of its project.
async function board(): Promise<ToolEnv> {
  const s = await newStore({ statuses: ['todo', 'in_progress', 'done'] });
  const env: ToolEnv = { cwd: s.root, env: {} };
  expect((await callTool('task_create', { title: 'Add median', status: 'todo', actor: 'orch' }, env)).isError).toBeUndefined();
  return env;
}

describe('MCP instructions: the rules in tool words', () => {
  it('the preamble and the MCP forms of the rules; no rule tells to run a laneboard command, the limit of 4096 holds', () => {
    const text = mcpRules();
    expect(text.startsWith(`${MCP_RULES_PREAMBLE}\n\n`)).toBe(true);
    const rules = text.slice(MCP_RULES_PREAMBLE.length + 2);
    expect(rules).not.toMatch(/`laneboard (prime|create|claim|comment|finish|get|list|update|attach|archive|restore|events|boards|init)\b/);
    expect(rules).not.toContain('--json');
    // 0.5.1 (ADR §59): the plan at once, then each step.
    expect(rules).toContain('at once task_comment with your plan, then with each step (a plan item, a commit)');
    expect(rules).toContain('add_links: [{kind, ref}]');
    expect(MCP_RULES_PREAMBLE).not.toContain('The rules below name CLI commands');
    expect(text.length).toBeLessThanOrEqual(4096);
  });

  it('one MCP form per rule, each written for the current rule (hash); shell-only rules are left out', () => {
    const full = new Map(agentRules().split('\n').map((l) => [/^(\d+)\. /.exec(l)?.[1] ?? '', l] as const));
    const forms = mcpRuleForms();
    expect(forms.map((f) => f.n)).toEqual([...full.keys()].filter((n) => n !== ''));
    for (const form of forms) {
      const hash = crypto.createHash('sha256').update(full.get(form.n) ?? '').digest('hex').slice(0, 8);
      expect(form.hash, `rule ${form.n} changed: re-read its mcp form in agent-rules.md so it says the same, then put hash ${hash}`).toBe(hash);
    }
    expect(forms.filter((f) => f.text === '-').map((f) => f.n)).toEqual(['12', '14']);
    expect(mcpRules()).not.toMatch(/^1[24]\. /m);
  });
});

describe('task_prime does not repeat the instructions', () => {
  it('rules points to the instructions; rules: true gives them; a wrong rules value is INVALID_VALUE', async () => {
    const env = await board();
    const plain = reply(await callTool('task_prime', { actor: 'dev-1' }, env));
    expect(plain.data.rules).toBe(PRIME_RULES_POINTER);
    expect(plain.data).toMatchObject({ agent: 'dev-1', prefix: 'LB', unassigned: [{ id: 'LB-1' }] });
    expect(reply(await callTool('task_prime', { actor: 'dev-1', rules: true }, env)).data.rules).toBe(mcpRules());
    const wrong = await callTool('task_prime', { actor: 'dev-1', rules: 'yes' }, env);
    expect(wrong.isError).toBe(true);
    expect(JSON.parse(wrong.content[0]?.text ?? '{}')).toMatchObject({ code: 'INVALID_VALUE', fix: 'pass rules: true to task_prime for the agent rules, or leave it out' });
    const prime = TOOLS.taskSummary;
    expect(prime !== 'cli-only' && Object.keys(prime.params.shape)).toEqual(['actor', 'rules']);
  });
});

describe('task_finish and task_claim', () => {
  it('task_finish does not suggest status review; leaving status out is the advice', () => {
    const finish = TOOLS.finishTask;
    const description = finish === 'cli-only' ? '' : finish.description;
    expect(description).not.toContain('e.g. review');
    expect(description).toContain('Leave status out');
  });

  it('task_claim: next is the task_comment call of your plan for this task; task_finish without a comment warns in tool words', async () => {
    const env = await board();
    const claimed = reply(await callTool('task_claim', { id: 'LB-1', status: 'in_progress', actor: 'dev-1' }, env));
    expect(claimed.data.next).toBe('task_comment {"id":"LB-1","text":"<now: your plan; then after each step: what you did>","actor":"dev-1"}');
    const finished = reply(await callTool('task_finish', { id: 'LB-1', result: 'median added', no_commit: true, actor: 'dev-1' }, env));
    expect(finished.warnings).toEqual([
      'no comment on LB-1 since your work on it began, so the board shows no steps of the work: comment after each step (task_comment {"id":"LB-1","text":"<what you did>","actor":"dev-1"}); the steps of this task can still be added',
    ]);
  });

  it('K2/K3: task_create with yourself as assignee replies the same task_comment call; for another name none; full: the task', async () => {
    const env = await board();
    const own = reply(await callTool('task_create', { title: 'Fix typo', status: 'in_progress', assignee: 'dev-5', actor: 'dev-5' }, env));
    expect(own.data).toEqual({ id: 'LB-2', rev: 1, status: 'in_progress', assignee: 'dev-5', next: 'task_comment {"id":"LB-2","text":"<now: your plan; then after each step: what you did>","actor":"dev-5"}' });
    expect(reply(await callTool('task_create', { title: 'For dev-6', status: 'todo', assignee: 'dev-6', actor: 'dev-5' }, env)).data.next).toBeUndefined();
    expect(reply(await callTool('task_create', { title: 'Free', status: 'todo', actor: 'dev-5' }, env)).data.next).toBeUndefined();
    expect(reply(await callTool('task_create', { title: 'Mine, full', status: 'todo', assignee: 'dev-5', actor: 'dev-5', full: true }, env)).data.next).toBeUndefined();
  });

  it('task_finish of somebody else\'s task with add_links: the acceptance adds none and warns with the task_update call', async () => {
    const env = await board();
    await callTool('task_claim', { id: 'LB-1', status: 'in_progress', actor: 'dev-1' }, env);
    await callTool('task_comment', { id: 'LB-1', text: 'added median()', actor: 'dev-1' }, env);
    await callTool('task_finish', { id: 'LB-1', result: 'r', status: 'in_progress', no_commit: true, actor: 'dev-1' }, env);
    const r = reply(await callTool('task_finish', { id: 'LB-1', result: 'ok', add_links: [{ kind: 'pr', ref: 'https://example.invalid/pr/1' }], actor: 'orch' }, env));
    expect(r.data).toMatchObject({ status: 'done', accepted: true });
    expect(r.warnings).toEqual(['links not added: only the assignee\'s finish adds links; task_update {"id":"LB-1","add_links":[{"kind":"pr","ref":"https://example.invalid/pr/1"}],"actor":"orch"}']);
    expect(readStore(`${env.cwd}/.laneboard`, 'active').tasks[0]?.links).toEqual([]);
  });

  it('task_finish takes add_links; a commit link is the commit to link', async () => {
    const env = await board();
    await callTool('task_claim', { id: 'LB-1', status: 'in_progress', actor: 'dev-1' }, env);
    await callTool('task_comment', { id: 'LB-1', text: 'added median()', actor: 'dev-1' }, env);
    const r = await callTool('task_finish', { id: 'LB-1', result: 'r', add_links: [{ kind: 'commit', ref: 'abcdef1' }, { kind: 'branch', ref: 'feat/median' }], actor: 'dev-1' }, env);
    expect(r.isError).toBeUndefined();
    // Outside git the named commit is linked as given (with a "could not check git" warning).
    expect(reply(r).data).toMatchObject({ status: 'done', commit: 'abcdef1' });
    const task = readStore(`${env.cwd}/.laneboard`, 'active').tasks[0];
    expect(task?.links).toEqual([
      { kind: 'commit', ref: 'abcdef1' },
      { kind: 'branch', ref: 'feat/median' },
    ]);
  });
});
