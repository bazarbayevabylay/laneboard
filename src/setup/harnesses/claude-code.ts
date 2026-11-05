// Claude Code: .mcp.json, CLAUDE.md block, in .claude/settings.json the SessionStart hook and the PostToolUse edit reminder, and the
// store pin plus the default agent name as `env` (LANEBOARD_DIR, LANEBOARD_DEFAULT_AGENT): code.claude.com/docs/en/mcp, /hooks,
// /memory, /settings (`env` is set "for every session and its subprocesses").
// The env goes into .claude/settings.local.json (no machine path is committed) when Claude Code reads that file from this folder:
// the folder is the root of its own git repository, or there is no repository (or it is the home directory). In a folder inside
// another repository Claude Code reads the local file at the repository root, and that file wins over the folder's own settings
// (code.claude.com/docs/en/settings, "Where Claude Code keeps the local file", "Settings precedence"): there the env stays in
// .claude/settings.json, and a repository root that holds other boards keeps its env in settings.json too, so its pin never reaches them.
// A local file setup writes is kept out of git by the marked block in the repository's .git/info/exclude (git-exclude.ts; Claude Code
// itself only excludes the file when it writes it first).
// A pin an earlier setup wrote (both env keys) to a path that holds no store any more (the project folder was moved or renamed) is
// replaced with this project's store; any other LANEBOARD_DIR that names another store is the user's and never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { defaultAgentBase, isLiveBoard, LaneboardError, readRegistry, samePath, storeState } from '../../core/index.ts';
import { readText } from '../files.ts';
import type { TextEdit } from '../files.ts';
import { jsonEdit, jsonEdits, jsonValueAt } from '../json-key.ts';
import type { JsonOwned } from '../json-key.ts';
import { blockEdit, MD_MARKERS } from '../md-block.ts';
import { EDIT_HOOK_COMMAND, EDIT_HOOK_MATCHER, instructionLines, MCP_ARGS, MCP_COMMAND, PRIME_HOOK_COMMAND, shellWord } from './common.ts';
import type { Harness, HarnessContext } from './common.ts';
import { gitExclude, gitRoot } from './git-exclude.ts';

const SETTINGS = '.claude/settings.json';
const LOCAL_SETTINGS = '.claude/settings.local.json';
const ENV_DIR = ['env', 'LANEBOARD_DIR'];
const ENV_AGENT = ['env', 'LANEBOARD_DEFAULT_AGENT'];

// Does this matcher group run `command` (so it is ours)?
function runs(command: string): (entry: unknown) => boolean {
  return (entry) => {
    const hooks = (entry as { hooks?: unknown } | null)?.hooks;
    return Array.isArray(hooks) && hooks.some((h) => (h as { command?: unknown } | null)?.command === command);
  };
}

const HOOK_PARTS: JsonOwned[] = [
  {
    kind: 'entry',
    path: ['hooks', 'SessionStart'],
    value: { matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: PRIME_HOOK_COMMAND }] },
    match: runs(PRIME_HOOK_COMMAND),
  },
  {
    kind: 'entry',
    path: ['hooks', 'PostToolUse'],
    value: { matcher: EDIT_HOOK_MATCHER, hooks: [{ type: 'command', command: EDIT_HOOK_COMMAND }] },
    match: runs(EDIT_HOOK_COMMAND),
  },
];

// The env keys with any value (for strip and owns; the value does not matter there).
const ENV_KEYS: JsonOwned[] = [
  { kind: 'key', path: ENV_DIR, value: '' },
  { kind: 'key', path: ENV_AGENT, value: '' },
];

// Does Claude Code read .claude/settings.local.json from this folder (so the env can live there)?
export function localSettingsHere(c: HarnessContext): boolean {
  const root = gitRoot(c.cwd);
  if (root === undefined || samePath(root, c.home)) return true;
  // A worktree or submodule has a `.git` file: Claude Code uses the main checkout's local file then.
  return root === c.cwd && fs.statSync(path.join(root, '.git')).isDirectory();
}

// Another live board of the machine registry inside this folder (a nested project): every session in it would get our pin
// from a local file at a repository root, so the env must not go there.
function nestedBoard(c: HarnessContext): string | undefined {
  let entries: Array<{ path: string }>;
  try {
    entries = readRegistry(c.home);
  } catch {
    // A broken registry is reported when setup registers the board; here it only means "no nested board known".
    return undefined;
  }
  return entries.map((e) => e.path).find((p) => p !== c.storeDir && !path.relative(c.cwd, p).startsWith('..') && isLiveBoard(p));
}

