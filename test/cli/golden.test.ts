// CLI golden outputs: every command and every error code, human and --json (ADR-0001 S1 DoD).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ERROR_CODES, ERRORS } from '../../src/core/index.ts';
import type { ErrorCode } from '../../src/core/index.ts';
import { commandLine } from '../../src/cli/format.ts';
import { acquireLock } from '../../src/core/lock.ts';
import { cleanupTemp, cli, readStore, tempDir, writeRaw } from '../helpers.ts';
import type { CliRun } from '../helpers.ts';

afterAll(cleanupTemp);

// A port held for the PORT_IN_USE case (one taken by another program is just as good: the case needs it busy, not ours).
const BUSY_PORT = 47420;
let busyServer: net.Server | undefined;
const holdPort = async (): Promise<void> => {
  if (busyServer) return;
  const server = net.createServer();
  busyServer = server;
  await new Promise<void>((resolve) => {
    server.once('error', () => resolve());
    server.listen(BUSY_PORT, '127.0.0.1', () => resolve());
  });
};
afterAll(() => busyServer?.close());

interface Env {
  root: string;
  dir: string;
  run(argv: string[], stdin?: string): Promise<CliRun>;
}

interface Case {
  name: string;
  argv: string[];
  // Expected error code, or undefined for success.
  error?: ErrorCode;
  // Run `init` before setup (default true).
  store?: boolean;
  setup?: (e: Env) => Promise<void>;
  stdin?: string;
  // Hold the store lock while the command runs.
  holdLock?: boolean;
  // Make the store directory read-only while the command runs.
  readOnlyStore?: boolean;
  // Write deadline after the lock acquire (0 = every write finds the lock lost).
  lockMaxHoldMs?: number;
  // Environment of the command (HOME is a temp directory under the case root when set to 'home').
  env?: Record<string, string>;
}

const seed = async (e: Env): Promise<void> => {
  await e.run(['create', 'Fix login', '--status', 'todo', '--as', 'a']);
};
const seedFile = async (e: Env): Promise<void> => {
  await seed(e);
  fs.writeFileSync(path.join(e.root, 'notes.txt'), 'some notes\n');
};
const seedAttached = async (e: Env): Promise<void> => {
  await seedFile(e);
  await e.run(['attach', 'LB-1', 'notes.txt', '--as', 'a']);
};
const seedArchived = async (e: Env): Promise<void> => {
  await seed(e);
  await e.run(['archive', 'LB-1', '--as', 'a']);
};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 3));
// A small board for view and boards: tasks in three statuses, one with a long title, one unassigned.
const seedBoard = async (e: Env): Promise<void> => {
  await e.run(['create', 'Fix login on the checkout page when the session cookie has expired', '--status', 'todo', '--assignee', 'dev-1', '--label', 'ui', '--as', 'a']);
  await tick();
  await e.run(['create', 'Add dark mode', '--status', 'todo', '--as', 'a']);
  await tick();
  await e.run(['create', 'Cache the product list', '--status', 'in_progress', '--assignee', 'dev-2', '--as', 'a']);
  await tick();
  await e.run(['create', 'Ship v1', '--status', 'done', '--assignee', 'dev-1', '--label', 'ui', '--as', 'a']);
};
// Another folder named `other` already has a registered board (prefix OTHE), so `init --dir other/.laneboard` derives a taken prefix.
const seedOtherBoard = async (e: Env): Promise<void> => {
  const elsewhere = path.join(e.root, 'elsewhere', 'other');
  fs.mkdirSync(elsewhere, { recursive: true });
  const r = await cli(['init', '--description', 'the first board called other'], { cwd: elsewhere, env: { HOME: path.join(e.root, 'home') } });
  expect(r.code).toBe(0);
};

