// `laneboard setup <harness> [--remove [--global]] [--dry-run]`: write (or roll back) laneboard's MCP entry and instruction block for one harness.
import fs from 'node:fs';
import path from 'node:path';
import { isLiveBoard, LaneboardError, readRegistry, samePath, STORE_DIR_NAME, storeState, suggestClosest } from '../core/index.ts';
import type { BoardEntry } from '../core/index.ts';
import { applyPlan, planAdd, planKeep, planRemove, readText } from './files.ts';
import type { FileResult, PlannedFile } from './files.ts';
import { claudeCode } from './harnesses/claude-code.ts';
import { codex } from './harnesses/codex.ts';
import type { Harness, HarnessContext, HarnessFile } from './harnesses/common.ts';
import { cursor } from './harnesses/cursor.ts';
import { gemini } from './harnesses/gemini.ts';
import { gitExclude } from './harnesses/git-exclude.ts';
import { opencode } from './harnesses/opencode.ts';

export { EDIT_HOOK_COMMAND, EDIT_HOOK_MATCHER, PRIME_HOOK_COMMAND } from './harnesses/common.ts';

export const HARNESSES: readonly Harness[] = [claudeCode, codex, cursor, gemini, opencode];
export const HARNESS_NAMES = HARNESSES.map((h) => h.name);

// Names people type for a harness that are not its setup name; the fix suggests the right one.
const OTHER_NAMES: Record<string, string> = { claude: 'claude-code', claudecode: 'claude-code', 'gemini-cli': 'gemini', 'codex-cli': 'codex' };

export interface SetupInput {
  harness: string;
  remove: boolean;
  // With remove: also take our part out of a global file (~/.codex/config.toml) other projects of this machine may still use.
  global: boolean;
  dryRun: boolean;
  // Project root (setup runs there).
  cwd: string;
  // Store the project is pinned to (absolute): --dir, else LANEBOARD_DIR, else <cwd>/.laneboard.
  storeDir: string;
  env: Record<string, string | undefined>;
}

export interface SetupFileResult {
  path: string;
  scope: 'project' | 'global';
  result: FileResult;
  diff?: string[];
}

export interface SetupResult {
  harness: string;
  // The store the instructions (and Claude Code's env) pin this project to.
  store: string;
  mode: 'install' | 'remove';
  dry_run: boolean;
  files: SetupFileResult[];
  notes: string[];
}

// Find a harness by its setup name; anything else fails with the allowed names.
function findHarness(name: string): Harness {
  const found = HARNESSES.find((h) => h.name === name);
  if (found) return found;
  const suggestion = OTHER_NAMES[name.toLowerCase()] ?? suggestClosest(name, HARNESS_NAMES);
  throw new LaneboardError('INVALID_VALUE', `unknown harness "${name}"`, {
    allowed: [...HARNESS_NAMES],
    input: suggestion ? { field: 'harness', value: name, suggestion } : { field: 'harness', value: name },
    fix: suggestion ? `use harness ${suggestion}` : 'use a harness from `allowed`',
  });
}

// Where a harness file is: absolute path and how it is shown (project-relative, ~/… under home, else absolute).
function locate(f: HarnessFile, c: HarnessContext): { file: string; shown: string; moved: boolean } {
  const moved = f.moved?.(c);
  if (moved === undefined) {
    const file = path.join(f.scope === 'project' ? c.cwd : c.home, f.path);
    return { file, shown: f.scope === 'project' ? f.path : `~/${f.path}`, moved: false };
  }
  const rel = path.relative(c.home, moved);
  return { file: moved, shown: rel.startsWith('..') || path.isAbsolute(rel) ? moved : `~/${rel}`, moved: true };
}

// Real path of a file as the kernel resolves it; a path that does not resolve (not made yet, a dangling link) is its folder's real path
// plus its name.
function realPathOf(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    // Missing, dangling or unreadable: resolve the folder instead (the root always resolves).
    const dir = path.dirname(file);
    return dir === file ? file : path.join(realPathOf(dir), path.basename(file));
  }
}

