// Test helpers: temp stores, in-process CLI runs, child processes, raw store file access.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/run.ts';
import { initStore, LaneboardError } from '../src/core/index.ts';
import type { ErrorCode, OpContext, StoreRef } from '../src/core/index.ts';

export const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const WORKER = path.join(REPO, 'test', 'fixtures', 'worker.ts');
export const CLI_SOURCE = path.join(REPO, 'src', 'cli', 'main.ts');

const made: string[] = [];

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

// Initialize a store at <temp>/.laneboard.
export async function newStore(opts: { prefix?: string; statuses?: string[] } = {}): Promise<TestStore> {
  const root = tempDir();
  const dir = path.join(root, '.laneboard');
  await initStore(dir, { prefix: opts.prefix, statuses: opts.statuses });
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

// Run a node child process; resolves with exit code and output.
export function spawnNode(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: opts.cwd ?? REPO, env: { PATH: process.env.PATH ?? '', ...opts.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

// Parsed store file straight from disk.
export function readStore(dir: string, kind: 'active' | 'archive'): { rev: number; next_id?: number; schema: string; tasks: Array<Record<string, unknown> & { id: string; rev: number }> } & Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, `${kind}.json`), 'utf8'));
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
