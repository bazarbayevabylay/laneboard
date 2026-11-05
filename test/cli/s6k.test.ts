// S6k: a monorepo (P3, UX C-U1, C-U2; A19 init). Inside one git repository only a `.git` of its own (a nested repository,
// a submodule) marks another project: a package with its own AGENTS.md or CLAUDE.md shares the repository's board without a warning.
// setup from a package pins that board; init there is refused (a board of its own is made by --dir). A LANEBOARD_DIR that names no
// folder while cwd has its board (the project folder moved) makes init refuse and setup re-pin, never an empty twin board.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readRegistry } from '../../src/core/index.ts';
import { cleanupTemp, cli, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

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
}

// A git repository with the board MONO at its root and packages/web holding its own AGENTS.md and package.json (persona C).
async function monorepo(): Promise<Mono> {
  const root = tempDir();
  const env = { HOME: tempDir(), USER: 'tester', LANEBOARD_AGENT: 'dev-c' };
  fs.mkdirSync(path.join(root, '.git'));
  const web = path.join(root, 'packages', 'web');
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, 'AGENTS.md'), '# web package\nRun npm test before a commit.\n');
  fs.writeFileSync(path.join(web, 'package.json'), '{ "name": "web" }\n');
  expect((await json(root, ['init', '--name', 'mono', '--prefix', 'MONO', '--description', 'the monorepo'], env)).code).toBe(0);
  return { root, web, store: path.join(root, '.laneboard'), env };
}

describe('C-U1: a package of a monorepo with its own AGENTS.md uses the repository board without a warning', () => {
  it('list, create and prime from packages/web (also with LANEBOARD_DIR of the root): store MONO, warnings []', async () => {
    const m = await monorepo();
    for (const env of [m.env, { ...m.env, LANEBOARD_DIR: m.store }]) {
      expect((await json(m.web, ['list'], env)).doc).toMatchObject({ ok: true, store: m.store, warnings: [] });
      const prime = await json(m.web, ['prime'], env);
      expect(prime.doc).toMatchObject({ store: m.store, warnings: [], data: { store_warning: null } });
      const text = await cli(['prime'], { cwd: m.web, env });
      expect(text.stdout).not.toContain('own board');
      expect(text.stdout).not.toContain('separate project');
    }
    for (const marker of ['CLAUDE.md', 'GEMINI.md']) fs.writeFileSync(path.join(m.web, marker), '# web\n');
    fs.mkdirSync(path.join(m.web, '.claude'));
    const created = await json(m.web, ['create', 'Fix the web build', '--status', 'todo'], m.env);
    expect(created.doc).toMatchObject({ ok: true, store: m.store, warnings: [] });
    expect(created.doc.data.id).toBe('MONO-1');
  });

  it('controls: a nested repository (packages/x/.git) still warns; outside git a subfolder with CLAUDE.md still warns', async () => {
    const m = await monorepo();
    const x = path.join(m.root, 'packages', 'x');
    fs.mkdirSync(path.join(x, '.git'), { recursive: true });
    const nested = await json(x, ['list'], m.env);
    expect(nested.doc.store).toBe(m.store);
    expect(nested.doc.warnings).toHaveLength(1);
    expect(nested.doc.warnings[0]).toContain('looks like a separate project (it has .git)');
    const plain = tempDir();
    expect((await json(plain, ['init', '--name', 'plain', '--prefix', 'PLN', '--description', 'no git'], m.env)).code).toBe(0);
    const agent = path.join(plain, 'agent-b');
    fs.mkdirSync(agent);
    fs.writeFileSync(path.join(agent, 'CLAUDE.md'), '# agent b\n');
    const outside = await json(agent, ['list'], m.env);
    expect(outside.doc.warnings).toHaveLength(1);
    expect(outside.doc.warnings[0]).toContain('looks like a separate project (it has CLAUDE.md)');
  });
});

