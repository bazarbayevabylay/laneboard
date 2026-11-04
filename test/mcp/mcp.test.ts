// MCP over stdio with the real SDK client: exactly 11 tools (C3; delete and redact are CLI-only, S6e), instructions = agent rules, every tool called,
// CLI/MCP parity on cloned stores (same data, same error objects), fresh reads per call (W3).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, describe, expect, it } from 'vitest';
import { agentRules, archiveTasks, claimTask, createTask, ERRORS, OPS, registerStore } from '../../src/core/index.ts';
import { TOOL_LIST, TOOLS } from '../../src/mcp/tools.ts';
import { as, cleanupTemp, cli, CLI_SOURCE, newStore, tempDir } from '../helpers.ts';
import type { TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

const TOOL_NAMES = ['task_create', 'task_get', 'task_list', 'task_update', 'task_claim', 'task_comment', 'task_finish', 'task_attach', 'task_archive', 'task_restore', 'task_events'];

interface Mcp {
  client: Client;
  call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; structured: Record<string, unknown>; text: string[] }>;
  close(): Promise<void>;
}

// Start `laneboard mcp` in `cwd` (from source) and connect the SDK client over stdio.
async function startMcp(cwd: string, env: Record<string, string> = {}): Promise<Mcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI_SOURCE, 'mcp'], cwd, env: { PATH: process.env.PATH ?? '', ...env }, stderr: 'pipe' });
  const client = new Client({ name: 'laneboard-test', version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    async call(name, args) {
      const r = await client.callTool({ name, arguments: args });
      const content = (r.content ?? []) as Array<{ type: string; text: string }>;
      return { isError: r.isError === true, structured: (r.structuredContent ?? {}) as Record<string, unknown>, text: content.map((c) => c.text) };
    },
    close: () => client.close(),
  };
}

// Base store: LB-1 todo (label auth), LB-2 claimed by dev-1, LB-3 archived; a file to attach outside the store.
async function baseStore(): Promise<TestStore & { file: string }> {
  const s = await newStore();
  await createTask(as(s, 'a'), { title: 'Fix login', status: 'todo', labels: ['auth'] });
  await createTask(as(s, 'a'), { title: 'Add dark mode', status: 'todo' });
  await claimTask(as(s, 'dev-1'), { id: 'LB-2' });
  await createTask(as(s, 'a'), { title: 'Old task', status: 'done' });
  await archiveTasks(as(s, 'a'), { ids: ['LB-3'] });
  const file = path.join(tempDir(), 'notes.txt');
  fs.writeFileSync(file, 'some notes\n');
  return { ...s, file };
}

// A byte copy of a store root in a new temp directory.
function cloneRoot(root: string): string {
  const copy = tempDir();
  fs.cpSync(root, copy, { recursive: true });
  return copy;
}

// Replace timestamps so runs a few ms apart compare equal.
function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<TS>'));
}

interface ParityCase {
  name: string;
  cli: string[];
  tool: string;
  args: Record<string, unknown>;
  // Expected error code (both sides), or undefined for success.
  error?: string;
  // Expected MCP fix when it differs from the CLI fix on purpose (CLI rebuilds argv; MCP names tool parameters).
  mcpFix?: string;
  // Expected MCP message when the CLI adds CLI-only advice to it (ACTOR_REQUIRED names LANEBOARD_AGENT).
  mcpMessage?: string;
}

