// What every harness recipe shares: the MCP launch command, the instruction block, the file plan shape.
import type { TextEdit } from '../files.ts';

export const MCP_COMMAND = 'laneboard';
export const MCP_ARGS = ['mcp'] as const;

// SessionStart hook command (Claude Code): prints the rules and the agent's tasks; a hint when the CLI is missing.
export const PRIME_HOOK_COMMAND = "command -v laneboard >/dev/null 2>&1 && laneboard prime --hook || echo 'laneboard CLI missing: npm i -g laneboard'";

// PostToolUse hook command (Claude Code) after Edit/Write: a reminder when no task is in progress; silent and exit 0 otherwise or on any failure.
export const EDIT_HOOK_COMMAND = 'command -v laneboard >/dev/null 2>&1 && laneboard prime --edit-hook 2>/dev/null; exit 0';

// Tools the edit reminder follows (exact names, code.claude.com/docs/en/hooks matcher syntax).
export const EDIT_HOOK_MATCHER = 'Edit|Write';

// A path as one shell word (single-quoted when it holds anything but safe characters).
function shellWord(value: string): string {
  return /^[A-Za-z0-9_\-.,:/=@+%]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

// The task rule every instruction block carries: weak models skip optional-sounding advice, so it says MANDATORY and when it applies.
const TASK_RULE =
  'MANDATORY for every request, even when nobody mentions tasks and the board is empty: before your first file change, run `laneboard prime` and claim your task or create one (prime prints the command); ' +
  'comment each meaningful step; when done, set the final status and add a result comment. No untracked work.';

const NAME_LINE = 'Writes need your name: pass `--as <your-name>` on every command (or `export LANEBOARD_AGENT=<your-name>`).';

// How the block pins the store: Claude Code reads LANEBOARD_DIR from .claude/settings.json; other harnesses get it inline.
export type StorePin = 'settings-env' | 'inline';

// Instruction block body (3 lines) for CLAUDE.md / AGENTS.md / GEMINI.md: what laneboard is and which store, the task rule, the name.
export function instructionLines(storeDir: string, pin: StorePin): string {
  const where =
    pin === 'settings-env'
      ? `Its store is ${storeDir} (LANEBOARD_DIR is set for this project in .claude/settings.json).`
      : `Its store is ${storeDir}: run every laneboard command with it, \`LANEBOARD_DIR=${shellWord(storeDir)} laneboard <command>\` (or export LANEBOARD_DIR=${shellWord(storeDir)} once).`;
  return [`This project tracks work with laneboard (task board & CLI for AI coding agents). ${where}`, TASK_RULE, NAME_LINE].join('\n');
}

export interface HarnessContext {
  cwd: string;
  home: string;
  // Absolute path of the store this project is pinned to.
  storeDir: string;
  env: Record<string, string | undefined>;
}

export interface HarnessFile {
  // Path relative to the project (cwd) or to home.
  path: string;
  scope: 'project' | 'global';
  edit: (shown: string, c: HarnessContext) => TextEdit;
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