describe('C-U2: setup and init from a package find the repository board', () => {
  it('setup codex --dry-run from packages/web pins <root>/.laneboard and names it', async () => {
    const m = await monorepo();
    const r = await json(m.web, ['setup', 'codex', '--dry-run'], m.env);
    expect(r.doc).toMatchObject({ ok: true, data: { store: m.store } });
    expect(r.doc.warnings.join('\n')).toContain(`pinned to the board of this git repository, ${m.store} (prefix MONO)`);
    expect(r.doc.warnings.join('\n')).not.toContain('no laneboard store');
    // A real setup writes the root's store into the package's AGENTS.md block.
    expect((await json(m.web, ['setup', 'codex'], m.env)).code).toBe(0);
    expect(fs.readFileSync(path.join(m.web, 'AGENTS.md'), 'utf8')).toContain(m.store);
    expect(fs.existsSync(path.join(m.web, '.laneboard'))).toBe(false);
  });

  it('init --name web from packages/web: STORE_EXISTS naming MONO, nothing created; init --dir makes the package board, which prime then uses', async () => {
    const m = await monorepo();
    const refused = await json(m.web, ['init', '--name', 'web', '--description', 'web package'], m.env);
    expect(refused.code).toBe(6);
    expect(refused.doc.error.code).toBe('STORE_EXISTS');
    expect(refused.doc.error.message).toBe(`${m.web} is part of board MONO (${m.store}) of this git repository; init creates no second board here`);
    expect(refused.doc.error.fix).toContain('use that board: laneboard prime');
    expect(refused.doc.error.fix).toContain(`laneboard init --dir ${path.join(m.web, '.laneboard')}`);
    expect(fs.existsSync(path.join(m.web, '.laneboard'))).toBe(false);
    expect(readRegistry(m.env.HOME).map((e) => e.path)).toEqual([m.store]);
    // A deeper folder of the package is refused the same way.
    const src = path.join(m.web, 'src');
    fs.mkdirSync(src);
    expect((await json(src, ['init', '--name', 'web', '--description', 'web package'], m.env)).doc.error.code).toBe('STORE_EXISTS');
    // The explicit way to a board of its own.
    const own = path.join(m.web, '.laneboard');
    expect((await json(m.web, ['init', '--dir', own, '--name', 'web', '--prefix', 'WEB', '--description', 'web package'], m.env)).code).toBe(0);
    const prime = await json(m.web, ['prime'], m.env);
    expect(prime.doc).toMatchObject({ store: own, warnings: [], data: { store_warning: null } });
    // In the folder of a board, init is the old STORE_EXISTS of that board.
    expect((await json(m.web, ['init', '--name', 'web', '--description', 'again'], m.env)).doc.error.message).toBe(`a store already exists at ${own}`);
  });

  it('outside git a subfolder of a board is not refused: init creates its board as before', async () => {
    const plain = tempDir();
    const env = { HOME: tempDir(), USER: 'tester' };
    expect((await json(plain, ['init', '--name', 'plain', '--prefix', 'PLN', '--description', 'no git'], env)).code).toBe(0);
    const sub = path.join(plain, 'sub');
    fs.mkdirSync(sub);
    expect((await json(sub, ['init', '--name', 'sub', '--prefix', 'SUB', '--description', 'subfolder'], env)).code).toBe(0);
    expect(fs.existsSync(path.join(sub, '.laneboard', 'config.json'))).toBe(true);
  });
});

