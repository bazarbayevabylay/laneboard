// S6f: setup and the machine registry made easier (audit A19 setup part, A20-A24). A pin an earlier setup wrote to a store that is gone
// (the project folder moved) is replaced, not a conflict (lifecycle F1). `setup codex --remove` keeps the global entry while another
// project of the registry may use it; --global removes it (newcomer F2). A registry folder that cannot be written is a warning for init,
// config and setup (newcomer F3). Every harness keeps backups and folder markers out of git through .git/info/exclude, and git's default
// exclude gets no backup (newcomer F6, F11). `boards --forget` drops an entry without a store (LB-26). The edit reminder follows every
// file edit tool (newcomer F12). A file shared through a link (CLAUDE.md -> AGENTS.md) is the same file for --remove (CARRYOVER S6b-r2).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readRegistry, registryFile } from '../../src/core/index.ts';
import { updateRegistry } from '../../src/core/boards.ts';
import { EDIT_HOOK_MATCHER } from '../../src/setup/index.ts';
import { cleanupTemp, cli, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

interface Run {
  code: number;
  json: { ok: boolean; data: Record<string, unknown> & { files?: Array<{ path: string; result: string }> }; warnings: string[]; error?: { code: string; message: string; fix: string; details?: Record<string, unknown> } };
}

// Run the CLI with --json in `cwd` under `home` (never the real HOME).
async function run(cwd: string, home: string, argv: string[], env: Record<string, string> = {}): Promise<Run> {
  const r = await cli([...argv, '--json'], { cwd, env: { HOME: home, USER: 'tester', ...env } });
  return { code: r.code, json: JSON.parse(r.stdout) };
}

// Like run, and the command must succeed.
async function ok(cwd: string, home: string, argv: string[], env: Record<string, string> = {}): Promise<Run['json']> {
  const r = await run(cwd, home, argv, env);
  expect(r.code, JSON.stringify(r.json.error)).toBe(0);
  return r.json;
}

// Result of one file in a setup reply.
function result(json: Run['json'], file: string): string | undefined {
  return json.data.files?.find((f) => f.path === file)?.result;
}

// Git that reads no config of this machine (an isolated HOME), so a global excludes file of the user changes nothing.
function git(cwd: string, home: string, args: string[]): string {
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig-none'), GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: path.join(home, '.config-none') };
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}

// A project folder with a fresh git repository (git's default .git/info/exclude of comments only).
function repo(home: string): string {
  const dir = tempDir();
  git(dir, home, ['init', '-q']);
  return dir;
}

describe('A19: a pin of an earlier setup to a store that is gone is replaced (lifecycle F1)', () => {
  it('the project folder is moved: setup in the new place pins the new store, warns with the forget command, never creates the old path', async () => {
    const home = tempDir();
    const parent = tempDir();
    const old = path.join(parent, 'proj');
    fs.mkdirSync(old);
    git(old, home, ['init', '-q']);
    await ok(old, home, ['init', '--name', 'movec', '--description', 'move test']);
    await ok(old, home, ['setup', 'claude-code']);
    await ok(old, home, ['create', 't1', '--status', 'todo', '--as', 'a']);
    const moved = path.join(parent, 'proj2');
    fs.renameSync(old, moved);
    const r = await ok(moved, home, ['setup', 'claude-code']);
    expect(result(r, '.claude/settings.local.json')).toBe('updated');
    const local = JSON.parse(fs.readFileSync(path.join(moved, '.claude', 'settings.local.json'), 'utf8'));
    expect(local.env).toEqual({ LANEBOARD_DIR: path.join(moved, '.laneboard'), LANEBOARD_DEFAULT_AGENT: 'claude-code@tester' });
    expect(r.warnings).toContain(
      `.claude/settings.local.json pinned LANEBOARD_DIR=${path.join(old, '.laneboard')}, which holds no store any more (the project folder was moved or renamed?), so setup pins ${path.join(moved, '.laneboard')} there instead; ` +
        `laneboard boards --forget ${path.join(old, '.laneboard')} drops the old path from the machine registry`,
    );
    expect(fs.existsSync(old)).toBe(false);
    // The old entry is listed as missing until forget drops it; then one board is left, the moved one with its task.
    await ok(moved, home, ['boards', '--forget', path.join(old, '.laneboard')]);
    expect(readRegistry(home).map((e) => e.path)).toEqual([path.join(moved, '.laneboard')]);
    expect((await ok(moved, home, ['list'])).data).toMatchObject({ items: [{ id: 'MOVE-1' }] });
  });

  it('the warning leaves out the forget command when the old path is not in the registry', async () => {
    const home = tempDir();
    const proj = tempDir();
    const gone = path.join(tempDir(), 'gone', '.laneboard');
    fs.mkdirSync(path.join(proj, '.claude'));
    fs.writeFileSync(path.join(proj, '.claude', 'settings.local.json'), JSON.stringify({ env: { LANEBOARD_DIR: gone, LANEBOARD_DEFAULT_AGENT: 'claude-code@tester' } }));
    const r = await ok(proj, home, ['setup', 'claude-code']);
    expect(r.warnings).toContain(
      `.claude/settings.local.json pinned LANEBOARD_DIR=${gone}, which holds no store any more (the project folder was moved or renamed?), so setup pins ${path.join(proj, '.laneboard')} there instead`,
    );
  });

  it('the pin is replaced in .claude/settings.json too (a folder inside another repository keeps its env there)', async () => {
    const home = tempDir();
    const root = repo(home);
    const nested = path.join(root, 'b');
    fs.mkdirSync(path.join(nested, '.claude'), { recursive: true });
    const gone = path.join(root, 'old-b', '.laneboard');
    fs.writeFileSync(path.join(nested, '.claude', 'settings.json'), JSON.stringify({ env: { LANEBOARD_DIR: gone, LANEBOARD_DEFAULT_AGENT: 'claude-code@me' } }));
    await ok(nested, home, ['setup', 'claude-code']);
    expect(JSON.parse(fs.readFileSync(path.join(nested, '.claude', 'settings.json'), 'utf8')).env).toEqual({ LANEBOARD_DIR: path.join(nested, '.laneboard'), LANEBOARD_DEFAULT_AGENT: 'claude-code@me' });
  });

  it('a pin of both keys to a store that exists is still a conflict, and so is the user\'s own LANEBOARD_DIR alone to a path without a store', async () => {
    const home = tempDir();
    const other = tempDir();
    await ok(other, home, ['init', '--name', 'other', '--description', 'other board']);
    const theirs = path.join(other, '.laneboard');
    for (const env of [{ LANEBOARD_DIR: theirs, LANEBOARD_DEFAULT_AGENT: 'claude-code@tester' }, { LANEBOARD_DIR: path.join(tempDir(), 'nothing', '.laneboard') }]) {
      const proj = tempDir();
      fs.mkdirSync(path.join(proj, '.claude'));
      const file = path.join(proj, '.claude', 'settings.local.json');
      fs.writeFileSync(file, JSON.stringify({ env }));
      const r = await run(proj, home, ['setup', 'claude-code']);
      expect(r.code).toBe(6);
      expect(r.json.error).toMatchObject({ code: 'SETUP_CONFLICT', fix: `laneboard setup claude-code --dir ${env.LANEBOARD_DIR}` });
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).env).toEqual(env);
    }
  });

  it('an empty folder at the old path holds no store either: the pin is replaced', async () => {
    const home = tempDir();
    const proj = tempDir();
    const empty = path.join(tempDir(), '.laneboard');
    fs.mkdirSync(empty);
    fs.mkdirSync(path.join(proj, '.claude'));
    fs.writeFileSync(path.join(proj, '.claude', 'settings.local.json'), JSON.stringify({ env: { LANEBOARD_DIR: empty, LANEBOARD_DEFAULT_AGENT: 'claude-code@tester' } }));
    await ok(proj, home, ['setup', 'claude-code']);
    expect(JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.local.json'), 'utf8')).env.LANEBOARD_DIR).toBe(path.join(proj, '.laneboard'));
  });
});

