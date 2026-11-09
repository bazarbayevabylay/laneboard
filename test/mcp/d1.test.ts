// 0.4.1 slice D1: the MCP server and error codes. LB-60.1 the fix of an error and the warnings name tool calls, not CLI commands (each
// runs as printed); LB-60.2 a link or fields parameter of the wrong form gets the form in its fix, the preamble names it; LB-60.3 the
// warnings are in structuredContent too; LB-60.4 task_prime without a name warns; LB-60.5 a relative --dir is named resolved; LB-63.3
// over MCP: task_finish says handed_in; LB-63.4 an id of another board that board does not hold either is not said to be there;
// review A2 NIT: finish in a main checkout with several worktrees gives one warning when the commit is linked to another task too.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claimTask, configureStore, createTask, finishTask, getTask, registerStore, updateTask } from '../../src/core/index.ts';
import { mcpText } from '../../src/mcp/fix-text.ts';
import { callTool, MCP_RULES_PREAMBLE, TOOLS } from '../../src/mcp/tools.ts';
import type { ToolEnv, ToolResult } from '../../src/mcp/tools.ts';
import { as, cleanupTemp, newStore, otherWarnings, readStore, rejectsWith, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';
import { runCalls, toolCalls } from './tool-calls.ts';

afterAll(cleanupTemp);

// A CLI command of a task tool, as the core writes it into a fix or a warning.
const CLI_TASK_COMMAND = /laneboard (prime|create|claim|comment|finish|get|list|update|attach|archive|restore|events)\b/;

// The text of an MCP fix or warning without the argument values of its tool calls: no CLI command of a task tool may be left in it.
function withoutArgs(text: string): string {
  return text.replace(/\{"[^]*?"\}(?=$|[,;) ])/g, '{}');
}

// The data part, the warnings of the envelope part and structuredContent of a tool reply.
function reply(r: ToolResult): { data: Record<string, unknown>; warnings: string[]; structured: Record<string, unknown> } {
  return {
    data: JSON.parse(r.content[0]?.text ?? '{}') as Record<string, unknown>,
    warnings: (JSON.parse(r.content[1]?.text ?? '{}') as { warnings?: string[] }).warnings ?? [],
    structured: r.structuredContent,
  };
}

// A board todo, in_progress, review, done with the check review by rev; API-1 claimed by dev-1 into in_progress.
async function checked(): Promise<{ s: TestStore; env: ToolEnv }> {
  const s = await newStore({ prefix: 'API', statuses: ['todo', 'in_progress', 'review', 'done'] });
  await configureStore(as(s, 'orch'), { review_statuses: ['review'], reviewers: ['rev'] });
  await createTask(as(s, 'orch'), { title: 'Add endpoint', status: 'todo' });
  await claimTask(as(s, 'dev-1'), { id: 'API-1', status: 'in_progress' });
  return { s, env: { cwd: s.root, env: {} } };
}

// The stored task.
function stored(s: TestStore, id: string): Record<string, any> {
  return readStore(s.dir, 'active').tasks.find((t) => t.id === id) as Record<string, any>;
}

