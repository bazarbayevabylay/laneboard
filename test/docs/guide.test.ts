// The docs are executable: every ```sh block of docs/agent-guide.md, the other docs/*.md listed in FILES, README.md and README-ru.md
// runs, in order, in one bash session in a fresh temp project and temp HOME, through the CLI compiled from src/ (tsc, as `npm run build`
// does: one node start per command, without type stripping). A command must exit 0, or the code named by a trailing `# exit <n>`.
// ```json file=<path> blocks are written to that path at their place. Only blocks marked <!-- guide:skip <reason> --> do not run
// (global installs); the test lists them, so nothing else is skipped silently.
// Bounds (guide-hang, RC check): every laneboard command is killed after STEP_LIMIT_S (SIGALRM, exit 142), the whole session after
// SESSION_LIMIT_MS (SIGKILL), and the log keeps the time of every step, so a slow or hanging step is named instead of a silent wait.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTemp, REPO, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

// One laneboard command may take this long (a step is 0.2-2.5 s even on a loaded machine).
const STEP_LIMIT_S = 30;
// The whole bash session of one file: a hard stop (48-95 s were measured under load with the CLI from src/, one third of that from tsc output).
const SESSION_LIMIT_MS = 300_000;
// The test of one file: room for a loaded machine (vitest's 60 s gave false timeouts, guide-hang); the step limit names a slow step first.
const RUN_TEST_TIMEOUT_MS = 180_000;

// The compiled CLI: main.js of a tsc build of src/ in a temp folder (package.json beside it for --version, node_modules linked).
let cliMain = '';

beforeAll(() => {
  const root = tempDir();
  const out = path.join(root, 'dist');
  const tsc = spawnSync(process.execPath, [path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(REPO, 'tsconfig.build.json'), '--outDir', out], { encoding: 'utf8' });
  expect(tsc.status, `${tsc.stdout}${tsc.stderr}`).toBe(0);
  fs.copyFileSync(path.join(REPO, 'src', 'core', 'agent-rules.md'), path.join(out, 'core', 'agent-rules.md'));
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(root, 'package.json'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'));
  cliMain = path.join(out, 'cli', 'main.js');
}, 120_000);

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
  // perl's alarm survives its exec: the command is killed by SIGALRM after STEP_LIMIT_S seconds (exit 142).
  fs.writeFileSync(path.join(bin, 'laneboard'), `#!/bin/sh\nexec perl -e 'alarm shift; exec @ARGV' ${STEP_LIMIT_S} "${process.execPath}" "${cliMain}" "$@"\n`, { mode: 0o755 });
  const log = path.join(root, 'guide.log');
  const clock = `perl -MTime::HiRes=time -e 'printf "%.2f", time - ($ARGV[0] // 0)'`;
  const script = steps
    .map((s, n) =>
      [
        `echo '### step ${n} (line ${s.line})' >>"$GUIDE_LOG"`,
        `t0=$(${clock})`,
        '{',
        s.text,
        '} >>"$GUIDE_LOG" 2>&1',
        'rc=$?',
        `echo "### step ${n}: exit $rc in $(${clock} "$t0") s" >>"$GUIDE_LOG"`,
        `if [ "$rc" -ne ${s.expect} ]; then echo "FAIL ${n} $rc"; exit 1; fi`,
      ].join('\n'),
    )
    .join('\n');
  const r = spawnSync('bash', ['-c', script], {
    cwd: project,
    env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, GUIDE_LOG: log, LANG: 'C.UTF-8' },
    encoding: 'utf8',
    timeout: SESSION_LIMIT_MS,
    killSignal: 'SIGKILL',
  });
  const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  if (r.error || r.signal) {
    // The session was killed: name the step it was in (the last header in the log).
    const last = [...text.matchAll(/^### step (\d+) \(line \d+\)$/gm)].at(-1)?.[1];
    const step = last === undefined ? undefined : steps[Number(last)];
    throw new Error(`the bash session was stopped (${r.error?.message ?? r.signal}) after ${SESSION_LIMIT_MS / 1000} s in step ${last ?? '?'}: ${step?.text ?? ''}\n--- log tail ---\n${text.slice(-3000)}`);
  }
  const fail = /FAIL (\d+) (\d+)/.exec(r.stdout);
  if (!fail) {
    expect(r.status, r.stderr).toBe(0);
    return { log: text };
  }
  return { failed: steps[Number(fail[1])], code: Number(fail[2]), log: text };
}

// README-ru.md mirrors README.md (ADR-0001 §10, §57: not README.ru.md, which npm would show as the package page).
const RU_README = path.join(REPO, 'README-ru.md');
const FILES: Array<[string, number]> = [
  ['docs/agent-guide.md', 40],
  // The pages the README links to for details; each starts with its own `init`, so it runs on its own.
  ['docs/install.md', 7],
  ['docs/configuration.md', 9],
  ['docs/task-cycle.md', 11],
  ['docs/agent-names.md', 5],
  ['docs/orchestrators.md', 17],
  ['docs/monorepo.md', 6],
  ['docs/board-http-api.md', 3],
  ['docs/storage.md', 4],
  ['README.md', 8],
  ['README-ru.md', 8],
];

// The Markdown headings of a file (outside code blocks), as their levels in order.
function headingLevels(file: string): number[] {
  const levels: number[] = [];
  let code = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('```')) code = !code;
    const h = /^(#{1,6}) /.exec(line);
    if (!code && h) levels.push(h[1]?.length ?? 0);
  }
  return levels;
}

describe('README-ru.md mirrors README.md', () => {
  it('the same headings, level by level, and the same number of sh blocks', () => {
    const en = path.join(REPO, 'README.md');
    expect(headingLevels(RU_README)).toEqual(headingLevels(en));
    expect(parse(RU_README).steps.length).toBe(parse(en).steps.length);
  });
});

describe('docs/*.md', () => {
  it('every page of docs/ is listed in FILES, so its sh blocks run', () => {
    const pages = fs.readdirSync(path.join(REPO, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`);
    expect(pages.filter((p) => !FILES.some(([file]) => file === p))).toEqual([]);
  });
});

describe.each(FILES)('%s runs as written', (file, minSteps) => {
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
  }, RUN_TEST_TIMEOUT_MS);
});