// Cases share the base store; `<FILE>` is replaced by the absolute path of the file to attach.
const CASES: ParityCase[] = [
  {
    name: 'create',
    cli: ['create', 'New task', '--status', 'todo', '--description', 'Steps', '--assignee', 'dev-3', '--label', 'ui', '--link', 'branch=feat/x', '--field', 'priority=1', '--as', 'a'],
    tool: 'task_create',
    args: { title: 'New task', status: 'todo', description: 'Steps', assignee: 'dev-3', labels: ['ui'], links: [{ kind: 'branch', ref: 'feat/x' }], fields: { priority: 1 }, actor: 'a' },
  },
  { name: 'get', cli: ['get', 'LB-1'], tool: 'task_get', args: { id: 'LB-1' } },
  { name: 'get archived, 0 events', cli: ['get', 'LB-3', '--events', '0'], tool: 'task_get', args: { id: 'LB-3', events: 0 } },
  { name: 'list', cli: ['list', '--scope', 'all', '--limit', '2', '--offset', '1'], tool: 'task_list', args: { scope: 'all', limit: 2, offset: 1 } },
  { name: 'list filtered', cli: ['list', '--status', 'todo', '--unassigned', '--label', 'auth', '--text', 'login'], tool: 'task_list', args: { status: ['todo'], unassigned: true, labels: ['auth'], text: 'login' } },
  {
    name: 'update',
    cli: ['update', 'LB-1', '--title', 'Fix login page', '--status', 'review', '--assignee', 'dev-2', '--add-label', 'ui', '--remove-label', 'auth', '--add-link', 'pr=https://example.com/7', '--field', 'priority=2', '--expected-rev', '1', '--as', 'a'],
    tool: 'task_update',
    args: { id: 'LB-1', title: 'Fix login page', status: 'review', assignee: 'dev-2', add_labels: ['ui'], remove_labels: ['auth'], add_links: [{ kind: 'pr', ref: 'https://example.com/7' }], fields: { priority: 2 }, expected_rev: 1, actor: 'a' },
  },
  { name: 'update unassign', cli: ['update', 'LB-2', '--unassign', '--as', 'a'], tool: 'task_update', args: { id: 'LB-2', assignee: null, actor: 'a' } },
  { name: 'claim', cli: ['claim', 'LB-1', '--status', 'in_progress', '--as', 'dev-2'], tool: 'task_claim', args: { id: 'LB-1', status: 'in_progress', actor: 'dev-2' } },
  { name: 'comment', cli: ['comment', 'LB-1', 'tests pass', '--as', 'b'], tool: 'task_comment', args: { id: 'LB-1', text: 'tests pass', actor: 'b' } },
  { name: 'attach', cli: ['attach', 'LB-1', '<FILE>', '--name', 'repro.txt', '--as', 'a'], tool: 'task_attach', args: { id: 'LB-1', path: '<FILE>', name: 'repro.txt', actor: 'a' } },
  { name: 'archive', cli: ['archive', 'LB-1', 'LB-2', '--as', 'a'], tool: 'task_archive', args: { ids: ['LB-1', 'LB-2'], actor: 'a' } },
  { name: 'archive bulk dry run', cli: ['archive', '--status', 'todo', '--updated-before', '1d', '--dry-run', '--as', 'a'], tool: 'task_archive', args: { status: 'todo', updated_before: '1d', dry_run: true, actor: 'a' } },
  { name: 'restore', cli: ['restore', 'LB-3', '--as', 'a'], tool: 'task_restore', args: { id: 'LB-3', actor: 'a' } },
  { name: 'events', cli: ['events', '--scope', 'all', '--limit', '3'], tool: 'task_events', args: { scope: 'all', limit: 3 } },
  { name: 'events of a task', cli: ['events', '--task', 'LB-2'], tool: 'task_events', args: { task: 'LB-2' } },

  { name: 'UNKNOWN_STATUS', cli: ['update', 'LB-1', '--status', 'doing', '--as', 'a'], tool: 'task_update', args: { id: 'LB-1', status: 'doing', actor: 'a' }, error: 'UNKNOWN_STATUS', mcpFix: 'use a status from `allowed`' },
  { name: 'TASK_NOT_FOUND', cli: ['get', 'LB-99'], tool: 'task_get', args: { id: 'LB-99' }, error: 'TASK_NOT_FOUND' },
  { name: 'REV_CONFLICT', cli: ['update', 'LB-1', '--title', 'y', '--expected-rev', '5', '--as', 'a'], tool: 'task_update', args: { id: 'LB-1', title: 'y', expected_rev: 5, actor: 'a' }, error: 'REV_CONFLICT' },
  { name: 'ALREADY_CLAIMED', cli: ['claim', 'LB-2', '--as', 'dev-2'], tool: 'task_claim', args: { id: 'LB-2', actor: 'dev-2' }, error: 'ALREADY_CLAIMED' },
  { name: 'TASK_ARCHIVED', cli: ['comment', 'LB-3', 'more', '--as', 'a'], tool: 'task_comment', args: { id: 'LB-3', text: 'more', actor: 'a' }, error: 'TASK_ARCHIVED' },
  { name: 'INVALID_VALUE id', cli: ['get', 'lb-1'], tool: 'task_get', args: { id: 'lb-1' }, error: 'INVALID_VALUE', mcpFix: 'use LB-1' },
  { name: 'UNKNOWN_FIELD', cli: ['update', 'LB-1', '--unset-field', 'prio', '--as', 'a'], tool: 'task_update', args: { id: 'LB-1', unset_fields: ['prio'], actor: 'a' }, error: 'UNKNOWN_FIELD', mcpFix: 'use a field from `allowed` or declare it in .laneboard/config.json `fields`' },
  {
    name: 'ACTOR_REQUIRED',
    cli: ['create', 'x', '--status', 'todo'],
    tool: 'task_create',
    args: { title: 'x', status: 'todo' },
    error: 'ACTOR_REQUIRED',
    mcpFix: 'pass actor: "<your-name>" (e.g. dev-1) to task_create',
    mcpMessage: 'this command changes the store and needs an actor',
  },
  {
    name: 'USAGE nothing to change',
    cli: ['update', 'LB-1', '--as', 'a'],
    tool: 'task_update',
    args: { id: 'LB-1', actor: 'a' },
    error: 'USAGE',
    mcpFix: 'call task_update with these parameters (? = optional): id, title?, description?, append_description?, status?, assignee?, parent?, add_labels?, remove_labels?, add_links?, remove_links?, fields?, unset_fields?, expected_rev?, actor?, full?',
  },
];

