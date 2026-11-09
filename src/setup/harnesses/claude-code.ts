// Claude Code: .mcp.json (only with --mcp, or kept from an earlier setup: mcpWanted), CLAUDE.md block, in .claude/settings.json the SessionStart hook and the PostToolUse edit reminder, and the
// store pin plus the default agent name as `env` (LANEBOARD_DIR, LANEBOARD_DEFAULT_AGENT): code.claude.com/docs/en/mcp, /hooks,
// /memory, /settings (`env` is set "for every session and its subprocesses").
// The env goes into a .claude/settings.local.json (no machine path is committed) that Claude Code reads for sessions in this folder:
// this folder's own when it is the root of its own git repository, or there is no repository (or the home directory is its root); in a
// folder inside a repository (a package of a monorepo) or a linked worktree Claude Code reads the local file at the repository root
// (the main checkout's), and that file wins over the folder's own settings (code.claude.com/docs/en/settings, "Where Claude Code
// keeps the local file", "Settings precedence"). So the env goes to the root's local file when this folder is pinned to the
// repository's own board (S6s); a folder with a board of its own (or another store) there keeps its env in .claude/settings.json, and
// a repository root that holds other boards keeps its env in settings.json too, so its pin never reaches them.
// A local file setup writes is kept out of git by the marked block in the repository's .git/info/exclude (git-exclude.ts; Claude Code
// itself only excludes the file when it writes it first).
// A pin an earlier setup wrote (both env keys) to a path that holds no store any more (the project folder was moved or renamed) is
// replaced with this project's store; any other LANEBOARD_DIR that names another store is the user's and never overwritten. A pin of an
// earlier setup in .claude/settings.json (to this store, or a stale one) moves out of it when the env goes to a local file.
import fs from 'node:fs';
import path from 'node:path';
import { canonicalPath, defaultAgentBase, isLiveBoard, LaneboardError, linkedWorktree, readRegistry, repositoryCheckouts, samePath, storeState } from '../../core/index.ts';
import { readText } from '../files.ts';
import type { TextEdit } from '../files.ts';
import { jsonEdit, jsonEdits, jsonValueAt } from '../json-key.ts';
import type { JsonOwned } from '../json-key.ts';
import { blockEdit, MD_MARKERS } from '../md-block.ts';
import { EDIT_HOOK_COMMAND, EDIT_HOOK_MATCHER, instructionLines, MCP_ARGS, MCP_COMMAND, PRIME_HOOK_COMMAND, shellWord } from './common.ts';
import type { Harness, HarnessContext, StorePin } from './common.ts';
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

// The folder whose .claude/settings.local.json Claude Code reads for a session started in cwd: cwd itself outside a repository or
// with the home directory as the root, else the repository root (a `.git` directory), the main checkout for a linked worktree;
// undefined for a submodule or a worktree of a bare repository.
function localFolder(c: HarnessContext): string | undefined {
  const root = gitRoot(c.cwd);
  if (root === undefined || samePath(root, c.home)) return c.cwd;
  if (fs.statSync(path.join(root, '.git')).isDirectory()) return root;
  return linkedWorktree(c.cwd)?.main;
}

// Another live board of the machine registry inside `folder` or inside a linked worktree of its repository (a nested project, a
// worktree with a board of its own): every session there would get our pin from the local file of `folder`, so the env must not go there.
function nestedBoard(c: HarnessContext, folder: string): string | undefined {
  const areas = [folder, ...(repositoryCheckouts(folder)?.others ?? [])];
  let entries: Array<{ path: string }>;
  try {
    entries = readRegistry(c.home);
  } catch {
    // A broken registry is reported when setup registers the board; here it only means "no nested board known".
    return undefined;
  }
  // Paths compared with symlinks resolved: the registry may name a board through a link (/var vs /private/var on macOS).
  const real = areas.map(canonicalPath);
  return entries
    .map((e) => e.path)
    .find((p) => !samePath(p, c.storeDir) && real.some((a) => !path.relative(a, canonicalPath(p)).startsWith('..')) && isLiveBoard(p));
}