describe('LB-60.1: CLI commands of a fix or warning become tool calls', () => {
  it('mcpText: each command of a task tool is its call (options as parameters, -- text, links, && as ", then"); others stay', () => {
    const cases: Array<[string, string]> = [
      ['laneboard get API-1 --json', 'task_get {"id":"API-1"}'],
      ['find the task: laneboard list --scope all --text "<words from the title>" --json', 'find the task: task_list {"scope":"all","text":"<words from the title>"}'],
      [
        "laneboard comment API-1 --as rev --json -- 'back: it'\\''s --broken' && laneboard update API-1 --status dev --as rev --json",
        'task_comment {"id":"API-1","actor":"rev","text":"back: it\'s --broken"}, then task_update {"id":"API-1","status":"dev","actor":"rev"}',
      ],
      [
        'link yours: laneboard finish LB-1 --status review --commit <HEAD of your worktree> --result "<your result>" --as dev-1 --json && laneboard update LB-1 --remove-link commit=abc1234 --as dev-1 --json',
        'link yours: task_finish {"id":"LB-1","status":"review","commit":"<HEAD of your worktree>","result":"<your result>","actor":"dev-1"}, then task_update {"id":"LB-1","remove_links":[{"kind":"commit","ref":"abc1234"}],"actor":"dev-1"}',
      ],
      ['Read it first (laneboard get API-1), then: laneboard claim API-2 --resume --json; or', 'Read it first (task_get {"id":"API-1"}), then: task_claim {"id":"API-2","resume":true}; or'],
      ['run laneboard finish LB-1 again (queue: laneboard prime)', 'run task_finish {"id":"LB-1"} again (queue: task_prime)'],
      ['laneboard update LB-1 --unassign --field priority=2 --add-label x --expected-rev 3', 'task_update {"id":"LB-1","assignee":null,"fields":{"priority":2},"add_labels":["x"],"expected_rev":3}'],
      ['laneboard archive LB-1 LB-2 --dry-run', 'task_archive {"ids":["LB-1","LB-2"],"dry_run":true}'],
      // No tool: config, boards; an option no tool takes: --board, --dir, --file. As they are.
      ['laneboard config --reviewers "rev,<another checker>" && laneboard boards --json', 'laneboard config --reviewers "rev,<another checker>" && laneboard boards --json'],
      ['laneboard get WEB-1 --board WEB --json', 'laneboard get WEB-1 --board WEB --json'],
      ['laneboard comment LB-1 --file notes.txt', 'laneboard comment LB-1 --file notes.txt'],
    ];
    for (const [cli, mcp] of cases) expect(mcpText(cli), cli).toBe(mcp);
  });

  it('ALREADY_CLAIMED, TASK_NOT_FOUND and a stale check: the fix is a tool call, run as printed it works and moves nothing', async () => {
    const { s, env } = await checked();
    const rev = stored(s, 'API-1').rev;
    const claim = await callTool('task_claim', { id: 'API-1', actor: 'dev-2' }, env);
    expect(claim.structuredContent).toMatchObject({ code: 'ALREADY_CLAIMED', fix: 'task_comment {"id":"API-1","text":"<note for dev-1>","actor":"dev-2"}' });
    const missing = await callTool('task_get', { id: 'API-99' }, env);
    expect(missing.structuredContent).toMatchObject({ code: 'TASK_NOT_FOUND', fix: 'find the task: task_list {"scope":"all","text":"<words from the title>"}' });
    // A move into the check of a task dev-1 has not handed in (LB-63.1): the comment that asks it to hand it in.
    const stale = await callTool('task_update', { id: 'API-1', status: 'review', actor: 'orch' }, env);
    const fix = String(stale.structuredContent.fix);
    expect(stale.structuredContent.code).toBe('ALREADY_CLAIMED');
    expect(fix).toBe('task_comment {"id":"API-1","text":"hand it in: laneboard finish API-1 --status review --result <result>","actor":"orch"}');
    for (const r of [claim, missing, stale]) expect(withoutArgs(String(r.structuredContent.fix))).not.toMatch(CLI_TASK_COMMAND);
    for (const r of await runCalls([claim, missing, stale].map((x) => String(x.structuredContent.fix)).join(', then '), env)) expect(r.isError).toBeUndefined();
    expect(stored(s, 'API-1')).toMatchObject({ status: 'in_progress', assignee: 'dev-1' });
    expect(stored(s, 'API-1').rev).toBe(rev + 2);
  });

  it('a hand-in into a status that is no check: the fix (comment, then update) runs as printed and puts the task there', async () => {
    const { s, env } = await checked();
    const r = await callTool('task_finish', { id: 'API-1', status: 'todo', result: 'parked', no_commit: true, actor: 'dev-1' }, env);
    expect(r.structuredContent).toMatchObject({ code: 'INVALID_VALUE' });
    const fix = String(r.structuredContent.fix);
    expect(withoutArgs(fix)).not.toMatch(CLI_TASK_COMMAND);
    expect(toolCalls(fix).map((c) => c.name)).toEqual(['task_comment', 'task_update']);
    for (const done of await runCalls(fix, env)) expect(done.isError).toBeUndefined();
    expect(stored(s, 'API-1')).toMatchObject({ status: 'todo', assignee: 'dev-1' });
  });

  it('warnings name tool calls (LB-60.1) and are in structuredContent too (LB-60.3); a reply without warnings has no such key', async () => {
    const { env } = await checked();
    await callTool('task_finish', { id: 'API-1', result: 'work', no_commit: true, actor: 'dev-1' }, env);
    const back = reply(await callTool('task_update', { id: 'API-1', status: 'in_progress', actor: 'rev' }, env));
    expect(back.warnings).toHaveLength(1);
    expect(back.warnings[0]).toContain('add the reason (shown to dev-1 until the next hand-in): task_comment {"id":"API-1","actor":"rev","text":"<why it goes back>"}');
    expect(withoutArgs(back.warnings[0] ?? '')).not.toMatch(CLI_TASK_COMMAND);
    expect(back.structured.warnings).toEqual(back.warnings);
    const quiet = reply(await callTool('task_comment', { id: 'API-1', text: 'ok', actor: 'dev-1' }, env));
    expect(quiet.warnings).toEqual([]);
    expect(Object.keys(quiet.structured)).not.toContain('warnings');
  });
});

