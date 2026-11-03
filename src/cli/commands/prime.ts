// laneboard prime
import { agentRules, LaneboardError, parentStoreWarning, taskSummary, toLaneboardError } from '../../core/index.ts';
import type { OpContext, SummaryResult } from '../../core/index.ts';
import { primeText } from '../format.ts';
import type { PrimeData } from '../format.ts';
import { flag } from './args.ts';
import type { CommandDef, CommandOutput } from './types.ts';

// What an agent may do when no store is found: point to an existing one; creating a store is the user's call.
const NO_STORE_FIX = 'if this project has a store: export LANEBOARD_DIR=<abs>/.laneboard; do not run laneboard init unless the user asks';

// Claude Code PostToolUse hook output after Edit/Write: a reminder for Claude when no task is in progress (code.claude.com/docs/en/hooks).
function editReminder(summary: SummaryResult, store: string): string {
  const text = `laneboard: no task claimed - run laneboard prime, then create or claim your task before more file changes (store ${store}, prefix ${summary.prefix}). No untracked work.`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } });
}

// `prime --edit-hook`: the reminder, or nothing at all (a task is in progress, no store, any error); it never fails a tool call.
async function editHook(op: () => OpContext, agent: string | undefined): Promise<CommandOutput> {
  const quiet: CommandOutput = { data: null, warnings: [], human: '', silent: true };
  try {
    const ctx = op();
    const r = await taskSummary(ctx, { assignee: agent });
    if (r.data.in_progress > 0) return quiet;
    return { data: null, warnings: [], human: editReminder(r.data, ctx.store.dir), storeWarningInText: true };
  } catch {
    // A hook must not disturb the session: no store, a broken store or a bad name all mean "say nothing".
    return quiet;
  }
}

export const prime: CommandDef = {
  name: 'prime',
  usage: 'prime [--hook | --edit-hook]',
  summary:
    'Print the agent rules, the store and its prefix, statuses, fields and your tasks (--as / LANEBOARD_AGENT), or the command to create one. ' +
    '--hook: plain text for a SessionStart hook, never fails. --edit-hook: Claude Code PostToolUse reminder when you have no task in progress, else nothing.',
  options: { hook: { type: 'boolean' }, 'edit-hook': { type: 'boolean' } },
  args: { min: 0, max: 0 },
  async run(c) {
    const hook = flag(c.values, 'hook');
    const edit = flag(c.values, 'edit-hook');
    if ((hook || edit) && c.values.json === true) throw new LaneboardError('USAGE', `--${hook ? 'hook' : 'edit-hook'} prints output for a hook; it cannot be combined with --json`);
    if (hook && edit) throw new LaneboardError('USAGE', '--hook and --edit-hook are two different hooks; pass one of them');
    const agent = typeof c.values.as === 'string' ? c.values.as : c.io.env.LANEBOARD_AGENT || undefined;
    if (edit) return editHook(c.op, agent);
    const rules = agentRules();
    let summary: SummaryResult | undefined;
    let ctx: OpContext | undefined;
    let problem: string | undefined;
    let noStore: string | undefined;
    let warnings: string[] = [];
    try {
      ctx = c.op();
      const r = await taskSummary(ctx, { assignee: agent });
      summary = r.data;
      warnings = r.warnings;
    } catch (raw) {
      const err = toLaneboardError(raw);
      // No store yet is a normal state for prime; in a hook every error becomes a line, so a session never starts with a failed hook.
      if (err.code !== 'STORE_NOT_FOUND' && !hook) throw err;
      if (err.code === 'STORE_NOT_FOUND') noStore = `laneboard: ${err.message} (STORE_NOT_FOUND); ${NO_STORE_FIX}`;
      problem = `${err.code}: ${err.message}; fix: ${noStore ? NO_STORE_FIX : err.fix}`;
    }
    const data: PrimeData = {
      rules,
      agent: agent ?? null,
      store: summary && ctx ? ctx.store.dir : null,
      prefix: summary?.prefix ?? null,
      store_warning: (summary && ctx && parentStoreWarning(ctx.store, c.io.cwd, summary.prefix)) || null,
      store_problem: problem ?? null,
      statuses: summary?.statuses ?? [],
      first_status: summary?.first_status ?? null,
      final_status: summary?.final_status ?? null,
      fields: summary?.fields ?? {},
      tasks: summary?.assigned ?? [],
      in_progress: summary?.in_progress ?? 0,
    };
    // The plugin hook runs in every session of every project: where laneboard is not used it prints one line, not the rules.
    const human = hook && noStore ? noStore : primeText(data);
    return { data, warnings, human, storeWarningInText: true };
  },
};
