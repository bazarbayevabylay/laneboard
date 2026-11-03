// `laneboard setup <harness>` in a temp HOME + project: second run unchanged with identical bytes, --remove restores the original bytes,
// unparseable files are never written, dry run writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HARNESS_NAMES } from '../../src/setup/index.ts';
import { cleanupTemp, cli, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

interface Sandbox {
  cwd: string;
  home: string;
  run(argv: string[], env?: Record<string, string>): ReturnType<typeof cli>;
}

// A temp project and a temp HOME; the CLI never sees the real HOME.
function sandbox(): Sandbox {
  const cwd = tempDir();
  const home = tempDir();
  return { cwd, home, run: (argv, env = {}) => cli(argv, { cwd, env: { HOME: home, ...env } }) };
}

// Every file under the project and HOME with its bytes (relative paths prefixed p:/h:).
function snapshot(s: Sandbox): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (root: string, prefix: string, dir = root): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        out[`${prefix}${path.relative(root, full)}/`] = '<dir>';
        walk(root, prefix, full);
      } else out[`${prefix}${path.relative(root, full)}`] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(s.cwd, 'p:');
  walk(s.home, 'h:');
  return out;
}

// Write files into the sandbox: keys `p:<rel>` (project) or `h:<rel>` (home).
function plant(s: Sandbox, files: Record<string, string>): void {
  for (const [key, content] of Object.entries(files)) {
    const file = key.startsWith('h:') ? path.join(s.home, key.slice(2)) : path.join(s.cwd, key.slice(2));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

// JSON data of a successful --json run.
async function ok(s: Sandbox, argv: string[]): Promise<{ files: Array<{ path: string; result: string; scope: string; diff?: string[] }>; notes: string[] } & Record<string, unknown>> {
  const r = await s.run([...argv, '--json']);
  expect(r.code, r.stdout).toBe(0);
  return JSON.parse(r.stdout).data;
}

// User content that exists before setup, per harness: other keys, other indent, no trailing newline, other TOML tables.
const EXISTING: Record<string, Record<string, string>> = {
  'claude-code': {
    'p:.mcp.json': '{\n    "mcpServers": {\n        "other": { "command": "x" }\n    }\n}',
    'p:CLAUDE.md': '# Project\n\nUse pnpm.',
    'p:.claude/settings.json': '{\n  "permissions": { "allow": ["Bash(ls)"] },\n  "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo hi" }] }] }\n}\n',
  },
  codex: {
    'h:.codex/config.toml': 'model = "o4"\n\n[mcp_servers.other]\ncommand = "x"\n',
    'p:AGENTS.md': '# Agents\n\nRun tests.\n',
  },
  cursor: {
    'p:.cursor/mcp.json': '{"mcpServers":{"other":{"command":"x"}}}\n',
    'p:AGENTS.md': '# Agents\n',
  },
  gemini: {
    'p:.gemini/settings.json': '{\n  "theme": "dark"\n}\n',
    'p:GEMINI.md': 'Be brief.\n',
  },
  opencode: {
    'p:opencode.json': '{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {}\n}\n',
    'p:AGENTS.md': '',
  },
};

describe.each(HARNESS_NAMES)('setup %s', (harness) => {
  it('fresh project: creates files, a second run is unchanged with identical bytes, --remove leaves nothing', async () => {
    const s = sandbox();
    const empty = snapshot(s);
    const first = await ok(s, ['setup', harness]);
    expect(first.files.map((f) => f.result)).toEqual(first.files.map(() => 'created'));
    const after = snapshot(s);
    const second = await ok(s, ['setup', harness]);
    expect(second.files.map((f) => f.result)).toEqual(second.files.map(() => 'unchanged'));
    expect(snapshot(s)).toEqual(after);
    expect(Object.keys(after).some((k) => k.endsWith('.laneboard.bak'))).toBe(false);
    const removed = await ok(s, ['setup', harness, '--remove']);
    expect(removed.files.map((f) => f.result)).toEqual(removed.files.map(() => 'deleted'));
    expect(snapshot(s)).toEqual(empty);
    const again = await ok(s, ['setup', harness, '--remove']);
    expect(again.files.map((f) => f.result)).toEqual(again.files.map(() => 'unchanged'));
  });

  it('existing files: updated once with a backup, then unchanged; --remove restores the original bytes', async () => {
    const s = sandbox();
    plant(s, EXISTING[harness] ?? {});
    const original = snapshot(s);
    const first = await ok(s, ['setup', harness]);
    expect(first.files.every((f) => f.result === 'updated' || f.result === 'created')).toBe(true);
    const after = snapshot(s);
    for (const f of first.files.filter((x) => x.result === 'updated')) {
      const key = `${f.scope === 'global' ? 'h:' : 'p:'}${f.path.replace(/^~\//, '')}`;
      expect(after[`${key}.laneboard.bak`], key).toBe(original[key]);
    }
    const second = await ok(s, ['setup', harness]);
    expect(second.files.map((f) => f.result)).toEqual(second.files.map(() => 'unchanged'));
    expect(snapshot(s)).toEqual(after);
    const removed = await ok(s, ['setup', harness, '--remove']);
    expect(removed.files.every((f) => f.result === 'restored' || f.result === 'deleted')).toBe(true);
    expect(snapshot(s)).toEqual(original);
  });

  it('--dry-run reports the plan and writes nothing', async () => {
    const s = sandbox();
    const before = snapshot(s);
    const plan = await ok(s, ['setup', harness, '--dry-run']);
    expect(plan.dry_run).toBe(true);
    expect(plan.files.map((f) => f.result)).toEqual(plan.files.map(() => 'created'));
    expect(snapshot(s)).toEqual(before);
  });
});

describe('setup details', () => {
  it('writes the MCP entry and the 3-line block each harness documents', async () => {
    const s = sandbox();
    for (const h of HARNESS_NAMES) await ok(s, ['setup', h]);
    const read = (rel: string): unknown => JSON.parse(fs.readFileSync(path.join(s.cwd, rel), 'utf8'));
    expect(read('.mcp.json')).toEqual({ mcpServers: { laneboard: { command: 'laneboard', args: ['mcp'] } } });
    expect(read('.cursor/mcp.json')).toEqual({ mcpServers: { laneboard: { type: 'stdio', command: 'laneboard', args: ['mcp'] } } });
    expect(read('.gemini/settings.json')).toEqual({ mcpServers: { laneboard: { command: 'laneboard', args: ['mcp'] } } });
    expect(read('opencode.json')).toEqual({ mcp: { laneboard: { type: 'local', command: ['laneboard', 'mcp'], enabled: true } } });
    expect(read('.claude/settings.json')).toEqual({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup|resume|clear|compact',
            hooks: [{ type: 'command', command: "command -v laneboard >/dev/null 2>&1 && laneboard prime --hook || echo 'laneboard CLI missing: npm i -g laneboard'" }],
          },
        ],
      },
    });
    expect(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8')).toBe('# laneboard:start\n[mcp_servers.laneboard]\ncommand = "laneboard"\nargs = ["mcp"]\n# laneboard:end\n');
    const agents = fs.readFileSync(path.join(s.cwd, 'AGENTS.md'), 'utf8');
    expect(agents.split('\n').slice(1, -2)).toHaveLength(3);
    expect(agents).toContain('run `laneboard prime`');
    expect(agents).toContain('LANEBOARD_AGENT');
    expect(fs.readFileSync(path.join(s.cwd, 'CLAUDE.md'), 'utf8')).toBe(agents);
  });

  it('a different laneboard entry is replaced and shown as a diff; --remove brings the old one back', async () => {
    const s = sandbox();
    plant(s, { 'p:.mcp.json': '{ "mcpServers": { "laneboard": { "command": "npx", "args": ["-y", "laneboard", "mcp"] } } }\n' });
    const original = snapshot(s);
    const r = await ok(s, ['setup', 'claude-code']);
    const mcp = r.files.find((f) => f.path === '.mcp.json');
    expect(mcp?.result).toBe('updated');
    expect(mcp?.diff?.some((l) => l.startsWith('+') && l.includes('"laneboard"'))).toBe(true);
    expect(mcp?.diff?.some((l) => l.startsWith('-') && l.includes('npx'))).toBe(true);
    await ok(s, ['setup', 'claude-code', '--remove']);
    expect(snapshot(s)).toEqual(original);
  });

  it('a file that already has the same entry (other formatting) is unchanged: no rewrite, no backup', async () => {
    const s = sandbox();
    plant(s, { 'p:.gemini/settings.json': '{"theme":"dark","mcpServers":{"laneboard":{"args":["mcp"],"command":"laneboard"}}}' });
    const before = snapshot(s);
    const r = await ok(s, ['setup', 'gemini']);
    expect(r.files.find((f) => f.path === '.gemini/settings.json')?.result).toBe('unchanged');
    expect(snapshot(s)['p:.gemini/settings.json']).toBe(before['p:.gemini/settings.json']);
    expect(snapshot(s)['p:.gemini/settings.json.laneboard.bak']).toBeUndefined();
  });

  it('a file changed after setup keeps the other changes on --remove (the backup stays)', async () => {
    const s = sandbox();
    plant(s, { 'p:.cursor/mcp.json': '{"mcpServers":{}}\n' });
    await ok(s, ['setup', 'cursor']);
    const file = path.join(s.cwd, '.cursor', 'mcp.json');
    const edited = JSON.parse(fs.readFileSync(file, 'utf8'));
    edited.mcpServers.mine = { command: 'y' };
    fs.writeFileSync(file, JSON.stringify(edited));
    const r = await ok(s, ['setup', 'cursor', '--remove']);
    expect(r.files.find((f) => f.path === '.cursor/mcp.json')?.result).toBe('removed');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ mcpServers: { mine: { command: 'y' } } });
    expect(fs.existsSync(`${file}.laneboard.bak`)).toBe(true);
  });

  it('JSON with comments -> SETUP_UNPARSEABLE (exit 6), nothing written, snippet to add by hand', async () => {
    const s = sandbox();
    plant(s, { 'p:opencode.json': '{\n  // my config\n  "model": "x"\n}\n' });
    const before = snapshot(s);
    const r = await s.run(['setup', 'opencode', '--json']);
    expect(r.code).toBe(6);
    const err = JSON.parse(r.stdout).error;
    expect(err).toMatchObject({ code: 'SETUP_UNPARSEABLE', details: { file: 'opencode.json' } });
    expect(JSON.parse(err.details.snippet)).toEqual({ mcp: { laneboard: { type: 'local', command: ['laneboard', 'mcp'], enabled: true } } });
    expect(snapshot(s)).toEqual(before);
  });

  it('a Codex table defined outside the block -> SETUP_UNPARSEABLE, nothing written', async () => {
    const s = sandbox();
    plant(s, { 'h:.codex/config.toml': '[mcp_servers.laneboard]\ncommand = "old"\n' });
    const before = snapshot(s);
    const r = await s.run(['setup', 'codex', '--json']);
    expect(r.code).toBe(6);
    expect(JSON.parse(r.stdout).error.message).toContain('already defines [mcp_servers.laneboard] outside the laneboard block');
    expect(snapshot(s)).toEqual(before);
  });

  it('a broken marker block -> SETUP_UNPARSEABLE', async () => {
    const s = sandbox();
    plant(s, { 'p:GEMINI.md': 'x\n<!-- laneboard:start -->\nhalf a block\n' });
    const r = await s.run(['setup', 'gemini', '--json']);
    expect(r.code).toBe(6);
    expect(JSON.parse(r.stdout).error.code).toBe('SETUP_UNPARSEABLE');
  });

  it('claude-code warns when the laneboard plugin is installed too', async () => {
    const s = sandbox();
    plant(s, { 'h:.claude/plugins/cache/laneboard/laneboard/0.1.0/.claude-plugin/plugin.json': '{}' });
    const r = await s.run(['setup', 'claude-code', '--json']);
    expect(JSON.parse(r.stdout).warnings[0]).toContain('the laneboard Claude Code plugin is installed');
    const viaEnv = sandbox();
    const cache = tempDir();
    fs.mkdirSync(path.join(cache, 'cache', 'other-market', 'laneboard'), { recursive: true });
    const r2 = await viaEnv.run(['setup', 'claude-code', '--json'], { CLAUDE_CODE_PLUGIN_CACHE_DIR: cache });
    expect(JSON.parse(r2.stdout).warnings).toHaveLength(1);
    expect(JSON.parse((await sandbox().run(['setup', 'claude-code', '--json'])).stdout).warnings).toEqual([]);
  });

  it('unknown harness names fail with allowed and a runnable fix', async () => {
    const s = sandbox();
    const r = await s.run(['setup', 'claude', '--json']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: 'INVALID_VALUE', allowed: HARNESS_NAMES, fix: 'laneboard setup claude-code --json' });
    const far = JSON.parse((await s.run(['setup', 'vim', '--json'])).stdout).error;
    expect(far.fix).toBe('laneboard setup <harness from allowed> --json');
  });

  it('human output names each file and marks global ones', async () => {
    const s = sandbox();
    const r = await s.run(['setup', 'codex']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('created ~/.codex/config.toml (global file)\ncreated AGENTS.md\nnext: ~/.codex/config.toml is a global file: the laneboard MCP server is on in every Codex project\n');
  });
});