describe('A19 init: a stale LANEBOARD_DIR next to the board of cwd (the project folder moved)', () => {
  it('init refuses with the setup fix, list names the board, setup claude-code re-pins it; the old path is never created', async () => {
    const parent = tempDir();
    const proj = path.join(parent, 'proj2');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    const gone = path.join(parent, 'proj', '.laneboard');
    const env = { HOME: tempDir(), USER: 'tester' };
    expect((await json(proj, ['init', '--name', 'move', '--prefix', 'MOVE', '--description', 'moved project'], env)).code).toBe(0);
    const stale = { ...env, LANEBOARD_DIR: gone };
    const own = path.join(proj, '.laneboard');
    const init = await json(proj, ['init', '--name', 'movec', '--description', 'twin'], stale);
    expect(init.code).toBe(6);
    expect(init.doc.error).toMatchObject({ code: 'STORE_EXISTS', message: `LANEBOARD_DIR points to ${gone}, which is not a directory, and ${proj} already has a board: MOVE (${own})` });
    expect(init.doc.error.fix).toContain(`laneboard setup claude-code in ${proj}`);
    expect(fs.existsSync(path.dirname(gone))).toBe(false);
    const list = await json(proj, ['list'], stale);
    expect(list.doc.error).toMatchObject({ code: 'STORE_NOT_FOUND', message: `LANEBOARD_DIR points to ${gone}, which is not a directory; this folder's board is MOVE (${own})` });
    expect(list.doc.error.fix).toContain('laneboard setup claude-code');
    expect(list.doc.error.fix).not.toContain('laneboard init');
    // The fix, run with the stale variable still in the shell: the pin goes to the board here.
    const setup = await json(proj, ['setup', 'claude-code'], stale);
    expect(setup.doc).toMatchObject({ ok: true, data: { store: own } });
    expect(setup.doc.warnings.join('\n')).not.toContain('found above');
    expect(JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.local.json'), 'utf8')).env.LANEBOARD_DIR).toBe(own);
    expect(fs.existsSync(path.dirname(gone))).toBe(false);
    expect(readRegistry(env.HOME).map((e) => e.path)).toEqual([own]);
    // --dir is explicit: no stale-pin refusal, the board is made where it says.
    expect((await json(proj, ['init', '--dir', path.join(parent, 'other', '.laneboard'), '--name', 'other', '--prefix', 'OTH', '--description', 'x'], stale)).code).toBe(0);
  });

  it('a stale LANEBOARD_DIR without a board here keeps the init fix (a new project)', async () => {
    const proj = tempDir();
    const gone = path.join(tempDir(), 'missing', '.laneboard');
    const list = await json(proj, ['list'], { HOME: tempDir(), LANEBOARD_DIR: gone });
    expect(list.doc.error.code).toBe('STORE_NOT_FOUND');
    expect(list.doc.error.fix).toContain('laneboard init --dir');
  });
});

describe('S6k r1: a nested repository or a submodule inside the monorepo is a project of its own', () => {
  // packages/x with a .git directory (a nested repository) or libs/sub with a .git file (a submodule).
  const cases: Array<[string, (dir: string) => void]> = [
    ['nested repository (packages/x/.git directory)', (dir) => fs.mkdirSync(path.join(dir, '.git'), { recursive: true })],
    ['submodule (libs/sub/.git file)', (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ../../.git/modules/libs/sub\n');
    }],
  ];
  for (const [name, make] of cases) {
    it(`${name}: setup pins its own board without the repository warning, a bare init creates it`, async () => {
      const m = await monorepo();
      const dir = path.join(m.root, ...(name.startsWith('nested') ? ['packages', 'x'] : ['libs', 'sub']));
      make(dir);
      const own = path.join(dir, '.laneboard');
      const setup = await json(dir, ['setup', 'codex', '--dry-run'], m.env);
      expect(setup.doc).toMatchObject({ ok: true, data: { store: own } });
      expect(setup.doc.warnings.join('\n')).not.toContain('pinned to the board of this git repository');
      expect((await json(dir, ['init', '--name', 'x', '--prefix', 'XX', '--description', 'own project'], m.env)).code).toBe(0);
      expect(fs.existsSync(path.join(own, 'config.json'))).toBe(true);
    });
  }
});

describe('S6k r1: fixes that create a board of a package name it by --dir', () => {
  it('setup --dir <package board> before init: the warning says init --dir, and that command works', async () => {
    const m = await monorepo();
    const own = path.join(m.web, '.laneboard');
    const r = await json(m.web, ['setup', 'codex', '--dir', own, '--dry-run'], m.env);
    const warning = r.doc.warnings.find((w: string) => w.startsWith('no laneboard store'));
    expect(warning).toContain(`run laneboard init --dir ${own} --name`);
    expect((await json(m.web, ['init', '--dir', own, '--name', 'web', '--prefix', 'WEB', '--description', 'web package'], m.env)).code).toBe(0);
  });

  it('setup in the folder of its own future board keeps the bare init in the warning', async () => {
    const proj = tempDir();
    const r = await json(proj, ['setup', 'codex', '--dry-run'], { HOME: tempDir(), USER: 'tester' });
    expect(r.doc.warnings.join('\n')).toContain(`in ${proj} run laneboard init --name`);
  });

  it('SETUP_CONFLICT under a root pin for a package board not yet made: the fix starts with init --dir', async () => {
    const m = await monorepo();
    expect((await json(m.root, ['setup', 'claude-code'], m.env)).code).toBe(0);
    const own = path.join(m.web, '.laneboard');
    const r = await json(m.web, ['setup', 'claude-code', '--dir', own], m.env);
    expect(r.doc.error.code).toBe('SETUP_CONFLICT');
    expect(r.doc.error.fix).toMatch(new RegExp(`^laneboard init --dir ${own.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --name .* && cd `));
  });
});
