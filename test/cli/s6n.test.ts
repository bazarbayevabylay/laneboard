// S6n "checklist import" (LB-36; UX run C-U3, PDR P6): `import checklist <file> --status S` makes a task of each "- [ ]" / "- [x]" item:
// checked items get the final status (or --done-status), an indented item is a subtask of the item above it, the link file=<path>#<text>
// keeps a re-run from making duplicates; `import markdown` on a checklist without frontmatter still answers ok but names that command.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTemp, cli, readStore, REPO, tempDir } from '../helpers.ts';
import type { CliRun } from '../helpers.ts';

afterAll(cleanupTemp);

// The persona's TODO.md: 10 items in two sections, 3 checked, "persist choice in localStorage" indented under "Dark mode toggle".
const TODO = path.join(REPO, 'test', 'fixtures', 's6n', 'TODO.md');

interface Board {
  root: string;
  dir: string;
  run(argv: string[]): Promise<CliRun>;
  json(argv: string[]): Promise<{ code: number } & Record<string, any>>;
}

// A project with board MONO (todo, in_progress, review, done) and TODO.md (the fixture, or `text`) in its folder.
async function board(text?: string): Promise<Board> {
  const home = tempDir();
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'TODO.md'), text ?? fs.readFileSync(TODO, 'utf8'));
  const run = (argv: string[]): Promise<CliRun> => cli(argv, { cwd: root, env: { HOME: home } });
  const init = await run(['init', '--description', 'mono shop', '--prefix', 'MONO', '--statuses', 'todo,in_progress,review,done']);
  expect(init.code, init.stderr).toBe(0);
  return {
    root,
    dir: path.join(root, '.laneboard'),
    run,
    json: async (argv) => {
      const r = await run([...argv, '--json']);
      return { code: r.code, ...JSON.parse(r.stdout) };
    },
  };
}

// Stored tasks by title: status, parent title, labels, link.
function byTitle(b: Board): Map<string, { id: string; status: string; parent?: string; labels: string[]; link: string; description: string }> {
  const tasks = readStore(b.dir, 'active').tasks as unknown as Array<{ id: string; title: string; status: string; parent?: string; labels: string[]; links: Array<{ ref: string }>; description: string }>;
  const titleOf = new Map(tasks.map((t) => [t.id, t.title]));
  return new Map(tasks.map((t) => [t.title, { id: t.id, status: t.status, ...(t.parent ? { parent: titleOf.get(t.parent) } : {}), labels: t.labels, link: t.links[0]?.ref ?? '', description: t.description }]));
}