// The folder whose local file gets the env, or undefined for .claude/settings.json of cwd. This folder's local file: outside a
// repository, with the home directory as the root, or at a repository root that holds no other board. The repository root's (the main
// checkout's) local file: cwd is pinned to the board in that folder and no other board lives inside it (S6s).
export function envFolder(c: HarnessContext): string | undefined {
  const folder = localFolder(c);
  if (folder === undefined) return undefined;
  if (folder === c.cwd) {
    const root = gitRoot(c.cwd);
    return root !== c.cwd || samePath(folder, c.home) || nestedBoard(c, folder) === undefined ? folder : undefined;
  }
  return samePath(path.dirname(c.storeDir), folder) && nestedBoard(c, folder) === undefined ? folder : undefined;
}

// The local file Claude Code reads for cwd when it lies outside cwd (the repository root's, the main checkout's), else undefined. It
// is that file whether or not the env goes there: a pin an earlier setup wrote there must still be found when it no longer applies.
function rootLocalFile(c: HarnessContext): string | undefined {
  const folder = localFolder(c);
  return folder === undefined || samePath(folder, c.cwd) ? undefined : path.join(folder, LOCAL_SETTINGS);
}

// Does setup of Claude Code stand in `folder` (its .mcp.json, CLAUDE.md or .claude/settings.json holds our part)? A file that cannot be
// read or parsed counts as yes: that setup may still use the folder's local file.
function standsIn(c: HarnessContext, folder: string): boolean {
  const there: HarnessContext = { ...c, cwd: folder };
  return claudeCode.files
    .filter((f) => f.path !== LOCAL_SETTINGS && f.scope === 'project' && f !== gitExclude)
    .some((f) => {
      try {
        const text = readText(path.join(folder, f.path));
        return text !== null && f.edit(f.path, there).owns(text);
      } catch {
        // Unreadable or unparseable: it may hold our part, so the folder's local file is left alone.
        return true;
      }
    });
}

// A pin an earlier setup (both env keys) left in the repository root's local file that no longer applies there (S6s review r1): cwd
// does not get its env there (another board appeared in the repository, the store changed), the pin names the board at that root
// while another live board lies in the repository (setup in any package would now keep its env in its settings.json), and setup does
// not stand at the root itself. Such a pin is taken out on install and --remove (ADR §14: a file that no longer applies loses our part).
function leftRootPin(text: string | null, c: HarnessContext): boolean {
  const file = rootLocalFile(c);
  if (file === undefined || text === null || envFolder(c) !== undefined || !setupPin(file, text)) return false;
  const dir = envString(text, ENV_DIR);
  if (dir === undefined) return false;
  const root = path.dirname(path.dirname(file));
  const pinned = path.resolve(c.cwd, dir);
  if (!samePath(path.dirname(pinned), root) || nestedBoard({ ...c, storeDir: pinned }, root) === undefined) return false;
  return !standsIn(c, root);
}

// Edit of the local settings file: as settingsEdit with the env; the repository root's file that does not get the env holds our part
// only as a pin an earlier setup left there (leftRootPin), never the user's value or another folder's pin.
function localEdit(file: string, c: HarnessContext): TextEdit {
  const edit = settingsEdit(file, c, { hooks: false, env: true });
  if (envFolder(c) !== undefined || rootLocalFile(c) === undefined) return edit;
  const left = (text: string): boolean => leftRootPin(text, c);
  return {
    ...edit,
    strip: (text) => (left(text) ? edit.strip(text) : text),
    owns: (text) => left(text) && edit.owns(text),
    ownsExclusive: (text) => left(text) && (edit.ownsExclusive?.(text) ?? edit.owns(text)),
  };
}

// The file the env goes to (absolute).
function envFile(c: HarnessContext): string {
  const folder = envFolder(c);
  return path.join(c.cwd, folder === undefined ? SETTINGS : path.relative(c.cwd, path.join(folder, LOCAL_SETTINGS)));
}

