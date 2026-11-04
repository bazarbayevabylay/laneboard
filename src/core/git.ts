// What git says about the checkout finish links: HEAD, its commit time and uncommitted changes. git is asked, if it is there;
// the store never depends on it (ADR-0001 §0, §21).
import { execFile } from 'node:child_process';

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
