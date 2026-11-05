// What every harness recipe shares: the MCP launch command, the instruction block, the file plan shape.
import { shellQuote } from '../../core/index.ts';
import type { TextEdit } from '../files.ts';

export const MCP_COMMAND = 'laneboard';
export const MCP_ARGS = ['mcp'] as const;

// MCP args pinned to the project's store, for harnesses whose MCP entry lives in a project file (cursor, gemini, opencode):
// the server then never discovers a store from wherever the harness starts it.
export function pinnedMcpArgs(storeDir: string): string[] {
  return [...MCP_ARGS, '--dir', storeDir];
}

// Environment variables the global Codex entry forwards to the server (`env_vars`): a global file cannot name one project's store,
// but a LANEBOARD_DIR exported for the session (as the AGENTS.md block says) then reaches the MCP server too.
export const CODEX_ENV_VARS = ['LANEBOARD_DIR'] as const;

// SessionStart hook command (Claude Code): prints the rules and the agent's tasks; a hint when the CLI is missing.
export const PRIME_HOOK_COMMAND = "command -v laneboard >/dev/null 2>&1 && laneboard prime --hook || echo 'laneboard CLI missing: npm i -g laneboard'";

// PostToolUse hook command (Claude Code) after a file edit tool: a reminder when no task is in progress; silent and exit 0 otherwise or on any failure.
export const EDIT_HOOK_COMMAND = 'command -v laneboard >/dev/null 2>&1 && laneboard prime --edit-hook 2>/dev/null; exit 0';

// Tools the edit reminder follows (exact names, code.claude.com/docs/en/hooks matcher syntax): every file edit tool, notebooks too
// (MultiEdit in the Claude Code versions that have it; an unknown name in the list matches nothing). Edits through Bash are not seen.
export const EDIT_HOOK_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

// A path as one shell word (single-quoted when it holds anything but safe characters).
export function shellWord(value: string): string {
  return shellQuote(value);
}

// The task rule every instruction block carries: weak models skip optional-sounding advice, so it says MANDATORY and when it applies.
const TASK_RULE =
  'MANDATORY for every request, even when nobody mentions tasks and the board is empty: before your first file change, run `laneboard prime` and claim your task or create one (prime prints the command); ' +
  'comment each meaningful step; when done: commit, then `laneboard finish <ID> --result "<result>" --json` (one write: the result, the commit link, the status). No untracked work.';

const NAME_LINE = 'Writes need your name: pass `--as <your-name>` on every command (or `export LANEBOARD_AGENT=<your-name>`).';

// Claude Code sets a default name per session (LANEBOARD_DEFAULT_AGENT plus the session id), so an agent without a name still writes as itself.
const DEFAULT_NAME_LINE =
  'Without `--as` your writes use this session\'s default name (`laneboard prime` shows it); subagents and parallel workers of one session pass their own `--as <name>`.';

// How the block pins the store: Claude Code reads LANEBOARD_DIR from .claude/settings.local.json (not committed) of this folder or
// of the repository root (a package of a repository, a linked worktree, pinned to the repository's board), or from
// .claude/settings.json (a folder inside another repository with a board of its own); other harnesses get it inline.
export type StorePin = 'settings-local-env' | 'settings-root-local-env' | 'settings-env' | 'inline';

// Instruction block body (3 lines) for CLAUDE.md / AGENTS.md / GEMINI.md: what laneboard is and which store, the task rule, the name.
export function instructionLines(storeDir: string, pin: StorePin): string {
  const where =
    pin === 'settings-local-env'
      ? 'Its store is pinned by LANEBOARD_DIR in .claude/settings.local.json (kept out of git; `laneboard prime` shows the path).'
      : pin === 'settings-root-local-env'
        ? 'Its store is pinned by LANEBOARD_DIR in .claude/settings.local.json at the root of this git repository (kept out of git; `laneboard prime` shows the path).'
        : pin === 'settings-env'
        ? `Its store is ${storeDir} (LANEBOARD_DIR is set for this project in .claude/settings.json).`
        : `Its store is ${storeDir}: run every laneboard command with it, \`LANEBOARD_DIR=${shellWord(storeDir)} laneboard <command>\` (or export LANEBOARD_DIR=${shellWord(storeDir)} once).`;
  return [`This project tracks work with laneboard (task board & CLI for AI coding agents). ${where}`, TASK_RULE, pin === 'inline' ? NAME_LINE : DEFAULT_NAME_LINE].join('\n');
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
  // Install writes this file only when true (default always); --remove looks at it either way.
  applies?: (c: HarnessContext) => boolean;
  // A moved project file outside the project: the folder its path must stay in (no symlink on the way leads out of it); setup may
  // create and later delete the folders below it. Default: the moved file's own folder, which is never deleted.
  movedInto?: (c: HarnessContext) => string | undefined;
}

export interface Harness {
  name: string;
  files: HarnessFile[];
  // Notes printed after a successful install (what the user still has to do).
  notes: string[];
  // Warnings that depend on the machine (e.g. the plugin is installed too).
  warnings?: (c: HarnessContext) => string[];
}
