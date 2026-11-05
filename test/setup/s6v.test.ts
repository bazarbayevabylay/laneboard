// S6v (UX run 3, C-U3): the instruction block of the harnesses without a settings pin (codex, cursor, gemini, opencode) names the
// store as a prefix of each command and never advises `export LANEBOARD_DIR`: exported, the shell's other projects (and Codex, whose
// global entry forwards LANEBOARD_DIR) write to this board. A block of an earlier version with that advice is still laneboard's and
// is rewritten without it.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTemp, cli, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

const BLOCK_FILE: Record<string, string> = { codex: 'AGENTS.md', cursor: 'AGENTS.md', gemini: 'GEMINI.md', opencode: 'AGENTS.md' };

// A temp project with a board and a temp HOME; `run` is the CLI there.
async function project(): Promise<{ cwd: string; run: (argv: string[]) => ReturnType<typeof cli> }> {
  const cwd = tempDir();
  const home = tempDir();
  const run = (argv: string[]): ReturnType<typeof cli> => cli(argv, { cwd, env: { HOME: home } });
  expect((await run(['init', '--description', 'test board', '--prefix', 'LB'])).code).toBe(0);
  return { cwd, run };
}

describe('S6v C-U3: no "export LANEBOARD_DIR" in the instruction blocks', () => {
  for (const harness of Object.keys(BLOCK_FILE)) {
    it(`setup ${harness}: the store as a prefix of each command, never exported`, async () => {
      const p = await project();
      expect((await p.run(['setup', harness])).code).toBe(0);
      const block = fs.readFileSync(path.join(p.cwd, BLOCK_FILE[harness] ?? ''), 'utf8');
      expect(block).toContain(`\`LANEBOARD_DIR=${p.cwd}/.laneboard laneboard <command>\` (a prefix of each command; never export it: other projects of the shell would write to this board).`);
      expect(block).not.toContain('export LANEBOARD_DIR');
    });
  }

  it('setup codex says how to start Codex for this project: its folder or LANEBOARD_DIR=<board> codex for one run, never export', async () => {
    const p = await project();
    const r = await p.run(['setup', 'codex']);
    expect(r.stdout).toContain('next: the Codex config.toml is a global file: the laneboard MCP server is on in every Codex project; start Codex in this project folder (or LANEBOARD_DIR=<board> codex for one run), never export LANEBOARD_DIR\n');
  });

  it('an AGENTS.md block of 0.3.1 with "export ... once" is laneboard\'s: setup codex rewrites it without the export', async () => {
    const p = await project();
    const old = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'blocks', '0.3.1-AGENTS.inline.md'), 'utf8');
    fs.writeFileSync(path.join(p.cwd, 'AGENTS.md'), `# Project rules\n\n${old}`);
    const r = await p.run(['setup', 'codex', '--json']);
    expect(r.code).toBe(0);
    const text = fs.readFileSync(path.join(p.cwd, 'AGENTS.md'), 'utf8');
    expect(text.startsWith('# Project rules\n\n<!-- laneboard:start -->\n')).toBe(true);
    expect(text).not.toContain('export LANEBOARD_DIR');
    expect(text).toContain('never export it');
  });
});
