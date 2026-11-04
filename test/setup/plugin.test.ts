// Claude Code plugin and marketplace: shapes from code.claude.com/docs/en/plugins (manifest, marketplace, components),
// versions in sync with package.json, skill = agent rules (one source), hook and MCP entry = what `setup claude-code` writes.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agentRules, skillMarkdown } from '../../src/core/index.ts';
import { EDIT_HOOK_COMMAND, EDIT_HOOK_MATCHER, PRIME_HOOK_COMMAND } from '../../src/setup/index.ts';
import { cleanupTemp, CLI_SOURCE, newStore, REPO, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

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

  it('at most 15 lines; name what the usability test showed agents had to guess (create, rev after writes, details.task, final status, commented)', () => {
    const rules = agentRules();
    expect(rules.split('\n').length).toBeLessThanOrEqual(15);
    expect(rules).toContain('`laneboard create "<title>" --status <status> --assignee <your name> --json`');
    // --as only with a name of the agent's own (rules 3 and 4 agree; S2d): no template forces a made-up --as.
    expect(rules).toContain('add `--as <name>` only for a name of your own');
    expect(rules).not.toContain('--as <you>');
    // A board found with boards --json is used with --dir on every command: an export does not outlive one Bash call (S2d).
    expect(rules).toContain('then pass `--dir <path>` on every command');
    expect(rules).not.toContain('export LANEBOARD_DIR');
    expect(rules).toContain('rev from your last read or write');
    // S3: the rev is needed only on top of what was read; two agents fetched it with `get` before a status change.
    expect(rules).toContain('`--expected-rev` is optional: only for edits on top of what you read');
    // S5a (ADR §26): appending to the description needs no rev either.
    expect(rules).toContain('Status, comment, claim, finish, `--append-description`: without it, and no `get` for it.');
    expect(rules).toContain('`--description` replaces the whole text');
    expect(rules).toContain('`error.details.task`');
    expect(rules).toContain('the last one is final');
    expect(rules).toContain('type `commented`');
    // Unsure which board: the registry first, then a board of its own with a name and description (owner's rule, S2c).
    expect(rules).toContain('`laneboard boards --json`, pick yours by `description` and `path`');
    // A board of its own by --dir: a bare init would take LANEBOARD_DIR, which may name another project's board (S2f).
    expect(rules).toContain('`laneboard init --dir .laneboard --name <name> --description "<whose project, what work>"`');
    expect(rules).not.toContain('`laneboard init --name');
    expect(rules).not.toContain('unless the user asks');
    // An agent without a name is told that its writes use the session's default name.
    expect(rules).toContain("without `--as` and LANEBOARD_AGENT writes use the session's default name");
  });

  it('rule 1 makes task tracking mandatory for any work, also when nobody asks for tasks and the board is empty (usability test 03.11)', () => {
    const first = agentRules().split('\n')[1] ?? '';
    expect(first).toMatch(/^1\. MANDATORY for every request, even when nobody mentions tasks and the board is empty: before your first file change, claim your task or create one/);
    expect(first).toContain('comment each meaningful step');
    // S3: closing is one command (result comment, commit link, final status), after the commit.
    expect(first).toContain('when done: commit, then `laneboard finish <ID> --result "<result>" --json`');
    expect(first).toContain('No untracked work.');
    expect(agentRules()).toContain('Every reply names `store` and `prefix`');
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

  it('.mcp.json starts `laneboard mcp`; the SessionStart and PostToolUse hooks run the same commands setup writes', () => {
    expect(json(path.join(PLUGIN, '.mcp.json'))).toEqual({ mcpServers: { laneboard: { command: 'laneboard', args: ['mcp'] } } });
    expect(json(path.join(PLUGIN, 'hooks', 'hooks.json'))).toEqual({
      hooks: {
        SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: PRIME_HOOK_COMMAND }] }],
        PostToolUse: [{ matcher: EDIT_HOOK_MATCHER, hooks: [{ type: 'command', command: EDIT_HOOK_COMMAND }] }],
      },
    });
  });

  it('the edit hook command, run by a shell with the CLI on PATH, prints the reminder JSON in a store without work in progress', async () => {
    const bin = tempDir();
    fs.writeFileSync(path.join(bin, 'laneboard'), `#!/bin/sh\nexec "${process.execPath}" "${CLI_SOURCE}" "$@"\n`, { mode: 0o755 });
    const s = await newStore();
    const r = spawnSync('/bin/sh', ['-c', EDIT_HOOK_COMMAND], { cwd: s.root, env: { PATH: `${bin}:/usr/bin:/bin`, LANEBOARD_AGENT: 'dev-1' }, input: '{"tool_name":"Edit"}', encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'PostToolUse', additionalContext: expect.stringContaining('laneboard: no task is in progress for dev-1') });
    const outside = spawnSync('/bin/sh', ['-c', EDIT_HOOK_COMMAND], { cwd: tempDir(), env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
    expect([outside.status, outside.stdout, outside.stderr]).toEqual([0, '', '']);
  });

  it('the edit hook is silent and exits 0 when the CLI is missing', () => {
    const r = spawnSync('/bin/sh', ['-c', EDIT_HOOK_COMMAND], { env: { PATH: '/nonexistent' }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
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
