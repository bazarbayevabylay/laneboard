// S6r "release 0.4.0" (LB-44; audit A33, A34): the CLI names an old Node.js in one warning line (stderr, or `warnings` with --json),
// and the version it prints is the package's 0.4.0, the same as the Claude Code plugin's.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { nodeWarning, runCli } from '../../src/cli/run.ts';
import { cleanupTemp, REPO, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

// Run the CLI in-process as if on the given Node.js version.
async function onNode(nodeVersion: string | undefined, argv: string[], cwd = tempDir()): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const code = await runCli({
    argv,
    // HOME apart from the project: the registry ~/.laneboard is never the board ./.laneboard.
    env: { HOME: tempDir() },
    cwd,
    readStdin: () => '',
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    ...(nodeVersion === undefined ? {} : { nodeVersion }),
  });
  return { code, stdout, stderr };
}

const OLD_NODE = /^warning: laneboard needs Node\.js 22 or newer and runs on 20\.11\.1, so commands may fail: install Node\.js 22 .*npm i -g laneboard again$/;

describe('A34: an old Node.js gets one warning line', () => {
  it('names the version and the way out, only below 22', () => {
    expect(nodeWarning('20.11.1')).toMatch(/needs Node\.js 22 or newer and runs on 20\.11\.1/);
    expect(nodeWarning('v18.20.4')).toMatch(/runs on v18\.20\.4/);
    expect(nodeWarning('22.0.0')).toBeUndefined();
    expect(nodeWarning('24.11.0')).toBeUndefined();
    expect(nodeWarning('nonsense')).toBeUndefined();
  });

  it('human output: the result on stdout, one warning line on stderr', async () => {
    const r = await onNode('20.11.1', ['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('0.4.1\n');
    const lines = r.stderr.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(OLD_NODE);
  });

  it('--json: the line is in warnings and stderr stays empty', async () => {
    const r = await onNode('20.11.1', ['--version', '--json']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    const doc = JSON.parse(r.stdout) as { ok: boolean; data: { version: string }; warnings: string[] };
    expect(doc.data.version).toBe('0.4.1');
    expect(doc.warnings).toHaveLength(1);
    expect(`warning: ${doc.warnings[0]}`).toMatch(OLD_NODE);
  });

  it('a command result carries it before its own warnings; an error is preceded by it on stderr', async () => {
    const root = tempDir();
    const init = await onNode('20.11.1', ['init', '--name', 'old-node', '--description', 'Old Node test board', '--json'], root);
    expect(init.code, init.stdout).toBe(0);
    const doc = JSON.parse(init.stdout) as { warnings: string[] };
    expect(`warning: ${doc.warnings[0]}`).toMatch(OLD_NODE);
    const failed = await onNode('20.11.1', ['get', 'OLDN-99'], root);
    expect(failed.code).toBe(3);
    const [first, second] = failed.stderr.split('\n');
    expect(first).toMatch(OLD_NODE);
    expect(second).toMatch(/^error TASK_NOT_FOUND/);
  });

  it('Node.js 22 and the real runtime print no such line', async () => {
    for (const v of ['22.0.0', undefined]) {
      const r = await onNode(v, ['--version', '--json']);
      expect(JSON.parse(r.stdout).warnings).toEqual([]);
      const human = await onNode(v, ['--version']);
      expect(human.stderr).toBe('');
    }
  });
});

describe('A33: version 0.4.1 everywhere', () => {
  it('package.json, package-lock.json and the plugin say 0.4.1', () => {
    const read = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8')) as Record<string, unknown>;
    const pkg = read('package.json') as { version: string; files: string[]; os: string[]; engines: { node: string } };
    expect(pkg.version).toBe('0.4.1');
    expect((read('package-lock.json') as { version: string }).version).toBe('0.4.1');
    expect((read('plugins/claude-code/.claude-plugin/plugin.json') as { version: string }).version).toBe('0.4.1');
    expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'schema', 'README.md', 'README.ru.md', 'CHANGELOG.md', 'docs/agent-guide.md', 'LICENSE']));
    expect(pkg.os).toEqual(['darwin', 'linux']);
    expect(pkg.engines.node).toBe('>=22');
  });

  it('the changelog starts with this version', () => {
    const changelog = fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toMatch(/^## 0\.4\.1\b/m);
    expect(changelog.indexOf('## 0.4.1')).toBeLessThan(changelog.indexOf('## 0.4.0'));
    expect(changelog.indexOf('## 0.4.0')).toBeLessThan(changelog.indexOf('## 0.3.1'));
  });
});