// SETUP_CONFLICT when the repository root's (a linked worktree: the main checkout's) local file pins another store: Claude Code
// applies it to every session in the repository above this folder's .claude/settings.json, so a pin written here would never take
// effect. That file may hold the pin setup in another package wrote (S6s); setup at the root moves it.
function checkRootPin(c: HarnessContext): void {
  const root = localFolder(c);
  if (root === undefined || root === c.cwd) return;
  const file = path.join(root, LOCAL_SETTINGS);
  const text = readText(file);
  const dir = envString(text, ENV_DIR);
  if (dir === undefined || samePath(path.resolve(c.cwd, dir), c.storeDir)) return;
  // A pin an earlier setup left there that no longer applies: this run takes it out (localEdit), so it is no conflict.
  if (leftRootPin(text, c)) return;
  // init by --dir: a bare one makes <cwd>/.laneboard only, and is refused in a package of a repository whose board lies above.
  const init = isLiveBoard(c.storeDir) ? '' : `laneboard init --dir ${shellWord(c.storeDir)} --name <name> --description "<whose project, what work>" --json && `;
  throw new LaneboardError(
    'SETUP_CONFLICT',
    `${file} sets env.LANEBOARD_DIR to ${dir}; Claude Code reads that file in every folder of the repository and it wins over ${SETTINGS} here, so sessions in this folder would use ${dir}, not ${c.storeDir}; nothing was written`,
    {
      details: { file, value: dir },
      // Setup at the root moves its env into its settings.json once this folder's board is in the registry (setup here registers
      // a live board when it refuses with this error; the init of the fix registers a new one).
      fix: `${init}cd ${shellWord(root)} && laneboard setup claude-code --json && cd ${shellWord(c.cwd)} && laneboard setup claude-code --json`,
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
    fix: `laneboard setup claude-code --dir ${shellWord(dir)} --json`,
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

// Does a settings text hold a pin an earlier setup wrote (both env keys: setup writes them together)?
function setupPin(file: string, text: string): boolean {
  return ENV_KEYS.every((k) => jsonEdits(file, [k]).owns(text));
}

// The pin of an earlier setup in .claude/settings.json that moves to the local file (to this store, or a stale one), or undefined.
export function movingPin(text: string | null, c: HarnessContext): string | undefined {
  const dir = envString(text, ENV_DIR);
  if (text === null || dir === undefined || !setupPin(SETTINGS, text)) return undefined;
  return samePath(path.resolve(c.cwd, dir), c.storeDir) || stalePin(text, c) !== undefined ? dir : undefined;
}

// Edit of a settings file: the hooks and/or the env. Without the env (it goes to a local file) the hooks file loses a pin an earlier
// setup left there (movingPin) and refuses another store pinned in it; --remove takes such a pin out too.
function settingsEdit(file: string, c: HarnessContext, parts: { hooks: boolean; env: boolean }): TextEdit {
  const owned = [...(parts.hooks ? HOOK_PARTS : []), ...(parts.env ? ENV_KEYS : [])];
  const any = jsonEdits(file, owned);
  const hooksOnly = jsonEdits(file, HOOK_PARTS);
  const envOnly = jsonEdits(file, ENV_KEYS);
  const bothEnv = ENV_KEYS.map((k) => jsonEdits(file, [k]));
  const all = jsonEdits(file, [...HOOK_PARTS, ...ENV_KEYS]);
  if (parts.env) {
    return {
      add(text) {
        if (parts.hooks) checkRootPin(c);
        return jsonEdits(file, [...(parts.hooks ? HOOK_PARTS : []), ...envParts(file, text, c)]).add(text);
      },
      strip: (text) => any.strip(text),
      owns: (text) => any.owns(text),
      // The hooks are only ever written by laneboard; env values alone may be the user's (both keys together are setup's).
      ownsExclusive: (text) => (parts.hooks ? hooksOnly.owns(text) : bothEnv.every((e) => e.owns(text))),
      same: (a, b) => any.same(a, b),
      isEmpty: (text) => any.isEmpty(text),
    };
  }
  return {
    add(text) {
      const kept = text !== null && movingPin(text, c) !== undefined ? envOnly.strip(text) : text;
      checkPin(file, kept, c, false);
      return hooksOnly.add(kept);
    },
    strip(text) {
      const rest = hooksOnly.strip(text);
      return setupPin(file, rest) ? envOnly.strip(rest) : rest;
    },
    owns: (text) => hooksOnly.owns(text) || setupPin(file, text),
    ownsExclusive: (text) => hooksOnly.owns(text) || setupPin(file, text),
    same: (a, b) => all.same(a, b),
    isEmpty: (text) => all.isEmpty(text),
  };
}

// What setup does with a stale pin of an earlier setup in the file that gets the env (read before the write): it is replaced, and the
// registry entry of the store it named stays as missing until `laneboard boards --forget` drops it.
function stalePinWarnings(c: HarnessContext): string[] {
  const file = envFile(c);
  const shown = envFolder(c) === undefined ? SETTINGS : (rootLocalFile(c) ?? path.relative(c.cwd, file).split(path.sep).join('/'));
  const dir = stalePin(readText(file), c);
  if (dir === undefined) return [];
  const old = path.resolve(c.cwd, dir);
  const head = `${shown} pinned LANEBOARD_DIR=${dir}, which holds no store any more (the project folder was moved or renamed?), so setup pins ${c.storeDir} there instead`;
  return [registered(c, old) ? `${head}; laneboard boards --forget ${shellWord(old)} --json drops the old path from the machine registry` : head];
}

// A pin of an earlier setup in .claude/settings.json (committed) that this run moves to the local file: say so, the change to commit.
// A --dry-run moves nothing, so it says what setup would do (review C2).
function movedPinWarnings(c: HarnessContext): string[] {
  if (envFolder(c) === undefined) return [];
  const dir = movingPin(readText(path.join(c.cwd, SETTINGS)), c);
  if (dir === undefined) return [];
  const to = rootLocalFile(c) ?? LOCAL_SETTINGS;
  if (c.dryRun) {
    return [
      `${SETTINGS} holds the store pin of an earlier laneboard setup (LANEBOARD_DIR=${dir}, LANEBOARD_DEFAULT_AGENT), a machine path in a committed file; setup would move the env to ${to} (kept out of git) and leave the rest of ${SETTINGS} as it is: commit that change after setup`,
    ];
  }
  return [
    `${SETTINGS} held the store pin of an earlier laneboard setup (LANEBOARD_DIR=${dir}, LANEBOARD_DEFAULT_AGENT), a machine path in a committed file; setup moved the env to ${to} (kept out of git) and left the rest of ${SETTINGS} as it was: commit that change`,
  ];
}

// A pin an earlier setup left in the repository root's local file that this run takes out (leftRootPin): say so, and how the folders
// that relied on it get their pin back. A --dry-run takes nothing out, so it says what setup would do (review C2).
function leftPinWarnings(c: HarnessContext): string[] {
  const file = rootLocalFile(c);
  if (file === undefined) return [];
  const text = readText(file);
  if (!leftRootPin(text, c)) return [];
  const dir = envString(text, ENV_DIR) ?? '';
  const [held, took] = c.dryRun ? ['holds', 'would take it out'] : ['held', 'took it out'];
  return [
    `${file} ${held} the store pin of an earlier laneboard setup (LANEBOARD_DIR=${dir}) that no longer applies there: another board lies in this repository and Claude Code would give that pin to its sessions too; setup ${took}. Folders pinned to ${dir} find it by walking up; laneboard setup claude-code --json there pins it again`,
  ];
}

// The env goes to .claude/settings.json (envFolder undefined: always inside a git repository), a file git sees: a path of this machine
// and the user's name would be committed with the hooks (ADR §49). Say why and what to do, in one line (review S6r risk 1).
function committedPinWarnings(c: HarnessContext): string[] {
  if (envFolder(c) !== undefined) return [];
  const folder = localFolder(c);
  const other = folder === undefined ? undefined : nestedBoard(c, folder);
  const why =
    folder === undefined
      ? 'Claude Code reads no git-ignored local file of the repository here (a submodule or a worktree of a bare repository)'
      : !samePath(folder, c.cwd) && !samePath(path.dirname(c.storeDir), folder)
        ? `this folder's board is not the one at the repository root ${folder} (Claude Code would give a pin there to every folder of the repository)`
        : `another board lies in this repository${other === undefined ? '' : ` (${other})`}, so the repository root's local file cannot hold this pin`;
  return [
    `${SETTINGS} holds env LANEBOARD_DIR=${c.storeDir} and LANEBOARD_DEFAULT_AGENT (a path of this machine and your name) in a file git sees, because ${why}: commit ${SETTINGS} only knowingly (the hooks are shared, the env is yours), or keep one board per repository so setup keeps the env in the git-ignored ${LOCAL_SETTINGS}`,
  ];
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

// How the instruction block names the pin: the local file of this folder or of the repository root, or .claude/settings.json.
function storePin(c: HarnessContext): StorePin {
  const folder = envFolder(c);
  return folder === undefined ? 'settings-env' : folder === c.cwd ? 'settings-local-env' : 'settings-root-local-env';
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

const MCP_FILE = '.mcp.json';

// Edit of our MCP server entry in .mcp.json.
function mcpEdit(file: string): TextEdit {
  return jsonEdit(file, { kind: 'key', path: ['mcpServers', 'laneboard'], value: { command: MCP_COMMAND, args: [...MCP_ARGS] } });
}

// Does .mcp.json of cwd hold the laneboard server an earlier setup wrote? A file that cannot be read or parsed says no: setup without
// --mcp then leaves it alone, as it never needs it.
function mcpInstalled(c: HarnessContext): boolean {
  try {
    const text = readText(path.join(c.cwd, MCP_FILE));
    return text !== null && mcpEdit(MCP_FILE).owns(text);
  } catch {
    // Unreadable or unparseable: not ours to touch without --mcp.
    return false;
  }
}

// Is the MCP server part of this install? The hooks print the rules and the CLI commands with the agent's name, so the agent works
// through the CLI and the server only adds its instructions and tool names to every request (lb-tokens experiment: 2 MCP calls against
// 120 CLI calls in 30 runs, about 1.7k tokens per request). So: --mcp adds it, --no-mcp takes it out, by default a new install goes
// without it and an entry an earlier setup wrote stays (a warning says how to take it out).
export function mcpWanted(c: HarnessContext): boolean {
  return c.mcp ?? mcpInstalled(c);
}

// The entry of an earlier setup that the default install keeps: say what it costs and how to take it out.
function keptMcpWarnings(c: HarnessContext): string[] {
  if (c.mcp !== undefined || !mcpInstalled(c)) return [];
  const keeps = c.dryRun ? 'would keep' : 'kept';
  return [
    `${keeps} the laneboard MCP server of an earlier setup in ${MCP_FILE}: with the hooks the agent works through the CLI, and the server adds about 1.7k tokens to every request; laneboard setup claude-code --no-mcp --json takes it out (--mcp keeps it without this warning)`,
  ];
}

export const claudeCode: Harness = {
  name: 'claude-code',
  optionalMcp: true,
  files: [
    // The MCP server only with --mcp, or when an earlier setup wrote it (mcpWanted); --no-mcp and --remove take it out.
    { path: MCP_FILE, scope: 'project', edit: (f) => mcpEdit(f), applies: mcpWanted },
    {
      path: 'CLAUDE.md',
      scope: 'project',
      edit: (f, c) => blockEdit(f, MD_MARKERS, instructionLines(c.storeDir, storePin(c))),
    },
    // Hooks always; the env too when it does not go to a local file.
    { path: SETTINGS, scope: 'project', edit: (f, c) => settingsEdit(f, c, { hooks: true, env: envFolder(c) === undefined }) },
    // The local file of this folder, or the repository root's (moved there) when that one gets the env.
    {
      path: LOCAL_SETTINGS,
      scope: 'project',
      edit: (f, c) => localEdit(f, c),
      applies: (c) => envFolder(c) !== undefined,
      // The file Claude Code reads (localFolder), also when the env no longer goes there: a pin left there is found and taken out.
      moved: rootLocalFile,
      movedInto: localFolder,
    },
    // The local file, backups and folder markers stay out of git (the local file holds a machine path and the user's name).
    gitExclude,
  ],
  notes: (c) =>
    mcpWanted(c)
      ? ['start Claude Code in this directory and approve the project MCP server "laneboard" when asked']
      : ['start Claude Code in this directory: the SessionStart hook prints the rules and your tasks (laneboard setup claude-code --mcp --json adds the MCP server too)'],
  warnings(c) {
    const dir = installedPlugin(c);
    const plugin = dir
      ? [`the laneboard Claude Code plugin is installed (${dir}); it registers the same MCP server and hook, so use one: uninstall the plugin or run laneboard setup claude-code --remove --json`]
      : [];
    return [...stalePinWarnings(c), ...movedPinWarnings(c), ...leftPinWarnings(c), ...committedPinWarnings(c), ...keptMcpWarnings(c), ...plugin];
  },
};
