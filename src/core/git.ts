// What git says about the checkout finish links: HEAD, its commit time and uncommitted changes, a commit named by its sha, the
// worktrees of the repository. git is asked, if it is there; the store never depends on it (ADR-0001 §0, §21). Where a linked
// worktree's repository lies is read from its `.git` file without running git (store discovery is synchronous).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Each git call gets this long; then it counts as "could not check".
export const GIT_TIMEOUT_MS = 2000;

// The checkout holding a folder. Nothing set: not a git repository, or no commit yet (nothing to link). `problem`: git could
// not answer (not installed, timed out, failed); the parts read before that stay.
export interface CheckoutState {
  head?: string;
  // HEAD's commit time, unix seconds.
  committedAt?: number;
  // Tracked files, staged or not, differ from HEAD (`git status --porcelain -uno` prints a line).
  dirty?: boolean;
  problem?: string;
}

// One git run: `out` on success; else `problem`, and `noCommit` when the folder is no repository or has no commit yet.
interface GitRun {
  out?: string;
  problem?: string;
  noCommit?: boolean;
}

// Run git in `cwd` with a timeout. No optional locks and no fsmonitor: reading neither writes .git/index nor starts a helper
// program. LC_ALL=C: git's "not a git repository" in English.
function runGit(cwd: string, args: string[]): Promise<GitRun> {
  const argv = ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args];
  return new Promise((resolve) => {
    execFile('git', argv, { cwd, timeout: GIT_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err === null) return resolve({ out: stdout.trim() });
      if (err.code === 'ENOENT') return resolve({ problem: 'git not found in PATH' });
      if (err.killed) return resolve({ problem: `git did not answer in ${GIT_TIMEOUT_MS / 1000} s` });
      // `rev-parse --verify -q` exits 1 silently before the first commit.
      const noCommit = /not a git repository/.test(stderr) || (err.code === 1 && stderr.trim() === '');
      resolve({ problem: `git ${args[0]}: ${stderr.trim().split('\n')[0] || err.message}`, noCommit });
    });
  });
}

// HEAD, its commit time and whether tracked files have uncommitted changes, for the checkout holding `cwd`.
export async function readCheckout(cwd: string): Promise<CheckoutState> {
  const head = await runGit(cwd, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (head.out === undefined) return head.noCommit === true ? {} : { problem: head.problem };
  const [time, status] = await Promise.all([runGit(cwd, ['log', '-1', '--format=%ct', head.out]), runGit(cwd, ['status', '--porcelain', '-uno'])]);
  return {
    head: head.out,
    committedAt: time.out === undefined ? undefined : Number(time.out),
    dirty: status.out === undefined ? undefined : status.out !== '',
    problem: time.problem ?? status.problem,
  };
}

// A commit named by the caller (finish --commit, MCP commit): its full sha and commit time, read in `cwd`. `unknown`: git answered,
// and no such commit is in the repository; `problem`: git could not answer (not a repository, not installed, timed out).
export interface CommitState {
  sha?: string;
  committedAt?: number;
  unknown?: boolean;
  problem?: string;
}

// The full sha and commit time of `ref` (7 to 64 hex digits) in the repository holding `cwd`.
export async function readCommit(cwd: string, ref: string): Promise<CommitState> {
  const top = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (top.out === undefined) return { problem: top.problem };
  const sha = await runGit(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  if (sha.out === undefined) return sha.noCommit === true ? { unknown: true } : { problem: sha.problem };
  const time = await runGit(cwd, ['log', '-1', '--format=%ct', sha.out]);
  return { sha: sha.out, committedAt: time.out === undefined ? undefined : Number(time.out), problem: time.problem };
}

// One checked-out worktree of a repository: its folder, HEAD, branch (none when detached) and HEAD's commit time (unix seconds).
export interface WorktreeState {
  path: string;
  head: string;
  branch?: string;
  committedAt?: number;
}

// The worktrees of the repository holding `cwd` (`git worktree list`: the main checkout first; bare and prunable entries left out)
// and the folder of the one holding `cwd`; undefined when git cannot tell (no repository, git missing or failing).
export async function readWorktrees(cwd: string): Promise<{ here: string; list: WorktreeState[] } | undefined> {
  const [top, listed] = await Promise.all([runGit(cwd, ['rev-parse', '--show-toplevel']), runGit(cwd, ['worktree', 'list', '--porcelain'])]);
  if (top.out === undefined || listed.out === undefined) return undefined;
  const list: WorktreeState[] = [];
  for (const block of listed.out.split(/\n\s*\n/)) {
    const line = (key: string): string | undefined => block.split('\n').find((l) => l === key || l.startsWith(`${key} `))?.slice(key.length + 1);
    const folder = line('worktree');
    const head = line('HEAD');
    if (folder === undefined || head === undefined || line('bare') !== undefined || line('prunable') !== undefined) continue;
    const branch = line('branch');
    list.push({ path: folder, head, ...(branch ? { branch: branch.replace(/^refs\/heads\//, '') } : {}) });
  }
  const shas = [...new Set(list.map((w) => w.head))];
  const times = shas.length ? await runGit(cwd, ['log', '--no-walk=unsorted', '--format=%H %ct', ...shas]) : {};
  const at = new Map((times.out ?? '').split('\n').map((l) => l.split(' ') as [string, string]));
  for (const w of list) {
    const t = at.get(w.head);
    if (t !== undefined) w.committedAt = Number(t);
  }
  return { here: top.out, list };
}

// Is `p` an existing directory?
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    // Missing or unreadable: no directory here.
    return false;
  }
}

// A linked git worktree (`git worktree add`) holding `cwd`: its root (the folder with the `.git` file), the repository's common git
// directory (the `commondir` file in the folder the `.git` file names) and the main checkout (the folder of that `.git` directory;
// none for a bare repository). Undefined for a `.git` directory, a submodule (no commondir), no repository or a broken link.
export interface LinkedWorktree {
  root: string;
  commonDir: string;
  main?: string;
}

// The linked worktree holding `cwd`, read from files only (see LinkedWorktree); the nearest `.git` from cwd up decides.
export function linkedWorktree(cwd: string): LinkedWorktree | undefined {
  let root = path.resolve(cwd);
  while (!fs.existsSync(path.join(root, '.git'))) {
    if (path.dirname(root) === root) return undefined;
    root = path.dirname(root);
  }
  let common: string;
  try {
    // A `.git` directory fails here with EISDIR: not a linked worktree.
    const text = fs.readFileSync(path.join(root, '.git'), 'utf8');
    const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (!gitdir) return undefined;
    const gitDir = path.resolve(root, gitdir);
    common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
  } catch {
    // No `.git` file, or no commondir next to the folder it names (a submodule, a removed worktree): not a linked worktree.
    return undefined;
  }
  if (!isDirectory(common)) return undefined;
  return { root, commonDir: common, ...(path.basename(common) === '.git' ? { main: path.dirname(common) } : {}) };
}
