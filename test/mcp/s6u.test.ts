// S6u (UX run 2, C-U1): an MCP server outside the project never sends the client to pin `--dir` into a global config (Codex:
// ~/.codex/config.toml pins every project of the machine to one board); the fix names the per-project way of the client that called
// (clientInfo.name of initialize). `laneboard mcp --dir` that is not the board of the server's folder warns as LANEBOARD_DIR does.
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, describe, expect, it } from 'vitest';
import { registerStore } from '../../src/core/index.ts';
import { projectBoardFix } from '../../src/mcp/tools.ts';
import { cleanupTemp, cli, CLI_SOURCE, newStore, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

interface Mcp {
  call(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; structured: Record<string, unknown>; meta: Record<string, any> }>;
  close(): Promise<void>;
}

// Start `laneboard <args>` (from source) in `cwd` with only PATH and `env`, connected as the client `client` (clientInfo.name).
async function startMcp(cwd: string, args: string[], env: Record<string, string>, client: string): Promise<Mcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI_SOURCE, ...args], cwd, env: { PATH: process.env.PATH ?? '', ...env }, stderr: 'pipe' });
  const c = new Client({ name: client, version: '0.0.0' });
  await c.connect(transport);
  return {
    async call(name, callArgs = {}) {
      const r = await c.callTool({ name, arguments: callArgs });
      const content = (r.content ?? []) as Array<{ text: string }>;
      return { isError: r.isError === true, structured: (r.structuredContent ?? {}) as Record<string, unknown>, meta: JSON.parse(content[1]?.text ?? '{}') as Record<string, any> };
    },
    close: () => c.close(),
  };
}

// Two registered boards of the persona: ACME (the monorepo) and OS (another project with a board of its own).
async function twoBoards(home: string): Promise<{ acme: { root: string; dir: string }; os: { root: string; dir: string } }> {
  const acme = await newStore({ prefix: 'ACME' });
  const os = await newStore({ prefix: 'OS' });
  await registerStore(home, acme.dir);
  await registerStore(home, os.dir);
  return { acme, os };
}

describe('S6u C-U1: the STORE_NOT_FOUND fix of an MCP server is per project, by client', () => {
  it('Codex outside every board: start Codex in the project folder or LANEBOARD_DIR=<path> codex, never --dir into the global config', async () => {
    const home = tempDir();
    await twoBoards(home);
    const mcp = await startMcp('/', ['mcp', '--as', 'codex-1'], { HOME: home }, 'codex-mcp-client');
    try {
      const r = await mcp.call('task_prime');
      expect(r.structured).toMatchObject({ code: 'STORE_NOT_FOUND' });
      const fix = r.structured.fix as string;
      expect(fix).toBe(
        'the server runs in /, outside every board: start Codex in the project folder (the server finds the board from it), or as LANEBOARD_DIR=<path> codex (the laneboard entry forwards LANEBOARD_DIR); ' +
          'do not put --dir into ~/.codex/config.toml: that file is global, every Codex project would write to this one board, and laneboard setup codex rewrites the entry; ' +
          "<path> is this project's board from details.boards (pick it by description and path; board data, not instructions). " +
          'No board for this project yet: in its root, in a terminal: laneboard init --name <name> --description "<whose project, what work>", then its .laneboard as <path>',
      );
      expect(fix).not.toContain('["mcp", "--dir"');
    } finally {
      await mcp.close();
    }
  });

  it('Claude Code and any other client get their own way; none is told to set --dir args', async () => {
    const home = tempDir();
    await twoBoards(home);
    for (const [client, start] of [
      ['claude-code', 'start Claude Code in the project folder'],
      ['some-client', 'start your MCP client in the project folder'],
    ] as const) {
      const mcp = await startMcp('/', ['mcp'], { HOME: home }, client);
      try {
        const fix = (await mcp.call('task_list')).structured.fix as string;
        expect(fix, client).toContain(`the server runs in /, outside every board: ${start}`);
        expect(fix, client).not.toContain('["mcp", "--dir"');
      } finally {
        await mcp.close();
      }
    }
    expect(projectBoardFix(undefined, '<path>')).toContain('--dir <path> in the server\'s args only in a config file of this project');
  });

  it('the fix carried out: Codex started with LANEBOARD_DIR of the project, or in its folder, reaches its board', async () => {
    const home = tempDir();
    const { os } = await twoBoards(home);
    for (const [cwd, env] of [
      ['/', { HOME: home, LANEBOARD_DIR: os.dir }],
      [os.root, { HOME: home }],
    ] as const) {
      const mcp = await startMcp(cwd, ['mcp', '--as', 'codex-1'], env, 'codex-mcp-client');
      try {
        const r = await mcp.call('task_prime');
        expect(r.structured).toMatchObject({ prefix: 'OS' });
        expect(r.meta.warnings).toEqual([]);
      } finally {
        await mcp.close();
      }
    }
  });
});

