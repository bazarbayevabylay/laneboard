// Claude Code: .mcp.json, CLAUDE.md block, SessionStart hook in .claude/settings.json (code.claude.com/docs/en/mcp, /hooks, /memory).
import fs from 'node:fs';
import path from 'node:path';
import { jsonEdit } from '../json-key.ts';
import { blockEdit, MD_MARKERS } from '../md-block.ts';
import { INSTRUCTION_LINES, MCP_ARGS, MCP_COMMAND, PRIME_HOOK_COMMAND } from './common.ts';
import type { Harness, HarnessContext } from './common.ts';

// Is this SessionStart matcher group ours (it runs our hook command)?
function isPrimeHook(entry: unknown): boolean {
  const hooks = (entry as { hooks?: unknown } | null)?.hooks;
  return Array.isArray(hooks) && hooks.some((h) => (h as { command?: unknown } | null)?.command === PRIME_HOOK_COMMAND);
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
    { path: 'CLAUDE.md', scope: 'project', edit: (f) => blockEdit(f, MD_MARKERS, INSTRUCTION_LINES) },
    {
      path: '.claude/settings.json',
      scope: 'project',
      edit: (f) =>
        jsonEdit(f, {
          kind: 'entry',
          path: ['hooks', 'SessionStart'],
          value: { matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: PRIME_HOOK_COMMAND }] },
          match: isPrimeHook,
        }),
    },
  ],
  notes: ['start Claude Code in this directory and approve the project MCP server "laneboard" when asked'],
  warnings(c) {
    const dir = installedPlugin(c);
    return dir
      ? [`the laneboard Claude Code plugin is installed (${dir}); it registers the same MCP server and hook, so use one: uninstall the plugin or run laneboard setup claude-code --remove`]
      : [];
  },
};