// Other harnesses that share this file and still have their own laneboard entry installed. The same file is the same real path:
// AGENTS.md of codex, cursor and opencode, and also CLAUDE.md when it is a link to AGENTS.md (CARRYOVER S6b-r2). A harness counts
// as installed by a file of its own only: a file this harness writes too (AGENTS.md, .git/info/exclude) says nothing about it. For the
// exclude block only its project files count: a global file (~/.codex/config.toml) may serve another project, not this repository.
function otherUsers(harness: Harness, f: HarnessFile, c: HarnessContext): string[] {
  const realOf = (g: HarnessFile): string => realPathOf(locate(g, c).file);
  const real = realOf(f);
  const shared = new Set(harness.files.map(realOf));
  return HARNESSES.filter((h) => h !== harness && h.files.some((g) => realOf(g) === real))
    .filter((h) =>
      h.files
        .filter((g) => !shared.has(realOf(g)) && (f !== gitExclude || g.scope === 'project'))
        .some((g) => {
          const { file, shown } = locate(g, c);
          try {
            const text = readText(file);
            return text !== null && g.edit(shown, c).owns(text);
          } catch {
            // That file cannot be read or parsed, so it may still hold the entry: keep the shared block.
            return true;
          }
        }),
    )
    .map((h) => h.name);
}

// Does this harness file hold our part now? An unreadable or unparseable file counts as no (install does not touch a file that does not apply).
function ownsNow(f: HarnessFile, c: HarnessContext): boolean {
  const { file, shown } = locate(f, c);
  try {
    const text = readText(file);
    return text !== null && f.edit(shown, c).owns(text);
  } catch {
    // Cannot read or parse it: leave it alone, as before this file stopped applying.
    return false;
  }
}

// Other projects of the machine registry that hold this harness's part in their own files (codex: the AGENTS.md block, which cursor
// and opencode write too, so their projects count as well): a global file of the harness (~/.codex/config.toml) serves them too.
// A registry that cannot be read, or a project file that cannot, counts as a user: the entry stays and --global removes it.
function projectsUsing(harness: Harness, c: HarnessContext): string[] {
  let entries: BoardEntry[];
  try {
    entries = readRegistry(c.home);
  } catch {
    // Cannot tell which projects use it: keep the global entry.
    return ['(the machine registry cannot be read)'];
  }
  const own = harness.files.filter((g) => g.scope === 'project' && g !== gitExclude);
  const projects = entries
    .filter((e) => path.basename(e.path) === STORE_DIR_NAME && storeState(e.path) !== 'missing')
    .filter((e) => !samePath(e.path, c.storeDir) && !samePath(path.dirname(e.path), c.cwd))
    .map((e) => ({ project: path.dirname(e.path), store: e.path }));
  const uses = ({ project, store }: { project: string; store: string }): boolean =>
    own.some((g) => {
      try {
        const text = readText(path.join(project, g.path));
        return text !== null && g.edit(g.path, { ...c, cwd: project, storeDir: store }).owns(text);
      } catch {
        // That file cannot be read or parsed: it may hold our part.
        return true;
      }
    });
  return [...new Set(projects.filter(uses).map((p) => p.project))];
}

// Inside a `.git` directory (the exclude file): never committed, so its backup needs no gitignore advice.
function inGitDir(file: string): boolean {
  return file.split(path.sep).includes('.git');
}

// The backup of a planned file as shown: next to the real file setup wrote (CLAUDE.md -> AGENTS.md: AGENTS.md.laneboard.bak), relative
// to the project; a global file's backup lies next to the file itself.
function backupShown(p: PlannedFile): string {
  if (p.scope !== 'project' || p.root === undefined || path.isAbsolute(p.shown) || p.shown.startsWith('~/')) return `${p.shown}.laneboard.bak`;
  return `${path.relative(fs.realpathSync.native(p.root), p.target).split(path.sep).join('/')}.laneboard.bak`;
}

// A list of paths for a message: the first three and how many more.
function someOf(items: readonly string[]): string {
  return items.length > 3 ? `${items.slice(0, 3).join(', ')} and ${items.length - 3} more` : items.join(', ');
}

// Why files were kept on --remove: the harnesses still using a shared file, the projects that may use a global one.
interface Keepers {
  harnesses: ReadonlyMap<string, string[]>;
  projects: ReadonlyMap<string, string[]>;
}

// Warnings about backups (written or left behind) and files kept for another harness or project. `exclude`: the exclude file setup
// keeps its block in (backups stay out of git), when it does.
function planWarnings(harness: string, plan: readonly PlannedFile[], keepers: Keepers, exclude: string | undefined): string[] {
  const out: string[] = [];
  for (const p of plan) {
    const bak = backupShown(p);
    if (p.backup !== undefined) {
      const git = p.scope !== 'project' || inGitDir(p.file) ? '' : exclude !== undefined ? `; ${exclude} keeps it out of git` : '; do not commit it: add *.laneboard.bak to .gitignore';
      out.push(`wrote ${bak} (your file before setup; setup --remove restores it)${git}`);
    }
    const projects = keepers.projects.get(p.file);
    if (p.result === 'kept' && projects !== undefined) {
      out.push(
        `kept the laneboard entry in ${p.shown} (a global file, other projects may use it: ${someOf(projects)}); laneboard setup ${harness} --remove --global removes it`,
      );
    } else if (p.result === 'kept') {
      const names = keepers.harnesses.get(p.file) ?? [];
      out.push(`kept the laneboard block in ${p.shown}: ${names.join(', ')} still use${names.length === 1 ? 's' : ''} it (laneboard setup ${names[0] ?? '<harness>'} --remove removes it)`);
    }
    if (p.keptBackup) out.push(`kept ${bak} (your file before setup; not restored because the file changed since): delete it when not needed`);
  }
  return out;
}

