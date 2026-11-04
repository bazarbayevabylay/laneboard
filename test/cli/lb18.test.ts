// LB-18: `create` keeps --status required (ADR-0001 §0 "no magic defaults", §23), and its error names the first status in a runnable fix
// (CLI and MCP); every CLI USAGE error has a fix that is one command built from the user's own argv, not the usage line.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTask } from '../../src/core/index.ts';
import { callTool } from '../../src/mcp/tools.ts';
import { as, cleanupTemp, cli, newStore } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

// Split a printed `laneboard ...` fix into argv the way a shell would.
function shellArgv(fix: string): string[] {
  expect(fix.startsWith('laneboard ')).toBe(true);
  const out = execFileSync('sh', ['-c', `printf '%s\\0' ${fix.slice('laneboard '.length)}`], { encoding: 'utf8' });
  return out.split('\0').slice(0, -1);
}

// A store with LB-1 (todo) and LB-2 (done), a file to attach, and a JSON import source.
async function seeded(statuses?: string[]): Promise<TestStore> {
  const s = await newStore(statuses ? { statuses } : {});
  await createTask(as(s, 'a'), { title: 'First', status: statuses?.[0] ?? 'todo' });
  await createTask(as(s, 'a'), { title: 'Second', status: statuses?.at(-1) ?? 'done' });
  fs.writeFileSync(path.join(s.root, 'notes.txt'), 'notes\n');
  expect((await cli(['attach', 'LB-1', 'notes.txt', '--name', 'old.txt', '--as', 'a'], { cwd: s.root })).code).toBe(0);
  fs.mkdirSync(path.join(s.root, 'src'));
  fs.writeFileSync(path.join(s.root, 'src', 'a.json'), '{"title":"Imported","state":"todo"}\n');
  return s;
}

// The JSON error of a failing CLI run.
async function errorOf(s: TestStore, argv: string[]): Promise<{ code: string; message: string; fix: string; allowed?: string[] }> {
  const r = await cli([...argv, '--json'], { cwd: s.root });
  expect(r.code, r.stdout).toBe(2);
  return JSON.parse(r.stdout).error;
}

describe('LB-18: create without --status', () => {
  it('CLI: USAGE, no default; the fix is the same command with the first configured status, and it runs', async () => {
    const s = await seeded(['backlog', 'doing', 'done']);
    const human = await cli(['create', 'Fix login', '--as', 'a'], { cwd: s.root });
    expect(human.code).toBe(2);
    expect(human.stderr).toBe("error USAGE: --status is required\n  allowed: backlog, doing, done\n  fix: laneboard create 'Fix login' --as a --status backlog\n");
    const err = await errorOf(s, ['create', 'Fix login', '--as', 'a']);
    expect(err).toEqual({ code: 'USAGE', message: '--status is required', fix: "laneboard create 'Fix login' --as a --json --status backlog", allowed: ['backlog', 'doing', 'done'] });
    // Nothing was written by the failed call: no magic default.
    const list = JSON.parse((await cli(['list', '--json'], { cwd: s.root })).stdout);
    expect(list.data.total).toBe(2);
    const r = await cli(shellArgv(err.fix), { cwd: s.root });
    expect(r.code, r.stdout).toBe(0);
    expect(JSON.parse(r.stdout).data).toMatchObject({ id: 'LB-3', status: 'backlog' });
  });

  it('CLI: text after -- stays after it; the status goes before', async () => {
    const s = await seeded();
    const r = await cli(['create', '--as', 'a', '--json', '--', '- item'], { cwd: s.root });
    expect(r.code).toBe(2);
    const err = JSON.parse(r.stdout).error as { fix: string };
    expect(err.fix).toBe("laneboard create --as a --json --status todo -- '- item'");
    expect((await cli(shellArgv(err.fix), { cwd: s.root })).code).toBe(0);
  });

  it('CLI: extra words without --status: one fix joins the title and adds the first status, and it runs', async () => {
    const s = await seeded(['backlog', 'doing', 'done']);
    const err = await errorOf(s, ['create', 'Fix', 'login', '--as', 'a']);
    expect(err.fix).toBe("laneboard create 'Fix login' --as a --json --status backlog");
    const r = await cli(shellArgv(err.fix), { cwd: s.root });
    expect(r.code, r.stdout).toBe(0);
    expect(JSON.parse(r.stdout).data).toMatchObject({ id: 'LB-3', status: 'backlog' });
  });

  it('MCP: the same USAGE with the first status in fix and allowed; calling with it creates the task', async () => {
    const s = await seeded(['backlog', 'doing', 'done']);
    const env = { cwd: s.root, env: {} };
    const r = await callTool('task_create', { title: 'Fix login', actor: 'a' }, env);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      code: 'USAGE',
      message: 'status is required',
      fix: 'pass status backlog (the first status: where new work starts), or another status from `allowed`',
      allowed: ['backlog', 'doing', 'done'],
    });
    const ok = await callTool('task_create', { title: 'Fix login', status: 'backlog', actor: 'a' }, env);
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent).toMatchObject({ id: 'LB-3', status: 'backlog' });
  });
});

