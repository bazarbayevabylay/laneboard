// S6b: setup inside the project. A project file is read and written at its real path, and only when that path stays inside the project:
// a symlink whose end is outside it or nowhere, or a file that is not a regular file, is refused before anything is read or written
// (A2, security F1); a link inside the project (`CLAUDE.md -> AGENTS.md`) writes the file it ends at. Every read is bounded (a link to
// /dev/zero, a FIFO, a huge file); a path setup cannot read gets an error with its chmod. A marker counts only as a whole line and a
// block holding a line laneboard did not write is never replaced or removed (A4, security F5); blocks written by the 0.1.0 builds,
// 0.2.0 and 0.3.1 (fixtures/blocks) are still laneboard's.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { LaneboardError, shellQuote } from '../../src/core/index.ts';
import { applyPlan, MAX_TEXT_BYTES, planAdd, readText } from '../../src/setup/files.ts';
import { blockEdit, MD_MARKERS } from '../../src/setup/md-block.ts';
import { cleanupTemp, cli, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'blocks');

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

// Every entry under a folder: sha256 of each file, the target of each symlink, `<dir>` for directories.
function hashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) out[rel] = `link ${fs.readlinkSync(full)}`;
      else if (stat.isDirectory()) {
        out[`${rel}/`] = '<dir>';
        walk(full);
      } else out[rel] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

// Both folders of a sandbox.
function state(s: Sandbox): { project: Record<string, string>; home: Record<string, string> } {
  return { project: hashes(s.cwd), home: hashes(s.home) };
}

