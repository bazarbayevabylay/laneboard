// W1/C1, C2 and C4 boundary checks: clean repo passes; planted violations fail.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTemp, REPO, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

const SCRIPT = path.join(REPO, 'scripts', 'check-boundaries.sh');

// Build a tree of files under a temp root.
function tree(files: Record<string, string>): string {
  const root = tempDir();
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

// Run the boundary script on a root.
function check(root: string): { code: number | null; out: string } {
  const r = spawnSync('bash', [SCRIPT, root], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

const allowed = {
  'src/core/fsio.ts': "import fs from 'node:fs'; fs.writeFileSync('a', 'b'); fs.renameSync('a', 'b');",
  'src/setup/claude.ts': "import fs from 'node:fs'; fs.writeFileSync('x', 'y');",
  'src/core/index.ts': "export * from './fsio.ts';",
};

describe('check-boundaries.sh', () => {
  it('passes on this repo', () => {
    expect(check(REPO)).toMatchObject({ code: 0 });
  });

  it('passes on a clean planted tree', () => {
    expect(check(tree(allowed))).toMatchObject({ code: 0 });
  });

  it('C1: a file write outside fsio/setup fails', () => {
    const r = check(tree({ ...allowed, 'src/mcp/server.ts': "import fs from 'node:fs'; fs.appendFileSync('log', 'x');" }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('C1 violation');
    expect(r.out).toContain('src/mcp/server.ts');
  });

  it('C1: a write in another core module fails too', () => {
    const r = check(tree({ ...allowed, 'src/core/transact.ts': "import fs from 'node:fs'; fs.renameSync('a', 'b');" }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/core/transact.ts');
  });

  it('C4: stdout writes in src/mcp fail', () => {
    for (const line of ["console.log('debug');", "process.stdout.write('x');"]) {
      const r = check(tree({ ...allowed, 'src/mcp/server.ts': line }));
      expect(r.code, line).toBe(1);
      expect(r.out).toContain('C4 violation');
    }
    expect(check(tree({ ...allowed, 'src/mcp/server.ts': "process.stderr.write('ok');" }))).toMatchObject({ code: 0 });
  });

  it('C2: core importing a facade fails', () => {
    const r = check(tree({ ...allowed, 'src/core/ops/x.ts': "import { runCli } from '../../cli/run.ts';" }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('C2 violation');
  });
});