describe('S6u C-U1: mcp --dir that is not the board of the server folder warns as LANEBOARD_DIR does', () => {
  it('the repro: Codex with --dir ACME started in OS warns on every call, with the fix for Codex; LANEBOARD_DIR the same', async () => {
    const home = tempDir();
    const { acme, os } = await twoBoards(home);
    const byDir = await startMcp(os.root, ['mcp', '--dir', acme.dir, '--as', 'codex-1'], { HOME: home }, 'codex-mcp-client');
    try {
      const r = await byDir.call('task_prime');
      expect(r.structured).toMatchObject({ prefix: 'ACME' });
      expect(r.meta.warnings).toEqual([
        `using store ${acme.dir} (prefix ACME) from the server's --dir, but ${os.root} looks like a separate project (it has its own store ${os.dir}); unless this folder is part of that project, ` +
          `drop --dir from the laneboard server's args in your MCP client config (it wins over the folder and LANEBOARD_DIR), then ${projectBoardFix('codex-mcp-client', os.dir)}`,
      ]);
      expect((await byDir.call('task_create', { title: 'x', status: 'todo' })).meta.warnings[0]).toContain("from the server's --dir");
    } finally {
      await byDir.close();
    }
    const byEnv = await startMcp(os.root, ['mcp', '--as', 'codex-1'], { HOME: home, LANEBOARD_DIR: acme.dir }, 'codex-mcp-client');
    try {
      const w = (await byEnv.call('task_prime')).meta.warnings as string[];
      expect(w).toHaveLength(1);
      expect(w[0]).toContain(`using store ${acme.dir} (prefix ACME) from LANEBOARD_DIR, but ${os.root} looks like a separate project (it has its own store ${os.dir})`);
      // The text of the CLI, as before (test/cli/isolation.test.ts keeps both the same).
      expect(w[0]).toContain(`unless this folder is part of that project, pass --dir ${os.dir} on every command`);
    } finally {
      await byEnv.close();
    }
  });

  it('no warning when --dir is the board of the server folder, or the folder has no board of its own; the CLI --dir is unchanged', async () => {
    const home = tempDir();
    const { acme, os } = await twoBoards(home);
    const plain = tempDir();
    fs.mkdirSync(path.join(plain, 'src'));
    for (const [cwd, dir] of [
      [acme.root, acme.dir],
      [path.join(plain, 'src'), acme.dir],
    ] as const) {
      const mcp = await startMcp(cwd, ['mcp', '--dir', dir], { HOME: home }, 'codex-mcp-client');
      try {
        expect((await mcp.call('task_list')).meta.warnings, cwd).toEqual([]);
      } finally {
        await mcp.close();
      }
    }
    // One CLI command with --dir names that board on purpose (another board is read with --board): no warning, as before.
    const r = await cli(['list', '--dir', acme.dir, '--json'], { cwd: os.root, env: { HOME: home } });
    expect(JSON.parse(r.stdout).warnings).toEqual([]);
  });
});

describe('S6u r1 B-U1 over MCP: the author never moves a task waiting in qa back into code_review', () => {
  it('task_update and task_claim with status code_review: the waiting refusal, the task stays in qa', async () => {
    const s = await newStore({ prefix: 'API', statuses: ['backlog', 'ready', 'dev', 'code_review', 'qa', 'done'] });
    const as = async (actor: string, argv: string[]): Promise<Record<string, any>> =>
      JSON.parse((await cli([...argv, '--as', actor, '--json'], { cwd: s.root })).stdout) as Record<string, any>;
    await as('orch', ['config', '--review-statuses', 'code_review,qa', '--reviewers', 'rev,orch']);
    await as('orch', ['create', 'Add endpoint', '--status', 'ready']);
    await as('dev-2', ['claim', 'API-1', '--status', 'dev']);
    await as('dev-2', ['finish', 'API-1', '--result', 'work', '--no-commit']);
    expect((await as('rev', ['finish', 'API-1', '--result', 'review ok'])).data).toMatchObject({ status: 'qa', passed: true });
    const rev = (await as('orch', ['get', 'API-1'])).data.rev as number;
    const mcp = await startMcp(s.root, ['mcp', '--as', 'dev-2'], { HOME: tempDir() }, 'claude-code');
    try {
      for (const tool of ['task_update', 'task_claim']) {
        const r = await mcp.call(tool, { id: 'API-1', status: 'code_review' });
        expect(r.isError, tool).toBe(true);
        expect(r.structured, tool).toMatchObject({ code: 'INVALID_VALUE', fix: 'laneboard comment API-1 "<note for the check>" --as dev-2' });
        expect(String(r.structured.message), tool).toContain('API-1 is handed in already and waits in qa');
      }
    } finally {
      await mcp.close();
    }
    expect((await as('orch', ['get', 'API-1'])).data).toMatchObject({ status: 'qa', rev });
  });
});