describe('LB-60.2: links and fields over MCP', () => {
  it('a link in the CLI form kind=ref or a field key=value: INVALID_VALUE whose fix names the form; the preamble maps them', async () => {
    const { s, env } = await checked();
    const rev = stored(s, 'API-1').rev;
    // A link without its ref is USAGE ("add_links.0.ref is required"), the CLI form INVALID_VALUE: the same fix.
    for (const [param, value, code] of [
      ['add_links', ['commit=abc1234'], 'INVALID_VALUE'],
      ['remove_links', ['x'], 'INVALID_VALUE'],
      ['add_links', [{ kind: 'commit' }], 'USAGE'],
    ] as const) {
      const r = await callTool('task_update', { id: 'API-1', [param]: value, actor: 'dev-1' }, env);
      expect(r.structuredContent, `${param} ${JSON.stringify(value)}`).toMatchObject({
        code,
        fix: `pass ${param} as a list of objects {kind, ref} (kind: task, branch, pr, commit, url, file), e.g. ${param}: [{"kind": "commit", "ref": "<sha>"}] to task_update; the CLI form kind=ref is not taken`,
      });
    }
    const links = await callTool('task_create', { title: 'x', status: 'todo', links: ['branch=main'], actor: 'orch' }, env);
    expect(String(links.structuredContent.fix)).toMatch(/^pass links as a list of objects \{kind, ref\}/);
    const fields = await callTool('task_update', { id: 'API-1', fields: 'priority=2', actor: 'dev-1' }, env);
    expect(fields.structuredContent).toMatchObject({ code: 'INVALID_VALUE', fix: 'pass fields as an object of declared field keys and values, e.g. fields: {"priority": 2} to task_update; the CLI form key=value is not taken' });
    expect(stored(s, 'API-1').rev).toBe(rev);
    expect(MCP_RULES_PREAMBLE).toContain('--add-link kind=ref -> add_links: [{kind, ref}], --field k=v -> fields: {k: v}');
  });

  it('a link of the right form with a wrong value keeps the fix of that value, not the form (review D1 MINOR)', async () => {
    const { s, env } = await checked();
    const rev = stored(s, 'API-1').rev;
    for (const [value, fix] of [
      [{ kind: 'commit', ref: '' }, 'add_links.0.ref must not be empty'],
      [{ kind: 'commit', ref: 'a'.repeat(2001) }, 'shorten add_links.0.ref to at most 2000 characters'],
      [{ kind: 'foo', ref: 'x' }, 'use a add_links.0.kind from `allowed`'],
    ] as const) {
      const r = await callTool('task_update', { id: 'API-1', add_links: [value], actor: 'dev-1' }, env);
      expect(r.structuredContent, JSON.stringify(value).slice(0, 40)).toMatchObject({ code: 'INVALID_VALUE', fix });
    }
    const removed = await callTool('task_update', { id: 'API-1', remove_links: [{ kind: 'commit', ref: '' }], actor: 'dev-1' }, env);
    expect(removed.structuredContent).toMatchObject({ code: 'INVALID_VALUE', fix: 'remove_links.0.ref must not be empty' });
    expect(stored(s, 'API-1').rev).toBe(rev);
  });
});

