// S6b r3: a project path is resolved as the kernel resolves it. Node's JS fs.realpathSync folds `conf/..` by text, the kernel walks the
// links (`conf -> .`, `.claude -> conf/..` is the project's parent folder), so the check saw "inside" while the write went through a
// link to ~/.claude/settings.json. A link into the repository's .git folder is refused too, and no write into a project file follows a
// link at the last step.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { LaneboardError } from '../../src/core/index.ts';
import { applyPlan, planAdd } from '../../src/setup/files.ts';
import type { PlannedFile, TextEdit } from '../../src/setup/files.ts';
import { cleanupTemp, cli, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

interface Sandbox {
  // Temp folder that holds the project two levels down (outer/x/proj): what a link leaving the project reaches.
  outer: string;
  cwd: string;
  home: string;
  run(argv: string[]): ReturnType<typeof cli>;
}

// A project at outer/x/proj and a temp HOME with a global ~/.claude/settings.json; the CLI never sees the real HOME.
function sandbox(): Sandbox {
  const outer = tempDir();
  const cwd = path.join(outer, 'x', 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const home = tempDir();
  put(path.join(home, '.claude', 'settings.json'), '{\n  "theme": "dark"\n}\n');
  return { outer, cwd, home, run: (argv) => cli(argv, { cwd, env: { HOME: home } }) };
}

// Write a file (and its folders).
function put(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
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

// HOME and the folder around the project (the project inside it too).
function state(s: Sandbox): { home: Record<string, string>; outer: Record<string, string> } {
  return { home: hashes(s.home), outer: hashes(s.outer) };
}

// The parsed `error` of a failed --json run (exit 6).
async function fails(s: Sandbox, argv: string[]): Promise<{ code: string; message: string; fix: string; details: Record<string, unknown> }> {
  const r = await s.run([...argv, '--json']);
  expect(r.code, r.stdout).toBe(6);
  return JSON.parse(r.stdout).error;
}

// A minimal edit: our part is the line `laneboard`.
const EDIT: TextEdit = {
  add: (t) => (t?.includes('laneboard\n') ? t : `${t ?? ''}laneboard\n`),
  strip: (t) => t.replace('laneboard\n', ''),
  owns: (t) => t.includes('laneboard\n'),
  same: (a, b) => a === b,
  isEmpty: (t) => t.trim() === '',
};

// The error applyPlan throws (fails the test when it does not throw).
function applyError(plan: readonly PlannedFile[], roots: readonly string[]): LaneboardError {
  try {
    applyPlan(plan, roots);
  } catch (err) {
    if (err instanceof LaneboardError) return err;
    throw err;
  }
  throw new Error('applyPlan did not fail');
}

// The error planAdd throws (fails the test when it does not throw).
function planError(file: string, shown: string): LaneboardError {
  try {
    planAdd(file, shown, 'project', EDIT);
  } catch (err) {
    if (err instanceof LaneboardError) return err;
    throw err;
  }
  throw new Error('planAdd did not fail');
}

// Links a clone can carry whose text, folded like path.resolve, stays in the project, while the kernel leaves it.
const ESCAPES: Array<{ name: string; link: string; plant: (s: Sandbox) => void }> = [
  {
    name: 'conf -> ., .claude -> conf/.., settings.json -> ~/.claude/settings.json (the review probe)',
    link: '.claude',
    plant: (s) => {
      fs.symlinkSync('.', path.join(s.cwd, 'conf'));
      fs.symlinkSync('conf/..', path.join(s.cwd, '.claude'));
      fs.symlinkSync(path.join(s.home, '.claude', 'settings.json'), path.join(s.cwd, 'settings.json'));
    },
  },
  {
    name: 'conf -> ., .claude -> conf/.., settings.local.json -> ~/.claude/settings.json',
    link: '.claude',
    plant: (s) => {
      fs.symlinkSync('.', path.join(s.cwd, 'conf'));
      fs.symlinkSync('conf/..', path.join(s.cwd, '.claude'));
      fs.symlinkSync(path.join(s.home, '.claude', 'settings.json'), path.join(s.cwd, 'settings.local.json'));
    },
  },
  {
    name: 'a -> ., b -> a/.., .claude -> b (a chain), settings.json -> ~/.claude/settings.json',
    link: '.claude',
    plant: (s) => {
      fs.symlinkSync('.', path.join(s.cwd, 'a'));
      fs.symlinkSync('a/..', path.join(s.cwd, 'b'));
      fs.symlinkSync('b', path.join(s.cwd, '.claude'));
      fs.symlinkSync(path.join(s.home, '.claude', 'settings.json'), path.join(s.cwd, 'settings.json'));
    },
  },
  {
    name: 'a -> ., b -> a/../.., .claude -> b/proj (text: the project; kernel: outer/proj), settings.json -> ~/.claude/settings.json',
    link: '.claude',
    plant: (s) => {
      fs.mkdirSync(path.join(s.outer, 'proj'));
      fs.symlinkSync('.', path.join(s.cwd, 'a'));
      fs.symlinkSync('a/../..', path.join(s.cwd, 'b'));
      fs.symlinkSync('b/proj', path.join(s.cwd, '.claude'));
      fs.symlinkSync(path.join(s.home, '.claude', 'settings.json'), path.join(s.cwd, 'settings.json'));
    },
  },
  {
    name: 'a link at the end of the path: conf -> ., CLAUDE.md -> conf/../AGENTS.md (text: the project AGENTS.md; kernel: outer/x/AGENTS.md)',
    link: 'CLAUDE.md',
    plant: (s) => {
      put(path.join(s.cwd, 'AGENTS.md'), '# Project agents\n');
      put(path.join(s.outer, 'x', 'AGENTS.md'), '# Outside\n');
      fs.symlinkSync('.', path.join(s.cwd, 'conf'));
      fs.symlinkSync('conf/../AGENTS.md', path.join(s.cwd, 'CLAUDE.md'));
    },
  },
];

describe('a project path is resolved as the kernel resolves it', () => {
  it.each(ESCAPES)('$name: SETUP_CONFLICT (exit 6), leads outside, HOME and the folders around keep every byte, no backup', async ({ link, plant }) => {
    const s = sandbox();
    plant(s);
    const before = state(s);
    for (const argv of [['setup', 'claude-code'], ['setup', 'claude-code', '--dry-run']]) {
      const err = await fails(s, argv);
      expect(err.code).toBe('SETUP_CONFLICT');
      expect(err.details.link).toBe(link);
      expect(err.message).toContain('which leads outside the project');
      expect(state(s)).toEqual(before);
    }
    expect(fs.readdirSync(s.cwd).filter((f) => f.endsWith('.laneboard.bak'))).toEqual([]);
  });

  it('conf -> ., .claude -> conf/.. without a link at the end: refused, not "created .claude/settings.json" in the project root', async () => {
    const s = sandbox();
    fs.symlinkSync('.', path.join(s.cwd, 'conf'));
    fs.symlinkSync('conf/..', path.join(s.cwd, '.claude'));
    const before = state(s);
    const err = await fails(s, ['setup', 'claude-code']);
    expect(err).toMatchObject({ code: 'SETUP_CONFLICT', details: { link: '.claude', resolved: path.join(s.outer, 'x') } });
    expect(state(s)).toEqual(before);
    expect(fs.existsSync(path.join(s.cwd, 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(s.outer, 'x', 'settings.json'))).toBe(false);
  });

  it('deep -> sub/inner, .claude -> deep/.. (inside both ways, text and kernel differ): the file lands where Claude Code reads it', async () => {
    const s = sandbox();
    fs.mkdirSync(path.join(s.cwd, 'sub', 'inner'), { recursive: true });
    fs.symlinkSync('sub/inner', path.join(s.cwd, 'deep'));
    fs.symlinkSync('deep/..', path.join(s.cwd, '.claude'));
    const r = await s.run(['setup', 'claude-code', '--json']);
    expect(r.code, r.stdout).toBe(0);
    // The kernel opens .claude/settings.json as sub/settings.json: that is the file Claude Code reads, and it holds the hook.
    expect(fs.readFileSync(path.join(s.cwd, '.claude', 'settings.json'), 'utf8')).toContain('laneboard prime --hook');
    expect(fs.lstatSync(path.join(s.cwd, 'sub', 'settings.json')).isFile()).toBe(true);
    expect(fs.existsSync(path.join(s.cwd, 'settings.json'))).toBe(false);
  });
});

describe("a link into the repository's .git folder is refused", () => {
  it.each([
    ['CLAUDE.md -> .git/config', 'CLAUDE.md', '.git/config'],
    ['CLAUDE.md -> .git/info/exclude', 'CLAUDE.md', '.git/info/exclude'],
    ['.claude -> .git', '.claude', '.git'],
  ])('%s: SETUP_CONFLICT (exit 6), .git keeps every byte', async (_name, link, to) => {
    const s = sandbox();
    execFileSync('git', ['init', '-q'], { cwd: s.cwd });
    put(path.join(s.cwd, '.git', 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n');
    fs.symlinkSync(to, path.join(s.cwd, link));
    const before = state(s);
    const err = await fails(s, ['setup', 'claude-code']);
    expect(err).toMatchObject({ code: 'SETUP_CONFLICT', details: { link, target: to } });
    expect(err.message).toBe(
      `${link} is a symlink to ${to}, which leads into the repository's .git folder (${path.join(s.cwd, to)}); setup does not write ${String(err.details.file)} through it (git reads that folder as its own data); nothing was written`,
    );
    expect(state(s)).toEqual(before);
  });

  it('without links setup still writes the exclude file of the repository (.git/info/exclude is laneboard\'s own place)', async () => {
    const s = sandbox();
    execFileSync('git', ['init', '-q'], { cwd: s.cwd });
    const r = await s.run(['setup', 'claude-code', '--json']);
    expect(r.code, r.stdout).toBe(0);
    expect(fs.readFileSync(path.join(s.cwd, '.git', 'info', 'exclude'), 'utf8')).toContain('.claude/settings.local.json');
  });
});

describe('belts behind the kernel resolution', () => {
  it('with realpath folding `..` by text (as before r3), the step-by-step lstat of the final path still refuses the probe: HOME intact', async () => {
    const s = sandbox();
    ESCAPES[0]!.plant(s);
    const before = state(s);
    const js = fs.realpathSync;
    const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation((p) => js(p as string));
    let err: { code: string; message: string };
    try {
      err = await fails(s, ['setup', 'claude-code']);
    } finally {
      spy.mockRestore();
    }
    expect(err.code).toBe('SETUP_CONFLICT');
    expect(err.message).toBe(`.claude/settings.json: ${path.join(s.cwd, 'settings.json')} is a symlink or lies outside the project, as setup checked the path again; nothing was written`);
    expect(state(s)).toEqual(before);
  });

  it('a project file that exists but was not checked (no dev/inode) is refused at planning', () => {
    const cwd = tempDir();
    const file = path.join(cwd, 'CLAUDE.md');
    put(file, '# Mine\n');
    const lstat = fs.lstatSync;
    // The final lstat sees nothing (the file appeared right after it): the read then finds a file setup has no identity for.
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, opts?: fs.StatSyncOptions) => {
      if (p === file && opts?.bigint === true) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return lstat(p, opts);
    }) as typeof fs.lstatSync);
    let err: LaneboardError;
    try {
      err = planError(file, 'CLAUDE.md');
    } finally {
      spy.mockRestore();
    }
    expect(err.code).toBe('SETUP_CONFLICT');
    expect(err.message).toBe('CLAUDE.md was replaced while setup ran (another file or a symlink is at its path now); nothing was written');
    expect(fs.readFileSync(file, 'utf8')).toBe('# Mine\n');
  });

  it('an existing project file without dev/inode is never written by path (writeExisting refuses, no writeFileSync through a link)', () => {
    const cwd = tempDir();
    const file = path.join(cwd, 'CLAUDE.md');
    put(file, '# Mine\n');
    const plan: PlannedFile[] = [{ file, shown: 'CLAUDE.md', scope: 'project', target: file, root: cwd, result: 'updated', write: '# Ours\n', before: '# Mine\n' }];
    const lstat = fs.lstatSync;
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, opts?: fs.StatSyncOptions) => {
      if (p === file && opts?.bigint === true) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return lstat(p, opts);
    }) as typeof fs.lstatSync);
    let err: LaneboardError;
    try {
      err = applyError(plan, [cwd]);
    } finally {
      spy.mockRestore();
    }
    expect(err.code).toBe('SETUP_CONFLICT');
    expect(fs.readFileSync(file, 'utf8')).toBe('# Mine\n');
  });

  it('undo puts a deleted project file back without following a link put at its path (O_NOFOLLOW): the outside file keeps its bytes', () => {
    const cwd = tempDir();
    const outside = path.join(tempDir(), 'zshrc');
    put(outside, 'export A=1\n');
    const a = path.join(cwd, 'a.md');
    const b = path.join(cwd, 'b.md');
    put(a, 'laneboard\n');
    put(b, '# B\n');
    const ids = (f: string): { dev: bigint; ino: bigint } => {
      const st = fs.lstatSync(f, { bigint: true });
      return { dev: st.dev, ino: st.ino };
    };
    const plan: PlannedFile[] = [
      { file: a, shown: 'a.md', scope: 'project', target: a, root: cwd, result: 'deleted', write: null, before: 'laneboard\n', identity: ids(a) },
      { file: b, shown: 'b.md', scope: 'project', target: b, root: cwd, result: 'updated', write: '# B\nlaneboard\n', before: '# B\n', identity: ids(b) },
    ];
    const unlink = fs.unlinkSync;
    const open = fs.openSync;
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((p) => {
      unlink(p);
      // A link put where a.md was, right after setup deleted it.
      if (p === a) fs.symlinkSync(outside, a);
    });
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...rest) => {
      // The write of b.md fails: undo runs and puts a.md back.
      if (target === b && typeof flags === 'number' && (flags & fs.constants.O_WRONLY) !== 0) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return open(target, flags, ...rest);
    });
    let err: LaneboardError;
    try {
      err = applyError(plan, [cwd]);
    } finally {
      unlinkSpy.mockRestore();
      openSpy.mockRestore();
    }
    expect(err.code).toBe('SETUP_WRITE_FAILED');
    expect(err.message).toBe('writing b.md failed (EIO); could not put back: a.md');
    expect(fs.readFileSync(outside, 'utf8')).toBe('export A=1\n');
    expect(fs.readFileSync(b, 'utf8')).toBe('# B\n');
  });
});