describe('A20: setup codex --remove keeps the global entry while another project may use it (newcomer F2)', () => {
  it('two projects with codex: --remove in one keeps ~/.codex/config.toml for the other; --global removes it', async () => {
    const home = tempDir();
    const [a, b] = [tempDir(), tempDir()];
    for (const [dir, name] of [[a, 'ca'], [b, 'cb']] as const) {
      await ok(dir, home, ['init', '--name', name, '--description', `codex ${name}`]);
      await ok(dir, home, ['setup', 'codex']);
    }
    const config = path.join(home, '.codex', 'config.toml');
    const before = fs.readFileSync(config, 'utf8');
    const r = await ok(a, home, ['setup', 'codex', '--remove']);
    expect(result(r, '~/.codex/config.toml')).toBe('kept');
    expect(result(r, 'AGENTS.md')).toBe('deleted');
    expect(r.warnings).toEqual([`kept the laneboard entry in ~/.codex/config.toml (a global file, other projects may use it: ${b}); laneboard setup codex --remove --global removes it`]);
    expect(fs.readFileSync(config, 'utf8')).toBe(before);
    const all = await ok(a, home, ['setup', 'codex', '--remove', '--global']);
    expect(result(all, '~/.codex/config.toml')).toBe('deleted');
    expect(fs.existsSync(config)).toBe(false);
  });

  it('a project of the registry without the AGENTS.md block, or whose board is gone, does not keep the entry', async () => {
    const home = tempDir();
    const [a, b, c] = [tempDir(), tempDir(), tempDir()];
    for (const dir of [a, b, c]) await ok(dir, home, ['init', '--description', 'codex']);
    await ok(a, home, ['setup', 'codex']);
    await ok(c, home, ['setup', 'codex']);
    fs.rmSync(path.join(c, '.laneboard'), { recursive: true });
    const r = await ok(a, home, ['setup', 'codex', '--remove']);
    expect(result(r, '~/.codex/config.toml')).toBe('deleted');
  });

  it('this project\'s own store in the registry does not keep the entry when setup ran with --dir another store', async () => {
    const home = tempDir();
    const proj = tempDir();
    const other = path.join(tempDir(), '.laneboard');
    await ok(proj, home, ['init', '--description', 'own store']);
    await ok(proj, home, ['setup', 'codex', '--dir', other]);
    const r = await ok(proj, home, ['setup', 'codex', '--remove', '--dir', other]);
    expect(result(r, '~/.codex/config.toml')).toBe('deleted');
    expect(r.warnings).toEqual([]);
  });

  it('a registry that cannot be read keeps the entry (it cannot tell who uses it)', async () => {
    const home = tempDir();
    const a = tempDir();
    await ok(a, home, ['setup', 'codex']);
    fs.mkdirSync(path.join(home, '.laneboard'), { recursive: true });
    fs.writeFileSync(registryFile(home), '{ broken');
    const r = await ok(a, home, ['setup', 'codex', '--remove']);
    expect(result(r, '~/.codex/config.toml')).toBe('kept');
    expect(r.warnings[0]).toContain('other projects may use it: (the machine registry cannot be read)');
  });

  it('--global without --remove is USAGE and writes nothing', async () => {
    const home = tempDir();
    const a = tempDir();
    const r = await run(a, home, ['setup', 'codex', '--global']);
    expect(r.code).toBe(2);
    expect(r.json.error).toMatchObject({ code: 'USAGE', message: '--global goes with --remove: it also removes the entry from a global file other projects may use' });
    expect(fs.readdirSync(a)).toEqual([]);
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
  });
});

