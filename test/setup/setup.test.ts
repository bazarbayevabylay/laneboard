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

// Every file under the project and HOME with its bytes, symlinks with their target (relative paths prefixed p:/h:).
function snapshot(s: Sandbox): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (root: string, prefix: string, dir = root): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) out[`${prefix}${path.relative(root, full)}`] = `<link to ${fs.readlinkSync(full)}>`;
      else if (stat.isDirectory()) {
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
    const store = path.join(s.cwd, '.laneboard');
    // Claude Code pins the store through env LANEBOARD_DIR (below); the other project MCP entries carry --dir.
    expect(read('.mcp.json')).toEqual({ mcpServers: { laneboard: { command: 'laneboard', args: ['mcp'] } } });
    expect(read('.cursor/mcp.json')).toEqual({ mcpServers: { laneboard: { type: 'stdio', command: 'laneboard', args: ['mcp', '--dir', store] } } });
    expect(read('.gemini/settings.json')).toEqual({ mcpServers: { laneboard: { command: 'laneboard', args: ['mcp', '--dir', store] } } });
    expect(read('opencode.json')).toEqual({ mcp: { laneboard: { type: 'local', command: ['laneboard', 'mcp', '--dir', store], enabled: true } } });
    expect(read('.claude/settings.json')).toEqual({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup|resume|clear|compact',
            hooks: [{ type: 'command', command: "command -v laneboard >/dev/null 2>&1 && laneboard prime --hook || echo 'laneboard CLI missing: npm i -g laneboard'" }],
          },
        ],
        PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'command -v laneboard >/dev/null 2>&1 && laneboard prime --edit-hook 2>/dev/null; exit 0' }] }],
      },
      env: { LANEBOARD_DIR: store },
    });
    expect(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8')).toBe(
      '# laneboard:start\n[mcp_servers.laneboard]\ncommand = "laneboard"\nargs = ["mcp"]\nenv_vars = ["LANEBOARD_DIR"]\n# laneboard:end\n',
    );
    const agents = fs.readFileSync(path.join(s.cwd, 'AGENTS.md'), 'utf8');
    const lines = agents.split('\n').slice(1, -2);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(`\`LANEBOARD_DIR=${store} laneboard <command>\``);
    expect(lines[1]).toMatch(/^MANDATORY for every request, even when nobody mentions tasks and the board is empty: before your first file change, run `laneboard prime` and claim your task or create one/);
    expect(lines[1]).toContain('No untracked work.');
    expect(lines[2]).toContain('LANEBOARD_AGENT');
    expect(fs.readFileSync(path.join(s.cwd, 'GEMINI.md'), 'utf8')).toBe(agents);
    // Claude Code gets the pin from .claude/settings.json; the rest of the block is the same.
    const claude = fs.readFileSync(path.join(s.cwd, 'CLAUDE.md'), 'utf8').split('\n').slice(1, -2);
    expect(claude[0]).toContain(`Its store is ${store} (LANEBOARD_DIR is set for this project in .claude/settings.json).`);
    expect(claude.slice(1)).toEqual(lines.slice(1));
  });

  it('pins --dir (or LANEBOARD_DIR) instead of ./.laneboard, never a store found in a parent directory; warns when no store is there yet', async () => {
    const s = sandbox();
    const sub = path.join(s.cwd, 'sub');
    fs.mkdirSync(sub);
    expect((await cli(['init', '--prefix', 'PARENT'], { cwd: s.cwd })).code).toBe(0);
    const inSub = { run: (argv: string[], env: Record<string, string> = {}) => cli(argv, { cwd: sub, env: { HOME: s.home, ...env } }) };
    const plain = JSON.parse((await inSub.run(['setup', 'gemini', '--json'])).stdout);
    expect(plain.data.store).toBe(path.join(sub, '.laneboard'));
    expect(plain.warnings).toContain(`no laneboard store at ${path.join(sub, '.laneboard')} yet: run laneboard init in ${sub}, or run setup again with --dir <the project's .laneboard>`);
    expect(fs.readFileSync(path.join(sub, 'GEMINI.md'), 'utf8')).toContain(`LANEBOARD_DIR=${path.join(sub, '.laneboard')} laneboard`);
    const parent = path.join(s.cwd, '.laneboard');
    const flagged = JSON.parse((await inSub.run(['setup', 'gemini', '--dir', parent, '--json'])).stdout);
    expect(flagged).toMatchObject({ store: parent, prefix: 'PARENT', data: { store: parent }, warnings: [] });
    expect(fs.readFileSync(path.join(sub, 'GEMINI.md'), 'utf8')).toContain(`LANEBOARD_DIR=${parent} laneboard`);
    const fromEnv = JSON.parse((await inSub.run(['setup', 'gemini', '--json'], { LANEBOARD_DIR: parent })).stdout);
    expect(fromEnv.warnings).toEqual([`the store pin comes from LANEBOARD_DIR=${parent} in your environment, not ./.laneboard; to pin another store run setup again with --dir <path>`]);
  });

  it('a store path with spaces is quoted in the instruction line', async () => {
    const s = sandbox();
    const odd = path.join(s.cwd, "my store's");
    await ok(s, ['setup', 'codex', '--dir', odd]);
    expect(fs.readFileSync(path.join(s.cwd, 'AGENTS.md'), 'utf8')).toContain(`\`LANEBOARD_DIR='${odd.replace("'", "'\\''")}' laneboard <command>\``);
  });

  it('a different laneboard entry is replaced and shown as a diff, without a backup; --remove takes laneboard out', async () => {
    const s = sandbox();
    plant(s, { 'p:.mcp.json': '{ "mcpServers": { "laneboard": { "command": "npx", "args": ["-y", "laneboard", "mcp"] }, "other": { "command": "x" } } }\n' });
    const r = await ok(s, ['setup', 'claude-code']);
    const mcp = r.files.find((f) => f.path === '.mcp.json');
    expect(mcp?.result).toBe('updated');
    expect(mcp?.diff?.some((l) => l.startsWith('+') && l.includes('"laneboard"'))).toBe(true);
    expect(mcp?.diff?.some((l) => l.startsWith('-') && l.includes('npx'))).toBe(true);
    // The file already held a laneboard entry, so it is not "the original without laneboard": no backup.
    expect(snapshot(s)['p:.mcp.json.laneboard.bak']).toBeUndefined();
    await ok(s, ['setup', 'claude-code', '--remove']);
    expect(snapshot(s)['p:.mcp.json']).toBe('{ "mcpServers": { "other": { "command": "x" } } }\n');
  });

  it('a file that already has the same entry (other formatting) is unchanged: no rewrite, no backup', async () => {
    const s = sandbox();
    plant(s, { 'p:.gemini/settings.json': `{"theme":"dark","mcpServers":{"laneboard":{"args":["mcp","--dir",${JSON.stringify(path.join(s.cwd, '.laneboard'))}],"command":"laneboard"}}}` });
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

  it('JSON with comments is edited in place: comments and formatting stay, --remove restores the bytes', async () => {
    const s = sandbox();
    const original = '{\n  // my config\n  "model": "x", // trailing note\n}\n';
    plant(s, { 'p:opencode.json': original });
    await ok(s, ['setup', 'opencode']);
    const text = snapshot(s)['p:opencode.json'];
    expect(text).toBe(`{\n  // my config\n  "model": "x",\n  "mcp": {\n    "laneboard": {\n      "type": "local",\n      "command": [\n        "laneboard",\n        "mcp",\n        "--dir",\n        ${JSON.stringify(path.join(s.cwd, '.laneboard'))}\n      ],\n      "enabled": true\n    }\n  }, // trailing note\n}\n`);
    await ok(s, ['setup', 'opencode', '--remove']);
    expect(snapshot(s)['p:opencode.json']).toBe(original);
  });

  it('a JSON syntax error, a byte order mark or a duplicate key on our path -> SETUP_UNPARSEABLE (exit 6), nothing written, snippet', async () => {
    for (const bad of ['{\n  "model": x\n}\n', '\uFEFF{"mcp":{}}\n', '{"mcp":{"a":{}},"mcp":{}}\n']) {
      const s = sandbox();
      plant(s, { 'p:opencode.json': bad });
      const before = snapshot(s);
      const r = await s.run(['setup', 'opencode', '--json']);
      expect(r.code, bad).toBe(6);
      const err = JSON.parse(r.stdout).error;
      expect(err).toMatchObject({ code: 'SETUP_UNPARSEABLE', details: { file: 'opencode.json' } });
      expect(JSON.parse(err.details.snippet)).toEqual({ mcp: { laneboard: { type: 'local', command: ['laneboard', 'mcp', '--dir', path.join(s.cwd, '.laneboard')], enabled: true } } });
      expect(snapshot(s)).toEqual(before);
    }
  });

  it('a Codex table defined outside the block -> SETUP_CONFLICT with a fix, nothing written', async () => {
    const s = sandbox();
    plant(s, { 'h:.codex/config.toml': '[mcp_servers.laneboard]\ncommand = "old"\n' });
    const before = snapshot(s);
    const r = await s.run(['setup', 'codex', '--json']);
    expect(r.code).toBe(6);
    const err = JSON.parse(r.stdout).error;
    expect(err.code).toBe('SETUP_CONFLICT');
    expect(err.message).toContain('already defines mcp_servers.laneboard on line 1');
    expect(err.fix).toContain('delete that mcp_servers.laneboard entry (line 1)');
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
    await viaEnv.run(['init', '--prefix', 'LB']);
    const r2 = await viaEnv.run(['setup', 'claude-code', '--json'], { CLAUDE_CODE_PLUGIN_CACHE_DIR: cache });
    expect(JSON.parse(r2.stdout).warnings).toHaveLength(1);
    const clean = sandbox();
    await clean.run(['init', '--prefix', 'LB']);
    expect(JSON.parse((await clean.run(['setup', 'claude-code', '--json'])).stdout).warnings).toEqual([]);
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
    expect(r.stdout).toBe(`store: ${s.cwd}/.laneboard\n` + 'created ~/.codex/config.toml (global file)\ncreated AGENTS.md\nnext: the Codex config.toml is a global file: the laneboard MCP server is on in every Codex project\n');
  });
});

