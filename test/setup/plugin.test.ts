// Claude Code plugin and marketplace: shapes from code.claude.com/docs/en/plugins (manifest, marketplace, components),
// versions in sync with package.json, skill = agent rules (one source), hook and MCP entry = what `setup claude-code` writes.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentRules, skillMarkdown } from '../../src/core/index.ts';
import { PRIME_HOOK_COMMAND } from '../../src/setup/index.ts';
import { REPO } from '../helpers.ts';

const PLUGIN = path.join(REPO, 'plugins', 'claude-code');
const json = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('agent rules (src/core/agent-rules.md)', () => {
  it('at most 15 numbered rules, the dash rule included, fit the 4096-char MCP instructions limit', () => {
    const rules = agentRules();
    const numbered = rules.split('\n').filter((l) => /^\d+\. /.test(l));
    expect(numbered.length).toBeGreaterThan(0);
    expect(numbered.length).toBeLessThanOrEqual(15);
    expect(numbered.map((l) => Number(l.split('.')[0]))).toEqual(numbered.map((_, i) => i + 1));
    expect(rules).toContain('Text starting with "-"');
    expect(rules).toContain('-- "- item"');
    expect(rules.length).toBeLessThanOrEqual(4096);
  });
});

describe('Claude Code plugin', () => {
  it('marketplace.json lists the plugin by a relative source inside the repo', () => {
    const m = json(path.join(REPO, '.claude-plugin', 'marketplace.json'));
    expect(m).toMatchObject({ name: 'laneboard', owner: { name: expect.any(String) } });
    const entries = m.plugins as Array<{ name: string; source: string; description: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'laneboard', source: './plugins/claude-code' });
    expect(fs.existsSync(path.join(REPO, entries[0]?.source ?? '', '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('plugin.json: name laneboard, version = package.json version', () => {
    const p = json(path.join(PLUGIN, '.claude-plugin', 'plugin.json'));
    const pkg = json(path.join(REPO, 'package.json'));
    expect(p).toMatchObject({ name: 'laneboard', version: pkg.version, license: 'MIT', author: { name: expect.any(String) } });
  });

  it('.mcp.json starts `laneboard mcp`; the SessionStart hook runs the same command setup writes', () => {
    expect(json(path.join(PLUGIN, '.mcp.json'))).toEqual({ mcpServers: { laneboard: { command: 'laneboard', args: ['mcp'] } } });
    expect(json(path.join(PLUGIN, 'hooks', 'hooks.json'))).toEqual({
      hooks: { SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: PRIME_HOOK_COMMAND }] }] },
    });
  });

  it('the hook prints a hint when the CLI is missing, and exits 0', () => {
    const r = spawnSync('/bin/sh', ['-c', PRIME_HOOK_COMMAND], { env: { PATH: '/nonexistent' }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('laneboard CLI missing: npm i -g laneboard\n');
  });

  it('SKILL.md is generated from the agent rules (npm run gen:skill)', () => {
    const skill = fs.readFileSync(path.join(PLUGIN, 'skills', 'laneboard', 'SKILL.md'), 'utf8');
    expect(skill).toBe(skillMarkdown());
    expect(skill.endsWith(`${agentRules()}\n`)).toBe(true);
    const front = /^---\nname: laneboard\ndescription: (".*")\n---\n/.exec(skill);
    expect(front).not.toBeNull();
    const description = JSON.parse(front?.[1] ?? '""') as string;
    expect(description).not.toMatch(/[<>]/);
    expect(description.length).toBeLessThanOrEqual(1536);
    const check = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'gen-skill.ts'), '--check'], { cwd: REPO, encoding: 'utf8' });
    expect(check.status, check.stderr).toBe(0);
  });

  it('every file the plugin references stays inside the plugin directory', () => {
    const files = ['.claude-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json', 'skills/laneboard/SKILL.md', 'README.md'];
    for (const f of files) expect(fs.existsSync(path.join(PLUGIN, f)), f).toBe(true);
    expect(JSON.stringify(json(path.join(PLUGIN, '.mcp.json')))).not.toContain('..');
  });
});