const CASES: Case[] = [
  { name: 'init', argv: ['init', '--description', 'Web shop of ACME: checkout and cart work'], store: false },
  { name: 'init-options', argv: ['init', '--description', 'test board', '--prefix', 'WEB', '--statuses', 'todo,doing,done', '--no-gitignore'], store: false },
  {
    name: 'create',
    argv: ['create', 'Fix login', '--status', 'todo', '--description', 'Users cannot log in', '--assignee', 'dev-1', '--label', 'auth', '--link', 'branch=fix/login', '--field', 'priority=1', '--as', 'a'],
  },
  { name: 'create-description-stdin', argv: ['create', 'From stdin', '--status', 'todo', '--description-file', '-', '--as', 'a'], stdin: 'line 1\nline 2\n' },
  {
    name: 'get',
    argv: ['get', 'LB-1'],
    setup: async (e) => {
      await seedAttached(e);
      await e.run(['update', 'LB-1', '--description', 'Steps:\n1. open /login', '--add-link', 'pr=https://example.com/pr/7', '--field', 'priority=0', '--as', 'a']);
      await e.run(['comment', 'LB-1', 'repro attached', '--as', 'b']);
    },
  },
  { name: 'get-no-events', argv: ['get', 'LB-1', '--events', '0'], setup: seed },
  {
    name: 'list',
    argv: ['list'],
    setup: async (e) => {
      await seed(e);
      await tick();
      await e.run(['create', 'Add dark mode', '--status', 'review', '--assignee', 'dev-2', '--as', 'a']);
      await tick();
      await e.run(['create', 'Old task', '--status', 'done', '--as', 'a']);
      await e.run(['archive', 'LB-3', '--as', 'a']);
    },
  },
  {
    name: 'list-paged-all',
    argv: ['list', '--scope', 'all', '--limit', '1', '--offset', '1'],
    setup: async (e) => {
      await seed(e);
      await tick();
      await e.run(['create', 'Second', '--status', 'todo', '--as', 'a']);
      await tick();
      await e.run(['create', 'Third', '--status', 'done', '--as', 'a']);
    },
  },
  { name: 'update', argv: ['update', 'LB-1', '--status', 'in_progress', '--title', 'Fix login page', '--add-label', 'ui', '--as', 'a'], setup: seed },
  { name: 'update-unchanged', argv: ['update', 'LB-1', '--status', 'todo', '--as', 'a'], setup: seed },
  { name: 'claim', argv: ['claim', 'LB-1', '--status', 'in_progress', '--as', 'dev-1'], setup: seed },
  { name: 'comment', argv: ['comment', 'LB-1', 'tests pass', '--as', 'a'], setup: seed },
  { name: 'comment-file', argv: ['comment', 'LB-1', '--file', '-', '--as', 'a'], setup: seed, stdin: 'long\nresult\n' },
  { name: 'comment-dash-text', argv: ['comment', 'LB-1', '--as', 'a', '--', '- item one'], setup: seed },
  { name: 'finish', argv: ['finish', 'LB-1', '--result', 'Fixed the redirect, tests green', '--as', 'dev-1'], setup: async (e) => void (await seed(e), await e.run(['claim', 'LB-1', '--status', 'in_progress', '--as', 'dev-1'])) },
  { name: 'finish-unchanged', argv: ['finish', 'LB-1', '--result', 'again', '--as', 'a'], setup: async (e) => void (await seed(e), await e.run(['finish', 'LB-1', '--result', 'first', '--as', 'a'])) },
  { name: 'update-dash-value', argv: ['update', 'LB-1', '--title=-x thing', '--description=- a', '--as', 'a'], setup: seed },
  { name: 'attach', argv: ['attach', 'LB-1', 'notes.txt', '--as', 'a'], setup: seedFile },
  { name: 'attach-remove', argv: ['attach', 'LB-1', '--remove', 'notes.txt', '--as', 'a'], setup: seedAttached },
  { name: 'archive', argv: ['archive', 'LB-1', '--as', 'a'], setup: seed },
  { name: 'archive-dry-run', argv: ['archive', '--status', 'todo', '--updated-before', '1d', '--dry-run'], setup: seed },
  { name: 'restore', argv: ['restore', 'LB-1', '--as', 'a'], setup: seedArchived },
  { name: 'delete', argv: ['delete', 'LB-1', '--confirm', 'LB-1', '--as', 'a'], setup: seed },
  {
    name: 'events',
    argv: ['events'],
    setup: async (e) => {
      await seed(e);
      await tick();
      await e.run(['comment', 'LB-1', 'looking', '--as', 'b']);
    },
  },
  { name: 'migrate', argv: ['migrate'] },
  { name: 'doctor', argv: ['doctor'], setup: seed },
  { name: 'setup', argv: ['setup', 'claude-code'], env: { HOME: '<ROOT>/home' } },
  {
    name: 'setup-replace',
    argv: ['setup', 'cursor'],
    env: { HOME: '<ROOT>/home' },
    setup: async (e) => {
      fs.mkdirSync(path.join(e.root, '.cursor'));
      fs.writeFileSync(path.join(e.root, '.cursor', 'mcp.json'), '{"mcpServers":{"laneboard":{"command":"npx"}}}\n');
    },
  },
  { name: 'setup-remove', argv: ['setup', 'codex', '--remove'], env: { HOME: '<ROOT>/home' }, setup: async (e) => void (await e.run(['setup', 'codex'])) },
  { name: 'setup-dry-run', argv: ['setup', 'opencode', '--dry-run'], env: { HOME: '<ROOT>/home' } },
  { name: 'prime', argv: ['prime', '--as', 'dev-1'], setup: async (e) => void (await e.run(['create', 'Fix login', '--status', 'todo', '--assignee', 'dev-1', '--as', 'a'])) },
  { name: 'prime-no-agent', argv: ['prime'], setup: seed },
  { name: 'config', argv: ['config'] },
  { name: 'config-change', argv: ['config', '--name', 'Web shop', '--description', 'ACME web shop: checkout and cart'], env: { HOME: '<ROOT>/home' } },
  { name: 'boards', argv: ['boards'], env: { HOME: '<ROOT>/home' }, setup: seedBoard },
  { name: 'view', argv: ['view'], env: { COLUMNS: '100' }, setup: seedBoard },
  { name: 'view-narrow', argv: ['view'], env: { COLUMNS: '50' }, setup: seedBoard },
  { name: 'view-filtered', argv: ['view', '--assignee', 'dev-1', '--label', 'ui'], env: { COLUMNS: '100' }, setup: seedBoard },
  { name: 'view-board', argv: ['view', '--board', 'LB'], env: { COLUMNS: '80', HOME: '<ROOT>/home' }, setup: seedBoard },
  { name: 'help', argv: ['--help'], store: false },
  { name: 'help-command', argv: ['create', '--help'], store: false },
  { name: 'version', argv: ['--version'], store: false },

  { name: 'error-INTERNAL', argv: ['create', 'x', '--status', 'todo', '--as', 'a'], error: 'INTERNAL', readOnlyStore: true },
  { name: 'error-USAGE', argv: ['update', 'LB-1', '--as', 'a'], error: 'USAGE', setup: seed },
  { name: 'error-USAGE-missing-flag', argv: ['delete', 'LB-1', '--as', 'a'], error: 'USAGE', setup: seed },
  { name: 'error-USAGE-no-command', argv: [], error: 'USAGE', store: false },
  { name: 'error-USAGE-unknown-command', argv: ['craete', 'x'], error: 'USAGE', store: false },
  { name: 'error-USAGE-repeated-option', argv: ['update', 'LB-1', '--status', 'done', '--status', 'todo', '--as', 'a'], error: 'USAGE', setup: seed },
  { name: 'error-USAGE-dash-value', argv: ['create', 't', '--status', 'todo', '--description', '- a\n- b', '--as', 'a'], error: 'USAGE' },
  { name: 'error-UNKNOWN_OPTION', argv: ['create', 'x', '--stauts', 'todo', '--as', 'a'], error: 'UNKNOWN_OPTION' },
  { name: 'error-UNKNOWN_OPTION-dash-text', argv: ['comment', 'LB-1', '- item one', '--as', 'a'], error: 'UNKNOWN_OPTION', setup: seed },
  { name: 'error-UNKNOWN_OPTION-double-dash-text', argv: ['comment', 'LB-1', '--- section', '--as', 'a'], error: 'UNKNOWN_OPTION', setup: seed },
  { name: 'error-UNKNOWN_OPTION-dash-title', argv: ['create', '-x', '--status', 'todo', '--as', 'a'], error: 'UNKNOWN_OPTION' },
  { name: 'error-INVALID_VALUE', argv: ['get', 'lb-1'], error: 'INVALID_VALUE', setup: seed },
  { name: 'error-INVALID_VALUE-field-type', argv: ['update', 'LB-1', '--field', 'priority=high', '--as', 'a'], error: 'INVALID_VALUE', setup: seed },
  { name: 'error-INVALID_VALUE-since', argv: ['events', '--since', 'yesterday'], error: 'INVALID_VALUE', setup: seed },
  { name: 'error-UNKNOWN_STATUS', argv: ['update', 'LB-1', '--status', 'doing', '--as', 'a'], error: 'UNKNOWN_STATUS', setup: seed },
  { name: 'error-UNKNOWN_STATUS-typo', argv: ['update', 'LB-1', '--status', 'in-progress', '--as', 'a'], error: 'UNKNOWN_STATUS', setup: seed },
  { name: 'error-UNKNOWN_FIELD', argv: ['update', 'LB-1', '--field', 'prio=1', '--as', 'a'], error: 'UNKNOWN_FIELD', setup: seed },
  { name: 'error-UNKNOWN_FIELD-typo', argv: ['update', 'LB-1', '--field', 'priorty=1', '--as', 'a'], error: 'UNKNOWN_FIELD', setup: seed },
  { name: 'error-ACTOR_REQUIRED', argv: ['create', 'x', '--status', 'todo'], error: 'ACTOR_REQUIRED' },
  { name: 'error-TASK_NOT_FOUND', argv: ['get', 'LB-99'], error: 'TASK_NOT_FOUND', setup: seed },
  { name: 'error-ATTACHMENT_NOT_FOUND', argv: ['attach', 'LB-1', '--remove', 'nope.txt', '--as', 'a'], error: 'ATTACHMENT_NOT_FOUND', setup: seedAttached },
  { name: 'error-REV_CONFLICT', argv: ['update', 'LB-1', '--title', 'y', '--expected-rev', '5', '--as', 'a'], error: 'REV_CONFLICT', setup: seed },
  {
    name: 'error-ALREADY_CLAIMED',
    argv: ['claim', 'LB-1', '--as', 'dev-2'],
    error: 'ALREADY_CLAIMED',
    setup: async (e) => {
      await seed(e);
      await e.run(['claim', 'LB-1', '--as', 'dev-1']);
    },
  },
  { name: 'error-TASK_ARCHIVED', argv: ['comment', 'LB-1', 'more', '--as', 'a'], error: 'TASK_ARCHIVED', setup: seedArchived },
  { name: 'error-ATTACHMENT_EXISTS', argv: ['attach', 'LB-1', 'notes.txt', '--as', 'a'], error: 'ATTACHMENT_EXISTS', setup: seedAttached },
  { name: 'error-LOCK_TIMEOUT', argv: ['create', 'x', '--status', 'todo', '--as', 'a'], error: 'LOCK_TIMEOUT', holdLock: true },
  { name: 'error-PORT_IN_USE', argv: ['board', '--port', String(BUSY_PORT)], error: 'PORT_IN_USE', setup: holdPort },
  { name: 'error-LOCK_LOST', argv: ['create', 'x', '--status', 'todo', '--as', 'a'], error: 'LOCK_LOST', lockMaxHoldMs: 0 },
  { name: 'error-STORE_NOT_FOUND', argv: ['list'], error: 'STORE_NOT_FOUND', store: false },
  {
    name: 'error-STORE_INVALID',
    argv: ['list'],
    error: 'STORE_INVALID',
    setup: async (e) => writeRaw(path.join(e.dir, 'active.json'), '{"schema":'),
  },
  {
    name: 'error-STORE_TOO_NEW',
    argv: ['create', 'x', '--status', 'todo', '--as', 'a'],
    error: 'STORE_TOO_NEW',
    setup: async (e) => {
      const data = readStore(e.dir, 'active');
      data.schema = 'laneboard/store@2';
      writeRaw(path.join(e.dir, 'active.json'), JSON.stringify(data));
    },
  },
  { name: 'error-STORE_EXISTS', argv: ['init', '--description', 'test board'], error: 'STORE_EXISTS' },
  { name: 'error-USAGE-init-no-description', argv: ['init', '--name', 'shop'], error: 'USAGE', store: false },
  { name: 'error-INVALID_VALUE-prefix-taken', argv: ['init', '--dir', 'other/.laneboard', '--description', 'another board'], error: 'INVALID_VALUE', env: { HOME: '<ROOT>/home' }, setup: seedOtherBoard },
  { name: 'error-STORE_READ_ONLY', argv: ['create', 'x', '--status', 'todo', '--board', '.', '--as', 'a'], error: 'STORE_READ_ONLY' },
  {
    name: 'error-SETUP_UNPARSEABLE',
    argv: ['setup', 'gemini'],
    error: 'SETUP_UNPARSEABLE',
    env: { HOME: '<ROOT>/home' },
    setup: async (e) => {
      fs.mkdirSync(path.join(e.root, '.gemini'));
      fs.writeFileSync(path.join(e.root, '.gemini', 'settings.json'), '{ "theme": dark }\n');
    },
  },
  {
    name: 'error-SETUP_CONFLICT',
    argv: ['setup', 'codex'],
    error: 'SETUP_CONFLICT',
    env: { HOME: '<ROOT>/home' },
    setup: async (e) => {
      fs.mkdirSync(path.join(e.root, 'home', '.codex'), { recursive: true });
      fs.writeFileSync(path.join(e.root, 'home', '.codex', 'config.toml'), '[mcp_servers]\nlaneboard = { command = "old", args = [] }\n');
    },
  },
  {
    name: 'error-SETUP_WRITE_FAILED',
    argv: ['setup', 'gemini'],
    error: 'SETUP_WRITE_FAILED',
    env: { HOME: '<ROOT>/home' },
    setup: async (e) => {
      fs.writeFileSync(path.join(e.root, 'GEMINI.md'), 'Be brief.\n', { mode: 0o444 });
    },
  },
  { name: 'error-INVALID_VALUE-harness', argv: ['setup', 'claude'], error: 'INVALID_VALUE', env: { HOME: '<ROOT>/home' } },
];

