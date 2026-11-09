// Test helpers: temp stores, in-process CLI runs, child processes, raw store file access.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { RULES_MAX_CHARS, SHORT_RULES_MAX_CHARS, shortRules } from '../src/cli/format.ts';
import { runCli } from '../src/cli/run.ts';
import { agentRules, initStore, LaneboardError } from '../src/core/index.ts';
import type { ErrorCode, OpContext, StoreRef } from '../src/core/index.ts';

export const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const WORKER = path.join(REPO, 'test', 'fixtures', 'worker.ts');
export const CLI_SOURCE = path.join(REPO, 'src', 'cli', 'main.ts');

const made: string[] = [];

// Isolation guard (incident 06.11: a spawn without `env` inherited the session's LANEBOARD_DIR and created tasks on a live board).
// Every test file that runs the CLI imports this module, so its worker drops the variables that pick a board, a name or a config
// folder, and points LANEBOARD_DIR at a path no board can be at: a child process started without its own `env` fails (STORE_NOT_FOUND
// or ENOTDIR) instead of reaching the runner's board. HOME becomes an empty folder of this test file: no ~/.laneboard registry, ~/.claude
// or ~/.gitconfig of the machine is read or written. test/isolation.test.ts checks the guard.
export const LEAKED_BOARD = '/dev/null/laneboard-test-guard';
export const GUARD_DROPPED_ENV = ['LANEBOARD_AGENT', 'LANEBOARD_DEFAULT_AGENT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME'] as const;
for (const key of GUARD_DROPPED_ENV) delete process.env[key];
process.env.LANEBOARD_DIR = LEAKED_BOARD;
const guardHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lb-test-home-')));
process.env.HOME = guardHome;
// Each test file imports this module anew (vitest isolates files), so its HOME goes with the file.
afterAll(() => fs.rmSync(guardHome, { recursive: true, force: true }));

// Fresh temp directory (realpath, so it matches process.cwd() on macOS).
export function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lb-test-')));
  made.push(dir);
  return dir;
}

// Remove temp directories created by this test file.
export function cleanupTemp(): void {
  for (const dir of made.splice(0)) {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface TestStore {
  root: string;
  dir: string;
  store: StoreRef;
}

// Initialize a store at <temp>/.laneboard (prefix LB unless given: the temp folder name would derive a random one).
export async function newStore(opts: { prefix?: string; statuses?: string[] } = {}): Promise<TestStore> {
  const root = tempDir();
  const dir = path.join(root, '.laneboard');
  await initStore(dir, { prefix: opts.prefix ?? 'LB', statuses: opts.statuses, name: 'test', description: 'test board' });
  return { root, dir, store: { dir } };
}

// Op context acting as `actor`.
export function as(s: TestStore, actor = 'tester', extra: Partial<OpContext> = {}): OpContext {
  return { store: s.store, actor, ...extra };
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

// Run the CLI in-process with an isolated environment.
export async function cli(argv: string[], opts: { cwd: string; env?: Record<string, string>; stdin?: string; lockWaitMs?: number; lockMaxHoldMs?: number }): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const code = await runCli({
    argv,
    env: opts.env ?? {},
    cwd: opts.cwd,
    readStdin: () => opts.stdin ?? '',
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
    lockWaitMs: opts.lockWaitMs,
    lockMaxHoldMs: opts.lockMaxHoldMs,
  });
  return { code, stdout, stderr };
}

// Run a node child process with only PATH and `env` (never the runner's LANEBOARD_DIR, LANEBOARD_AGENT, HOME); `stdin` is written and
// closed when given. Resolves with exit code and output.
export function spawnNode(args: string[], opts: { cwd?: string; env?: Record<string, string>; stdin?: string } = {}): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: opts.cwd ?? REPO, env: { PATH: process.env.PATH ?? '', ...opts.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

// Parsed store file straight from disk.
export function readStore(dir: string, kind: 'active' | 'archive'): { rev: number; next_id?: number; schema: string; tasks: Array<Record<string, unknown> & { id: string; rev: number }> } & Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, `${kind}.json`), 'utf8'));
}

// The warnings without finish's "no comment on <ID> between your claim and this finish" (0.4.4, tested in test/cli/agent-ux.test.ts):
// tests of the other finish warnings leave it out.
export function otherWarnings(warnings: readonly string[]): string[] {
  return warnings.filter((w) => !w.startsWith('no comment on '));
}

// Overwrite a store file by hand (simulates a hand edit or corruption).
export function writeRaw(file: string, content: string): void {
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o444);
}

// Assert that a promise rejects with a LaneboardError of `code`; returns the error.
export async function rejectsWith(promise: Promise<unknown>, code: ErrorCode): Promise<LaneboardError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof LaneboardError && err.code === code) return err;
    throw new Error(`expected ${code}, got ${err instanceof LaneboardError ? err.code : String(err)}`);
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

// The agent rules padded to the prime budgets (review S5a MINOR 1): the header line (it has no short form) grows by the room left under
// SHORT_RULES_MAX_CHARS, rule 5 (it has one) by the rest up to RULES_MAX_CHARS. Prime tests built on it check prime at the ceiling of
// the budgets, so a longer rule fails the budget test, not them.
export function ceilingRules(): string {
  const rules = agentRules();
  const lines = rules.split('\n');
  lines[0] = `${lines[0] ?? ''}${'x'.repeat(SHORT_RULES_MAX_CHARS - shortRules(rules).length)}`;
  const five = lines.findIndex((l) => l.startsWith('5. '));
  lines[five] = `${lines[five] ?? ''}${'y'.repeat(RULES_MAX_CHARS - lines.join('\n').length)}`;
  const out = lines.join('\n');
  if (out.length !== RULES_MAX_CHARS || shortRules(out).length !== SHORT_RULES_MAX_CHARS) throw new Error('ceilingRules: the budgets cannot both be reached');
  return out;
}

// A store path of exactly `len` characters for primeText (the tmpdir differs between macOS and Linux; prime prints the path).
export function fixedStorePath(len = 100): string {
  return `/${'p'.repeat(len - '/'.length - '/.laneboard'.length)}/.laneboard`;
}
