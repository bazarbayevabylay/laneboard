// S6s (LB-43): `setup claude-code` writes no machine path into a committed .claude/settings.json. In a package of a git repository (or
// a linked worktree) pinned to the repository's own board, the env goes to the repository root's .claude/settings.local.json, which
// Claude Code reads for every folder of the repository and git does not see (.git/info/exclude); the package keeps only the hooks.
// A pin an earlier setup left in .claude/settings.json moves out of it; --remove takes our env out of both files.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTemp, cli, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

// git isolated from the user's config.
function gitIn(dir: string): (args: string[]) => string {
  const home = tempDir();
  const config = path.join(home, '.gitconfig');
  fs.writeFileSync(config, '');
  return (args) => {
    const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: path.join(home, '.config') };
    return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, env, encoding: 'utf8' }).trim();
  };
}

// Run the CLI with --json in `cwd`; exit code and the parsed envelope.
async function json(cwd: string, argv: string[], env: Record<string, string>): Promise<{ code: number; doc: Record<string, any> }> {
  const r = await cli([...argv, '--json'], { cwd, env });
  return { code: r.code, doc: JSON.parse(r.stdout) };
}

interface Mono {
  root: string;
  web: string;
  store: string;
  env: Record<string, string>;
  rootLocal: string;
  webSettings: string;
  git: (args: string[]) => string;
}

// A real git repository (one commit) with the board MONO at its root and packages/web holding its own AGENTS.md and package.json.
async function monorepo(): Promise<Mono> {
  const root = tempDir();
  const git = gitIn(root);
  git(['init', '-q', '-b', 'main']);
  const web = path.join(root, 'packages', 'web');
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, 'AGENTS.md'), '# web package\n');
  fs.writeFileSync(path.join(web, 'package.json'), '{ "name": "web" }\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'first']);
  const env = { HOME: tempDir(), USER: 'tester' };
  expect((await json(root, ['init', '--name', 'mono', '--prefix', 'MONO', '--description', 'the monorepo'], env)).code).toBe(0);
  return { root, web, store: path.join(root, '.laneboard'), env, rootLocal: path.join(root, '.claude', 'settings.local.json'), webSettings: path.join(web, '.claude', 'settings.json'), git };
}

// Parsed JSON file.
function read(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Every file of the working tree git would commit (changed or untracked, not ignored) whose text holds `needle`.
function committableWith(m: Mono, needle: string): string[] {
  const status = m.git(['status', '--porcelain', '--untracked-files=all']);
  return status
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => l.slice(3))
    .filter((f) => !f.startsWith('.laneboard/'))
    .filter((f) => fs.readFileSync(path.join(m.root, f), 'utf8').includes(needle));
}

