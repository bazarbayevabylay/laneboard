// laneboard prime
import path from 'node:path';
import { agentRules, foreignStore, LaneboardError, parentStoreWarning, resolveActor, taskSummary, toLaneboardError } from '../../core/index.ts';
import type { ActorSource, ForeignStore, OpContext, SummaryResult } from '../../core/index.ts';
import { primeText } from '../format.ts';
import type { PrimeData } from '../format.ts';
import { flag } from './args.ts';
import type { CommandDef, CommandOutput } from './types.ts';

// What an agent does when no store is found: find this project's board, else create it (agent rule 12). `--dir` on every command,
// not `export`: each Bash call of an agent is a new shell, and the MCP server never sees an export.
const NO_STORE_FIX =
  'find this project\'s board: laneboard boards --json (pick it by description and path), then pass --dir <its path> on every command; none for this project: in its root laneboard init --name <name> --description "<whose project, what work>", then laneboard prime';

// SessionStart line where no board is found. The plugin hook runs in every project of the user, most of them without laneboard:
// a neutral fact and how to start if the user wants it, never a task rule (owner's decision, S2d).
function noBoardLine(message: string): string {
  return `laneboard: no board found (${message}). If the user wants to track work here with laneboard: laneboard init --name <name> --description "<whose project, what work>" in the project root, then laneboard prime.`;
}

// Claude Code PostToolUse output: text added to Claude's context next to the tool result (code.claude.com/docs/en/hooks).
// It states facts, not orders: imperative out-of-band text can trigger prompt-injection defenses (same page, "Add context for Claude").
function hookContext(text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } });
}

// Reminder after an edit when nothing is in progress for the agent.
function editReminder(summary: SummaryResult, store: string, agent: string | undefined): string {
  const who = agent === undefined ? '' : ` for ${agent}`;
  return hookContext(
    `laneboard: no task is in progress${who} in store ${store} (prefix ${summary.prefix}). ` +
      'This project tracks every change in a laneboard task (agent rule 1); `laneboard prime` prints the create command.',
  );
}

// Note after an edit in a folder that looks like its own project while the store in use may belong to another one (a heuristic,
// so it is worded like the warning: "looks like", "unless").
function foreignStoreNote(store: string, prefix: string, cwd: string, foreign: ForeignStore): string {
  const why = foreign.ownStore ? `has its own store ${foreign.ownStore}` : `has ${foreign.marker} and no laneboard store of its own`;
  return hookContext(
    `laneboard: the store in use, ${store} (prefix ${prefix}), looks like another project's: ${path.resolve(cwd)} ${why}. ` +
      'Unless this folder is part of that project, its tasks belong on its own board; `laneboard boards --json` lists the boards on this machine with their descriptions.',
  );
}

// `prime --edit-hook`: a note, or nothing at all (a task is in progress, no store, any error); it never fails a tool call.
async function editHook(op: () => OpContext, agent: string | undefined, cwd: string, home: string | undefined): Promise<CommandOutput> {
  const quiet: CommandOutput = { data: null, warnings: [], human: '', silent: true };
  try {
    const ctx = op();
    const r = await taskSummary(ctx, { assignee: agent });
    if (r.data.in_progress > 0) return quiet;
    // Never nudge towards another project's store: name the situation instead of asking for a task there.
    const foreign = foreignStore(ctx.store, cwd, home);
    if (foreign !== undefined) return { data: null, warnings: [], human: foreignStoreNote(ctx.store.dir, r.data.prefix, cwd, foreign), storeWarningInText: true };
    return { data: null, warnings: [], human: editReminder(r.data, ctx.store.dir, agent), storeWarningInText: true };
  } catch {
    // A hook must not disturb the session: no store, a broken store or a bad name all mean "say nothing".
    return quiet;
  }
}

export const prime: CommandDef = {
  name: 'prime',
  usage: 'prime [--hook | --edit-hook]',
  summary:
    'Print the agent rules, the board (store, prefix, name, description), statuses, fields and your tasks (--as / LANEBOARD_AGENT / the session default name), or the command to create one. ' +
    '--hook: plain text for a SessionStart hook, never fails. --edit-hook: Claude Code PostToolUse reminder when you have no task in progress, else nothing.',
  options: { hook: { type: 'boolean' }, 'edit-hook': { type: 'boolean' } },
  args: { min: 0, max: 0 },
  async run(c) {
    const hook = flag(c.values, 'hook');
    const edit = flag(c.values, 'edit-hook');
    if ((hook || edit) && c.values.json === true) throw new LaneboardError('USAGE', `--${hook ? 'hook' : 'edit-hook'} prints output for a hook; it cannot be combined with --json`);
    if (hook && edit) throw new LaneboardError('USAGE', '--hook and --edit-hook are two different hooks; pass one of them');
    // The same name a write would use: --as, LANEBOARD_AGENT, else the session's default name.
    const named = resolveActor(typeof c.values.as === 'string' ? c.values.as : undefined, c.io.env);
    const agent = named.actor;
    const agentSource: ActorSource | null = named.actorSource ?? null;
    // A default name says little in the hook: an agent that passed its own --as owns its task under that name, so the reminder
    // looks at anybody's work in progress then (a session without a task is not reminded while another one has one).
    if (edit) return editHook(c.op, agentSource === 'default' ? undefined : agent, c.io.cwd, c.io.env.HOME || undefined);
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
      if (err.code === 'STORE_NOT_FOUND') noStore = noBoardLine(err.message);
      problem = `${err.code}: ${err.message}; fix: ${noStore ? NO_STORE_FIX : err.fix}`;
    }
    const data: PrimeData = {
      rules,
      agent: agent ?? null,
      agent_source: agentSource,
      name: summary?.name ?? null,
      description: summary?.description ?? null,
      store: summary && ctx ? ctx.store.dir : null,
      prefix: summary?.prefix ?? null,
      store_warning: (summary && ctx && parentStoreWarning(ctx.store, c.io.cwd, summary.prefix, c.io.env.HOME || undefined)) || null,
      store_problem: problem ?? null,
      statuses: summary?.statuses ?? [],
      first_status: summary?.first_status ?? null,
      final_status: summary?.final_status ?? null,
      fields: summary?.fields ?? {},
      tasks: summary?.assigned ?? [],
      in_progress: summary?.in_progress ?? 0,
      unassigned: summary?.unassigned ?? [],
      unassigned_total: summary?.unassigned_total ?? 0,
    };
    // The plugin hook runs in every session of every project: where laneboard is not used it prints one neutral line, not the rules.
    // A store named by --dir stays named in the commands prime prints (LANEBOARD_DIR or a walk-up may find another one).
    const human = hook && noStore ? noStore : primeText(data, ctx?.store.found === 'dir' ? ctx.store.dir : undefined);
    return { data, warnings, human, storeWarningInText: true };
  },
};