// Write a file (and its folders).
function put(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// The parsed `error` of a failed --json run.
async function fails(s: Sandbox, argv: string[], env?: Record<string, string>): Promise<{ code: string; message: string; fix: string; details: Record<string, unknown> }> {
  const r = await s.run([...argv, '--json'], env);
  expect(r.code, r.stdout).toBe(6);
  return JSON.parse(r.stdout).error;
}

// The data of a successful --json run.
async function ok(s: Sandbox, argv: string[], env?: Record<string, string>): Promise<{ files: Array<{ path: string; result: string }> }> {
  const r = await s.run([...argv, '--json'], env);
  expect(r.code, r.stdout).toBe(0);
  return JSON.parse(r.stdout).data;
}

// The user's dotfiles in HOME that a cloned repository links to.
const DOTFILES: Record<string, string> = {
  '.gitconfig': '[user]\n\tname = Dev\n',
  '.zshrc': 'export PATH=$HOME/bin:$PATH\n',
  '.claude/settings.json': '{\n  "model": "opus"\n}\n',
  '.cursor/mcp.json': '{"mcpServers":{}}\n',
  '.gemini/settings.json': '{\n  "theme": "dark"\n}\n',
  '.config/opencode/opencode.json': '{}\n',
  '.mcp-global.json': '{}\n',
};

// Per harness: the project path a clone holds as a symlink and the HOME entry it points to.
const LINKS: Array<{ harness: string; link: string; target: string }> = [
  { harness: 'claude-code', link: 'CLAUDE.md', target: '.zshrc' },
  { harness: 'claude-code', link: '.claude', target: '.claude' },
  { harness: 'claude-code', link: '.mcp.json', target: '.mcp-global.json' },
  { harness: 'codex', link: 'AGENTS.md', target: '.gitconfig' },
  { harness: 'cursor', link: 'AGENTS.md', target: '.gitconfig' },
  { harness: 'cursor', link: '.cursor', target: '.cursor' },
  { harness: 'gemini', link: 'GEMINI.md', target: '.zshrc' },
  { harness: 'gemini', link: '.gemini', target: '.gemini' },
  { harness: 'opencode', link: 'AGENTS.md', target: '.gitconfig' },
  { harness: 'opencode', link: 'opencode.json', target: '.config/opencode/opencode.json' },
];

describe('A2: setup never writes through a symlink in the project', () => {
  it.each(LINKS)('$harness with $link -> ~/$target: SETUP_CONFLICT (exit 6) naming the link and its target, no file anywhere changed', async ({ harness, link, target }) => {
    const s = sandbox();
    for (const [rel, text] of Object.entries(DOTFILES)) put(path.join(s.home, rel), text);
    fs.symlinkSync(path.join(s.home, target), path.join(s.cwd, link));
    const before = state(s);
    for (const argv of [['setup', harness], ['setup', harness, '--dry-run']]) {
      const err = await fails(s, argv);
      expect(err.code).toBe('SETUP_CONFLICT');
      const file = String(err.details.file);
      expect(file === link || file.startsWith(`${link}/`)).toBe(true);
      expect(err.message).toBe(
        `${link} is a symlink to ${path.join(s.home, target)}, which leads outside the project (${path.join(s.home, target)}); setup does not write ${file} through it (a cloned repository can point a link at your files); nothing was written`,
      );
      expect(err.details).toMatchObject({ link, target: path.join(s.home, target), resolved: path.join(s.home, target) });
      expect(err.fix).toContain(`replace the symlink ${path.join(s.cwd, link)} with a real ${fs.statSync(path.join(s.home, target)).isDirectory() ? 'folder' : 'file'}`);
      expect(state(s)).toEqual(before);
    }
  });

  it('--remove through a link to a file that holds a laneboard block (setup ran there before) is refused too: the target keeps its bytes', async () => {
    const s = sandbox();
    put(path.join(s.home, '.zshrc'), 'export A=1\n');
    fs.symlinkSync(path.join(s.home, '.zshrc'), path.join(s.cwd, 'CLAUDE.md'));
    const real = sandbox();
    await ok(real, ['setup', 'claude-code']);
    fs.appendFileSync(path.join(s.home, '.zshrc'), `\n${fs.readFileSync(path.join(real.cwd, 'CLAUDE.md'), 'utf8')}`);
    const before = state(s);
    const err = await fails(s, ['setup', 'claude-code', '--remove']);
    expect(err).toMatchObject({ code: 'SETUP_CONFLICT', details: { link: 'CLAUDE.md' } });
    expect(state(s)).toEqual(before);
  });

  it('a dangling link (CLAUDE.md -> a missing file outside) is refused: the target is not created', async () => {
    const s = sandbox();
    const target = path.join(s.home, '.ssh', 'authorized_keys');
    fs.mkdirSync(path.dirname(target));
    fs.symlinkSync(target, path.join(s.cwd, 'CLAUDE.md'));
    const err = await fails(s, ['setup', 'claude-code']);
    expect(err).toMatchObject({ code: 'SETUP_CONFLICT', details: { link: 'CLAUDE.md', target } });
    expect(err.message).toBe(`CLAUDE.md is a symlink to ${target}, which leads nowhere (ENOENT: a missing target or a loop); setup does not write CLAUDE.md through it; nothing was written`);
    expect(fs.existsSync(target)).toBe(false);
  });

  it.each([
    ['a dangling link inside the project (CLAUDE.md -> missing.md)', { 'CLAUDE.md': 'missing.md' }, 'CLAUDE.md'],
    ['a link loop (CLAUDE.md -> a -> CLAUDE.md)', { 'CLAUDE.md': 'a', a: 'CLAUDE.md' }, 'CLAUDE.md'],
    ['a dangling folder link (.claude -> conf/missing)', { '.claude': 'conf/missing' }, '.claude'],
  ])('%s is refused: nothing is created, the links stay', async (_name, links, link) => {
    const s = sandbox();
    for (const [from, to] of Object.entries(links)) fs.symlinkSync(to, path.join(s.cwd, from));
    const before = state(s);
    const err = await fails(s, ['setup', 'claude-code']);
    expect(err).toMatchObject({ code: 'SETUP_CONFLICT', details: { link } });
    expect(err.message).toContain('which leads nowhere');
    expect(state(s)).toEqual(before);
  });

  it.each([
    ['a chain that ends outside (CLAUDE.md -> l2 -> ~/.zshrc)', (s: Sandbox) => {
      fs.symlinkSync(path.join(s.home, '.zshrc'), path.join(s.cwd, 'l2'));
      fs.symlinkSync('l2', path.join(s.cwd, 'CLAUDE.md'));
    }, 'CLAUDE.md'],
    ['a relative link with .. out of the project (CLAUDE.md -> sub/../../outside/zshrc)', (s: Sandbox) => {
      fs.mkdirSync(path.join(s.cwd, 'sub'));
      fs.symlinkSync(`sub/../../${path.basename(s.home)}/.zshrc`, path.join(s.cwd, 'CLAUDE.md'));
    }, 'CLAUDE.md'],
    ['a folder link leaving the project whose file links back in (.claude -> ~/conf, ~/conf/settings.json -> project file)', (s: Sandbox) => {
      fs.mkdirSync(path.join(s.home, 'conf'));
      put(path.join(s.cwd, 'real-settings.json'), '{}\n');
      fs.symlinkSync(path.join(s.cwd, 'real-settings.json'), path.join(s.home, 'conf', 'settings.json'));
      fs.symlinkSync(path.join(s.home, 'conf'), path.join(s.cwd, '.claude'));
    }, '.claude'],
  ])('%s is refused (SETUP_CONFLICT), HOME and the project keep every byte', async (_name, plant, link) => {
    const s = sandbox();
    put(path.join(s.home, '.zshrc'), 'export A=1\n');
    plant(s);
    const before = state(s);
    const err = await fails(s, ['setup', 'claude-code']);
    expect(err).toMatchObject({ code: 'SETUP_CONFLICT', details: { link } });
    expect(err.message).toContain('which leads outside the project');
    expect(state(s)).toEqual(before);
  });

  it('CLAUDE.md -> AGENTS.md inside the project: the block goes into AGENTS.md with its backup, the link stays, --remove gives the bytes back', async () => {
    const s = sandbox();
    put(path.join(s.home, '.zshrc'), 'export A=1\n');
    const agents = path.join(s.cwd, 'AGENTS.md');
    put(agents, '# Agents\n');
    fs.symlinkSync('AGENTS.md', path.join(s.cwd, 'CLAUDE.md'));
    const home = hashes(s.home);
    const r = await ok(s, ['setup', 'claude-code']);
    expect(r.files.find((f) => f.path === 'CLAUDE.md')?.result).toBe('updated');
    expect(fs.readlinkSync(path.join(s.cwd, 'CLAUDE.md'))).toBe('AGENTS.md');
    expect(fs.readFileSync(agents, 'utf8')).toMatch(/^# Agents\n\n<!-- laneboard:start -->\n/);
    // The backup lies next to the real file (codex, writing AGENTS.md itself, finds the same one); none next to the link.
    expect(fs.readFileSync(`${agents}.laneboard.bak`, 'utf8')).toBe('# Agents\n');
    expect(fs.existsSync(path.join(s.cwd, 'CLAUDE.md.laneboard.bak'))).toBe(false);
    await ok(s, ['setup', 'claude-code', '--remove']);
    expect(fs.readFileSync(agents, 'utf8')).toBe('# Agents\n');
    expect(fs.existsSync(`${agents}.laneboard.bak`)).toBe(false);
    expect(fs.readlinkSync(path.join(s.cwd, 'CLAUDE.md'))).toBe('AGENTS.md');
    expect(hashes(s.home)).toEqual(home);
  });

  it('.claude -> conf/claude inside the project: settings are written in conf/claude, the link stays, --remove deletes only our file', async () => {
    const s = sandbox();
    fs.mkdirSync(path.join(s.cwd, 'conf', 'claude'), { recursive: true });
    fs.symlinkSync(path.join('conf', 'claude'), path.join(s.cwd, '.claude'));
    const home = hashes(s.home);
    await ok(s, ['setup', 'claude-code']);
    expect(fs.lstatSync(path.join(s.cwd, '.claude')).isSymbolicLink()).toBe(true);
    const settings = path.join(s.cwd, 'conf', 'claude', 'settings.json');
    expect(fs.lstatSync(settings).isFile()).toBe(true);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks).toBeDefined();
    await ok(s, ['setup', 'claude-code', '--remove']);
    expect(fs.existsSync(settings)).toBe(false);
    // The folder was the user's (no marker): it stays.
    expect(fs.readdirSync(path.join(s.cwd, 'conf', 'claude'))).toEqual([]);
    expect(hashes(s.home)).toEqual(home);
  });

  it('a backup path planted as a link (CLAUDE.md.laneboard.bak -> outside) is refused: setup never writes the user file through it', async () => {
    const s = sandbox();
    const target = path.join(s.home, '.ssh', 'authorized_keys');
    fs.mkdirSync(path.dirname(target));
    put(path.join(s.cwd, 'CLAUDE.md'), 'ssh-ed25519 AAAA attacker\n');
    fs.symlinkSync(target, path.join(s.cwd, 'CLAUDE.md.laneboard.bak'));
    const before = state(s);
    const err = await fails(s, ['setup', 'claude-code']);
    expect(err).toMatchObject({ code: 'SETUP_CONFLICT', details: { file: 'CLAUDE.md.laneboard.bak', link: 'CLAUDE.md.laneboard.bak', target } });
    expect(fs.existsSync(target)).toBe(false);
    expect(state(s)).toEqual(before);
  });

  it('a project file that is not a regular file (CLAUDE.md is a folder) is SETUP_CONFLICT, nothing written', async () => {
    const s = sandbox();
    fs.mkdirSync(path.join(s.cwd, 'CLAUDE.md'));
    const before = state(s);
    const err = await fails(s, ['setup', 'claude-code']);
    expect(err.code).toBe('SETUP_CONFLICT');
    expect(err.message).toBe('CLAUDE.md is not a regular file (a directory); nothing was written');
    expect(state(s)).toEqual(before);
  });

  it('the exclude file under a .git that is a link is refused (every step below the project is checked)', async () => {
    const s = sandbox();
    const realGit = tempDir();
    execFileSync('git', ['init', '-q', realGit]);
    fs.symlinkSync(path.join(realGit, '.git'), path.join(s.cwd, '.git'));
    const before = state(s);
    const err = await fails(s, ['setup', 'claude-code']);
    expect(err).toMatchObject({ code: 'SETUP_CONFLICT', details: { file: '.git/info/exclude', link: '.git' } });
    expect(state(s)).toEqual(before);
  });

  it('links above the project are fine: setup run in a folder reached through a symlink writes real files inside it', async () => {
    const s = sandbox();
    const link = path.join(tempDir(), 'via-link');
    fs.symlinkSync(s.cwd, link);
    const r = await cli(['setup', 'claude-code', '--json'], { cwd: link, env: { HOME: s.home } });
    expect(r.code, r.stdout).toBe(0);
    expect(fs.lstatSync(path.join(s.cwd, 'CLAUDE.md')).isFile()).toBe(true);
  });

  it('global files keep following links: a dotfiles-managed ~/.codex/config.toml is written in its target, --remove gives its bytes back', async () => {
    const s = sandbox();
    const dotfiles = path.join(s.home, 'dotfiles', 'codex.toml');
    put(dotfiles, 'model = "o4"\n');
    fs.mkdirSync(path.join(s.home, '.codex'));
    fs.symlinkSync(dotfiles, path.join(s.home, '.codex', 'config.toml'));
    const before = hashes(s.home);
    await ok(s, ['setup', 'codex']);
    expect(fs.lstatSync(path.join(s.home, '.codex', 'config.toml')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(dotfiles, 'utf8')).toContain('[mcp_servers.laneboard]');
    // The backup stays next to the link, out of the dotfiles folder.
    expect(fs.readFileSync(path.join(s.home, '.codex', 'config.toml.laneboard.bak'), 'utf8')).toBe('model = "o4"\n');
    await ok(s, ['setup', 'codex', '--remove']);
    expect(hashes(s.home)).toEqual(before);
  });

  it('a dangling global link (~/.codex/config.toml -> ~/dotfiles/codex.toml, not made yet) creates its target; --remove deletes it, the link stays', async () => {
    const s = sandbox();
    const dotfiles = path.join(s.home, 'dotfiles', 'codex.toml');
    fs.mkdirSync(path.dirname(dotfiles));
    fs.mkdirSync(path.join(s.home, '.codex'));
    fs.symlinkSync(dotfiles, path.join(s.home, '.codex', 'config.toml'));
    const before = hashes(s.home);
    const r = await ok(s, ['setup', 'codex']);
    expect(r.files.find((f) => f.path === '~/.codex/config.toml')?.result).toBe('created');
    expect(fs.readlinkSync(path.join(s.home, '.codex', 'config.toml'))).toBe(dotfiles);
    expect(fs.readFileSync(dotfiles, 'utf8')).toContain('[mcp_servers.laneboard]');
    await ok(s, ['setup', 'codex', '--remove']);
    expect(fs.existsSync(dotfiles)).toBe(false);
    expect(hashes(s.home)).toEqual(before);
  });

  it('a relative dangling global link is resolved from the folder it really lies in (~/.codex is itself a link)', async () => {
    const s = sandbox();
    fs.mkdirSync(path.join(s.home, 'dotfiles', 'codex'), { recursive: true });
    fs.mkdirSync(path.join(s.home, 'dotfiles', 'shared'));
    fs.symlinkSync(path.join('dotfiles', 'codex'), path.join(s.home, '.codex'));
    fs.symlinkSync(path.join('..', 'shared', 'config.toml'), path.join(s.home, 'dotfiles', 'codex', 'config.toml'));
    await ok(s, ['setup', 'codex']);
    expect(fs.readFileSync(path.join(s.home, 'dotfiles', 'shared', 'config.toml'), 'utf8')).toContain('[mcp_servers.laneboard]');
    expect(fs.existsSync(path.join(s.home, 'shared'))).toBe(false);
  });

  it('a global link that appears after planning is never followed by the create (wx): EEXIST with a true fix, the link and its target untouched', () => {
    const home = tempDir();
    const file = path.join(home, '.codex', 'config.toml');
    const outside = path.join(tempDir(), 'missing-target');
    const plan = [planAdd(file, '~/.codex/config.toml', 'global', blockEdit('~/.codex/config.toml', MD_MARKERS, 'body'))];
    fs.mkdirSync(path.dirname(file));
    fs.symlinkSync(outside, file);
    let caught: unknown;
    try {
      applyPlan(plan, [home]);
    } catch (err) {
      caught = err;
    }
    expect((caught as LaneboardError).message).toBe('writing ~/.codex/config.toml failed (EEXIST); the files changed before it were put back');
    expect((caught as LaneboardError).fix).toBe('~/.codex/config.toml appeared while setup ran and was left as it is: look at it and run setup again');
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.readlinkSync(file)).toBe(outside);
  });

  it('a link that appears after planning is refused by applyPlan before the first write (SETUP_CONFLICT, the target untouched)', () => {
    const cwd = tempDir();
    const outside = path.join(tempDir(), 'zshrc');
    put(outside, 'export A=1\n');
    const file = path.join(cwd, 'CLAUDE.md');
    put(file, '# Mine\n');
    const plan = [planAdd(file, 'CLAUDE.md', 'project', blockEdit('CLAUDE.md', MD_MARKERS, 'body'))];
    fs.rmSync(file);
    fs.symlinkSync(outside, file);
    let caught: unknown;
    try {
      applyPlan(plan, [cwd]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LaneboardError);
    expect((caught as LaneboardError).code).toBe('SETUP_CONFLICT');
    expect(fs.readFileSync(outside, 'utf8')).toBe('export A=1\n');
    expect(fs.existsSync(`${file}.laneboard.bak`)).toBe(false);
  });

  it('the failed wx create does not undo what it did not make: a link to an existing file stays, the file keeps its bytes', () => {
    const home = tempDir();
    const file = path.join(home, '.codex', 'config.toml');
    const outside = path.join(tempDir(), 'zshrc');
    put(outside, 'export A=1\n');
    const plan = [planAdd(file, '~/.codex/config.toml', 'global', blockEdit('~/.codex/config.toml', MD_MARKERS, 'body'))];
    fs.mkdirSync(path.dirname(file));
    fs.symlinkSync(outside, file);
    expect(() => applyPlan(plan, [home])).toThrow('writing ~/.codex/config.toml failed (EEXIST)');
    expect(fs.readFileSync(outside, 'utf8')).toBe('export A=1\n');
    expect(fs.readlinkSync(file)).toBe(outside);
  });
});

// The error applyPlan throws (it must throw).
function applyError(plan: Parameters<typeof applyPlan>[0], roots: string[]): LaneboardError {
  try {
    applyPlan(plan, roots);
  } catch (err) {
    expect(err).toBeInstanceOf(LaneboardError);
    return err as LaneboardError;
  }
  throw new Error('applyPlan did not throw');
}

describe('A2: a project file replaced between planning and its write is never written', () => {
  // A project with CLAUDE.md (and AGENTS.md), planned for an update.
  function planned(): { cwd: string; file: string; plan: ReturnType<typeof planAdd>[] } {
    const cwd = tempDir();
    const file = path.join(cwd, 'CLAUDE.md');
    put(file, '# Mine\n');
    put(path.join(cwd, 'AGENTS.md'), '# Agents\n');
    return { cwd, file, plan: [planAdd(file, 'CLAUDE.md', 'project', blockEdit('CLAUDE.md', MD_MARKERS, 'body'))] };
  }

  it('CLAUDE.md swapped for a link inside the project (-> AGENTS.md) before applyPlan: SETUP_CONFLICT, AGENTS.md untouched', () => {
    const { cwd, file, plan } = planned();
    fs.rmSync(file);
    fs.symlinkSync('AGENTS.md', file);
    const err = applyError(plan, [cwd]);
    expect(err.code).toBe('SETUP_CONFLICT');
    expect(err.message).toBe('CLAUDE.md was replaced while setup ran (another file or a symlink is at its path now); nothing was written');
    expect(fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8')).toBe('# Agents\n');
  });

  it('CLAUDE.md swapped for another real file before applyPlan (new inode): SETUP_CONFLICT, the new file keeps its bytes', () => {
    const { cwd, file, plan } = planned();
    put(path.join(cwd, 'other.md'), '# Other\n');
    fs.renameSync(path.join(cwd, 'other.md'), file);
    const err = applyError(plan, [cwd]);
    expect(err.code).toBe('SETUP_CONFLICT');
    expect(fs.readFileSync(file, 'utf8')).toBe('# Other\n');
  });

  it.each([
    ['a link to the same file moved outside the project (same inode: only O_NOFOLLOW stops it)', 'link'],
    ['another real file (the open file has another inode)', 'file'],
  ])('swapped for %s right before the open of the write: SETUP_CONFLICT, nothing written through it, the backup undone', (_name, swap) => {
    const { cwd, file, plan } = planned();
    const moved = path.join(tempDir(), 'moved.md');
    const open = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...rest) => {
      // The write opens CLAUDE.md with a numeric O_WRONLY: swap the file in between the checks and this open.
      if (target === file && typeof flags === 'number' && (flags & fs.constants.O_WRONLY) !== 0) {
        if (swap === 'link') {
          fs.renameSync(file, moved);
          fs.symlinkSync(moved, file);
        } else {
          fs.rmSync(file);
          put(file, '# Swapped\n');
        }
      }
      return open(target, flags, ...rest);
    });
    let err: LaneboardError;
    try {
      err = applyError(plan, [cwd]);
    } finally {
      spy.mockRestore();
    }
    expect(err.code).toBe('SETUP_CONFLICT');
    expect(err.message).toBe('CLAUDE.md was replaced while setup ran (another file or a symlink is at its path now); the files changed before it were put back');
    if (swap === 'link') expect(fs.readFileSync(moved, 'utf8')).toBe('# Mine\n');
    else expect(fs.readFileSync(file, 'utf8')).toBe('# Swapped\n');
    expect(fs.existsSync(`${file}.laneboard.bak`)).toBe(false);
  });

  it('a new file whose folder is swapped for a link outside right before the create: the file made there is removed, SETUP_CONFLICT', () => {
    const cwd = tempDir();
    const outside = tempDir();
    const dir = path.join(cwd, '.claude');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'settings.json');
    const plan = [planAdd(file, '.claude/settings.json', 'project', blockEdit('.claude/settings.json', MD_MARKERS, 'body'))];
    const open = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...rest) => {
      if (target === file && flags === 'wx') {
        fs.rmdirSync(dir);
        fs.symlinkSync(outside, dir);
      }
      return open(target, flags, ...rest);
    });
    let err: LaneboardError;
    try {
      err = applyError(plan, [cwd]);
    } finally {
      spy.mockRestore();
    }
    expect(err.code).toBe('SETUP_CONFLICT');
    expect(err.message).toContain('.claude/settings.json was replaced while setup ran');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe('every read is bounded: a device, a FIFO or a huge file is never read', () => {
  it('readText refuses /dev/zero (not a regular file) at once', () => {
    expect(() => readText('/dev/zero')).toThrow('/dev/zero is not a regular file (a device, FIFO or socket); nothing was written');
  });

  it('readText refuses a FIFO without waiting for a writer', () => {
    const fifo = path.join(tempDir(), 'settings.json');
    execFileSync('mkfifo', [fifo]);
    expect(() => readText(fifo)).toThrow(`${fifo} is not a regular file (a device, FIFO or socket)`);
  });

  it('readText reads a file of exactly MAX_TEXT_BYTES and refuses one byte more (SETUP_CONFLICT)', () => {
    const file = path.join(tempDir(), 'AGENTS.md');
    fs.writeFileSync(file, '');
    fs.truncateSync(file, MAX_TEXT_BYTES);
    expect(readText(file)?.length).toBe(MAX_TEXT_BYTES);
    fs.truncateSync(file, MAX_TEXT_BYTES + 1);
    let caught: unknown;
    try {
      readText(file);
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'SETUP_CONFLICT', message: `${file} is larger than 4 MiB, too big for a harness file; nothing was written` });
  });

  it('a cloned sub/.claude/settings.local.json -> /dev/zero (read before any check to see whether it holds our part) does not stop setup; the link stays', async () => {
    const repo = tempDir();
    execFileSync('git', ['init', '-q', repo]);
    const cwd = path.join(repo, 'sub');
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.symlinkSync('/dev/zero', path.join(cwd, '.claude', 'settings.local.json'));
    const r = await cli(['setup', 'claude-code', '--json'], { cwd, env: { HOME: tempDir() } });
    expect(r.code, r.stdout).toBe(0);
    expect(fs.readlinkSync(path.join(cwd, '.claude', 'settings.local.json'))).toBe('/dev/zero');
  });

  it('the repository root\'s .claude/settings.local.json -> /dev/zero (read for its pin) is SETUP_CONFLICT, not a hang', async () => {
    const repo = tempDir();
    execFileSync('git', ['init', '-q', repo]);
    fs.mkdirSync(path.join(repo, '.claude'));
    fs.symlinkSync('/dev/zero', path.join(repo, '.claude', 'settings.local.json'));
    const cwd = path.join(repo, 'sub');
    fs.mkdirSync(cwd);
    const r = await cli(['setup', 'claude-code', '--json'], { cwd, env: { HOME: tempDir() } });
    expect(r.code, r.stdout).toBe(6);
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: 'SETUP_CONFLICT', message: `${path.join(repo, '.claude', 'settings.local.json')} is not a regular file (a device, FIFO or socket); nothing was written` });
  });
});