describe('A21: a registry folder that cannot be written is a warning (newcomer F3)', () => {
  const warning = (home: string): string =>
    `this board is not in the machine registry (${path.join(home, '.laneboard')} cannot be written: EACCES), so laneboard boards does not list it and its prefix was checked only against the boards listed there; ` +
    'once that folder is writable, laneboard config --name <name> in the project adds it';

  it('read-only HOME: init and config exit 0 with the warning; init says registered false', async () => {
    const home = tempDir();
    const proj = tempDir();
    fs.chmodSync(home, 0o555);
    try {
      const init = await ok(proj, home, ['init', '--name', 'ro', '--description', 'read-only home']);
      expect(init.data).toMatchObject({ registered: false });
      expect(init.warnings).toContain(warning(home));
      expect(fs.existsSync(path.join(proj, '.laneboard', 'config.json'))).toBe(true);
      const config = await ok(proj, home, ['config', '--name', 'ro2']);
      expect(config.warnings).toContain(warning(home));
    } finally {
      fs.chmodSync(home, 0o755);
    }
    expect(fs.existsSync(path.join(home, '.laneboard'))).toBe(false);
  });

  it('a registry folder without write permission (the lock cannot be made): config and setup warn, the registry stays as it was', async () => {
    const home = tempDir();
    const proj = tempDir();
    await ok(proj, home, ['init', '--name', 'rw', '--description', 'registry']);
    const dir = path.join(home, '.laneboard');
    const before = fs.readFileSync(registryFile(home), 'utf8');
    fs.chmodSync(dir, 0o555);
    try {
      expect((await ok(proj, home, ['config', '--name', 'rw2'])).warnings).toContain(warning(home));
      expect((await ok(proj, home, ['setup', 'claude-code'])).warnings).toContain(warning(home));
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    expect(fs.readFileSync(registryFile(home), 'utf8')).toBe(before);
  });

  it('a prefix the readable registry knows is still refused in a read-only registry', async () => {
    const home = tempDir();
    await ok(tempDir(), home, ['init', '--prefix', 'TAKEN', '--description', 'first']);
    const dir = path.join(home, '.laneboard');
    fs.chmodSync(dir, 0o555);
    try {
      const r = await run(tempDir(), home, ['init', '--prefix', 'TAKEN', '--description', 'second']);
      expect(r.json.error).toMatchObject({ code: 'INVALID_VALUE' });
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it('updateRegistry: without onUnwritable the error stays; an error of the command itself is never taken for the registry folder', async () => {
    const home = tempDir();
    fs.chmodSync(home, 0o555);
    try {
      await expect(updateRegistry(home, {}, (entries) => ({ entries, result: 1 }))).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      fs.chmodSync(home, 0o755);
    }
    const warnings: string[] = [];
    let calls = 0;
    const own = Object.assign(new Error('the command failed'), { code: 'EACCES' });
    const failing = updateRegistry(home, { onUnwritable: (w) => warnings.push(w) }, () => {
      calls += 1;
      throw own;
    });
    await expect(failing).rejects.toBe(own);
    expect([calls, warnings]).toEqual([1, []]);
  });
});

describe('A22: backups and folder markers stay out of git (newcomer F6, F11)', () => {
  it('setup claude-code and cursor in a project with files: git add -A -n lists no .laneboard.bak and no .laneboard-created', async () => {
    const home = tempDir();
    const proj = repo(home);
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# P\n');
    fs.writeFileSync(path.join(proj, '.mcp.json'), '{}\n');
    fs.writeFileSync(path.join(proj, 'AGENTS.md'), '# A\n');
    const cc = await ok(proj, home, ['setup', 'claude-code']);
    expect(cc.warnings).toContain('wrote CLAUDE.md.laneboard.bak (your file before setup; setup --remove restores it); .git/info/exclude keeps it out of git');
    await ok(proj, home, ['setup', 'cursor']);
    expect(fs.existsSync(path.join(proj, 'AGENTS.md.laneboard.bak'))).toBe(true);
    expect(fs.existsSync(path.join(proj, '.cursor', '.laneboard-created'))).toBe(true);
    const added = git(proj, home, ['add', '-A', '-n']);
    expect(added).toContain("add 'AGENTS.md'");
    expect(added).not.toContain('laneboard.bak');
    expect(added).not.toContain('.laneboard-created');
    expect(added).not.toContain('settings.local.json');
  });

  it.each(['codex', 'cursor', 'gemini', 'opencode'])('%s writes the exclude block in a git repository; git\'s default exclude gets no backup; --remove gives it back', async (harness) => {
    const home = tempDir();
    const proj = repo(home);
    const exclude = path.join(proj, '.git', 'info', 'exclude');
    const original = fs.readFileSync(exclude, 'utf8');
    const r = await ok(proj, home, ['setup', harness]);
    expect(result(r, '.git/info/exclude')).toBe('updated');
    expect(fs.readFileSync(exclude, 'utf8')).toContain('# laneboard:start\n# backups of your files (laneboard setup --remove restores them) and markers of folders laneboard setup made\n*.laneboard.bak\n.laneboard-created\n');
    expect(fs.existsSync(`${exclude}.laneboard.bak`)).toBe(false);
    expect(r.warnings.filter((w) => w.includes('exclude'))).toEqual([]);
    await ok(proj, home, ['setup', harness, '--remove', '--global']);
    expect(fs.readFileSync(exclude, 'utf8')).toBe(original);
  });

  it('an exclude file with patterns of its own still gets its backup (restored byte for byte)', async () => {
    const home = tempDir();
    const proj = repo(home);
    const exclude = path.join(proj, '.git', 'info', 'exclude');
    fs.writeFileSync(exclude, '# mine\n*.log\n');
    const r = await ok(proj, home, ['setup', 'cursor']);
    expect(fs.readFileSync(`${exclude}.laneboard.bak`, 'utf8')).toBe('# mine\n*.log\n');
    expect(r.warnings).toContain('wrote .git/info/exclude.laneboard.bak (your file before setup; setup --remove restores it)');
    await ok(proj, home, ['setup', 'cursor', '--remove']);
    expect(fs.readFileSync(exclude, 'utf8')).toBe('# mine\n*.log\n');
  });

  it('outside a git repository the backup advice stays', async () => {
    const home = tempDir();
    const proj = tempDir();
    fs.writeFileSync(path.join(proj, 'AGENTS.md'), '# A\n');
    const r = await ok(proj, home, ['setup', 'cursor']);
    expect(r.warnings.filter((w) => w.includes('.laneboard.bak'))).toEqual(['wrote AGENTS.md.laneboard.bak (your file before setup; setup --remove restores it); do not commit it: add *.laneboard.bak to .gitignore']);
  });

  it('the shared exclude block stays while another harness is set up, and goes with the last one', async () => {
    const home = tempDir();
    const proj = repo(home);
    await ok(proj, home, ['setup', 'cursor']);
    await ok(proj, home, ['setup', 'gemini']);
    const first = await ok(proj, home, ['setup', 'cursor', '--remove']);
    expect(result(first, '.git/info/exclude')).toBe('kept');
    expect(first.warnings).toContain('kept the laneboard block in .git/info/exclude: gemini still uses it (laneboard setup gemini --remove removes it)');
    // AGENTS.md of cursor is not gemini's file, so it goes; the exclude block alone does not count as gemini or cursor being set up.
    expect(result(first, 'AGENTS.md')).toBe('deleted');
    const last = await ok(proj, home, ['setup', 'gemini', '--remove']);
    expect(result(last, '.git/info/exclude')).toBe('removed');
  });

  it('codex set up in another project only (a global ~/.codex/config.toml): --remove of claude-code here takes the exclude block out', async () => {
    const home = tempDir();
    const [a, b] = [repo(home), repo(home)];
    await ok(a, home, ['init', '--description', 'a']);
    await ok(b, home, ['init', '--description', 'b']);
    await ok(a, home, ['setup', 'claude-code']);
    await ok(b, home, ['setup', 'codex']);
    const r = await ok(a, home, ['setup', 'claude-code', '--remove']);
    expect(result(r, '.git/info/exclude')).toBe('removed');
    expect(r.warnings.filter((w) => w.includes('exclude'))).toEqual([]);
    expect(fs.readFileSync(path.join(a, '.git', 'info', 'exclude'), 'utf8')).not.toContain('laneboard');
    expect(fs.existsSync(path.join(home, '.codex', 'config.toml'))).toBe(true);
  });

  it('an empty exclude file (0 bytes) is given back empty by --remove, not deleted', async () => {
    const home = tempDir();
    const proj = repo(home);
    const exclude = path.join(proj, '.git', 'info', 'exclude');
    fs.writeFileSync(exclude, '');
    await ok(proj, home, ['setup', 'gemini']);
    const r = await ok(proj, home, ['setup', 'gemini', '--remove']);
    expect(result(r, '.git/info/exclude')).toBe('restored');
    expect(fs.readFileSync(exclude, 'utf8')).toBe('');
  });

  it('a 0.3.1 exclude block (two lines) is laneboard\'s: updated to the new body', async () => {
    const home = tempDir();
    const proj = repo(home);
    const exclude = path.join(proj, '.git', 'info', 'exclude');
    fs.writeFileSync(exclude, "# laneboard:start\n# .claude/settings.local.json holds this machine's store path and your name (laneboard setup claude-code)\n**/.claude/settings.local.json\n# laneboard:end\n");
    await ok(proj, home, ['setup', 'cursor']);
    expect(fs.readFileSync(exclude, 'utf8')).toContain('*.laneboard.bak\n.laneboard-created\n');
  });
});

describe('CARRYOVER S6b-r2: a file shared through a link is one file for --remove and its backup is named where it lies', () => {
  it('CLAUDE.md -> AGENTS.md: the backup warning names AGENTS.md.laneboard.bak; codex --remove keeps the block claude-code still uses', async () => {
    const home = tempDir();
    const proj = tempDir();
    fs.writeFileSync(path.join(proj, 'AGENTS.md'), '# Agents\n');
    fs.symlinkSync('AGENTS.md', path.join(proj, 'CLAUDE.md'));
    const cc = await ok(proj, home, ['setup', 'claude-code']);
    expect(cc.warnings).toContain('wrote AGENTS.md.laneboard.bak (your file before setup; setup --remove restores it); do not commit it: add *.laneboard.bak to .gitignore');
    expect(fs.existsSync(path.join(proj, 'CLAUDE.md.laneboard.bak'))).toBe(false);
    await ok(proj, home, ['setup', 'codex']);
    const r = await ok(proj, home, ['setup', 'codex', '--remove']);
    expect(result(r, 'AGENTS.md')).toBe('kept');
    expect(r.warnings).toContain('kept the laneboard block in AGENTS.md: claude-code still uses it (laneboard setup claude-code --remove removes it)');
    expect(fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8')).toContain('<!-- laneboard:start -->');
  });
});

describe('A23: boards --forget drops an entry whose path holds no store (LB-26)', () => {
  it('by path or by prefix: only entries without a store go, a live one with the same prefix stays with a warning', async () => {
    const home = tempDir();
    const [a, b] = [tempDir(), tempDir()];
    await ok(a, home, ['init', '--prefix', 'GONE', '--description', 'a']);
    await ok(b, home, ['init', '--prefix', 'KEEP', '--description', 'b']);
    fs.rmSync(path.join(a, '.laneboard'), { recursive: true });
    const r = await ok(tempDir(), home, ['boards', '--forget', 'gone']);
    expect(r.data).toEqual({ registry: registryFile(home), forgotten: [{ path: path.join(a, '.laneboard'), prefix: 'GONE', name: path.basename(a) }] });
    expect(readRegistry(home).map((e) => e.prefix)).toEqual(['KEEP']);
    // The project folder names its entry too; a live board is never dropped.
    const live = await run(b, home, ['boards', '--forget', b]);
    expect(live.code).toBe(2);
    expect(live.json.error).toMatchObject({ code: 'INVALID_VALUE', details: { path: path.join(b, '.laneboard'), prefix: 'KEEP' } });
    // An agent may run the fix blindly: it never moves or deletes the live board.
    expect(live.json.error?.fix).toBe('nothing to do: a live board stays listed; laneboard boards shows the entries marked missing, the only ones --forget drops');
    expect(live.json.error?.fix).not.toMatch(/delete|move|\brm\b|mv\b/);
    expect(readRegistry(home).map((e) => e.prefix)).toEqual(['KEEP']);
  });

  it('a prefix of a moved board and its live copy: the missing entry goes, the live one is kept with a warning', async () => {
    const home = tempDir();
    const parent = tempDir();
    const old = path.join(parent, 'p');
    fs.mkdirSync(old);
    await ok(old, home, ['init', '--prefix', 'MOVE', '--description', 'm']);
    fs.renameSync(old, path.join(parent, 'p2'));
    await ok(path.join(parent, 'p2'), home, ['config', '--name', 'p2']);
    const r = await ok(parent, home, ['boards', '--forget', 'MOVE']);
    expect((r.data.forgotten as Array<{ path: string }>).map((f) => f.path)).toEqual([path.join(old, '.laneboard')]);
    expect(r.warnings).toEqual([`kept ${path.join(parent, 'p2', '.laneboard')} (MOVE): it still holds a store, and forget drops only entries without one`]);
    expect(readRegistry(home).map((e) => e.path)).toEqual([path.join(parent, 'p2', '.laneboard')]);
  });

  it('a value that names no entry: STORE_NOT_FOUND with the prefixes; an empty registry is not created for it', async () => {
    const home = tempDir();
    const none = await run(tempDir(), home, ['boards', '--forget', 'NOPE']);
    expect(none.code).toBe(6);
    expect(none.json.error).toMatchObject({ code: 'STORE_NOT_FOUND' });
    expect(fs.existsSync(path.join(home, '.laneboard'))).toBe(false);
    await ok(tempDir(), home, ['init', '--prefix', 'ONE', '--description', 'one']);
    const miss = await run(tempDir(), home, ['boards', '--forget', 'NOPE']);
    expect(miss.json.error).toMatchObject({ code: 'STORE_NOT_FOUND', allowed: ['ONE'] });
  });
});

describe('A23 + A21: boards --forget with a registry folder that cannot be written', () => {
  it('a plain STORE_READ_ONLY error (not INTERNAL) naming the folder; the registry stays as it was', async () => {
    const home = tempDir();
    const a = tempDir();
    await ok(a, home, ['init', '--prefix', 'GONE', '--description', 'a']);
    fs.rmSync(path.join(a, '.laneboard'), { recursive: true });
    const dir = path.join(home, '.laneboard');
    const before = fs.readFileSync(registryFile(home), 'utf8');
    fs.chmodSync(dir, 0o555);
    try {
      const r = await run(tempDir(), home, ['boards', '--forget', 'GONE']);
      expect(r.code).toBe(6);
      expect(r.json.error).toMatchObject({
        code: 'STORE_READ_ONLY',
        message: `--forget GONE: the machine registry ${dir} cannot be written, so nothing was forgotten`,
        fix: `make ${dir} writable, then run laneboard boards --forget GONE again`,
      });
      // A value that names nothing is still STORE_NOT_FOUND.
      expect((await run(tempDir(), home, ['boards', '--forget', 'NOPE'])).json.error).toMatchObject({ code: 'STORE_NOT_FOUND' });
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    expect(fs.readFileSync(registryFile(home), 'utf8')).toBe(before);
  });
});

describe('A24: the edit reminder follows every file edit tool (newcomer F12)', () => {
  it('setup writes the matcher; a 0.3.1 entry (Edit|Write) is updated in place, not added twice', async () => {
    expect(EDIT_HOOK_MATCHER).toBe('Edit|Write|MultiEdit|NotebookEdit');
    const home = tempDir();
    const proj = tempDir();
    await ok(proj, home, ['setup', 'claude-code']);
    const file = path.join(proj, '.claude', 'settings.json');
    const read = (): Array<{ matcher: string }> => JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PostToolUse;
    expect(read().map((e) => e.matcher)).toEqual(['Edit|Write|MultiEdit|NotebookEdit']);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Edit|Write|MultiEdit|NotebookEdit', 'Edit|Write'));
    const r = await ok(proj, home, ['setup', 'claude-code']);
    expect(result(r, '.claude/settings.json')).toBe('updated');
    expect(read().map((e) => e.matcher)).toEqual(['Edit|Write|MultiEdit|NotebookEdit']);
  });
});