describe('import checklist (P6)', () => {
  it('TODO.md -> 10 tasks: 3 checked in the final status, the indented item under its parent; a re-run skips 10', async () => {
    const b = await board();
    const first = await b.json(['import', 'checklist', 'TODO.md', '--status', 'todo', '--as', 'persona-c']);
    expect(first.code).toBe(0);
    expect(first.data.created).toHaveLength(10);
    expect(first.data.skipped).toEqual([]);
    const tasks = byTitle(b);
    expect([...tasks.values()].filter((t) => t.status === 'done').length).toBe(3);
    expect(tasks.get('Set up Postgres schema for users')).toMatchObject({ status: 'done', link: 'TODO.md#Set up Postgres schema for users' });
    expect(tasks.get('Rate limit /login (5 req/min per IP)')).toMatchObject({ status: 'todo' });
    expect(tasks.get('persist choice in localStorage')).toMatchObject({ parent: 'Dark mode toggle', status: 'todo' });
    expect([...tasks.values()].filter((t) => t.parent !== undefined)).toHaveLength(1);
    const child = first.data.created.find((c: { title: string }) => c.title === 'persist choice in localStorage');
    expect(child.parent).toBe(tasks.get('Dark mode toggle')?.id);
    const got = (await b.json(['get', child.id])).data;
    expect(got.events[0]).toMatchObject({ type: 'created', data: { parent: child.parent, imported_from: 'TODO.md#persist choice in localStorage' } });

    const again = await b.json(['import', 'checklist', 'TODO.md', '--status', 'todo', '--as', 'persona-c']);
    expect(again.code).toBe(0);
    expect(again.data.created).toEqual([]);
    expect(again.data.skipped).toHaveLength(10);
    expect(readStore(b.dir, 'active').tasks).toHaveLength(10);
  });

  it('import markdown on the checklist: exit 0, nothing created, a warning that names import checklist with the typed path', async () => {
    const b = await board();
    const r = await b.json(['import', 'markdown', 'TODO.md', '--status-key', 'status', '--as', 'persona-c']);
    expect(r.code).toBe(0);
    expect(r.data.created).toEqual([]);
    const hint = r.warnings.find((w: string) => w.includes('import checklist'));
    expect(hint).toContain('TODO.md (10 items)');
    expect(hint).toContain('laneboard import checklist TODO.md --status todo --dry-run');
    // The command in the warning runs as given.
    const dry = await b.json(['import', 'checklist', 'TODO.md', '--status', 'todo', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.data.created).toHaveLength(10);
    // A Markdown file without checkboxes gets no such warning.
    fs.writeFileSync(path.join(b.root, 'NOTES.md'), '# Notes\n\n- plain item\n');
    const plain = await b.json(['import', 'markdown', 'NOTES.md', '--status-key', 'status', '--as', 'persona-c']);
    expect(plain.code).toBe(0);
    expect(plain.warnings.some((w: string) => w.includes('import checklist'))).toBe(false);
  });

  it('a dry run writes nothing; a subtask of a new parent shows parent null', async () => {
    const b = await board();
    const before = readStore(b.dir, 'active');
    const dry = await b.json(['import', 'checklist', 'TODO.md', '--status', 'todo', '--dry-run']);
    expect(dry.data).toMatchObject({ dry_run: true });
    expect(dry.data.created.find((c: { title: string }) => c.title === 'persist choice in localStorage')).toMatchObject({ id: null, parent: null });
    expect(readStore(b.dir, 'active')).toEqual(before);
  });

  it('nesting levels, a heading starts anew, duplicate texts, code blocks, * [X] and 1. [ ], --done-status, --heading-labels', async () => {
    const text = [
      '# Plan',
      '## API & Auth',
      '- [ ] top',
      '  - [ ] mid',
      '    - [x] deep',
      '  - [ ] mid sibling',
      '- [ ] top2',
      '\t- [ ] tab child',
      '* [X] star checked',
      '1. [ ] numbered',
      '- [ ] same',
      '- [ ] same',
      '```',
      '- [ ] in a code block',
      '```',
      '## Web',
      '  - [ ] indented under a new heading',
      '- [] not an item',
      '',
    ].join('\n');
    const b = await board(text);
    const r = await b.json(['import', 'checklist', 'TODO.md', '--status', 'in_progress', '--done-status', 'review', '--heading-labels', '--as', 'persona-c']);
    expect(r.code, JSON.stringify(r.error)).toBe(0);
    const t = byTitle(b);
    expect(r.data.created.map((c: { source: string }) => c.source)).toEqual([
      'TODO.md#top', 'TODO.md#mid', 'TODO.md#deep', 'TODO.md#mid sibling', 'TODO.md#top2', 'TODO.md#tab child', 'TODO.md#star checked', 'TODO.md#numbered',
      'TODO.md#same', 'TODO.md#same (2)', 'TODO.md#indented under a new heading',
    ]);
    expect(t.get('mid')).toMatchObject({ parent: 'top', status: 'in_progress', labels: ['api-auth'] });
    expect(t.get('deep')).toMatchObject({ parent: 'mid', status: 'review' });
    expect(t.get('mid sibling')).toMatchObject({ parent: 'top' });
    expect(t.get('tab child')).toMatchObject({ parent: 'top2' });
    expect(t.get('star checked')).toMatchObject({ status: 'review' });
    expect(t.get('star checked')?.parent).toBeUndefined();
    expect(t.get('numbered')?.parent).toBeUndefined();
    expect(t.get('indented under a new heading')).toMatchObject({ labels: ['web'] });
    expect(t.get('indented under a new heading')?.parent).toBeUndefined();
    expect(t.has('in a code block')).toBe(false);
  });

  it('a checked item without --done-status takes the final status; without --heading-labels no label', async () => {
    const b = await board('## Ops\n- [x] shipped\n');
    expect((await b.json(['import', 'checklist', 'TODO.md', '--status', 'todo', '--as', 'c'])).code).toBe(0);
    expect(byTitle(b).get('shipped')).toMatchObject({ status: 'done', labels: [] });
  });

  it('a new item under a parent imported before gets that parent; an archived parent stops the import', async () => {
    const b = await board('- [ ] parent\n');
    expect((await b.json(['import', 'checklist', 'TODO.md', '--status', 'todo', '--as', 'c'])).code).toBe(0);
    fs.writeFileSync(path.join(b.root, 'TODO.md'), '- [ ] parent\n  - [ ] new child\n');
    const r = await b.json(['import', 'checklist', 'TODO.md', '--status', 'todo', '--as', 'c']);
    expect(r.data).toMatchObject({ created: [{ id: 'MONO-2', source: 'TODO.md#new child', parent: 'MONO-1' }], skipped: [{ id: 'MONO-1' }] });
    expect(byTitle(b).get('new child')).toMatchObject({ parent: 'parent' });

    expect((await b.json(['archive', 'MONO-1', 'MONO-2', '--as', 'c'])).code).toBe(0);
    fs.writeFileSync(path.join(b.root, 'TODO.md'), '- [ ] parent\n  - [ ] another child\n');
    const rev = readStore(b.dir, 'active').rev;
    const stopped = await b.json(['import', 'checklist', 'TODO.md', '--status', 'todo', '--as', 'c']);
    expect(stopped.code).toBe(2);
    expect(stopped.error).toMatchObject({ code: 'INVALID_VALUE' });
    expect(stopped.error.message).toContain('parent MONO-1 (TODO.md#parent) is archived');
    expect(readStore(b.dir, 'active').rev).toBe(rev);
  });

  it('a title over 200 characters is cut, the description keeps the whole text', async () => {
    const long = `${'word '.repeat(60)}end`;
    const b = await board(`- [ ] ${long}\n`);
    expect((await b.json(['import', 'checklist', 'TODO.md', '--status', 'todo', '--as', 'c'])).code).toBe(0);
    const task = readStore(b.dir, 'active').tasks[0] as unknown as { title: string; description: string };
    expect(Array.from(task.title)).toHaveLength(200);
    expect(task.title.endsWith('…')).toBe(true);
    expect(task.description).toBe(long.replace(/\s+/g, ' '));
  });

  it('usage: --status is required, key options are markdown/json only, checklist options are checklist only, an unknown status names --status', async () => {
    const b = await board();
    expect((await b.json(['import', 'checklist', 'TODO.md'])).error).toMatchObject({ code: 'USAGE', fix: 'laneboard import checklist TODO.md --json --status <status>' });
    expect((await b.json(['import', 'checklist', 'TODO.md', '--status', 'todo', '--status-key', 'state'])).error).toMatchObject({ code: 'USAGE', fix: 'laneboard import checklist TODO.md --status todo --json' });
    expect((await b.json(['import', 'markdown', 'TODO.md', '--status-key', 'state', '--status', 'todo'])).error).toMatchObject({ code: 'USAGE', fix: 'laneboard import markdown TODO.md --status-key state --json' });
    const unknown = await b.json(['import', 'checklist', 'TODO.md', '--status', 'open', '--as', 'c']);
    expect(unknown.error).toMatchObject({ code: 'UNKNOWN_STATUS', allowed: ['todo', 'in_progress', 'review', 'done'] });
    expect(unknown.error.fix).toContain('--status (open items)');
    expect(readStore(b.dir, 'active').tasks).toHaveLength(0);
    // A file without items is left out with a warning.
    fs.writeFileSync(path.join(b.root, 'EMPTY.md'), '# nothing\n');
    const empty = await b.json(['import', 'checklist', 'EMPTY.md', '--status', 'todo', '--as', 'c']);
    expect(empty).toMatchObject({ code: 0, data: { created: [], ignored: [{ source: 'EMPTY.md', reason: 'no checklist items (- [ ] / - [x])' }] } });
  });
});
