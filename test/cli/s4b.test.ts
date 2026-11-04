// S4b (review S4 MINOR and the prime room): the commands view and prime print under their lists name the same tasks they count
// (filters, --dir, --board, open statuses), and prime prints a store path named by --dir once, so a 5-status config keeps its lines.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agentRules, createTask, VIEW_FINAL_MAX } from '../../src/core/index.ts';
import { PRIME_MAX_CHARS, primeText } from '../../src/cli/format.ts';
import type { PrimeData } from '../../src/cli/format.ts';
import type { ListItem } from '../../src/core/index.ts';
import { as, cleanupTemp, cli, newStore, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

// The argv of a printed `laneboard ...` command (the test paths have no spaces or quotes).
function argvOf(command: string): string[] {
  return command.replace(/^laneboard /, '').split(' ');
}

// The `+K more: laneboard list ...` hint of a view text (the narrow list wraps it at spaces, indented): K and the command.
function moreHint(text: string): { more: number; command: string } {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^ {2}\+\d+ more: /.test(l));
  if (at < 0) throw new Error(`no more hint in:\n${text}`);
  let hint = (lines[at] ?? '').trim();
  for (let i = at + 1; /^ {2}\S/.test(lines[i] ?? '') && !/^ {2}[A-Z]+-\d+ /.test(lines[i] ?? '') && (lines[i] ?? '').trim() !== ''; i++) hint += ` ${(lines[i] ?? '').trim()}`;
  const m = /^\+(\d+) more: (laneboard list .+)$/.exec(hint);
  return { more: Number(m?.[1]), command: m?.[2] ?? '' };
}

describe('review S4 MINOR: the "+K more" hint of view lists exactly the done tasks it counts', () => {
  // dev-1 has 8 done tasks (2 labelled ui), dev-2 has 6; one open task each.
  async function board() {
    const s = await newStore();
    await createTask(as(s, 'a'), { title: 'Open', status: 'todo', assignee: 'dev-1' });
    await createTask(as(s, 'a'), { title: 'Open too', status: 'todo', assignee: 'dev-2' });
    for (let i = 0; i < 8; i++) await createTask(as(s, 'a'), { title: `Shipped ${i}`, status: 'done', assignee: 'dev-1', labels: i < 2 ? ['ui'] : [] });
    for (let i = 0; i < 6; i++) await createTask(as(s, 'a'), { title: `Other ${i}`, status: 'done', assignee: 'dev-2' });
    return s;
  }

  it('filters and --dir from another folder: the hint repeats them, and running it lists the shown cards plus K', async () => {
    const s = await board();
    const elsewhere = tempDir();
    const runs: Array<{ argv: string[]; total: number; hint: string }> = [
      { argv: [], total: 14, hint: 'laneboard list --status done' },
      { argv: ['--assignee', 'dev-2'], total: 6, hint: 'laneboard list --status done --assignee dev-2' },
      { argv: ['--assignee', 'dev-1', '--text', 'Shipped'], total: 8, hint: 'laneboard list --status done --assignee dev-1 --text Shipped' },
      { argv: ['--dir', s.dir, '--assignee', 'dev-1'], total: 8, hint: `laneboard list --status done --assignee dev-1 --dir ${s.dir}` },
      { argv: ['--board', s.root], total: 14, hint: `laneboard list --status done --board ${s.root}` },
    ];
    for (const run of runs) {
      const cwd = run.argv.includes('--dir') || run.argv.includes('--board') ? elsewhere : s.root;
      const view = await cli(['view', ...run.argv], { cwd, env: { COLUMNS: '40', HOME: tempDir() } });
      expect(view.code, run.argv.join(' ')).toBe(0);
      const { more, command } = moreHint(view.stdout);
      expect(command, run.argv.join(' ')).toBe(run.hint);
      expect(more).toBe(run.total - VIEW_FINAL_MAX);
      const listed = await cli([...argvOf(command), '--json'], { cwd, env: { HOME: tempDir() } });
      expect(listed.code, listed.stdout).toBe(0);
      expect(JSON.parse(listed.stdout).data.total, run.argv.join(' ')).toBe(VIEW_FINAL_MAX + more);
    }
  });

  it('a label filter with only 2 done tasks: no hint; a value with a space is quoted and the quoted command lists the same', async () => {
    const s = await board();
    const view = await cli(['view', '--label', 'ui'], { cwd: s.root, env: { COLUMNS: '40' } });
    expect(view.code).toBe(0);
    expect(view.stdout).not.toContain('more: laneboard list');
    for (let i = 0; i < VIEW_FINAL_MAX + 2; i++) await createTask(as(s, 'a'), { title: `With space ${i}`, status: 'done', assignee: 'dev-1' });
    const hint = moreHint((await cli(['view', '--text', 'With space'], { cwd: s.root, env: { COLUMNS: '60' } })).stdout);
    expect(hint).toEqual({ more: 2, command: "laneboard list --status done --text 'With space'" });
    const listed = JSON.parse((await cli(['list', '--status', 'done', '--text', 'With space', '--json'], { cwd: s.root })).stdout).data;
    expect(listed.total).toBe(VIEW_FINAL_MAX + 2);
  });
});