// Where setup writes the env: the local file when Claude Code reads it from this folder and, at a repository root, no other board
// lives inside the repository; else .claude/settings.json.
export function envInLocalFile(c: HarnessContext): boolean {
  if (!localSettingsHere(c)) return false;
  // Outside a repository, or with the home directory as its root, Claude Code reads the local file of the session folder only.
  const root = gitRoot(c.cwd);
  return root !== c.cwd || samePath(root, c.home) || nestedBoard(c) === undefined;
}

// SETUP_CONFLICT when the repository root's local file pins another store: Claude Code applies it to every session in the
// repository above this folder's .claude/settings.json, so a pin written here would never take effect.
function checkRootPin(c: HarnessContext): void {
  const root = gitRoot(c.cwd);
  if (root === undefined || root === c.cwd || samePath(root, c.home)) return;
  const file = path.join(root, LOCAL_SETTINGS);
  const dir = envString(readText(file), ENV_DIR);
  if (dir === undefined || samePath(path.resolve(c.cwd, dir), c.storeDir)) return;
  // init by --dir: a bare one makes <cwd>/.laneboard only, and is refused in a package of a repository whose board lies above.
  const init = isLiveBoard(c.storeDir) ? '' : `laneboard init --dir ${shellWord(c.storeDir)} --name <name> --description "<whose project, what work>" && `;
  throw new LaneboardError(
    'SETUP_CONFLICT',
    `${file} sets env.LANEBOARD_DIR to ${dir}; Claude Code reads that file in every folder of the repository and it wins over ${SETTINGS} here, so sessions in this folder would use ${dir}, not ${c.storeDir}; nothing was written`,
    {
      details: { file, value: dir },
      // Setup at the root moves its env into its settings.json once this folder's board is in the registry (setup here registers
      // a live board when it refuses with this error; the init of the fix registers a new one).
      fix: `${init}cd ${shellWord(root)} && laneboard setup claude-code && cd ${shellWord(c.cwd)} && laneboard setup claude-code`,
    },
  );
}

