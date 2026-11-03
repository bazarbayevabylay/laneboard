// laneboard prime
import { agentRules, LaneboardError, taskSummary, toLaneboardError } from '../../core/index.ts';
import type { SummaryResult } from '../../core/index.ts';
import { primeText } from '../format.ts';
import { flag } from './args.ts';
import type { CommandDef } from './types.ts';

// What an agent may do when no store is found: point to an existing one; creating a store is the user's call.
const NO_STORE_FIX = 'if this project has a store: export LANEBOARD_DIR=<abs>/.laneboard; do not run laneboard init unless the user asks';

export const prime: CommandDef = {
  name: 'prime',
  usage: 'prime [--hook]',
  summary: 'Print the agent rules, statuses, fields and your active tasks (--as / LANEBOARD_AGENT). --hook: plain text for a SessionStart hook, never fails.',
  options: { hook: { type: 'boolean' } },
  args: { min: 0, max: 0 },
  async run(c) {
    const hook = flag(c.values, 'hook');
    if (hook && c.values.json === true) throw new LaneboardError('USAGE', '--hook prints plain text for a hook; it cannot be combined with --json');
    const agent = typeof c.values.as === 'string' ? c.values.as : c.io.env.LANEBOARD_AGENT || undefined;
    const rules = agentRules();
    let summary: SummaryResult | undefined;
    let problem: string | undefined;
    let noStore: string | undefined;
    let warnings: string[] = [];
    try {
      const r = await taskSummary(c.op(), { assignee: agent });
      summary = r.data;
      warnings = r.warnings;
    } catch (raw) {
      const err = toLaneboardError(raw);
      // No store yet is a normal state for prime; in a hook every error becomes a line, so a session never starts with a failed hook.
      if (err.code !== 'STORE_NOT_FOUND' && !hook) throw err;
      if (err.code === 'STORE_NOT_FOUND') noStore = `laneboard: ${err.message} (STORE_NOT_FOUND); ${NO_STORE_FIX}`;
      problem = `${err.code}: ${err.message}; fix: ${noStore ? NO_STORE_FIX : err.fix}`;
    }
    const data = {
      rules,
      agent: agent ?? null,
      store_problem: problem ?? null,
      statuses: summary?.statuses ?? [],
      final_status: summary?.final_status ?? null,
      fields: summary?.fields ?? {},
      tasks: summary?.assigned ?? [],
    };
    // The plugin hook runs in every session of every project: where laneboard is not used it prints one line, not the rules.
    const human = hook && noStore ? noStore : primeText(data);
    return { data, warnings, human };
  },
};
