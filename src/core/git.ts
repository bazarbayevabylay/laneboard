// The commit a folder's git checkout is at, read from the repository files (laneboard never runs git; ADR-0001 §0, §19).
import fs from 'node:fs';
import path from 'node:path';

// A full object name: SHA-1 (40 hex) or SHA-256 (64 hex).
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Text of a file, or undefined when it cannot be read.
function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    // No such file (no repository here, a ref that is not loose): the caller tries the next place.
    return undefined;
  }
}

// The git directory of the repository holding `cwd`: the nearest `.git` folder, or the folder a `.git` file names (worktree, submodule).
function gitDir(cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    const stat = fs.statSync(dotGit, { throwIfNoEntry: false });
    if (stat?.isDirectory()) return dotGit;
    if (stat?.isFile()) {
      const target = /^gitdir:\s*(.+)$/m.exec(readText(dotGit) ?? '')?.[1]?.trim();
      return target ? path.resolve(dir, target) : undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// The commit HEAD points at for the repository holding `cwd`; undefined outside a repository, before the first commit,
// or for a ref format laneboard does not read (reftable).
export function gitHead(cwd: string): string | undefined {
  const dir = gitDir(cwd);
  if (dir === undefined) return undefined;
  const head = readText(path.join(dir, 'HEAD'))?.trim() ?? '';
  if (SHA_RE.test(head)) return head;
  const ref = /^ref:\s*(refs\/\S+)$/.exec(head)?.[1];
  if (ref === undefined) return undefined;
  // A worktree keeps its HEAD in its own folder and the branches in the main repository (named by `commondir`).
  const common = path.resolve(dir, readText(path.join(dir, 'commondir'))?.trim() || '.');
  for (const base of [dir, common]) {
    const loose = readText(path.join(base, ref))?.trim() ?? '';
    if (SHA_RE.test(loose)) return loose;
  }
  for (const line of (readText(path.join(common, 'packed-refs')) ?? '').split('\n')) {
    const [sha, name] = line.trim().split(' ');
    if (name === ref && sha !== undefined && SHA_RE.test(sha)) return sha;
  }
  return undefined;
}