describe('tool descriptions after slices A1, A2, B (handoffs, review A2 tools.ts:115)', () => {
  it('task_update names ALREADY_CLAIMED for a check of another name\'s task; task_finish handed_in; task_claim the first status; task_prime tasks, in_progress, last_return', () => {
    const text = (op: keyof typeof TOOLS): string => (TOOLS[op] as { description: string }).description;
    expect(text('updateTask')).toContain('one somebody else holds and has not handed in, or that was returned for rework: ALREADY_CLAIMED');
    expect(text('updateTask')).not.toContain('no update sets a check (INVALID_VALUE)');
    expect(text('finishTask')).toContain('handed_in: true when this finish handed the task in');
    expect(text('claimTask')).toContain('in the first status moves it to the working status');
    expect(text('claimTask')).toContain('never a closed one');
    expect(text('taskSummary')).toContain('in_progress counts only those past the first status and not final, so your own tasks are in tasks');
    expect(text('taskSummary')).toContain('last_return');
  });
});

describe('LB-60.4, 60.5, 63.3 over MCP', () => {
  it('task_prime without a name: agent null and a warning that says to pass actor; with a name no such warning', async () => {
    const { env } = await checked();
    const bare = reply(await callTool('task_prime', {}, env));
    expect(bare.data.agent).toBeNull();
    expect(bare.warnings[0]).toMatch(/^your name is not set .*: pass actor: "<your-name>" \(e\.g\. dev-1\) to task_prime and to every write tool/);
    expect(bare.structured.warnings).toEqual(bare.warnings);
    expect(reply(await callTool('task_prime', { actor: 'dev-1' }, env)).warnings).toEqual([]);
  });

  it('a relative --dir or LANEBOARD_DIR of the server: the fix names it resolved against the server folder', async () => {
    const cwd = tempDir();
    const abs = path.join(cwd, 'missing', '.laneboard');
    const byDir = await callTool('task_list', {}, { cwd, dir: 'missing/.laneboard', env: { HOME: tempDir() } });
    expect(String(byDir.structuredContent.fix)).toMatch(new RegExp(`^the server's --dir \\(${abs}, given as missing/\\.laneboard in the server's folder ${cwd}\\) is no board`));
    const byEnv = await callTool('task_list', {}, { cwd, env: { HOME: tempDir(), LANEBOARD_DIR: 'missing/.laneboard' } });
    expect(String(byEnv.structuredContent.fix)).toContain(`the server's LANEBOARD_DIR (${abs}, given as missing/.laneboard in the server's folder ${cwd}) is no board`);
    // An absolute one as it is.
    const plain = await callTool('task_list', {}, { cwd, dir: abs, env: { HOME: tempDir() } });
    expect(String(plain.structuredContent.fix)).toMatch(new RegExp(`^the server's --dir \\(${abs}\\) is no board`));
  });

  it('task_finish into a status that is not final: handed_in true, as the CLI; into the final one and with full: no such key', async () => {
    const s = await newStore({ prefix: 'API' });
    const env = { cwd: s.root, env: {} };
    for (const n of [1, 2]) {
      await createTask(as(s, 'orch'), { title: `T${n}`, status: 'todo' });
      await claimTask(as(s, 'dev-1'), { id: `API-${n}`, status: 'in_progress' });
    }
    const handIn = await callTool('task_finish', { id: 'API-1', status: 'review', result: 'work', no_commit: true, actor: 'dev-1' }, env);
    const { warnings: handInWarnings = [], ...handInReply } = handIn.structuredContent as { warnings?: string[] };
    expect(handInReply).toEqual({ id: 'API-1', rev: expect.any(Number), status: 'review', assignee: 'dev-1', commit: null, handed_in: true });
    expect(otherWarnings(handInWarnings)).toEqual([]);
    const close = await callTool('task_finish', { id: 'API-2', result: 'work', no_commit: true, actor: 'dev-1' }, env);
    expect(Object.keys(close.structuredContent)).not.toContain('handed_in');
    await updateTask(as(s, 'dev-1'), { id: 'API-2', status: 'in_progress' });
    const full = await callTool('task_finish', { id: 'API-2', status: 'review', result: 'again', no_commit: true, actor: 'dev-1', full: true }, env);
    expect(Object.keys(full.structuredContent)).not.toContain('handed_in');
  });
});