let base: (TestStore & { file: string }) | undefined;

describe('MCP server over stdio (SDK client)', () => {
  it('C3: every core op is a tool or CLI-only; exactly 11 tools (delete and redact are for people: CLI only)', () => {
    expect(Object.keys(TOOLS).sort()).toEqual(Object.keys(OPS).sort());
    expect(TOOL_LIST.map((t) => t.def.name)).toEqual(TOOL_NAMES);
    expect(TOOLS.deleteTask).toBe('cli-only');
    expect(TOOLS.redactTask).toBe('cli-only');
  });

  it('lists exactly 11 tools with strict schemas; instructions are the agent rules (<= 4096 chars)', async () => {
    const s = await newStore();
    const mcp = await startMcp(s.root);
    try {
      const { tools } = await mcp.client.listTools();
      expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
      for (const t of tools) {
        expect(t.inputSchema.additionalProperties, t.name).toBe(false);
        expect(t.description?.length ?? 0, t.name).toBeGreaterThan(10);
        // Write tools take an optional actor (else LANEBOARD_AGENT, else the session default name); reads take none.
        const required = (t.inputSchema.required ?? []) as string[];
        expect(required.includes('actor'), t.name).toBe(false);
        expect('actor' in (t.inputSchema.properties ?? {}), t.name).toBe(t.annotations?.readOnlyHint === false);
        expect('field_args' in (t.inputSchema.properties ?? {}), t.name).toBe(false);
      }
      const instructions = mcp.client.getInstructions() ?? '';
      expect(instructions).toBe(agentRules());
      expect(instructions.length).toBeLessThanOrEqual(4096);
    } finally {
      await mcp.close();
    }
  });

  it('K2 (ADR §25-§26): the new op inputs are tool params by themselves (task_create/task_list parent; task_update parent, append_description)', async () => {
    const s = await newStore();
    const mcp = await startMcp(s.root);
    try {
      const { tools } = await mcp.client.listTools();
      const params = (name: string): string[] => Object.keys(tools.find((t) => t.name === name)?.inputSchema.properties ?? {});
      expect(tools).toHaveLength(11);
      expect(params('task_create')).toContain('parent');
      expect(params('task_list')).toContain('parent');
      expect(params('task_update')).toEqual(expect.arrayContaining(['parent', 'append_description']));
      const created = await mcp.call('task_create', { title: 'P', status: 'todo', actor: 'a' });
      expect(created.isError).toBe(false);
      const child = await mcp.call('task_create', { title: 'C', status: 'todo', parent: 'LB-1', actor: 'a', full: true });
      expect(child.structured).toMatchObject({ id: 'LB-2', parent: 'LB-1' });
      const appended = await mcp.call('task_update', { id: 'LB-1', append_description: 'more', actor: 'a', full: true });
      expect(appended.structured).toMatchObject({ description: 'more' });
      const got = await mcp.call('task_get', { id: 'LB-1' });
      expect(got.structured).toMatchObject({ children: [{ id: 'LB-2', title: 'C' }] });
    } finally {
      await mcp.close();
    }
  });

  it('K2/K3 (ADR §29): task_list takes all_boards and open by itself; the server passes HOME, so it lists the tasks of every board', async () => {
    const home = tempDir();
    const own = await newStore();
    const web = await newStore({ prefix: 'WEB' });
    await registerStore(home, own.dir);
    await registerStore(home, web.dir);
    await createTask(as(own, 'a'), { title: 'Own open', status: 'todo' });
    await createTask(as(own, 'a'), { title: 'Own done', status: 'done' });
    await createTask(as(web, 'a'), { title: 'Web open', status: 'in_progress', labels: ['waiting-owner'] });
    const mcp = await startMcp(own.root, { HOME: home });
    try {
      const { tools } = await mcp.client.listTools();
      expect(tools).toHaveLength(11);
      expect(Object.keys(tools.find((t) => t.name === 'task_list')?.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['all_boards', 'open', 'parent']));
      const all = await mcp.call('task_list', { all_boards: true, open: true });
      expect(all.isError).toBe(false);
      expect((all.structured.items as Array<{ id: string }>).map((t) => t.id).sort()).toEqual(['LB-1', 'WEB-1']);
      expect((all.structured.boards as Array<{ prefix: string }>).map((b) => b.prefix)).toEqual(['LB', 'WEB']);
      const waiting = await mcp.call('task_list', { all_boards: true, labels: ['waiting-owner'] });
      expect((waiting.structured.items as Array<{ id: string }>).map((t) => t.id)).toEqual(['WEB-1']);
    } finally {
      await mcp.close();
    }
    // HOME empty in the server environment (the SDK passes the parent's HOME otherwise): USAGE that names HOME.
    const bare = await startMcp(own.root, { HOME: '' });
    try {
      const r = await bare.call('task_list', { all_boards: true });
      expect(r.isError).toBe(true);
      expect(r.structured).toMatchObject({ code: 'USAGE', fix: 'set HOME to your home directory and run the same command again' });
    } finally {
      await bare.close();
    }
  });

  it('calls each of the 11 tools in one session; results carry the CLI data as structuredContent and text', async () => {
    base ??= await baseStore();
    const root = cloneRoot(base.root);
    const mcp = await startMcp(root);
    try {
      const ok = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const r = await mcp.call(name, args);
        expect(r.isError, `${name}: ${r.text.join(' ')}`).toBe(false);
        expect(JSON.parse(r.text[0] ?? 'null')).toEqual(r.structured);
        return r.structured;
      };
      const called = new Set<string>();
      const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
        called.add(name);
        return ok(name, args);
      };
      expect(await call('task_create', { title: 'From MCP', status: 'todo', actor: 'm', full: true })).toMatchObject({ id: 'LB-4', created_by: 'm', rev: 1 });
      expect(await call('task_get', { id: 'LB-4' })).toMatchObject({ id: 'LB-4', archived: false });
      expect(await call('task_list', { scope: 'all' })).toMatchObject({ total: 4, scope: 'all' });
      expect(await call('task_claim', { id: 'LB-4', actor: 'm' })).toMatchObject({ assignee: 'm', rev: 2 });
      expect(await call('task_update', { id: 'LB-4', status: 'in_progress', expected_rev: 2, actor: 'm' })).toMatchObject({ status: 'in_progress', rev: 3 });
      expect(await call('task_comment', { id: 'LB-4', text: '- item one', actor: 'm' })).toMatchObject({ rev: 4 });
      // S3: the server folder is no git checkout, so no commit is linked.
      expect(await call('task_finish', { id: 'LB-4', result: 'Done over MCP', actor: 'm' })).toEqual({ id: 'LB-4', rev: 5, status: 'done', assignee: 'm', commit: null });
      const attached = await call('task_attach', { id: 'LB-4', path: base.file, actor: 'm', full: true });
      expect(attached.attachments).toMatchObject([{ name: 'notes.txt', size: 11 }]);
      expect(await call('task_attach', { id: 'LB-4', remove: 'notes.txt', actor: 'm', full: true })).toMatchObject({ attachments: [] });
      expect(await call('task_archive', { ids: ['LB-4'], actor: 'm' })).toMatchObject({ archived: [{ id: 'LB-4' }], dry_run: false });
      expect(await call('task_restore', { id: 'LB-4', actor: 'm', full: true })).toMatchObject({ archived: false });
      const events = await call('task_events', { task: 'LB-4', limit: 50 });
      expect((events.items as Array<{ type: string }>).map((e) => e.type)).toEqual(['restored', 'archived', 'detached', 'attached', 'status', 'commented', 'commented', 'status', 'assigned', 'created']);
      expect([...called].sort()).toEqual([...TOOL_NAMES].sort());
      // An agent cannot delete over MCP (S6e): the tool is unknown and the task stays.
      const gone = await mcp.call('task_delete', { id: 'LB-4', confirm_id: 'LB-4', actor: 'm' });
      expect(gone.isError).toBe(true);
      expect(gone.structured).toMatchObject({ code: 'USAGE', message: 'unknown tool "task_delete"' });
      expect(await ok('task_get', { id: 'LB-4' })).toMatchObject({ id: 'LB-4', archived: false });

      // A no-op update is not an error; its warning comes as a second text item.
      const same = await mcp.call('task_update', { id: 'LB-1', status: 'todo', actor: 'm' });
      expect(same.isError).toBe(false);
      // Like the CLI envelope: store and prefix next to the warnings (agent rule 11).
      expect(JSON.parse(same.text[1] ?? '{}')).toEqual({ store: path.join(root, '.laneboard'), prefix: 'LB', warnings: ['no changes: LB-1 already has these values'] });
    } finally {
      await mcp.close();
    }
  });

  it.each(CASES)('parity with the CLI: $name', async (c) => {
    base ??= await baseStore();
    const sub = (v: unknown): unknown => JSON.parse(JSON.stringify(v).split('<FILE>').join(base?.file ?? ''));
    const cliRoot = cloneRoot(base.root);
    const mcpRoot = cloneRoot(base.root);
    const viaCli = await cli([...(sub(c.cli) as string[]), '--json'], { cwd: cliRoot });
    const envelope = JSON.parse(viaCli.stdout) as { ok: boolean; data?: unknown; error?: Record<string, unknown> };
    const mcp = await startMcp(mcpRoot);
    try {
      const r = await mcp.call(c.tool, sub(c.args) as Record<string, unknown>);
      if (!c.error) {
        expect(envelope.ok, viaCli.stdout).toBe(true);
        expect(r.isError, r.text.join(' ')).toBe(false);
        expect(normalize(r.structured)).toEqual(normalize(envelope.data));
        return;
      }
      expect(envelope.error?.code).toBe(c.error);
      expect(r.isError).toBe(true);
      const { fix: cliFix, message: cliMessage, ...cliRest } = envelope.error ?? {};
      const { fix: mcpFix, message: mcpMessage, ...mcpRest } = r.structured;
      expect(normalize(mcpRest)).toEqual(normalize(cliRest));
      expect(mcpFix).toBe(c.mcpFix ?? cliFix);
      expect(mcpMessage).toBe(c.mcpMessage ?? cliMessage);
      expect(JSON.parse(r.text[0] ?? '{}')).toEqual(r.structured);
    } finally {
      await mcp.close();
    }
  });

  it('exits with code 0 within a second after stdin closes', async () => {
    const s = await newStore();
    const child = spawn(process.execPath, [CLI_SOURCE, 'mcp'], { cwd: s.root, env: { PATH: process.env.PATH ?? '', HOME: s.root }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    const initialized = new Promise<void>((resolve) => child.stdout.on('data', () => stdout.includes('"id":0') && resolve()));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })}\n`);
    await initialized;
    const started = Date.now();
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    child.stdin.end();
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000).unref());
    const result = await Promise.race([exited, timeout]);
    if (result === 'timeout') child.kill();
    expect(result).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('rejects unknown parameters (field_args is CLI-only) with the tool parameters as fix', async () => {
    const s = await newStore();
    const mcp = await startMcp(s.root);
    try {
      const r = await mcp.call('task_create', { title: 'x', status: 'todo', field_args: ['priority=1'], actor: 'a' });
      expect(r.isError).toBe(true);
      expect(r.structured).toMatchObject({ code: 'USAGE', message: 'unknown parameter: field_args' });
      expect(r.structured.fix).toBe('call task_create with these parameters (? = optional): title, status, description?, assignee?, labels?, links?, parent?, fields?, actor?, full?');
      const read = await mcp.call('task_get', { id: 'LB-1', actor: 'a' });
      expect(read.structured).toMatchObject({ code: 'USAGE', message: 'unknown parameter: actor' });
    } finally {
      await mcp.close();
    }
  });

  it('W3: a long-lived server sees a CLI write on the next call; no store -> STORE_NOT_FOUND with fix', async () => {
    const s = await newStore();
    const mcp = await startMcp(s.root);
    try {
      expect((await mcp.call('task_list', {})).structured).toMatchObject({ total: 0 });
      expect((await cli(['create', 'From CLI', '--status', 'todo', '--as', 'a'], { cwd: s.root })).code).toBe(0);
      expect((await mcp.call('task_get', { id: 'LB-1' })).structured).toMatchObject({ title: 'From CLI' });
    } finally {
      await mcp.close();
    }
    const empty = await startMcp(tempDir());
    try {
      const r = await empty.call('task_list', {});
      expect(r.isError).toBe(true);
      expect(r.structured).toMatchObject({ code: 'STORE_NOT_FOUND', fix: ERRORS.STORE_NOT_FOUND.fix });
    } finally {
      await empty.close();
    }
  });
});
