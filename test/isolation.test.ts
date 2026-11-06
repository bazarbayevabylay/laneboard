// Guard of the test isolation (incident 06.11: test/cli/process.test.ts spawned the CLI without `env`, inherited the session's
// LANEBOARD_DIR and created tasks "piped" on a live board). test/helpers.ts poisons LANEBOARD_DIR and drops the names and config
// folders in every worker that imports it; this file checks that the guard holds and that every test file starting a process imports it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTemp, CLI_SOURCE, GUARD_DROPPED_ENV, LEAKED_BOARD, REPO, spawnNode, tempDir } from './helpers.ts';

afterAll(cleanupTemp);

// Does `text` import test/helpers.ts so that it runs in the worker: a value import or `import '../helpers.ts'`. `import type … from` is
// erased by the compiler and runs nothing (review C2); `import { type X } from` stays, as `import {} from`, under verbatimModuleSyntax.
function runsGuard(text: string): boolean {
  const imports = text.matchAll(/^import\s+(?:([^;'"]*?)\s+from\s+)?'(?:\.\.?\/)+helpers\.ts'/gm);
  return [...imports].some(([, clause]) => clause === undefined || !/^type\s/.test(clause));
}

// Every *.ts file below test/ (vitest suites and their helpers).
function testFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'e2e' ? [] : testFiles(file);
    return e.name.endsWith('.ts') ? [file] : [];
  });
}

describe('test isolation guard', () => {
  it('the worker env names no board, no agent and no config folder of the machine; HOME is an empty temp folder', () => {
    expect(process.env.LANEBOARD_DIR).toBe(LEAKED_BOARD);
    for (const key of GUARD_DROPPED_ENV) expect(process.env[key], key).toBeUndefined();
    const home = process.env.HOME ?? '';
    expect(home.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    expect(fs.existsSync(path.join(home, '.laneboard'))).toBe(false);
  });

  it('a CLI process started without its own env (the 06.11 pattern) reaches no board, not even the one in its folder', async () => {
    const cwd = tempDir();
    expect((await spawnNode([CLI_SOURCE, 'init', '--description', 'guard', '--prefix', 'GD'], { cwd, env: { HOME: tempDir() } })).code).toBe(0);
    const child = spawn(process.execPath, [CLI_SOURCE, 'create', 'leaked', '--status', 'todo', '--as', 'a', '--json'], { cwd });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const code = await new Promise((resolve) => child.on('exit', resolve));
    expect(code).not.toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: false });
    expect(out).toContain(LEAKED_BOARD);
    const active = JSON.parse(fs.readFileSync(path.join(cwd, '.laneboard', 'active.json'), 'utf8'));
    expect(active.tasks).toEqual([]);
  });

  it('every test file that starts a process imports test/helpers.ts, so the guard runs in its worker', () => {
    const starts = /\bchild_process\b|StdioClientTransport/;
    const unguarded = testFiles(path.join(REPO, 'test'))
      .filter((file) => !file.endsWith(`${path.sep}helpers.ts`))
      .filter((file) => {
        const text = fs.readFileSync(file, 'utf8');
        return starts.test(text) && !runsGuard(text);
      })
      .map((file) => path.relative(REPO, file));
    expect(unguarded).toEqual([]);
  });

  it('only an import that runs test/helpers.ts counts: import type does not (review C2)', () => {
    expect(runsGuard("import { cli } from '../helpers.ts';")).toBe(true);
    expect(runsGuard("import {\n  cli,\n  newStore,\n} from '../../helpers.ts';")).toBe(true);
    expect(runsGuard("import '../helpers.ts';")).toBe(true);
    expect(runsGuard("import { type TestStore } from './helpers.ts';")).toBe(true);
    expect(runsGuard("import type { TestStore } from '../helpers.ts';")).toBe(false);
    expect(runsGuard("import type { TestStore } from '../helpers.ts';\nimport { x } from '../other.ts';")).toBe(false);
    expect(runsGuard("import type { TestStore } from '../helpers.ts';\nimport { cli } from '../helpers.ts';")).toBe(true);
  });
});