describe('a package of a monorepo pinned to the repository board', () => {
  it('the env goes to the root settings.local.json; nothing git would commit holds the machine path; a second run changes nothing', async () => {
    const m = await monorepo();
    const r = await json(m.web, ['setup', 'claude-code'], m.env);
    expect(r.code, JSON.stringify(r.doc)).toBe(0);
    expect(r.doc.data.store).toBe(m.store);
    expect(read(m.rootLocal).env).toEqual({ LANEBOARD_DIR: m.store, LANEBOARD_DEFAULT_AGENT: 'claude-code@tester' });
    const settings = fs.readFileSync(m.webSettings, 'utf8');
    expect(settings).toContain('laneboard prime --hook');
    expect(settings).not.toContain(m.root);
    expect(read(m.webSettings).env).toBeUndefined();
    expect(fs.existsSync(path.join(m.web, '.claude', 'settings.local.json'))).toBe(false);
    const block = fs.readFileSync(path.join(m.web, 'CLAUDE.md'), 'utf8');
    expect(block).toContain('pinned by LANEBOARD_DIR in .claude/settings.local.json at the root of this git repository');
    expect(block).not.toContain(m.root);
    expect(r.doc.data.files.map((f: { path: string; result: string }) => [f.path, f.result])).toEqual([
      ['.mcp.json', 'created'],
      ['CLAUDE.md', 'created'],
      ['.claude/settings.json', 'created'],
      [m.rootLocal, 'created'],
      [path.join(m.root, '.git', 'info', 'exclude'), 'updated'],
    ]);
    // Persona C: git sees the package's files, none of them with this machine's path; the root's local file is not seen at all.
    expect(committableWith(m, m.root)).toEqual([]);
    expect(m.git(['status', '--porcelain', '--untracked-files=all'])).not.toContain('settings.local.json');
    const again = await json(m.web, ['setup', 'claude-code'], m.env);
    expect(again.doc.data.files.map((f: { result: string }) => f.result)).toEqual(['unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged']);
    // The session in the package reads the root's pin: prime there names the board.
    expect((await json(m.web, ['prime'], { ...m.env, LANEBOARD_DIR: read(m.rootLocal).env.LANEBOARD_DIR })).doc.store).toBe(m.store);
  });

  it('--dry-run names both files (the package settings.json and the root local file) and writes nothing', async () => {
    const m = await monorepo();
    const r = await json(m.web, ['setup', 'claude-code', '--dry-run'], m.env);
    expect(r.code).toBe(0);
    const paths = r.doc.data.files.map((f: { path: string }) => f.path);
    expect(paths).toContain('.claude/settings.json');
    expect(paths).toContain(m.rootLocal);
    expect(fs.existsSync(path.join(m.root, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(m.web, '.claude'))).toBe(false);
  });

  it('--remove takes our env out of the root local file and the hooks out of the package; folders setup made go too', async () => {
    const m = await monorepo();
    expect((await json(m.web, ['setup', 'claude-code'], m.env)).code).toBe(0);
    const r = await json(m.web, ['setup', 'claude-code', '--remove', '--dry-run'], m.env);
    expect(r.doc.data.files.map((f: { path: string; result: string }) => [f.path, f.result])).toContainEqual([m.rootLocal, 'deleted']);
    expect((await json(m.web, ['setup', 'claude-code', '--remove'], m.env)).code).toBe(0);
    expect(fs.existsSync(m.rootLocal)).toBe(false);
    expect(fs.existsSync(path.join(m.root, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(m.web, '.claude'))).toBe(false);
    expect(m.git(['status', '--porcelain', '--untracked-files=all'])).toBe('');
    // Setup stands nowhere else in the repository: the exclude block goes too.
    expect(fs.readFileSync(path.join(m.root, '.git', 'info', 'exclude'), 'utf8')).not.toContain('laneboard');
  });

  it('a pin an earlier setup left in the package settings.json moves to the root local file; other keys stay; --remove gives the file back', async () => {
    const m = await monorepo();
    // As 0.3.x wrote it: the hooks and both env keys next to the user's own keys.
    const old = await json(m.web, ['setup', 'claude-code'], m.env);
    expect(old.code).toBe(0);
    fs.rmSync(m.rootLocal);
    const original = '{\n  "model": "opus",\n  "env": { "FOO": "1" }\n}\n';
    const withPin = {
      ...JSON.parse(original),
      env: { FOO: '1', LANEBOARD_DIR: m.store, LANEBOARD_DEFAULT_AGENT: 'claude-code@someone' },
      hooks: read(m.webSettings).hooks,
    };
    fs.writeFileSync(m.webSettings, `${JSON.stringify(withPin, null, 2)}\n`);
    fs.writeFileSync(`${m.webSettings}.laneboard.bak`, original);
    const r = await json(m.web, ['setup', 'claude-code'], m.env);
    expect(r.code, JSON.stringify(r.doc)).toBe(0);
    expect(read(m.webSettings)).toEqual({ model: 'opus', env: { FOO: '1' }, hooks: withPin.hooks });
    expect(read(m.rootLocal).env).toEqual({ LANEBOARD_DIR: m.store, LANEBOARD_DEFAULT_AGENT: 'claude-code@tester' });
    expect(r.doc.warnings).toContain(
      `.claude/settings.json held the store pin of an earlier laneboard setup (LANEBOARD_DIR=${m.store}, LANEBOARD_DEFAULT_AGENT), a machine path in a committed file; setup moved the env to ${m.rootLocal} (kept out of git) and left the rest of .claude/settings.json as it was: commit that change`,
    );
    expect((await json(m.web, ['setup', 'claude-code', '--remove'], m.env)).code).toBe(0);
    expect(fs.readFileSync(m.webSettings, 'utf8')).toBe(original);
    expect(fs.existsSync(m.rootLocal)).toBe(false);
  });

  it('review C2: --dry-run over an old pin in settings.json says it would move the env and moves nothing', async () => {
    const m = await monorepo();
    expect((await json(m.web, ['setup', 'claude-code'], m.env)).code).toBe(0);
    fs.rmSync(m.rootLocal);
    const withPin = { env: { LANEBOARD_DIR: m.store, LANEBOARD_DEFAULT_AGENT: 'claude-code@someone' }, hooks: read(m.webSettings).hooks };
    fs.writeFileSync(m.webSettings, `${JSON.stringify(withPin, null, 2)}\n`);
    const before = fs.readFileSync(m.webSettings, 'utf8');
    const r = await json(m.web, ['setup', 'claude-code', '--dry-run'], m.env);
    expect(r.code, JSON.stringify(r.doc)).toBe(0);
    expect(r.doc.warnings).toContain(
      `.claude/settings.json holds the store pin of an earlier laneboard setup (LANEBOARD_DIR=${m.store}, LANEBOARD_DEFAULT_AGENT), a machine path in a committed file; setup would move the env to ${m.rootLocal} (kept out of git) and leave the rest of .claude/settings.json as it is: commit that change after setup`,
    );
    expect(r.doc.warnings.join('\n')).not.toContain('setup moved');
    expect(fs.readFileSync(m.webSettings, 'utf8')).toBe(before);
    expect(fs.existsSync(m.rootLocal)).toBe(false);
  });

  it('--remove takes an old pin out of the package settings.json too (an install of 0.3.x never re-run)', async () => {
    const m = await monorepo();
    expect((await json(m.web, ['setup', 'claude-code'], m.env)).code).toBe(0);
    const settings = read(m.webSettings);
    fs.writeFileSync(m.webSettings, `${JSON.stringify({ ...settings, theme: 'dark', env: { LANEBOARD_DIR: m.store, LANEBOARD_DEFAULT_AGENT: 'claude-code@x' } }, null, 2)}\n`);
    expect((await json(m.web, ['setup', 'claude-code', '--remove'], m.env)).code).toBe(0);
    expect(read(m.webSettings)).toEqual({ theme: 'dark' });
    expect(fs.existsSync(m.rootLocal)).toBe(false);
  });

  it("a stale pin (the repository moved) in the package settings.json moves too; a user's own LANEBOARD_DIR there (one key) stays", async () => {
    const m = await monorepo();
    fs.mkdirSync(path.join(m.web, '.claude'));
    const gone = path.join(tempDir(), 'old-place', '.laneboard');
    fs.writeFileSync(m.webSettings, JSON.stringify({ env: { LANEBOARD_DIR: gone, LANEBOARD_DEFAULT_AGENT: 'claude-code@me' } }));
    const r = await json(m.web, ['setup', 'claude-code'], m.env);
    expect(r.code, JSON.stringify(r.doc)).toBe(0);
    expect(read(m.webSettings).env).toBeUndefined();
    expect(read(m.rootLocal).env.LANEBOARD_DIR).toBe(m.store);
    // One key of the user's, naming this very board: not setup's, so it stays (no conflict either).
    fs.writeFileSync(m.webSettings, JSON.stringify({ env: { LANEBOARD_DIR: m.store } }));
    expect((await json(m.web, ['setup', 'claude-code'], m.env)).code).toBe(0);
    expect(read(m.webSettings).env).toEqual({ LANEBOARD_DIR: m.store });
  });

  it("the root local file pinning another store is the user's: SETUP_CONFLICT naming that file, nothing written", async () => {
    const m = await monorepo();
    fs.mkdirSync(path.join(m.root, '.claude'));
    const theirs = '/shared/team/.laneboard';
    fs.writeFileSync(m.rootLocal, JSON.stringify({ env: { LANEBOARD_DIR: theirs } }));
    const r = await json(m.web, ['setup', 'claude-code'], m.env);
    expect(r.code).toBe(6);
    expect(r.doc.error).toMatchObject({ code: 'SETUP_CONFLICT', details: { file: m.rootLocal, value: theirs }, fix: `laneboard setup claude-code --dir ${theirs}` });
    expect(fs.existsSync(path.join(m.web, '.claude'))).toBe(false);
  });

  it('a .claude link at the repository root leading outside is refused, never written through', async () => {
    const m = await monorepo();
    const outside = tempDir();
    fs.symlinkSync(outside, path.join(m.root, '.claude'));
    const r = await json(m.web, ['setup', 'claude-code'], m.env);
    expect(r.code).toBe(6);
    expect(r.doc.error.code).toBe('SETUP_CONFLICT');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe('where the env stays in the package settings.json (controls)', () => {
  it('another board inside the repository (packages/x) would get the root pin: the package keeps its env, as before', async () => {
    const m = await monorepo();
    const x = path.join(m.root, 'packages', 'x');
    fs.mkdirSync(x, { recursive: true });
    expect((await json(x, ['init', '--dir', path.join(x, '.laneboard'), '--description', 'x'], m.env)).code).toBe(0);
    expect((await json(m.web, ['setup', 'claude-code'], m.env)).code).toBe(0);
    expect(fs.existsSync(m.rootLocal)).toBe(false);
    expect(read(m.webSettings).env.LANEBOARD_DIR).toBe(m.store);
  });

  it('a package pinned to a store outside the repository keeps its env in its settings.json (also with no board at the root)', async () => {
    const m = await monorepo();
    const elsewhere = path.join(tempDir(), '.laneboard');
    expect((await json(m.web, ['setup', 'claude-code', '--dir', elsewhere], m.env)).code).toBe(0);
    expect(fs.existsSync(m.rootLocal)).toBe(false);
    expect(read(m.webSettings).env.LANEBOARD_DIR).toBe(elsewhere);
    // No other board in the repository: the root local file would still pin every folder to a store not of this repository.
    const bare = await json(m.web, ['setup', 'claude-code', '--dir', elsewhere], { ...m.env, HOME: tempDir() });
    expect(bare.code).toBe(0);
    expect(fs.existsSync(m.rootLocal)).toBe(false);
  });
});

describe('a linked worktree and a plain project', () => {
  it("a linked worktree pinned to the main checkout's board: the env goes to the main checkout's local file", async () => {
    const m = await monorepo();
    const wt = path.join(tempDir(), 'wt');
    m.git(['worktree', 'add', '-q', wt, '-b', 'feat']);
    const r = await json(wt, ['setup', 'claude-code'], m.env);
    expect(r.code, JSON.stringify(r.doc)).toBe(0);
    expect(r.doc.data.store).toBe(m.store);
    expect(read(m.rootLocal).env.LANEBOARD_DIR).toBe(m.store);
    expect(read(path.join(wt, '.claude', 'settings.json')).env).toBeUndefined();
    expect(fs.existsSync(path.join(wt, '.claude', 'settings.local.json'))).toBe(false);
  });

  it('the root of a project: a pin an earlier setup left in its settings.json moves to its own local file', async () => {
    const m = await monorepo();
    fs.mkdirSync(path.join(m.root, '.claude'));
    const settings = path.join(m.root, '.claude', 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ env: { LANEBOARD_DIR: m.store, LANEBOARD_DEFAULT_AGENT: 'claude-code@old' } }));
    const r = await json(m.root, ['setup', 'claude-code'], m.env);
    expect(r.code, JSON.stringify(r.doc)).toBe(0);
    expect(read(settings).env).toBeUndefined();
    expect(read(m.rootLocal).env.LANEBOARD_DIR).toBe(m.store);
    expect(r.doc.warnings.some((w: string) => w.includes('setup moved the env to .claude/settings.local.json'))).toBe(true);
  });
});

describe('--remove in a package while setup stands at the repository root', () => {
  it('keeps the root local file and the exclude block (the root uses them), says so, and takes the package part out', async () => {
    const m = await monorepo();
    expect((await json(m.root, ['setup', 'claude-code'], m.env)).code).toBe(0);
    expect((await json(m.web, ['setup', 'claude-code'], m.env)).code).toBe(0);
    const local = fs.readFileSync(m.rootLocal, 'utf8');
    const exclude = path.join(m.root, '.git', 'info', 'exclude');
    const block = fs.readFileSync(exclude, 'utf8');
    const r = await json(m.web, ['setup', 'claude-code', '--remove'], m.env);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(m.rootLocal, 'utf8')).toBe(local);
    expect(fs.readFileSync(exclude, 'utf8')).toBe(block);
    expect(r.doc.warnings).toContain(`kept the laneboard entry in ${m.rootLocal}: setup in ${m.root} still uses it (laneboard setup <harness> --remove there removes it)`);
    expect(fs.existsSync(path.join(m.web, '.claude'))).toBe(false);
    expect(m.git(['status', '--porcelain', '--untracked-files=all']).split('\n').filter((l) => l.includes('settings.local.json'))).toEqual([]);
  });
});

describe('SETUP_CONFLICT follows the file Claude Code reads', () => {
  it("a linked worktree with a board of its own while the main checkout's local file pins the main board: refused, nothing written", async () => {
    const m = await monorepo();
    expect((await json(m.root, ['setup', 'claude-code'], m.env)).code).toBe(0);
    const wt = path.join(tempDir(), 'wt');
    m.git(['worktree', 'add', '-q', wt, '-b', 'feat']);
    expect((await json(wt, ['init', '--dir', path.join(wt, '.laneboard'), '--description', 'wt'], m.env)).code).toBe(0);
    const r = await json(wt, ['setup', 'claude-code'], m.env);
    expect(r.code).toBe(6);
    expect(r.doc.error).toMatchObject({ code: 'SETUP_CONFLICT', details: { file: m.rootLocal, value: m.store }, fix: `cd ${m.root} && laneboard setup claude-code && cd ${wt} && laneboard setup claude-code` });
    expect(fs.existsSync(path.join(wt, '.claude'))).toBe(false);
    // As the fix says: the main checkout sees the worktree's board, moves its env out of the local file, and the worktree pins its own.
    expect((await json(m.root, ['setup', 'claude-code'], m.env)).code).toBe(0);
    expect(fs.existsSync(m.rootLocal)).toBe(false);
    expect((await json(wt, ['setup', 'claude-code'], m.env)).code).toBe(0);
    expect(read(path.join(wt, '.claude', 'settings.json')).env.LANEBOARD_DIR).toBe(path.join(wt, '.laneboard'));
  });
});

// Review r1 (S6s): another board appears in the repository after setup in a package wrote the root local pin. The pin no longer
// applies there (ADR §14: a re-run takes our env out of the file that no longer applies), so re-running setup, setup in the new board's
// folder and --remove all take it out, unless setup stands at the root itself.
describe('another board appears in the repository after setup in a package', () => {
  // The monorepo after setup in packages/web (env in the root local file), then a board of its own in packages/b.
  async function withLaterBoard(): Promise<Mono & { b: string; bStore: string }> {
    const m = await monorepo();
    expect((await json(m.web, ['setup', 'claude-code'], m.env)).code).toBe(0);
    expect(read(m.rootLocal).env.LANEBOARD_DIR).toBe(m.store);
    const b = path.join(m.root, 'packages', 'b');
    fs.mkdirSync(b, { recursive: true });
    const bStore = path.join(b, '.laneboard');
    expect((await json(b, ['init', '--dir', bStore, '--name', 'b', '--prefix', 'BB', '--description', 'b'], m.env)).code).toBe(0);
    return { ...m, b, bStore };
  }

  const leftWarning = (m: Mono): string =>
    `${m.rootLocal} held the store pin of an earlier laneboard setup (LANEBOARD_DIR=${m.store}) that no longer applies there: another board lies in this repository and Claude Code would give that pin to its sessions too; setup took it out. Folders pinned to ${m.store} find it by walking up; laneboard setup claude-code there pins it again`;

  it('setup again in the package takes the pin out of the root local file and keeps its env in its settings.json; then setup in b works', async () => {
    const m = await withLaterBoard();
    const r = await json(m.web, ['setup', 'claude-code'], m.env);
    expect(r.code, JSON.stringify(r.doc)).toBe(0);
    expect(r.doc.data.files.map((f: { path: string; result: string }) => [f.path, f.result])).toContainEqual([m.rootLocal, 'deleted']);
    expect(r.doc.warnings).toContain(leftWarning(m));
    expect(fs.existsSync(m.rootLocal)).toBe(false);
    expect(read(m.webSettings).env.LANEBOARD_DIR).toBe(m.store);
    const again = await json(m.web, ['setup', 'claude-code'], m.env);
    expect(again.doc.data.files.map((f: { path: string }) => f.path)).not.toContain(m.rootLocal);
    const inB = await json(m.b, ['setup', 'claude-code'], m.env);
    expect(inB.code, JSON.stringify(inB.doc)).toBe(0);
    expect(read(path.join(m.b, '.claude', 'settings.json')).env.LANEBOARD_DIR).toBe(m.bStore);
    expect(fs.existsSync(m.rootLocal)).toBe(false);
  });

  it('setup in b right away: no SETUP_CONFLICT (no fix sending setup to the root), the left pin goes, sessions in b get no root LANEBOARD_DIR', async () => {
    const m = await withLaterBoard();
    const r = await json(m.b, ['setup', 'claude-code'], m.env);
    expect(r.code, JSON.stringify(r.doc)).toBe(0);
    expect(r.doc.data.store).toBe(m.bStore);
    expect(r.doc.warnings).toContain(leftWarning(m));
    expect(fs.existsSync(m.rootLocal)).toBe(false);
    expect(read(path.join(m.b, '.claude', 'settings.json')).env.LANEBOARD_DIR).toBe(m.bStore);
    // Nothing setup wrote at the root but the exclude block.
    expect(fs.existsSync(path.join(m.root, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(m.root, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(m.root, '.claude'))).toBe(false);
  });

  it('--remove in the package takes the pin out of the root local file, with no warning that setup at the root uses it', async () => {
    const m = await withLaterBoard();
    const r = await json(m.web, ['setup', 'claude-code', '--remove'], m.env);
    expect(r.code, JSON.stringify(r.doc)).toBe(0);
    expect(r.doc.data.files.map((f: { path: string; result: string }) => [f.path, f.result])).toContainEqual([m.rootLocal, 'deleted']);
    expect(fs.existsSync(m.rootLocal)).toBe(false);
    expect(fs.existsSync(path.join(m.root, '.claude'))).toBe(false);
    expect(r.doc.warnings.filter((w: string) => w.includes('still uses it'))).toEqual([]);
    expect(fs.readFileSync(path.join(m.root, '.git', 'info', 'exclude'), 'utf8')).not.toContain('laneboard');
    expect(m.git(['status', '--porcelain', '--untracked-files=all']).split('\n').filter((l) => l !== '' && !l.includes('packages/b/.laneboard'))).toEqual([]);
  });

  it('control: while setup stands at the root, the package leaves the root local file alone and b is still refused (that pin is the root setup\'s)', async () => {
    const m = await monorepo();
    expect((await json(m.root, ['setup', 'claude-code'], m.env)).code).toBe(0);
    expect((await json(m.web, ['setup', 'claude-code'], m.env)).code).toBe(0);
    const local = fs.readFileSync(m.rootLocal, 'utf8');
    const b = path.join(m.root, 'packages', 'b');
    fs.mkdirSync(b, { recursive: true });
    expect((await json(b, ['init', '--dir', path.join(b, '.laneboard'), '--description', 'b'], m.env)).code).toBe(0);
    const r = await json(m.web, ['setup', 'claude-code'], m.env);
    expect(r.code, JSON.stringify(r.doc)).toBe(0);
    expect(fs.readFileSync(m.rootLocal, 'utf8')).toBe(local);
    const inB = await json(b, ['setup', 'claude-code'], m.env);
    expect(inB.doc.error).toMatchObject({ code: 'SETUP_CONFLICT', fix: `cd ${m.root} && laneboard setup claude-code && cd ${b} && laneboard setup claude-code` });
  });

  it("control: the user's own LANEBOARD_DIR (one key) in the root local file stays", async () => {
    const m = await withLaterBoard();
    fs.writeFileSync(m.rootLocal, JSON.stringify({ env: { LANEBOARD_DIR: m.store } }));
    expect((await json(m.web, ['setup', 'claude-code'], m.env)).code).toBe(0);
    expect((await json(m.web, ['setup', 'claude-code', '--remove'], m.env)).code).toBe(0);
    expect(read(m.rootLocal)).toEqual({ env: { LANEBOARD_DIR: m.store } });
  });

  it('control: a pin of both keys to a store outside the repository in the root local file is not a left pin: SETUP_CONFLICT, kept', async () => {
    const m = await withLaterBoard();
    const elsewhere = path.join(tempDir(), '.laneboard');
    fs.writeFileSync(m.rootLocal, JSON.stringify({ env: { LANEBOARD_DIR: elsewhere, LANEBOARD_DEFAULT_AGENT: 'claude-code@x' } }));
    const before = fs.readFileSync(m.rootLocal, 'utf8');
    const r = await json(m.b, ['setup', 'claude-code'], m.env);
    expect(r.doc.error).toMatchObject({ code: 'SETUP_CONFLICT', details: { file: m.rootLocal, value: elsewhere } });
    expect(fs.readFileSync(m.rootLocal, 'utf8')).toBe(before);
  });

  it('control: with no other board the root pin still applies to the other packages: a package pinned elsewhere is refused, the pin stays', async () => {
    const m = await monorepo();
    expect((await json(m.web, ['setup', 'claude-code'], m.env)).code).toBe(0);
    const before = fs.readFileSync(m.rootLocal, 'utf8');
    const api = path.join(m.root, 'packages', 'api');
    fs.mkdirSync(api, { recursive: true });
    const r = await json(api, ['setup', 'claude-code', '--dir', path.join(tempDir(), '.laneboard')], m.env);
    expect(r.doc.error).toMatchObject({ code: 'SETUP_CONFLICT', details: { file: m.rootLocal, value: m.store } });
    expect(fs.readFileSync(m.rootLocal, 'utf8')).toBe(before);
  });

  it('a board inside the repository is seen when setup runs through a link to the repository (paths compared with links resolved)', async () => {
    const m = await monorepo();
    const b = path.join(m.root, 'packages', 'b');
    fs.mkdirSync(b, { recursive: true });
    expect((await json(b, ['init', '--dir', path.join(b, '.laneboard'), '--description', 'b'], m.env)).code).toBe(0);
    const link = path.join(tempDir(), 'mono-link');
    fs.symlinkSync(m.root, link);
    const r = await json(path.join(link, 'packages', 'web'), ['setup', 'claude-code'], m.env);
    expect(r.code, JSON.stringify(r.doc)).toBe(0);
    expect(fs.existsSync(m.rootLocal)).toBe(false);
    expect(read(m.webSettings).env.LANEBOARD_DIR).toBe(path.join(link, '.laneboard'));
  });
});
