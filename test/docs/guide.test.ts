// The docs are executable: every ```sh block of docs/agent-guide.md and README.md runs, in order, in one bash session
// in a fresh temp project and temp HOME, through the CLI from src/. A command must exit 0, or the code named by a trailing `# exit <n>`.
// ```json file=<path> blocks are written to that path at their place. Only blocks marked <!-- guide:skip <reason> --> do not run
// (global installs); the test lists them, so nothing else is skipped silently.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTemp, CLI_SOURCE, REPO, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

interface Step {
  // Line of the command in the Markdown file.
  line: number;
  // Shell text (one command, with its heredoc body).
  text: string;
  expect: number;
}

interface Parsed {
  steps: Step[];
  skipped: Array<{ line: number; reason: string; text: string }>;
}

// Split a sh block into commands: a heredoc body and `\` continuations belong to their command; blank and comment lines are dropped.
function commands(lines: readonly string[], firstLine: number): Step[] {
  const out: Step[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i] ?? '';
    if (head.trim() === '' || head.trim().startsWith('#')) continue;
    const start = i;
    const body = [head];
    while ((lines[i] ?? '').endsWith('\\') && i + 1 < lines.length) body.push(lines[++i] ?? '');
    const heredoc = /<<-?'?([A-Za-z_]+)'?/.exec(body.join('\n'))?.[1];
    if (heredoc) while (i + 1 < lines.length && lines[i] !== heredoc) body.push(lines[++i] ?? '');
    const code = /#\s*exit\s+(\d+)\s*$/.exec(head)?.[1];
    out.push({ line: firstLine + start, text: body.join('\n'), expect: code === undefined ? 0 : Number(code) });
  }
  return out;
}

// Steps of one Markdown file: sh commands and config writes, in document order.
function parse(file: string): Parsed {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const parsed: Parsed = { steps: [], skipped: [] };
  for (let i = 0; i < lines.length; i++) {
    const fence = /^```(\w+)(?:\s+file=(\S+))?\s*$/.exec(lines[i] ?? '');
    if (!fence) continue;
    const lang = fence[1];
    const target = fence[2];
    const skip = /^<!-- guide:skip (.+) -->$/.exec(lines[i - 1] ?? '');
    const start = i + 1;
    let end = start;
    while (end < lines.length && lines[end] !== '```') end++;
    const body = lines.slice(start, end);
    if (lang === 'sh' && skip) parsed.skipped.push({ line: start + 1, reason: skip[1] ?? '', text: body.join('\n') });
    else if (lang === 'sh') parsed.steps.push(...commands(body, start + 1));
    else if (target) parsed.steps.push({ line: start + 1, text: `cat > ${target} <<'GUIDE_FILE'\n${body.join('\n')}\nGUIDE_FILE`, expect: 0 });
    i = end;
  }
  return parsed;
}

// Run the steps in one bash session; returns the first failing step (or undefined) and the log of all output.
function run(steps: readonly Step[]): { failed?: Step; code?: number; log: string } {
  const root = tempDir();
  const project = path.join(root, 'my-app');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  for (const dir of [project, home, bin]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(bin, 'laneboard'), `#!/bin/sh\nexec "${process.execPath}" "${CLI_SOURCE}" "$@"\n`, { mode: 0o755 });
  const log = path.join(root, 'guide.log');
  const script = steps
    .map((s, n) => [`echo '### step ${n}' >>"$GUIDE_LOG"`, '{', s.text, '} >>"$GUIDE_LOG" 2>&1', 'rc=$?', `if [ "$rc" -ne ${s.expect} ]; then echo "FAIL ${n} $rc"; exit 1; fi`].join('\n'))
    .join('\n');
  const r = spawnSync('bash', ['-c', script], {
    cwd: project,
    env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, GUIDE_LOG: log, LANG: 'C.UTF-8' },
    encoding: 'utf8',
  });
  const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const fail = /FAIL (\d+) (\d+)/.exec(r.stdout);
  if (!fail) {
    expect(r.status, r.stderr).toBe(0);
    return { log: text };
  }
  return { failed: steps[Number(fail[1])], code: Number(fail[2]), log: text };
}

describe.each([
  ['docs/agent-guide.md', 40],
  ['README.md', 8],
])('%s runs as written', (file, minSteps) => {
  const parsed = parse(path.join(REPO, file));

  it('only global installs are skipped', () => {
    expect(parsed.skipped.length).toBeGreaterThan(0);
    for (const s of parsed.skipped) {
      expect(s.reason, `line ${s.line}`).toBe('installs globally');
      expect(s.text, `line ${s.line}`).toMatch(/npm i -g /);
    }
  });

  it('every command exits as stated', () => {
    expect(parsed.steps.length).toBeGreaterThanOrEqual(minSteps);
    const r = run(parsed.steps);
    const where = r.failed ? `${file}:${r.failed.line} exited ${r.code}, expected ${r.failed.expect}: ${r.failed.text}\n--- log tail ---\n${r.log.slice(-3000)}` : '';
    expect(where).toBe('');
  });
});