describe('review S4 MINOR: the "Your active tasks" footer of prime counts what its command lists', () => {
  it('own done tasks are not in the count, and the footer command leaves them out too', async () => {
    const s = await newStore();
    for (let i = 0; i < 120; i++) await createTask(as(s, 'a'), { title: `Task number ${i} with a fairly long title to fill the prime output quickly`, status: 'todo', assignee: 'dev-1' });
    for (let i = 0; i < 7; i++) await createTask(as(s, 'a'), { title: `Shipped ${i}`, status: 'done', assignee: 'dev-1' });
    const text = (await cli(['prime', '--as', 'dev-1'], { cwd: s.root })).stdout.trimEnd();
    expect(text.length).toBeLessThanOrEqual(PRIME_MAX_CHARS);
    const m = /\n\.\.\. (\d+) more: (laneboard list --assignee dev-1 --status todo --status in_progress --status review --json)$/.exec(text);
    expect(m, text.slice(-300)).not.toBeNull();
    const shown = text.split('\n').filter((l) => /^ {2}LB-\d+ /.test(l)).length;
    expect(shown + Number(m?.[1])).toBe(120);
    const listed = JSON.parse((await cli(argvOf(m?.[2] ?? ''), { cwd: s.root })).stdout).data;
    expect(listed.total).toBe(shown + Number(m?.[1]));
  });

  it('an own task in a status no longer in config is not counted: list --status <open> would not find it', async () => {
    const s = await newStore({ statuses: ['todo', 'qa', 'done'] });
    await createTask(as(s, 'a'), { title: 'In qa', status: 'qa', assignee: 'dev-1' });
    await createTask(as(s, 'a'), { title: 'Open', status: 'todo', assignee: 'dev-1' });
    const file = path.join(s.dir, 'config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.statuses = ['todo', 'done'];
    fs.writeFileSync(file, JSON.stringify(config));
    const data = JSON.parse((await cli(['prime', '--as', 'dev-1', '--json'], { cwd: s.root })).stdout).data;
    expect(data.tasks.map((t: { id: string }) => t.id)).toEqual(['LB-2']);
  });

  it('a config whose open statuses make the command too long: the short command and a note that it lists the final status too', () => {
    const statuses = Array.from({ length: 40 }, (_, i) => `status_with_a_long_name_${i}`);
    const d = primeData(85, 300, 0, 0, 'd', 'dev-base', statuses);
    const text = primeText(d);
    // Rewritten in LB-11 (b): the note goes before the command, so the copied line ends with --json.
    expect(text).toMatch(/\n\.\.\. \d+ more: \(lists status_with_a_long_name_39 tasks too\) laneboard list --assignee dev-base:bbbb2222 --json$/);
  });
});

// Summary for primeText (as the s3b grid), with the statuses as a parameter.
const item = (id: number, title: string, assignee: string | null): ListItem => ({ id: `LB-${id}`, title, status: 'todo', assignee, labels: [], parent: null, updated_at: new Date().toISOString(), updated_by: 'a', rev: 1, archived: false });
function primeData(len: number, own: number, resume: number, free: number, description: string, base: string, statuses: string[]): PrimeData {
  return {
    rules: agentRules(),
    agent: `${base}:bbbb2222`,
    agent_source: 'default',
    name: 'shop',
    description,
    store: `/${'p'.repeat(len - '/'.length - '/.laneboard'.length)}/.laneboard`,
    prefix: 'LB',
    store_warning: null,
    store_problem: null,
    statuses: statuses.map((status) => ({ status, count: 0 })),
    first_status: statuses[0] ?? null,
    final_status: statuses.at(-1) ?? null,
    open_statuses: statuses.slice(0, -1),
    fields: { priority: { type: 'number', description: '0 = highest', example: 'priority=1' } },
    tasks: Array.from({ length: own }, (_, i) => item(i + 1, `Own task ${i + 1} with a title of ordinary length`, `${base}:bbbb2222`)),
    in_progress: own,
    unassigned: Array.from({ length: Math.min(free, 10) }, (_, i) => item(100 + i, `Free task ${i + 1} with a title of ordinary length`, null)),
    unassigned_total: free,
    session_base: base,
    resumable: Array.from({ length: resume }, (_, i) => item(200 + i, 'Add discount to total()', `${base}:aaaa1111`)),
  };
}

describe('review S4: prime prints a store path named by --dir once, so the status lines stay whole', () => {
  const BASES = ['claude-code@abylaybazarbayev', `claude-code@${'u'.repeat(43)}`];
  const CONFIGS = [
    ['todo', 'in_progress', 'review', 'done'],
    ['todo', 'in_progress', 'review', 'blocked', 'done'],
  ];

  it('grid: 4 and 5 statuses × store path 85/160/250 × --dir or not × free 0/3/12 × earlier 0/1 × own 0/1 × description 56/200 × name 37/64', () => {
    for (const statuses of CONFIGS) {
      const statusLine = `Statuses in order (final: done), active tasks: ${statuses.slice(0, -1).map((st) => `${st} 0`).join(', ')}; done 0`;
      for (const len of [85, 160, 250]) {
        for (const base of BASES) {
          for (const withDir of [false, true]) {
            for (const free of [0, 3, 12]) {
              for (const resume of [0, 1]) {
                for (const own of [0, 1]) {
                  for (const description of ['Shop backend and admin panel: orders, payments, refunds', 'd'.repeat(200)]) {
                    const d = primeData(len, own, resume, free, description, base, statuses);
                    const storeDir = withDir ? (d.store ?? '') : undefined;
                    const text = primeText(d, storeDir);
                    const where = `statuses=${statuses.length} len=${len} dir=${withDir} free=${free} resume=${resume} own=${own} desc=${description.length} name=${base.length + 9}`;
                    expect(text.length, where).toBeLessThanOrEqual(PRIME_MAX_CHARS);
                    const lines = text.split('\n');
                    expect(lines, where).toContain(statusLine);
                    expect(lines, where).toContain('Fields (--field key=value): priority (number, 0 = highest)');
                    const dirOnce = lines.includes('This board was named by --dir: add the --dir option of the Store line to every laneboard command below.');
                    // The path once: as `--dir <path>` in the Store line; else in the Store line and in each command.
                    if (dirOnce) {
                      expect(lines.some((l) => l.startsWith(`Store: --dir ${d.store} (prefix LB)`)), where).toBe(true);
                      expect(text.split(d.store ?? '').length - 1, where).toBe(1);
                    }
                    if (!withDir) expect(dirOnce, where).toBe(false);
                    if (own === 0) expect(lines, where).toContain(`  laneboard create "<short title of your work>" --status todo --assignee ${base}:bbbb2222${withDir && !dirOnce ? ` --dir ${d.store}` : ''} --json`);
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it('the real CLI at a 160-character path: prime --dir from another folder keeps the 5-status line and names the path once', async () => {
    const base = tempDir();
    const root = path.join(base, 'p'.repeat(160 - base.length - '/'.length - '/.laneboard'.length));
    const env = { HOME: tempDir() };
    const statuses = 'todo,in_progress,review,blocked,done';
    const init = await cli(['init', '--dir', path.join(root, '.laneboard'), '--name', 'shop', '--description', 'd'.repeat(200), '--statuses', statuses, '--json'], { cwd: tempDir(), env });
    expect(init.code, init.stdout).toBe(0);
    const dir = path.join(root, '.laneboard');
    expect(dir.length).toBe(160);
    for (let i = 0; i < 12; i++) await cli(['create', `Free task ${i} with a title of ordinary length`, '--status', 'todo', '--as', 'x', '--dir', dir, '--json'], { cwd: tempDir(), env });
    const text = (await cli(['prime', '--dir', dir, '--as', `claude-code@${'u'.repeat(43)}`], { cwd: tempDir(), env })).stdout.trimEnd();
    expect(text.length).toBeLessThanOrEqual(PRIME_MAX_CHARS);
    expect(text.split('\n')).toContain('Statuses in order (final: done), active tasks: todo 12, in_progress 0, review 0, blocked 0; done 0');
  });
});
