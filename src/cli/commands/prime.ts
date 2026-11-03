// laneboard prime
import { agentRules, LaneboardError, taskSummary, toLaneboardError } from '../../core/index.ts';
import type { SummaryResult } from '../../core/index.ts';
import { primeText } from '../format.ts';
import { flag } from './args.ts';
import type { CommandDef } from './types.ts';

export const prime: CommandDef = {
  name: 'prime',
  usage: 'prime [--hook]',
  summary: 'Print the agent rules and your active tasks (--as / LANEBOARD_AGENT). --hook: plain text for a SessionStart hook, never fails.',
  options: { hook: { type: 'boolean' } },
  args: { min: 0, max: 0 },
  async run(c) {
    const hook = flag(c.values, 'hook');
    if (hook && c.values.json === true) throw new LaneboardError('USAGE', '--hook prints plain text for a hook; it cannot be combined with --json');
    const agent = typeof c.values.as === 'string' ? c.values.as : c.io.env.LANEBOARD_AGENT || undefined;
    const rules = agentRules();
    let summary: SummaryResult | undefined;
    let problem: string | undefined;
    let warnings: string[] = [];
    try {
      const r = await taskSummary(c.op(), { assignee: agent });
      summary = r.data;
      warnings = r.warnings;
    } catch (raw) {
      const err = toLaneboardError(raw);
      // No store yet is a normal state for prime; in a hook every error becomes a line, so a session never starts with a failed hook.
      if (err.code !== 'STORE_NOT_FOUND' && !hook) throw err;
      problem = `${err.code}: ${err.message}; fix: ${err.fix}`;
    }
    const data = { rules, agent: agent ?? null, store_problem: problem ?? null, statuses: summary?.statuses ?? [], tasks: summary?.assigned ?? [] };
    return { data, warnings, human: primeText(data) };
  },
};
