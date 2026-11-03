// What every harness recipe shares: the MCP launch command, the instruction block, the file plan shape.
import type { TextEdit } from '../files.ts';

export const MCP_COMMAND = 'laneboard';
export const MCP_ARGS = ['mcp'] as const;

// SessionStart hook command (Claude Code): prints the rules and the agent's tasks; a hint when the CLI is missing.
export const PRIME_HOOK_COMMAND = "command -v laneboard >/dev/null 2>&1 && laneboard prime --hook || echo 'laneboard CLI missing: npm i -g laneboard'";

// Instruction block body (3 lines) for CLAUDE.md / AGENTS.md / GEMINI.md.
export const INSTRUCTION_LINES = [
  'This project tracks tasks with laneboard (task board & CLI for AI coding agents; the store is .laneboard/).',
  'Before you work on tasks, run `laneboard prime` and follow the rules it prints.',
  'Writes need your name: `export LANEBOARD_AGENT=<your-name>` or pass `--as <your-name>`.',
].join('\n');

export interface HarnessContext {
  cwd: string;
  home: string;
  env: Record<string, string | undefined>;
}

export interface HarnessFile {
  // Path relative to the project (cwd) or to home.
  path: string;
  scope: 'project' | 'global';
  edit: (shown: string) => TextEdit;
  // Absolute path the harness itself reads instead, when its environment moves the file (e.g. CODEX_HOME).
  moved?: (c: HarnessContext) => string | undefined;
}

export interface Harness {
  name: string;
  files: HarnessFile[];
  // Notes printed after a successful install (what the user still has to do).
  notes: string[];
  // Warnings that depend on the machine (e.g. the plugin is installed too).
  warnings?: (c: HarnessContext) => string[];
}
