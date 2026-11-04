// `laneboard setup <harness> [--remove] [--dry-run]`: write (or roll back) laneboard's MCP entry and instruction block for one harness.
import fs from 'node:fs';
import path from 'node:path';
import { isLiveBoard, LaneboardError, suggestClosest } from '../core/index.ts';
import { applyPlan, planAdd, planKeep, planRemove, readText } from './files.ts';
import type { FileResult, PlannedFile } from './files.ts';
import { claudeCode } from './harnesses/claude-code.ts';
import { codex } from './harnesses/codex.ts';
import type { Harness, HarnessContext, HarnessFile } from './harnesses/common.ts';
import { cursor } from './harnesses/cursor.ts';
import { gemini } from './harnesses/gemini.ts';
import { opencode } from './harnesses/opencode.ts';

export { EDIT_HOOK_COMMAND, EDIT_HOOK_MATCHER, PRIME_HOOK_COMMAND } from './harnesses/common.ts';

export const HARNESSES: readonly Harness[] = [claudeCode, codex, cursor, gemini, opencode];
export const HARNESS_NAMES = HARNESSES.map((h) => h.name);

// Names people type for a harness that are not its setup name; the fix suggests the right one.
const OTHER_NAMES: Record<string, string> = { claude: 'claude-code', claudecode: 'claude-code', 'gemini-cli': 'gemini', 'codex-cli': 'codex' };

export interface SetupInput {
  harness: string;
  remove: boolean;
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

// Other harnesses that share this file (AGENTS.md) and still have their own laneboard entry installed.
function otherUsers(harness: Harness, f: HarnessFile, c: HarnessContext): string[] {
  const sameFile = (g: HarnessFile): boolean => g.path === f.path && g.scope === f.scope;
  return HARNESSES.filter((h) => h !== harness && h.files.some(sameFile))
    .filter((h) =>
      h.files
        .filter((g) => !sameFile(g))
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

// Inside a `.git` directory (the exclude file): never committed, so its backup needs no gitignore advice.
function inGitDir(file: string): boolean {
  return file.split(path.sep).includes('.git');
}

// Warnings about backups (written or left behind) and shared files kept for another harness.
function planWarnings(plan: readonly PlannedFile[], users: ReadonlyMap<string, string[]>): string[] {
  const out: string[] = [];
  for (const p of plan) {
    const bak = `${p.shown}.laneboard.bak`;
    if (p.backup !== undefined) {
      out.push(`wrote ${bak} (your file before setup; setup --remove restores it)${p.scope === 'project' && !inGitDir(p.file) ? '; do not commit it: add *.laneboard.bak to .gitignore' : ''}`);
    }
    if (p.result === 'kept') {
      const names = users.get(p.file) ?? [];
      out.push(`kept the laneboard block in ${p.shown}: ${names.join(', ')} still use${names.length === 1 ? 's' : ''} it (laneboard setup ${names[0] ?? '<harness>'} --remove removes it)`);
    }
    if (p.keptBackup) out.push(`kept ${bak} (your file before setup; not restored because the file changed since): delete it when not needed`);
  }
  return out;
}

// Plan every file first (an unparseable or unwritable file stops everything before any write), then write unless dry run.
export function runSetup(input: SetupInput): { data: SetupResult; warnings: string[]; registered: boolean } {
  const harness = findHarness(input.harness);
  const home = input.env.HOME;
  if (!home) throw new LaneboardError('USAGE', 'HOME is not set, so global harness files cannot be found', {
    fix: 'export HOME=<your home directory> and run setup again',
    edit: { env: 'HOME=<your home directory>' },
  });
  const cwd = path.resolve(input.cwd);
  const context: HarnessContext = { cwd, home, env: input.env, storeDir: path.resolve(cwd, input.storeDir) };
  const roots = [cwd, home];
  const users = new Map<string, string[]>();
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
    }
    return (input.remove ? planRemove : planAdd)(file, shown, f.scope, f.edit(shown, context));
  });
  if (!input.dryRun) applyPlan(plan, roots);
  // After an install, an existing store at the pin is added to the machine registry by the caller.
  const registered = !input.dryRun && !input.remove && isLiveBoard(context.storeDir);
  const warnings = [...planWarnings(plan, users), ...(input.remove ? [] : (harness.warnings?.(context) ?? []))];
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