// [argv, fix]: every USAGE error the CLI raises (src/cli and the core ops it calls) and its one-command fix.
const USAGE_CASES: Array<[string[], string]> = [
  [['create', 'T', '--as', 'a'], 'laneboard create T --as a --json --status todo'],
  [['create', '--as', 'a'], 'laneboard create --as a --json --status todo <title>'],
  [['create', 'Fix', 'login', '--status', 'todo', '--as', 'a'], "laneboard create 'Fix login' --status todo --as a --json"],
  [['create', 'Fix', 'login', '--as', 'a'], "laneboard create 'Fix login' --as a --json --status todo"],
  [['create', 'Fix', 'login', '--status=todo', '--as', 'a'], "laneboard create 'Fix login' --status=todo --as a --json"],
  [['create', 'x', '--description', 'a', '--description-file', 'b', '--status', 'todo', '--as', 'a'], 'laneboard create x --description a --status todo --as a --json'],
  [['create', 'x', '--status'], 'laneboard create x --status <value> --json'],
  [['update', 'LB-1', '--as', 'a'], 'laneboard update LB-1 --as a --json --status <status>'],
  [['update', 'LB-1', '--assignee', 'b', '--unassign', '--as', 'a'], 'laneboard update LB-1 --assignee b --as a --json'],
  [['update', 'LB-1', '--add-label', 'x', '--remove-label=x', '--remove-label', 'y', '--as', 'a'], 'laneboard update LB-1 --add-label x --remove-label y --as a --json'],
  [['update', 'LB-1', '--field', 'priority=1', '--unset-field', 'priority', '--as', 'a'], 'laneboard update LB-1 --field priority=1 --as a --json'],
  [['update', 'LB-1', '--status', 'done', '--status', 'todo', '--as', 'a'], 'laneboard update LB-1 --status <one of: done, todo> --as a --json'],
  [['claim', '--as', 'a'], 'laneboard claim --as a --json <id>'],
  [['get', 'LB-1', 'LB-2'], 'laneboard get LB-1 --json'],
  [['comment', 'LB-1', '--as', 'a'], 'laneboard comment LB-1 --as a --json <text>'],
  [['comment', 'LB-1', 'hello', 'world', '--as', 'a'], "laneboard comment LB-1 'hello world' --as a --json"],
  [['comment', 'LB-1', 'x', '--file', 'notes.txt', '--as', 'a'], 'laneboard comment LB-1 x --as a --json'],
  [['finish', 'LB-1', '--as', 'a'], 'laneboard finish LB-1 --as a --json --result <result>'],
  [['attach', 'LB-1', '--as', 'a'], 'laneboard attach LB-1 --as a --json <path>'],
  [['attach', 'LB-1', 'notes.txt', '--remove', 'z', '--as', 'a'], 'laneboard attach LB-1 notes.txt --as a --json'],
  [['attach', 'LB-1', '--remove', 'old.txt', '--name', 'n', '--as', 'a'], 'laneboard attach LB-1 --remove old.txt --as a --json'],
  [['archive', '--as', 'a'], 'laneboard archive --as a --json <id>'],
  [['archive', 'LB-2', '--status', 'done', '--as', 'a'], 'laneboard archive LB-2 --as a --json'],
  [['archive', 'LB-2', '--dry-run', '--as', 'a'], 'laneboard archive LB-2 --as a --json'],
  [['archive', 'LB-1', 'LB-2', '--expected-rev', '1', '--as', 'a'], 'laneboard archive LB-1 LB-2 --as a --json'],
  [['archive', '--status', 'done', '--as', 'a'], 'laneboard archive --status done --as a --json --updated-before <days like 14d>'],
  [['archive', '--updated-before', '0d', '--dry-run', '--as', 'a'], 'laneboard archive --updated-before 0d --dry-run --as a --json --status <status>'],
  [['delete', 'LB-1', '--as', 'a'], 'laneboard delete LB-1 --as a --json --confirm <id>'],
  [['list', '--assignee', 'a', '--unassigned'], 'laneboard list --assignee a --json'],
  [['list', '--json=1'], 'laneboard list --json'],
  [['list', '--dir', '.laneboard', '--board', '.laneboard'], 'laneboard list --board .laneboard --json'],
  [['view', '--watch'], 'laneboard view --json'],
  // A mode for people or a hook with --json (ADR §23): the fix keeps --json and drops the mode.
  [['prime', '--hook'], 'laneboard prime --json'],
  [['prime', '--edit-hook'], 'laneboard prime --json'],
  [['prime', '--hook', '--edit-hook'], 'laneboard prime --json'],
  [['import', 'json', 'src'], 'laneboard import json src --json --status-key <source key of the status>'],
  [['import', 'json', 'src', '--status-key', 'state', '--status-map', 'a=todo', '--status-map', 'a=done', '--dry-run'], 'laneboard import json src --status-key state --status-map a=todo --dry-run --json'],
  [['import', 'markdown', 'src', '--status-key', 'state', '--history-key', 'h', '--dry-run'], 'laneboard import markdown src --status-key state --dry-run --json'],
  [['boards'], 'HOME=<your home directory> laneboard boards --json'],
  [['setup', 'codex', '--dry-run'], 'HOME=<your home directory> laneboard setup codex --dry-run --json'],
  [[], 'laneboard prime --json'],
  [['--dir', '.laneboard', 'list'], 'laneboard list --dir .laneboard --json'],
];

describe('LB-18: every CLI USAGE error has a fix that is one command', () => {
  it.each(USAGE_CASES)('%j', async (argv, fix) => {
    const s = await seeded();
    const err = await errorOf(s, argv);
    expect(err.code).toBe('USAGE');
    expect(err.fix).toBe(fix);
    // One command, not the usage line: no [optional] or a|b syntax, no --help.
    expect(err.fix).not.toMatch(/\[|--help|\s\|\s/);
    expect(err.fix).toMatch(/^(HOME=<your home directory> )?laneboard /);
  });

  it.each(USAGE_CASES.filter(([, fix]) => !fix.includes('<')))('runs as printed: %j', async (argv) => {
    const s = await seeded();
    const err = await errorOf(s, argv);
    const r = await cli(shellArgv(err.fix), { cwd: s.root, env: { HOME: s.root } });
    expect(r.code, `${err.fix}\n${r.stdout}${r.stderr}`).toBe(0);
  });
});