// A string value at an env key of a settings text.
function envString(text: string | null, keys: string[]): string | undefined {
  const value = jsonValueAt(text, keys);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// The pin of a settings text when an earlier setup wrote it (both env keys: setup writes them together) and it leads to no store any
// more (the project folder was moved or renamed, lifecycle F1): setup replaces it instead of refusing. Else undefined.
export function stalePin(text: string | null, c: HarnessContext): string | undefined {
  const dir = envString(text, ENV_DIR);
  if (dir === undefined || envString(text, ENV_AGENT) === undefined) return undefined;
  const pinned = path.resolve(c.cwd, dir);
  return samePath(pinned, c.storeDir) || storeState(pinned) !== 'missing' ? undefined : dir;
}

// SETUP_CONFLICT when the file already pins another store: the user's own LANEBOARD_DIR is never overwritten. `replacing`: the file
// gets our env, so a stale pin of an earlier setup (stalePin) is no conflict there.
function checkPin(file: string, text: string | null, c: HarnessContext, replacing: boolean): void {
  const dir = envString(text, ENV_DIR);
  if (dir === undefined || samePath(path.resolve(c.cwd, dir), c.storeDir)) return;
  if (replacing && stalePin(text, c) !== undefined) return;
  throw new LaneboardError('SETUP_CONFLICT', `${file} sets env.LANEBOARD_DIR to ${dir}, not to ${c.storeDir}; setup does not overwrite your value`, {
    details: { file, value: dir },
    fix: `laneboard setup claude-code --dir ${shellWord(dir)}`,
  });
}

// Our env parts for this text: the pin (the user's equal spelling kept, a stale one replaced) and the default agent name (a value
// already there is kept).
function envParts(file: string, text: string | null, c: HarnessContext): JsonOwned[] {
  checkPin(file, text, c, true);
  const kept = stalePin(text, c) === undefined ? envString(text, ENV_DIR) : undefined;
  return [
    { kind: 'key', path: ENV_DIR, value: kept ?? c.storeDir },
    { kind: 'key', path: ENV_AGENT, value: envString(text, ENV_AGENT) ?? defaultAgentBase('claude-code', c.env) },
  ];
}

// Edit of a settings file: the hooks and/or the env; `guard` also refuses another store pinned in a file we do not write env to.
function settingsEdit(file: string, c: HarnessContext, parts: { hooks: boolean; env: boolean }): TextEdit {
  const owned = [...(parts.hooks ? HOOK_PARTS : []), ...(parts.env ? ENV_KEYS : [])];
  const any = jsonEdits(file, owned);
  const hooksOnly = jsonEdits(file, HOOK_PARTS);
  const bothEnv = ENV_KEYS.map((k) => jsonEdits(file, [k]));
  return {
    add(text) {
      if (!parts.env) checkPin(file, text, c, false);
      if (parts.env && parts.hooks) checkRootPin(c);
      return jsonEdits(file, [...(parts.hooks ? HOOK_PARTS : []), ...(parts.env ? envParts(file, text, c) : [])]).add(text);
    },
    strip: (text) => any.strip(text),
    owns: (text) => any.owns(text),
    // The hooks are only ever written by laneboard; env values alone may be the user's (both keys together are setup's).
    ownsExclusive: (text) => (parts.hooks ? hooksOnly.owns(text) : bothEnv.every((e) => e.owns(text))),
    same: (a, b) => any.same(a, b),
    isEmpty: (text) => any.isEmpty(text),
  };
}

// What setup does with a stale pin of an earlier setup in the file that gets the env (read before the write): it is replaced, and the
// registry entry of the store it named stays as missing until `laneboard boards --forget` drops it.
function stalePinWarnings(c: HarnessContext): string[] {
  const shown = envInLocalFile(c) ? LOCAL_SETTINGS : SETTINGS;
  const dir = stalePin(readText(path.join(c.cwd, shown)), c);
  if (dir === undefined) return [];
  const old = path.resolve(c.cwd, dir);
  const head = `${shown} pinned LANEBOARD_DIR=${dir}, which holds no store any more (the project folder was moved or renamed?), so setup pins ${c.storeDir} there instead`;
  return [registered(c, old) ? `${head}; laneboard boards --forget ${shellWord(old)} drops the old path from the machine registry` : head];
}

// Is this path in the machine registry? A registry that cannot be read says no (setup reports it when it registers the board).
function registered(c: HarnessContext, dir: string): boolean {
  try {
    return readRegistry(c.home).some((e) => samePath(e.path, dir));
  } catch {
    // Broken or unreadable: the warning just leaves out the forget command.
    return false;
  }
}

// Plugins root: CLAUDE_CODE_PLUGIN_CACHE_DIR, else <CLAUDE_CONFIG_DIR or ~/.claude>/plugins (code.claude.com/docs/en/env-vars).
function pluginsRoot(c: HarnessContext): string {
  if (c.env.CLAUDE_CODE_PLUGIN_CACHE_DIR) return c.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  return path.join(c.env.CLAUDE_CONFIG_DIR || path.join(c.home, '.claude'), 'plugins');
}

// Installed copies of the laneboard plugin: cache/<marketplace>/laneboard (code.claude.com/docs/en/plugins/loading).
function installedPlugin(c: HarnessContext): string | undefined {
  const cache = path.join(pluginsRoot(c), 'cache');
  let marketplaces: string[];
  try {
    marketplaces = fs.readdirSync(cache);
  } catch {
    // No plugin cache: the plugin is not installed.
    return undefined;
  }
  return marketplaces.map((m) => path.join(cache, m, 'laneboard')).find((dir) => fs.existsSync(dir));
}

export const claudeCode: Harness = {
  name: 'claude-code',
  files: [
    { path: '.mcp.json', scope: 'project', edit: (f) => jsonEdit(f, { kind: 'key', path: ['mcpServers', 'laneboard'], value: { command: MCP_COMMAND, args: [...MCP_ARGS] } }) },
    {
      path: 'CLAUDE.md',
      scope: 'project',
      edit: (f, c) => blockEdit(f, MD_MARKERS, instructionLines(c.storeDir, envInLocalFile(c) ? 'settings-local-env' : 'settings-env')),
    },
    // Hooks always; the env too when it does not go to the local file.
    { path: SETTINGS, scope: 'project', edit: (f, c) => settingsEdit(f, c, { hooks: true, env: !envInLocalFile(c) }) },
    { path: LOCAL_SETTINGS, scope: 'project', edit: (f, c) => settingsEdit(f, c, { hooks: false, env: true }), applies: envInLocalFile },
    // The local file, backups and folder markers stay out of git (the local file holds a machine path and the user's name).
    gitExclude,
  ],
  notes: ['start Claude Code in this directory and approve the project MCP server "laneboard" when asked'],
  warnings(c) {
    const dir = installedPlugin(c);
    const plugin = dir
      ? [`the laneboard Claude Code plugin is installed (${dir}); it registers the same MCP server and hook, so use one: uninstall the plugin or run laneboard setup claude-code --remove`]
      : [];
    return [...stalePinWarnings(c), ...plugin];
  },
};