// Plan every file first (an unparseable or unwritable file stops everything before any write), then write unless dry run.
export function runSetup(input: SetupInput): { data: SetupResult; warnings: string[]; registered: boolean } {
  const harness = findHarness(input.harness);
  if (input.global && !input.remove) {
    throw new LaneboardError('USAGE', '--global goes with --remove: it also removes the entry from a global file other projects may use', {
      fix: `laneboard setup ${harness.name}`,
      edit: { drop: [{ name: 'global' }] },
    });
  }
  const home = input.env.HOME;
  if (!home) throw new LaneboardError('USAGE', 'HOME is not set, so global harness files cannot be found', {
    fix: 'export HOME=<your home directory> and run setup again',
    edit: { env: 'HOME=<your home directory>' },
  });
  const cwd = path.resolve(input.cwd);
  const context: HarnessContext = { cwd, home, env: input.env, storeDir: path.resolve(cwd, input.storeDir) };
  const roots = [cwd, home];
  const users = new Map<string, string[]>();
  const projects = new Map<string, string[]>();
  // A file that does not apply here (Claude Code's local settings in a folder inside another repository) is not written, and our part
  // is taken out of it when an earlier setup put it there (the env moved to another file); --remove also takes it out of such a file.
  const applies = (f: HarnessFile): boolean => f.applies?.(context) ?? true;
  const files = harness.files.filter((f) => applies(f) || ownsNow(f, context));
  const plan = files.map((f) => {
    const { file, shown, moved } = locate(f, context);
    if (!input.remove && !applies(f)) return planRemove(file, shown, f.scope, f.edit(shown, context));
    // A directory the harness was pointed to (CODEX_HOME) is the user's, never removed.
    if (moved) roots.push(path.dirname(file));
    if (input.remove) {
      const others = otherUsers(harness, f, context);
      if (others.length) {
        users.set(file, others);
        return planKeep(file, shown, f.scope);
      }
      // A global file serves every project of this machine: it keeps our entry while another project may use it (newcomer F2).
      const using = f.scope === 'global' && !input.global ? projectsUsing(harness, context) : [];
      if (using.length) {
        projects.set(file, using);
        return planKeep(file, shown, f.scope);
      }
    }
    return (input.remove ? planRemove : planAdd)(file, shown, f.scope, f.edit(shown, context));
  });
  // Read before the write: a warning may describe what the write replaces (a stale store pin).
  const harnessWarnings = input.remove ? [] : (harness.warnings?.(context) ?? []);
  if (!input.dryRun) applyPlan(plan, roots);
  // After an install, an existing store at the pin is added to the machine registry by the caller.
  const registered = !input.dryRun && !input.remove && isLiveBoard(context.storeDir);
  const excludeAt = files.findIndex((f) => f === gitExclude && applies(f));
  const exclude = input.remove || excludeAt < 0 ? undefined : plan[excludeAt]?.shown;
  const warnings = [...planWarnings(harness.name, plan, { harnesses: users, projects }, exclude), ...harnessWarnings];
  // The pin is written either way (init may follow), but a pin to nothing makes every laneboard command fail until then.
  if (!input.remove && !fs.existsSync(path.join(context.storeDir, 'config.json'))) {
    warnings.push(
      `no laneboard store at ${context.storeDir} yet: in ${cwd} run laneboard init --name <name> --description "<whose project, what work>", then laneboard prime; or run setup again with --dir <the project's .laneboard>`,
    );
  }
  return {
    registered,
    data: {
      harness: harness.name,
      store: context.storeDir,
      mode: input.remove ? 'remove' : 'install',
      dry_run: input.dryRun,
      files: plan.map((p) => ({ path: p.shown, scope: p.scope, result: p.result, ...(p.diff ? { diff: p.diff } : {}) })),
      notes: input.remove || input.dryRun ? [] : harness.notes,
    },
    warnings,
  };
}
