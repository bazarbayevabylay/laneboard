// lb-tokens experiment (0.5.0): `setup claude-code` writes no MCP server by default (its hooks print the rules and the CLI commands, and
// the agent works through the CLI), --mcp adds it, --no-mcp takes it out; an entry an earlier setup wrote stays, with a warning. The other
// harnesses have no hooks and always get the server.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTemp, cli, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

const KEPT_WARNING =
  'kept the laneboard MCP server of an earlier setup in .mcp.json: with the hooks the agent works through the CLI, and the server adds about 1.7k tokens to every request; laneboard setup claude-code --no-mcp --json takes it out (--mcp keeps it without this warning)';

// A temp project with a board and a temp HOME; `run` gives the --json envelope.
async function project(): Promise<{ cwd: string; run(argv: string[]): Promise<{ code: number; doc: Record<string, any> }> }> {
  const cwd = tempDir();
  const home = tempDir();
  const run = async (argv: string[]) => {
    const r = await cli([...argv, '--json'], { cwd, env: { HOME: home, USER: 'tester' } });
    return { code: r.code, doc: JSON.parse(r.stdout) };
  };
  expect((await run(['init', '--description', 'mcp optional test'])).code).toBe(0);
  return { cwd, run };
}

const mcpFile = (cwd: string): string => path.join(cwd, '.mcp.json');

describe('setup claude-code: the MCP server is optional', () => {
  it('a new install: no .mcp.json, hooks and the block are written, the note names the hook and --mcp', async () => {
    const p = await project();
    const r = await p.run(['setup', 'claude-code']);
    expect(r.code).toBe(0);
    expect(fs.existsSync(mcpFile(p.cwd))).toBe(false);
    const files = (r.doc.data.files as Array<{ path: string }>).map((f) => f.path);
    expect(files).not.toContain('.mcp.json');
    expect(files).toEqual(expect.arrayContaining(['CLAUDE.md', '.claude/settings.json']));
    expect(r.doc.data.notes).toEqual(['start Claude Code in this directory: the SessionStart hook prints the rules and your tasks (laneboard setup claude-code --mcp --json adds the MCP server too)']);
    expect(r.doc.warnings).not.toContain(KEPT_WARNING);
  });

  it('a project .mcp.json of the user without laneboard is left as it was', async () => {
    const p = await project();
    const mine = '{"mcpServers":{"other":{"command":"x"}}}\n';
    fs.writeFileSync(mcpFile(p.cwd), mine);
    expect((await p.run(['setup', 'claude-code'])).code).toBe(0);
    expect(fs.readFileSync(mcpFile(p.cwd), 'utf8')).toBe(mine);
  });

  it('--mcp writes the server and names the approval; a later setup keeps it with a warning; --no-mcp takes it out', async () => {
    const p = await project();
    const added = await p.run(['setup', 'claude-code', '--mcp']);
    expect(added.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(mcpFile(p.cwd), 'utf8'))).toEqual({ mcpServers: { laneboard: { command: 'laneboard', args: ['mcp'] } } });
    expect(added.doc.data.notes).toEqual(['start Claude Code in this directory and approve the project MCP server "laneboard" when asked']);
    expect(added.doc.warnings).not.toContain(KEPT_WARNING);
    // An existing install with the server (0.4.3 and older): the default setup does not break it, and says how to take it out.
    const again = await p.run(['setup', 'claude-code']);
    expect(again.code).toBe(0);
    expect(again.doc.data.files.find((f: { path: string }) => f.path === '.mcp.json')?.result).toBe('unchanged');
    expect(again.doc.warnings).toContain(KEPT_WARNING);
    expect((await p.run(['setup', 'claude-code', '--dry-run'])).doc.warnings).toContain(KEPT_WARNING.replace('kept the', 'would keep the'));
    // --mcp again: kept without the warning.
    expect((await p.run(['setup', 'claude-code', '--mcp'])).doc.warnings).not.toContain(KEPT_WARNING);
    const removed = await p.run(['setup', 'claude-code', '--no-mcp']);
    expect(removed.code).toBe(0);
    // setup created the file, so it goes.
    expect(removed.doc.data.files.find((f: { path: string }) => f.path === '.mcp.json')?.result).toBe('deleted');
    expect(fs.existsSync(mcpFile(p.cwd))).toBe(false);
    expect(fs.existsSync(path.join(p.cwd, 'CLAUDE.md'))).toBe(true);
  });

  it('--remove takes out a server an earlier setup wrote', async () => {
    const p = await project();
    expect((await p.run(['setup', 'claude-code', '--mcp'])).code).toBe(0);
    const r = await p.run(['setup', 'claude-code', '--remove']);
    expect(r.code).toBe(0);
    expect(fs.existsSync(mcpFile(p.cwd))).toBe(false);
  });

  it('the other harnesses always get the server; --mcp and --no-mcp are refused there, with --remove and together', async () => {
    const p = await project();
    expect((await p.run(['setup', 'cursor'])).code).toBe(0);
    expect(fs.existsSync(path.join(p.cwd, '.cursor', 'mcp.json'))).toBe(true);
    const cursor = await p.run(['setup', 'cursor', '--no-mcp']);
    expect(cursor.code).toBe(2);
    expect(cursor.doc.error).toMatchObject({ code: 'USAGE', fix: 'laneboard setup cursor --json' });
    const remove = await p.run(['setup', 'claude-code', '--remove', '--mcp']);
    expect(remove.doc.error).toMatchObject({ code: 'USAGE', fix: 'laneboard setup claude-code --remove --json' });
    const both = await p.run(['setup', 'claude-code', '--mcp', '--no-mcp']);
    expect(both.doc.error).toMatchObject({ code: 'USAGE', fix: 'laneboard setup claude-code --mcp --json' });
  });
});
