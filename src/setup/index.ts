// `laneboard setup <harness> [--remove] [--dry-run]`: write (or roll back) laneboard's MCP entry and instruction block for one harness.
import path from 'node:path';
import { LaneboardError, suggestClosest } from '../core/index.ts';
import { applyPlan, planAdd, planRemove } from './files.ts';
import type { FileResult } from './files.ts';
import { claudeCode } from './harnesses/claude-code.ts';
import { codex } from './harnesses/codex.ts';
import type { Harness } from './harnesses/common.ts';
import { cursor } from './harnesses/cursor.ts';
import { gemini } from './harnesses/gemini.ts';
import { opencode } from './harnesses/opencode.ts';

export { PRIME_HOOK_COMMAND, INSTRUCTION_LINES } from './harnesses/common.ts';

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

// Plan every file first (an unparseable file stops everything before any write), then write unless dry run.
export function runSetup(input: SetupInput): { data: SetupResult; warnings: string[] } {
  const harness = findHarness(input.harness);
  const home = input.env.HOME;
  if (!home) throw new LaneboardError('USAGE', 'HOME is not set, so global harness files cannot be found', { fix: 'export HOME=<your home directory> and run setup again' });
  const cwd = path.resolve(input.cwd);
  const plan = harness.files.map((f) => {
    const root = f.scope === 'project' ? cwd : home;
    const file = path.join(root, f.path);
    const shown = f.scope === 'project' ? f.path : `~/${f.path}`;
    return (input.remove ? planRemove : planAdd)(file, shown, f.scope, f.edit(shown));
  });
  if (!input.dryRun) applyPlan(plan, [cwd, home]);
  const warnings = input.remove ? [] : (harness.warnings?.({ cwd, home, env: input.env }) ?? []);
  return {
    data: {
      harness: harness.name,
      mode: input.remove ? 'remove' : 'install',
      dry_run: input.dryRun,
      files: plan.map((p) => ({ path: p.shown, scope: p.scope, result: p.result, ...(p.diff ? { diff: p.diff } : {}) })),
      notes: input.remove || input.dryRun ? [] : harness.notes,
    },
    warnings,
  };
}
