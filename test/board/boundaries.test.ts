// C9 (K6): the web board is read-only and reaches the core only through src/core/index.ts; planted violations fail the script.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTemp, REPO, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

const SCRIPT = path.join(REPO, 'scripts', 'check-boundaries.sh');

// A tree of files under a temp root.
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

const clean = {
  'src/core/index.ts': "export { viewBoard } from './ops/read.ts';",
  'src/board/server/api.ts': "import { viewBoard, getTask } from '../../core/index.ts';",
  'src/board/ui/App.vue': "<script setup lang=\"ts\">import type { TaskView } from '../../core/index.ts';</script>",
};

describe('check-boundaries.sh C9 (web board read-only)', () => {
  it('passes on a clean board tree', () => {
    expect(check(tree(clean))).toMatchObject({ code: 0 });
  });

  it('a core write op or the store lock named in src/board fails', () => {
    for (const name of ['updateTask', 'transact', 'withLock', 'commentTask', 'doctor']) {
      const r = check(tree({ ...clean, 'src/board/server/api.ts': `import { ${name} } from '../../core/index.ts';` }));
      expect(r.code, name).toBe(1);
      expect(r.out).toContain('C9 violation');
      expect(r.out).toContain('src/board/server/api.ts');
    }
  });

  it('an import of a core module other than index.ts fails (server and UI alike)', () => {
    const server = check(tree({ ...clean, 'src/board/server/http.ts': "import { readActive } from '../../core/transact.ts';" }));
    expect(server.code).toBe(1);
    expect(server.out).toContain('imports core modules');
    const ui = check(tree({ ...clean, 'src/board/ui/x.ts': "import type { TaskT } from \"../../core/schema.ts\";" }));
    expect(ui.code).toBe(1);
  });
});