// Review S2: backups (M1, M2), byte-exact JSON edits (M3), TOML forms (M4), and the minor findings.
describe('setup backups and exact edits', () => {
  const mcpFile = (s: Sandbox): string => path.join(s.cwd, '.mcp.json');
  // Change laneboard's own entry by hand (as a user or an older laneboard version would) and add a key of the user's.
  const editOurEntry = (s: Sandbox): void => {
    const j = JSON.parse(fs.readFileSync(mcpFile(s), 'utf8'));
    j.mcpServers.laneboard.args = ['mcp', '--dir', '/x'];
    j.mcpServers.mine = { command: 'o' };
    fs.writeFileSync(mcpFile(s), `${JSON.stringify(j, null, 2)}\n`);
  };

  it('a created file whose laneboard entry changed: setup takes no backup, --remove really takes the entry out', async () => {
    const s = sandbox();
    await ok(s, ['setup', 'claude-code']);
    editOurEntry(s);
    const r = await ok(s, ['setup', 'claude-code']);
    expect(r.files.find((f) => f.path === '.mcp.json')?.result).toBe('updated');
    expect(fs.existsSync(`${mcpFile(s)}.laneboard.bak`)).toBe(false);
    const removed = await ok(s, ['setup', 'claude-code', '--remove']);
    expect(removed.files.find((f) => f.path === '.mcp.json')?.result).toBe('removed');
    expect(JSON.parse(fs.readFileSync(mcpFile(s), 'utf8'))).toEqual({ mcpServers: { mine: { command: 'o' } } });
  });

  it('a created CLAUDE.md with text added later and an older block: --remove leaves only the user text', async () => {
    const s = sandbox();
    await ok(s, ['setup', 'claude-code']);
    const file = path.join(s.cwd, 'CLAUDE.md');
    const old = fs.readFileSync(file, 'utf8').replace('run `laneboard prime`', 'run laneboard prime (old text)');
    fs.writeFileSync(file, `${old}\n## Mine\n`);
    expect((await ok(s, ['setup', 'claude-code'])).files.find((f) => f.path === 'CLAUDE.md')?.result).toBe('updated');
    expect(fs.existsSync(`${file}.laneboard.bak`)).toBe(false);
    await ok(s, ['setup', 'claude-code', '--remove']);
    expect(fs.readFileSync(file, 'utf8')).toBe('## Mine\n');
  });

  it('a pre-existing file: the backup is the original, a second setup after the entry changed keeps it, --remove restores the bytes', async () => {
    const s = sandbox();
    const original = '{\n    "mcpServers": {\n        "other": { "command": "x" }\n    }\n}';
    plant(s, { 'p:.mcp.json': original });
    await ok(s, ['setup', 'claude-code']);
    editOurEntry(s);
    fs.writeFileSync(mcpFile(s), fs.readFileSync(mcpFile(s), 'utf8').replace(',\n    "mine": {\n      "command": "o"\n    }', ''));
    await ok(s, ['setup', 'claude-code']);
    expect(fs.readFileSync(`${mcpFile(s)}.laneboard.bak`, 'utf8')).toBe(original);
    const removed = await ok(s, ['setup', 'claude-code', '--remove']);
    expect(removed.files.find((f) => f.path === '.mcp.json')?.result).toBe('restored');
    expect(fs.readFileSync(mcpFile(s), 'utf8')).toBe(original);
    expect(fs.existsSync(`${mcpFile(s)}.laneboard.bak`)).toBe(false);
  });

  it('a backup that holds a laneboard entry (older laneboard) is never restored', async () => {
    const s = sandbox();
    const ours = '{"mcpServers":{"laneboard":{"command":"laneboard","args":["mcp"]},"o":{"command":"o"}}}\n';
    plant(s, { 'p:.mcp.json': ours, 'p:.mcp.json.laneboard.bak': ours });
    const r = await s.run(['setup', 'claude-code', '--remove', '--json']);
    const data = JSON.parse(r.stdout);
    expect(data.data.files.find((f: { path: string }) => f.path === '.mcp.json')?.result).toBe('removed');
    expect(fs.readFileSync(mcpFile(s), 'utf8')).toBe('{"mcpServers":{"o":{"command":"o"}}}\n');
    expect(data.warnings).toContain('kept .mcp.json.laneboard.bak (your file before setup; not restored because the file changed since): delete it when not needed');
  });

  // 0664 is wider than the 022 umask allows at creation, so only an explicit chmod gives the backup the original's mode.
  it.each([0o600, 0o640, 0o664])('the backup keeps the mode of the original (%o)', async (mode) => {
    const s = sandbox();
    plant(s, { 'h:.codex/config.toml': 'model = "o4"\n[mcp_servers.gh]\nenv = { TOKEN = "secret" }\n' });
    const file = path.join(s.home, '.codex', 'config.toml');
    fs.chmodSync(file, mode);
    await ok(s, ['setup', 'codex']);
    expect(fs.statSync(`${file}.laneboard.bak`).mode & 0o777).toBe(mode);
    expect(fs.statSync(file).mode & 0o777).toBe(mode);
  });

  it('writing a backup is reported (project files: do not commit it)', async () => {
    const s = sandbox();
    plant(s, { 'p:CLAUDE.md': '# Project\n' });
    const r = JSON.parse((await s.run(['setup', 'claude-code', '--json'])).stdout);
    expect(r.warnings).toContain('wrote CLAUDE.md.laneboard.bak (your file before setup; setup --remove restores it); do not commit it: add *.laneboard.bak to .gitignore');
    const human = await s.run(['setup', 'claude-code', '--remove']);
    expect(human.stderr).toBe('');
  });

  it('JSON: only our key changes, every other byte stays (arrays on one line, 1.0, escapes, big numbers, other indent)', async () => {
    const s = sandbox();
    const original = '{\n  "permissions": { "allow": ["Bash(npm test)", "Read"], "deny": [] },\n  "env": { "BIG": 12345678901234567890, "F": 1.0, "U": "caf\\u00e9" }\n}\n';
    plant(s, { 'p:.claude/settings.json': original });
    await ok(s, ['setup', 'claude-code']);
    const hook = JSON.stringify({ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: "command -v laneboard >/dev/null 2>&1 && laneboard prime --hook || echo 'laneboard CLI missing: npm i -g laneboard'" }] }, null, 2);
    const edit = JSON.stringify({ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'command -v laneboard >/dev/null 2>&1 && laneboard prime --edit-hook 2>/dev/null; exit 0' }] }, null, 2);
    const indent = (text: string): string => text.split('\n').join('\n      ');
    const inserted = `,\n  "hooks": {\n    "SessionStart": [\n      ${indent(hook)}\n    ],\n    "PostToolUse": [\n      ${indent(edit)}\n    ]\n  }`;
    const file = path.join(s.cwd, '.claude', 'settings.json');
    const pinned = original.replace('"caf\\u00e9" }', `"caf\\u00e9",${JSON.stringify('LANEBOARD_DIR')}:${JSON.stringify(path.join(s.cwd, '.laneboard'))} }`);
    expect(fs.readFileSync(file, 'utf8')).toBe(pinned.replace('" }\n}\n', `" }${inserted}\n}\n`));
    // The user changes something else after setup: --remove takes only our part out and keeps every other byte.
    const edited = fs.readFileSync(file, 'utf8').replace('"deny": []', '"deny": ["Bash(rm)"]');
    fs.writeFileSync(file, edited);
    const r = await ok(s, ['setup', 'claude-code', '--remove']);
    expect(r.files.find((f) => f.path === '.claude/settings.json')?.result).toBe('removed');
    expect(fs.readFileSync(file, 'utf8')).toBe(original.replace('"deny": []', '"deny": ["Bash(rm)"]'));
  });

  it('JSON on one line stays on one line; an empty object gets an indented entry', async () => {
    const s = sandbox();
    plant(s, { 'p:.cursor/mcp.json': '{"mcpServers":{"other":{"command":"x"}}}\n', 'p:.gemini/settings.json': '{\n  "theme": "dark",\n  "mcpServers": {}\n}\n' });
    await ok(s, ['setup', 'cursor']);
    await ok(s, ['setup', 'gemini']);
    const store = JSON.stringify(path.join(s.cwd, '.laneboard'));
    expect(snapshot(s)['p:.cursor/mcp.json']).toBe(`{"mcpServers":{"other":{"command":"x"},"laneboard":{"type":"stdio","command":"laneboard","args":["mcp","--dir",${store}]}}}\n`);
    expect(snapshot(s)['p:.gemini/settings.json']).toBe(
      `{\n  "theme": "dark",\n  "mcpServers": {\n    "laneboard": {\n      "command": "laneboard",\n      "args": [\n        "mcp",\n        "--dir",\n        ${store}\n      ]\n    }\n  }\n}\n`,
    );
  });

  it.each([
    ['inline table under [mcp_servers]', '[mcp_servers]\nlaneboard = { command = "old", args = [] }\n', 2],
    ['dotted key under [mcp_servers]', 'model = "o4"\n\n[mcp_servers]\nlaneboard.command = "old"\n', 4],
    ['quoted key under [mcp_servers]', '[mcp_servers]\n"laneboard" = { command = "old" }\n', 2],
    ['dotted key at the root', 'mcp_servers.laneboard.command = "old"\n', 1],
    ['a sub-table', '[mcp_servers.laneboard.env]\nTOKEN = "x"\n', 1],
    ['spaces and quotes in the header', "[ mcp_servers . 'laneboard' ]\ncommand = \"old\"\n", 1],
    ['mcp_servers as an inline table', 'mcp_servers = { other = { command = "x" } }\n', 1],
    ['mcp_servers as an array of tables', '[[mcp_servers]]\nname = "x"\n', 1],
  ])('Codex: laneboard as %s -> SETUP_CONFLICT, nothing written', async (_name, toml, line) => {
    const s = sandbox();
    plant(s, { 'h:.codex/config.toml': toml });
    const before = snapshot(s);
    const r = await s.run(['setup', 'codex', '--json']);
    expect(r.code).toBe(6);
    const err = JSON.parse(r.stdout).error;
    expect(err.code).toBe('SETUP_CONFLICT');
    expect(err.message).toContain(`on line ${line}`);
    expect(err.fix).toContain(`(line ${line})`);
    expect(err.details.snippet).toContain('[mcp_servers.laneboard]');
    expect(snapshot(s)).toEqual(before);
  });

  it('Codex: look-alikes in strings, comments, arrays and other tables are not conflicts', async () => {
    const s = sandbox();
    const toml = [
      '# [mcp_servers.laneboard]',
      'note = """',
      '[mcp_servers.laneboard]',
      'laneboard = 1"""',
      "lit = '''",
      "mcp_servers.laneboard = 2'''",
      'args = [',
      '  "[mcp_servers.laneboard]", # comment',
      '  [1, 2],',
      ']',
      '[mcp_servers.laneboard_old]',
      'command = "x"',
      '[other.mcp_servers.laneboard]',
      'command = "y"',
      '',
    ].join('\n');
    plant(s, { 'h:.codex/config.toml': toml });
    const r = await ok(s, ['setup', 'codex']);
    expect(r.files.find((f) => f.scope === 'global')?.result).toBe('updated');
    await ok(s, ['setup', 'codex', '--remove']);
    expect(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8')).toBe(toml);
  });

  it('Codex: TOML laneboard cannot read (unterminated string) -> SETUP_UNPARSEABLE, nothing written', async () => {
    const s = sandbox();
    plant(s, { 'h:.codex/config.toml': 'model = "o4\n' });
    const r = await s.run(['setup', 'codex', '--json']);
    expect(r.code).toBe(6);
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: 'SETUP_UNPARSEABLE', message: '~/.codex/config.toml is not TOML laneboard can read (an unterminated string on line 1); nothing was written' });
  });

  it('Codex: CODEX_HOME moves config.toml; the output names the real path and the directory is never removed', async () => {
    const s = sandbox();
    const codexHome = path.join(s.home, 'codex-home');
    const elsewhere = tempDir();
    fs.mkdirSync(codexHome);
    const r = await s.run(['setup', 'codex', '--json'], { CODEX_HOME: codexHome });
    expect(JSON.parse(r.stdout).data.files[0]).toMatchObject({ path: '~/codex-home/config.toml', scope: 'global', result: 'created' });
    expect(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')).toContain('[mcp_servers.laneboard]');
    expect(fs.existsSync(path.join(s.home, '.codex'))).toBe(false);
    const out = await s.run(['setup', 'codex', '--remove', '--json'], { CODEX_HOME: codexHome });
    expect(JSON.parse(out.stdout).data.files[0].result).toBe('deleted');
    expect(fs.readdirSync(codexHome)).toEqual([]);
    const abs = await s.run(['setup', 'codex', '--json', '--dry-run'], { CODEX_HOME: elsewhere });
    expect(JSON.parse(abs.stdout).data.files[0].path).toBe(path.join(elsewhere, 'config.toml'));
  });

  it('AGENTS.md shared by codex and cursor: removing one keeps the block and says who still uses it', async () => {
    const s = sandbox();
    plant(s, { 'p:AGENTS.md': '# Agents\n' });
    await ok(s, ['setup', 'codex']);
    await ok(s, ['setup', 'cursor']);
    const r = JSON.parse((await s.run(['setup', 'cursor', '--remove', '--json'])).stdout);
    expect(r.data.files.find((f: { path: string }) => f.path === 'AGENTS.md')?.result).toBe('kept');
    expect(r.warnings).toContain('kept the laneboard block in AGENTS.md: codex still uses it (laneboard setup codex --remove removes it)');
    expect(fs.readFileSync(path.join(s.cwd, 'AGENTS.md'), 'utf8')).toContain('laneboard:start');
    const last = await ok(s, ['setup', 'codex', '--remove']);
    expect(last.files.find((f) => f.path === 'AGENTS.md')?.result).toBe('restored');
    expect(fs.readFileSync(path.join(s.cwd, 'AGENTS.md'), 'utf8')).toBe('# Agents\n');
  });

  it('a read-only file -> SETUP_WRITE_FAILED before any write', async () => {
    const s = sandbox();
    plant(s, { 'p:CLAUDE.md': '# x\n' });
    fs.chmodSync(path.join(s.cwd, 'CLAUDE.md'), 0o444);
    const before = snapshot(s);
    const r = await s.run(['setup', 'claude-code', '--json']);
    expect(r.code).toBe(6);
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: 'SETUP_WRITE_FAILED', details: { file: 'CLAUDE.md' } });
    expect(snapshot(s)).toEqual(before);
  });

  it('a write that fails midway (symlink into a read-only directory) puts back what was already written', async () => {
    const s = sandbox();
    const locked = tempDir();
    fs.symlinkSync(path.join(locked, 'CLAUDE.md'), path.join(s.cwd, 'CLAUDE.md'));
    fs.chmodSync(locked, 0o555);
    try {
      const before = snapshot(s);
      const r = await s.run(['setup', 'claude-code', '--json']);
      expect(r.code).toBe(6);
      const err = JSON.parse(r.stdout).error;
      expect(err.code).toBe('SETUP_WRITE_FAILED');
      expect(err.message).toBe('writing CLAUDE.md failed (EACCES); the files changed before it were put back');
      expect(snapshot(s)).toEqual(before);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it('text added after the block: --remove leaves no extra blank line', async () => {
    const s = sandbox();
    plant(s, { 'p:CLAUDE.md': '# P\n\nUse pnpm.\n' });
    await ok(s, ['setup', 'claude-code']);
    fs.appendFileSync(path.join(s.cwd, 'CLAUDE.md'), '\n## Added later\n');
    await ok(s, ['setup', 'claude-code', '--remove']);
    expect(fs.readFileSync(path.join(s.cwd, 'CLAUDE.md'), 'utf8')).toBe('# P\n\nUse pnpm.\n\n## Added later\n');
  });
});

describe("setup --remove never deletes what is not laneboard's", () => {
  it('a directory the user had before setup stays after --remove, even when it is empty again', async () => {
    const s = sandbox();
    fs.mkdirSync(path.join(s.cwd, '.cursor'));
    const store = path.join(s.cwd, '.laneboard');
    plant(s, { 'p:.cursor/mcp.json': `{"mcpServers":{"laneboard":{"type":"stdio","command":"laneboard","args":["mcp","--dir",${JSON.stringify(store)}]}}}\n` });
    await ok(s, ['setup', 'cursor']);
    const removed = await ok(s, ['setup', 'cursor', '--remove']);
    expect(removed.files.find((f) => f.path === '.cursor/mcp.json')?.result).toBe('deleted');
    expect(fs.existsSync(path.join(s.cwd, '.cursor'))).toBe(true);
    expect(fs.readdirSync(path.join(s.cwd, '.cursor'))).toEqual([]);
  });

  it('a directory setup created is marked; --remove deletes it only when nothing else is in it', async () => {
    const s = sandbox();
    await ok(s, ['setup', 'gemini']);
    expect(fs.readdirSync(path.join(s.cwd, '.gemini')).sort()).toEqual(['.laneboard-created', 'settings.json']);
    fs.mkdirSync(path.join(s.cwd, '.gemini', 'commands'));
    await ok(s, ['setup', 'gemini', '--remove']);
    expect(fs.readdirSync(path.join(s.cwd, '.gemini'))).toEqual(['commands']);
  });

  it('Codex: a foreign table written inside the laneboard block -> SETUP_CONFLICT on --remove and on setup, nothing written', async () => {
    const s = sandbox();
    await ok(s, ['setup', 'codex']);
    const file = path.join(s.home, '.codex', 'config.toml');
    const text = fs.readFileSync(file, 'utf8').replace('# laneboard:end', '[mcp_servers.mine]\ncommand = "mine"\n# laneboard:end');
    fs.writeFileSync(file, text);
    for (const argv of [['setup', 'codex', '--remove', '--json'], ['setup', 'codex', '--json']]) {
      const before = snapshot(s);
      const r = await s.run(argv);
      expect(r.code, argv.join(' ')).toBe(6);
      const err = JSON.parse(r.stdout).error;
      expect(err.code).toBe('SETUP_CONFLICT');
      expect(err.message).toBe("~/.codex/config.toml holds mcp_servers.mine (line 6), mcp_servers.mine.command (line 7) inside the laneboard block, which is not laneboard's; nothing was written");
      expect(err.fix).toBe('move mcp_servers.mine (line 6), mcp_servers.mine.command (line 7) above the "# laneboard:start" line in ~/.codex/config.toml, then run setup again');
      expect(snapshot(s)).toEqual(before);
    }
  });

  it('Codex: our own table edited inside the block (other args, a sub-table) is still ours: --remove takes it out', async () => {
    const s = sandbox();
    plant(s, { 'h:.codex/config.toml': 'model = "o4"\n' });
    await ok(s, ['setup', 'codex']);
    const file = path.join(s.home, '.codex', 'config.toml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('# laneboard:end', '[mcp_servers.laneboard.env]\nX = "1"\n# laneboard:end').replace('args = ["mcp"]', 'args = ["mcp", "--dir", "/x"]'));
    const removed = await ok(s, ['setup', 'codex', '--remove']);
    expect(removed.files[0]?.result).toBe('restored');
    expect(fs.readFileSync(file, 'utf8')).toBe('model = "o4"\n');
  });
});