describe('a path setup cannot read: SETUP_WRITE_FAILED with the chmod that opens it, not INTERNAL', () => {
  it('.claude without permissions (mode 000): the folder is named with chmod u+rx, nothing written', async () => {
    const s = sandbox();
    const dir = path.join(s.cwd, '.claude');
    put(path.join(dir, 'settings.json'), '{}\n');
    fs.chmodSync(dir, 0o000);
    try {
      const err = await fails(s, ['setup', 'claude-code']);
      expect(err.code).toBe('SETUP_WRITE_FAILED');
      expect(err.message).toBe(`cannot read ${path.join(dir, 'settings.json')} (EACCES); nothing was written`);
      expect(err.fix).toBe(`let yourself open the folder (chmod u+rx ${shellQuote(dir)}) and run setup again`);
      expect(fs.readdirSync(s.cwd)).toEqual(['.claude']);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it('CLAUDE.md without read permission (mode 000): the file is named with chmod u+r, nothing written', async () => {
    const s = sandbox();
    const file = path.join(s.cwd, 'CLAUDE.md');
    put(file, '# Mine\n');
    fs.chmodSync(file, 0o000);
    try {
      const err = await fails(s, ['setup', 'claude-code']);
      expect(err.code).toBe('SETUP_WRITE_FAILED');
      expect(err.message).toBe(`cannot read ${file} (EACCES); nothing was written`);
      expect(err.fix).toBe(`let yourself read the file (chmod u+r ${shellQuote(file)}) and run setup again`);
      expect(fs.readdirSync(s.cwd)).toEqual(['CLAUDE.md']);
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });
});

// The security F5 (a) document: a marker quoted as an example, the other one inline in a sentence.
const QUOTED_DOC = [
  '# Team rules',
  'How laneboard blocks look (example):',
  '```',
  '<!-- laneboard:start -->',
  '...',
  '```',
  '## Deploy rules (IMPORTANT, only copy)',
  'Never deploy on Friday.',
  'Step 2 ...',
  'Example end: <!-- laneboard:end --> end of example',
  '## More rules',
  'keep me',
  '',
].join('\n');

describe('A4: a marker is a whole line, and only lines laneboard writes are inside its block', () => {
  it('security F5 (a): the quoted start marker and an inline end marker are not a block -> refused, the deploy rules stay', async () => {
    const s = sandbox();
    const file = path.join(s.cwd, 'CLAUDE.md');
    put(file, QUOTED_DOC);
    const err = await fails(s, ['setup', 'claude-code']);
    expect(err.code).toBe('SETUP_UNPARSEABLE');
    expect(err.fix).toContain('a marker quoted as an example stops counting when it is indented or has other text on its line');
    expect(fs.readFileSync(file, 'utf8')).toBe(QUOTED_DOC);
  });

  it('markers quoted inside sentences are text: setup appends its block with a backup, --remove gives the bytes back', async () => {
    const s = sandbox();
    const file = path.join(s.cwd, 'CLAUDE.md');
    const doc = '# Rules\nThe block starts at `<!-- laneboard:start -->` and ends at `<!-- laneboard:end -->`.\n    <!-- laneboard:start -->\nDeploy on Monday.\n';
    put(file, doc);
    await ok(s, ['setup', 'claude-code']);
    const after = fs.readFileSync(file, 'utf8');
    expect(after.startsWith(doc)).toBe(true);
    expect(fs.readFileSync(`${file}.laneboard.bak`, 'utf8')).toBe(doc);
    await ok(s, ['setup', 'claude-code', '--remove']);
    expect(fs.readFileSync(file, 'utf8')).toBe(doc);
  });

  it('both markers quoted as whole lines around the user text: SETUP_CONFLICT naming the foreign lines, nothing deleted', async () => {
    const s = sandbox();
    const file = path.join(s.cwd, 'CLAUDE.md');
    const doc = '# Rules\n```\n<!-- laneboard:start -->\nDeploy rules: never on Friday\n\n<!-- laneboard:end -->\n```\n';
    put(file, doc);
    const err = await fails(s, ['setup', 'claude-code']);
    expect(err.code).toBe('SETUP_CONFLICT');
    expect(err.message).toBe('CLAUDE.md has text laneboard did not write inside its block (line 4); nothing was written');
    expect(err.fix).toBe('move line 4 of CLAUDE.md out of the block between "<!-- laneboard:start -->" and "<!-- laneboard:end -->" (or delete the marker lines if that text is yours), then run setup again');
    expect(fs.readFileSync(file, 'utf8')).toBe(doc);
  });

  it('security F5 (b): the user\'s own lines inside the block -> re-run and --remove refuse with their line numbers, the file and its backup stay', async () => {
    const s = sandbox();
    const file = path.join(s.cwd, 'AGENTS.md');
    put(file, '# Agents\n');
    await ok(s, ['setup', 'codex']);
    const text = fs.readFileSync(file, 'utf8').replace('<!-- laneboard:end -->', 'My rule one\nMy rule two\n<!-- laneboard:end -->');
    fs.writeFileSync(file, text);
    const before = state(s);
    for (const argv of [['setup', 'codex'], ['setup', 'codex', '--remove']]) {
      const err = await fails(s, argv);
      expect(err.code).toBe('SETUP_CONFLICT');
      expect(err.message).toBe('AGENTS.md has text laneboard did not write inside its block (lines 7, 8); nothing was written');
      expect(state(s)).toEqual(before);
    }
  });

  it('an edited laneboard line inside the block is not laneboard\'s any more: refused, not overwritten', async () => {
    const s = sandbox();
    await ok(s, ['setup', 'claude-code']);
    const file = path.join(s.cwd, 'CLAUDE.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('No untracked work.', 'No untracked work. Ask Dana before deploys.'));
    const before = state(s);
    const err = await fails(s, ['setup', 'claude-code']);
    expect(err.message).toContain('(line 3)');
    expect(state(s)).toEqual(before);
  });

  it.each([
    ['a repeated start line', '<!-- laneboard:start -->\nbody\n<!-- laneboard:start -->\nbody\n<!-- laneboard:end -->\n'],
    ['the end line before the start line', '<!-- laneboard:end -->\nbody\n<!-- laneboard:start -->\n'],
    ['a lone end line', '# Mine\n<!-- laneboard:end -->\n'],
  ])('whole marker lines out of order (%s) -> SETUP_UNPARSEABLE, nothing written', async (_name, doc) => {
    const s = sandbox();
    const file = path.join(s.cwd, 'GEMINI.md');
    put(file, doc);
    const err = await fails(s, ['setup', 'gemini']);
    expect(err.code).toBe('SETUP_UNPARSEABLE');
    expect(err.message).toBe('GEMINI.md has a broken laneboard block (markers missing, repeated or out of order); nothing was written');
    expect(fs.readFileSync(file, 'utf8')).toBe(doc);
  });

  it('marker lines with trailing spaces or CRLF still count, and blank lines inside the block are no foreign text', () => {
    const edit = blockEdit('CLAUDE.md', MD_MARKERS, 'body');
    const text = '# x\r\n<!-- laneboard:start -->  \r\nbody\r\n\r\n<!-- laneboard:end -->\r\nafter\r\n';
    expect(edit.owns(text)).toBe(true);
    // The whole marker lines are replaced (their \r too); the text around keeps its line ends.
    expect(edit.add(text)).toBe('# x\r\n<!-- laneboard:start -->\nbody\n<!-- laneboard:end -->\nafter\r\n');
  });
});

describe('blocks written by 0.1.0 builds, 0.2.0 and 0.3.1 are laneboard\'s: updated in place and removed', () => {
  const md = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.md'));

  it('the fixtures are the real blocks of the releases (three ways to name the store) and of the 0.1.0 builds that wrote other lines', () => {
    expect(md.sort()).toEqual([
      // S2 (one block for every harness), S2b-1 (env in settings.json), S2c-S2f (the finish rule before S3b).
      '0.1.0-4e19d07-AGENTS.inline.md',
      '0.1.0-4e19d07-CLAUDE.local-env.md',
      '0.1.0-69f36fc-CLAUDE.settings-env.md',
      '0.1.0-6f81877-CLAUDE.md',
      ...['0.2.0', '0.3.1'].flatMap((v) => [`${v}-AGENTS.inline.md`, `${v}-CLAUDE.local-env.md`, `${v}-CLAUDE.settings-env.md`]),
    ]);
  });

  it.each(md)('%s with the user text around it: setup replaces the block, --remove leaves only the user text', async (name) => {
    const s = sandbox();
    const old = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
    const target = name.includes('AGENTS') ? 'AGENTS.md' : 'CLAUDE.md';
    const harness = target === 'AGENTS.md' ? 'codex' : 'claude-code';
    const file = path.join(s.cwd, target);
    put(file, `# Mine\n\n${old}\n## Later\n`);
    const r = await ok(s, ['setup', harness]);
    const now = fs.readFileSync(file, 'utf8');
    // This folder is no repository: Claude Code's block names the local file (the 0.2.0/0.3.1 block is what setup writes now), AGENTS.md this project's store.
    if (name.includes('local-env') && !name.startsWith('0.1.0')) expect(r.files.find((f) => f.path === target)?.result).toBe('unchanged');
    else expect(r.files.find((f) => f.path === target)?.result).toBe('updated');
    expect(now).toContain(target === 'AGENTS.md' ? `Its store is ${path.join(s.cwd, '.laneboard')}:` : 'Its store is pinned by LANEBOARD_DIR in .claude/settings.local.json');
    expect(now).not.toContain('/home/dev/project');
    expect(now.startsWith('# Mine\n\n<!-- laneboard:start -->\n')).toBe(true);
    expect(now.endsWith('<!-- laneboard:end -->\n\n## Later\n')).toBe(true);
    await ok(s, ['setup', harness, '--remove']);
    expect(fs.readFileSync(file, 'utf8')).toBe('# Mine\n\n## Later\n');
  });

  it.each(['0.2.0-exclude', '0.3.1-exclude'])('%s: the .git/info/exclude block of a release is replaced and removed at a repository root', async (name) => {
    const s = sandbox();
    execFileSync('git', ['init', '-q', s.cwd]);
    const exclude = path.join(s.cwd, '.git', 'info', 'exclude');
    put(exclude, `*.log\n\n${fs.readFileSync(path.join(FIXTURES, name), 'utf8')}`);
    await ok(s, ['setup', 'claude-code']);
    expect(fs.readFileSync(exclude, 'utf8')).toContain('**/.claude/settings.local.json\n# laneboard:end');
    await ok(s, ['setup', 'claude-code', '--remove']);
    expect(fs.readFileSync(exclude, 'utf8')).toBe('*.log\n');
  });
});