describe('LB-63.4: an id of another board that board does not hold either', () => {
  it('get and update of WEB-99: TASK_NOT_FOUND not on this board nor on WEB, the fix searches WEB; WEB-1: still "is on board WEB"', async () => {
    const home = tempDir();
    const lb = await newStore();
    const web = await newStore({ prefix: 'WEB' });
    await registerStore(home, lb.dir);
    await registerStore(home, web.dir);
    await createTask(as(web, 'w'), { title: 'Web open', status: 'todo' });
    const message = `WEB-99 is not on this board (LB), nor on board WEB (${web.dir}), which its prefix names`;
    const fix = 'find the task on board WEB: laneboard list --board WEB --scope all --text "<words from the title>" --json';
    for (const call of [() => getTask(as(lb, 'x', { home }), { id: 'WEB-99' }), () => updateTask(as(lb, 'x', { home }), { id: 'WEB-99', title: 'y' })]) {
      const err = await rejectsWith(call(), 'TASK_NOT_FOUND');
      expect({ message: err.message, fix: err.fix, edit: err.edit }).toEqual({ message, fix, edit: undefined });
    }
    expect((await rejectsWith(getTask(as(lb, 'x', { home }), { id: 'WEB-1' }), 'TASK_NOT_FOUND')).message).toBe(`WEB-1 is on board WEB (${web.dir}), not on this board (LB)`);
    // Over MCP: the same message; the fix reads another board (--board), which no tool does, so it stays the CLI command.
    const r = await callTool('task_get', { id: 'WEB-99' }, { cwd: lb.root, env: { HOME: home } });
    expect(r.structuredContent).toMatchObject({ code: 'TASK_NOT_FOUND', message, fix });
  });
});

// git isolated from the user's config.
function gitIn(dir: string): (args: string[]) => string {
  const home = tempDir();
  const config = path.join(home, '.gitconfig');
  fs.writeFileSync(config, '');
  return (args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' }).trim();
}

describe('review A2 NIT: one warning for one wrong commit', () => {
  it('main checkout with two worktrees, HEAD linked to LB-2 of dev-2 already: task_finish of LB-1 gives the worktree warning only, naming LB-2', async () => {
    const s = await newStore();
    const git = gitIn(s.root);
    git(['init', '-q', '-b', 'main']);
    git(['commit', '-q', '--allow-empty', '-m', 'first']);
    for (const [n, dev] of [[1, 'dev-1'], [2, 'dev-2']] as const) {
      await createTask(as(s, dev), { title: `Work ${n}`, status: 'todo', assignee: dev });
      await claimTask(as(s, dev), { id: `LB-${n}`, status: 'in_progress' });
    }
    const head = git(['rev-parse', 'HEAD']);
    await finishTask(as(s, 'dev-2', { cwd: s.root }), { id: 'LB-2', result: 'mine', commit: head });
    for (const name of ['wt-a', 'wt-b']) {
      const wt = path.join(tempDir(), name);
      git(['worktree', 'add', '-q', wt, '-b', name]);
      gitIn(wt)(['commit', '-q', '--allow-empty', '-m', `work in ${name}`]);
    }
    const r = reply(await callTool('task_finish', { id: 'LB-1', status: 'review', result: 'done', actor: 'dev-1' }, { cwd: s.root, env: {} }));
    expect(r.data.commit).toBe(head);
    expect(otherWarnings(r.warnings)).toHaveLength(1);
    expect(r.warnings[0]).toContain('other worktrees of this repository have commits since you claimed LB-1');
    expect(r.warnings[0]).toMatch(new RegExp(`; commit ${head.slice(0, 12)} is already linked to LB-2 of dev-2 too$`));
    expect(r.warnings[0]).toContain('task_finish {"id":"LB-1","status":"review","commit":"<HEAD of your worktree>"');
  });
});