// Replace machine-specific parts (temp path, timestamps) with stable tokens.
function normalize(text: string, root: string): string {
  return text
    .split(root)
    .join('<ROOT>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, 'YYYY-MM-DDTHH:MM:SS.mmmZ')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g, 'YYYY-MM-DDTHH-MM-SS-mmmZ');
}

// Run one case in a fresh directory, in human or JSON mode.
async function runCase(c: Case, json: boolean): Promise<{ argv: string[]; result: CliRun; root: string }> {
  // A fixed folder name, so `init` without --prefix derives the same prefix (WA) on every machine.
  const root = path.join(tempDir(), 'web-app');
  fs.mkdirSync(root);
  const dir = path.join(root, '.laneboard');
  const caseEnv = Object.fromEntries(Object.entries(c.env ?? {}).map(([k, v]) => [k, v.split('<ROOT>').join(root)]));
  if (caseEnv.HOME) fs.mkdirSync(caseEnv.HOME, { recursive: true });
  const env: Env = { root, dir, run: (argv, stdin) => cli(argv, { cwd: root, stdin, env: caseEnv }) };
  if (c.store !== false) expect((await env.run(['init', '--description', 'test board', '--prefix', 'LB'])).code).toBe(0);
  await c.setup?.(env);
  // `--json` goes before `--`: after it, it would be text.
  const end = c.argv.indexOf('--');
  const argv = !json ? c.argv : end < 0 ? [...c.argv, '--json'] : [...c.argv.slice(0, end), '--json', ...c.argv.slice(end)];
  const lock = c.holdLock ? await acquireLock(dir) : undefined;
  if (c.readOnlyStore) fs.chmodSync(dir, 0o555);
  try {
    const result = await cli(argv, { cwd: root, stdin: c.stdin, env: caseEnv, lockWaitMs: 200, lockMaxHoldMs: c.lockMaxHoldMs });
    return { argv, result, root };
  } finally {
    if (c.readOnlyStore) fs.chmodSync(dir, 0o755);
    await lock?.release();
  }
}

// One transcript block for the golden file.
function transcript(argv: string[], r: CliRun, root: string): string {
  return normalize([`$ ${commandLine(argv)}`, `exit ${r.code}`, '--- stdout', r.stdout.trimEnd(), '--- stderr', r.stderr.trimEnd(), ''].join('\n'), root);
}

describe('CLI golden outputs', () => {
  it('cover every error code', () => {
    const covered = new Set(CASES.map((c) => c.error).filter(Boolean));
    expect(ERROR_CODES.filter((code) => !covered.has(code))).toEqual([]);
  });

  it.each(CASES)('$name', async (c) => {
    const human = await runCase(c, false);
    const json = await runCase(c, true);
    const exit = c.error ? ERRORS[c.error].exit : 0;
    expect(human.result.code).toBe(exit);
    expect(json.result.code).toBe(exit);
    if (c.error) expect(human.result.stdout).toBe('');

    // --json: exactly one JSON document on stdout, nothing on stderr.
    expect(json.result.stderr).toBe('');
    expect(json.result.stdout.trimEnd().split('\n')).toHaveLength(1);
    const doc = JSON.parse(json.result.stdout);
    expect(doc.ok).toBe(!c.error);
    if (c.error) expect(doc.error.code).toBe(c.error);
    if (c.error) expect(doc.error.fix.length).toBeGreaterThan(0);

    const text = [`# ${c.name}`, transcript(human.argv, human.result, human.root), transcript(json.argv, json.result, json.root)].join('\n');
    await expect(text).toMatchFileSnapshot(`__golden__/${c.name}.txt`);
  });
});
