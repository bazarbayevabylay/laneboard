// Claude Code: .mcp.json, CLAUDE.md block, in .claude/settings.json the SessionStart hook and the PostToolUse edit reminder, and the
// store pin plus the default agent name as `env` (LANEBOARD_DIR, LANEBOARD_DEFAULT_AGENT): code.claude.com/docs/en/mcp, /hooks,
// /memory, /settings (`env` is set "for every session and its subprocesses").
// The env goes into .claude/settings.local.json (kept out of git, so no machine path is committed) when Claude Code reads that file
// from this folder: the folder is the root of its own git repository, or there is no repository (or it is the home directory).
// In a folder inside another repository Claude Code reads the local file at the repository root, which would pin the parent's store,
// so there the env stays in .claude/settings.json (code.claude.com/docs/en/settings, "Where Claude Code keeps the local file").
import fs from 'node:fs';
import path from 'node:path';
import { defaultAgentBase, LaneboardError } from '../../core/index.ts';
import type { TextEdit } from '../files.ts';
import { jsonEdit, jsonEdits, jsonValueAt } from '../json-key.ts';
import type { JsonOwned } from '../json-key.ts';
import { blockEdit, MD_MARKERS } from '../md-block.ts';
import { EDIT_HOOK_COMMAND, EDIT_HOOK_MATCHER, instructionLines, MCP_ARGS, MCP_COMMAND, PRIME_HOOK_COMMAND } from './common.ts';
import type { Harness, HarnessContext } from './common.ts';

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

// Closest folder from cwd up that holds `.git`, or undefined.
function gitRoot(cwd: string): string | undefined {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

// Does Claude Code read .claude/settings.local.json from this folder (so the env can live there)?
export function localSettingsHere(c: HarnessContext): boolean {
  const root = gitRoot(c.cwd);
  if (root === undefined || root === c.home) return true;
  // A worktree or submodule has a `.git` file: Claude Code uses the main checkout's local file then.
  return root === c.cwd && fs.statSync(path.join(root, '.git')).isDirectory();
}

// A string value at an env key of a settings text.
function envString(text: string | null, keys: string[]): string | undefined {
  const value = jsonValueAt(text, keys);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// SETUP_CONFLICT when the file already pins another store: the user's own LANEBOARD_DIR is never overwritten.
function checkPin(file: string, text: string | null, c: HarnessContext): void {
  const dir = envString(text, ENV_DIR);
  if (dir === undefined || path.resolve(c.cwd, dir) === c.storeDir) return;
  throw new LaneboardError('SETUP_CONFLICT', `${file} sets env.LANEBOARD_DIR to ${dir}, not to ${c.storeDir}; setup does not overwrite your value`, {
    details: { file, value: dir },
    fix: `laneboard setup claude-code --dir ${dir}`,
  });
}

// Our env parts for this text: the pin (the user's equal spelling kept) and the default agent name (a value already there is kept).
function envParts(file: string, text: string | null, c: HarnessContext): JsonOwned[] {
  checkPin(file, text, c);
  return [
    { kind: 'key', path: ENV_DIR, value: envString(text, ENV_DIR) ?? c.storeDir },
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
      if (!parts.env) checkPin(file, text, c);
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
      edit: (f, c) => blockEdit(f, MD_MARKERS, instructionLines(c.storeDir, localSettingsHere(c) ? 'settings-local-env' : 'settings-env')),
    },
    // Hooks always; the env too when the local file is not read from this folder.
    { path: SETTINGS, scope: 'project', edit: (f, c) => settingsEdit(f, c, { hooks: true, env: !localSettingsHere(c) }) },
    { path: LOCAL_SETTINGS, scope: 'project', edit: (f, c) => settingsEdit(f, c, { hooks: false, env: true }), applies: localSettingsHere },
  ],
  notes: ['start Claude Code in this directory and approve the project MCP server "laneboard" when asked'],
  warnings(c) {
    const dir = installedPlugin(c);
    return dir
      ? [`the laneboard Claude Code plugin is installed (${dir}); it registers the same MCP server and hook, so use one: uninstall the plugin or run laneboard setup claude-code --remove`]
      : [];
  },
};
