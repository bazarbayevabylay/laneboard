// laneboard prime
import path from 'node:path';
import { agentRules, boardsOverview, ERRORS, foreignStore, inRegistry, LaneboardError, parentStoreWarning, resolveActor, taskSummary, toLaneboardError } from '../../core/index.ts';
import type { ActorSource, ForeignStore, OpContext, OverviewBoard, StoreRef, SummaryResult } from '../../core/index.ts';
import { BOARD_DATA_NOTE, OVERVIEW_MAX_CHARS, overviewText, primeText } from '../format.ts';
import type { PrimeData } from '../format.ts';
import { flag } from './args.ts';
import type { CommandContext, CommandDef, CommandOutput } from './types.ts';

// What an agent does when no store is found: find this project's board, else create it (agent rule 12). `--dir` on every command,
// not `export`: each Bash call of an agent is a new shell, and the MCP server never sees an export.
const NO_STORE_FIX =
  'find this project\'s board: laneboard boards --json (pick it by description and path), then pass --dir <its path> on every command; none for this project: in its root laneboard init --name <name> --description "<whose project, what work>", then laneboard prime';

// SessionStart line where no board is found. The plugin hook runs in every project of the user, most of them without laneboard:
// a neutral fact and how to start if the user wants it, never a task rule (owner's decision, S2d).
function noBoardLine(message: string): string {
  return `laneboard: no board found (${message}). If the user wants to track work here with laneboard: laneboard init --name <name> --description "<whose project, what work>" in the project root, then laneboard prime.`;
}

// SessionStart line where LANEBOARD_DIR or --dir names no folder (a pin left by a moved project, S6k): the store's own fix, which is
// `laneboard setup <harness>` when this folder's board exists (a bare init is refused there), else `init --dir <that path>`.
function pinLine(message: string, fix: string): string {
  return `laneboard: no board opened (${message}). If the user wants to track work here with laneboard: ${fix}.`;
}

// SessionStart line for a board that is not in the machine registry (a cloned repository with a committed .laneboard, review security F4):
// its name, description and titles are another author's text, so the hook shows none of them, and no agent rule either. `overview`: the
// registered boards follow (--all-boards), so the line ends with the data note as noOwnBoardLine (review S6i MINOR 3).
function unregisteredLine(dir: string, overview: boolean): string {
  return (
    `laneboard: the board found here, ${dir}, is not in this machine's board registry (a board that came with a cloned repository, or one made without laneboard init or setup on this machine), so this hook shows none of its texts. ` +
    `If the user wants to use it: laneboard setup claude-code in the project root adds it to the registry.${overview ? ` The boards of this machine follow. ${BOARD_DATA_NOTE}` : ''}`
  );
}

// Where prime --all-boards runs outside every board (an orchestrator's root folder, review orchestrator F17): a fact, no init advice.
function noOwnBoardLine(message: string): string {
  return `laneboard: no board in this folder (${message}); the boards of this machine follow. ${BOARD_DATA_NOTE}`;
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
    // A board this machine never registered (a cloned repository's) gets no reminder to track work there.
    if (r.data.in_progress > 0 || r.data.registered === false) return quiet;
    // Never nudge towards another project's store: name the situation instead of asking for a task there.
    const foreign = foreignStore(ctx.store, cwd, home);
    if (foreign !== undefined) return { data: null, warnings: [], human: foreignStoreNote(ctx.store.dir, r.data.prefix, cwd, foreign), storeWarningInText: true };
    return { data: null, warnings: [], human: editReminder(r.data, ctx.store.dir, agent), storeWarningInText: true };
  } catch {
    // A hook must not disturb the session: no store, a broken store or a bad name all mean "say nothing".
    return quiet;
  }
}

// The `source` of the Claude Code SessionStart hook input on stdin (startup, resume, clear, compact, fork:
// code.claude.com/docs/en/hooks); undefined without input (a terminal, another harness, not JSON). Its `session_id` is never read
// (S6x r1, ADR §52): the hook's name comes from CLAUDE_CODE_SESSION_ID only, as the name of every later Bash command does.
function sessionStartSource(io: CommandContext['io']): string | undefined {
  if (io.stdinIsTTY === true) return undefined;
  let input: unknown;
  try {
    input = JSON.parse(io.readStdin());
  } catch {
    // A hook never fails: no input, unreadable or not JSON all mean "source unknown".
    return undefined;
  }
  const source = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).source : undefined;
  return typeof source === 'string' ? source : undefined;
}

// prime --all-boards: every board of the machine (ADR §29), or one line saying why not; a read, so it never fails prime.
async function allBoards(home: string | undefined, current: StoreRef | undefined, warnings: string[]): Promise<{ boards: OverviewBoard[]; line?: string }> {
  if (home === undefined) {
    warnings.push('all boards: HOME is not set, so the board registry cannot be read');
    return { boards: [], line: 'all boards: HOME is not set' };
  }
  try {
    const r = await boardsOverview(home, current);
    warnings.push(...r.warnings);
    return { boards: r.data };
  } catch (raw) {
    // A broken registry: the line names it with its fix; the usual prime above stays.
    const err = toLaneboardError(raw);
    warnings.push(`all boards: ${err.message}`);
    return { boards: [], line: `all boards: ${err.code}: ${err.message}; fix: ${err.fix}` };
  }
}

export const prime: CommandDef = {
  name: 'prime',
  usage: 'prime [--hook | --edit-hook] [--all-boards]',
  summary:
    'Print the agent rules, the board (store, prefix, name, description), statuses, fields and your tasks (--as / LANEBOARD_AGENT / the session default name), or the ways to start one: ' +
      'claim a task from the request, resume your own task of an earlier session, after /clear or a restart (claim --resume), take a free task, create one. ' +
    '--hook: plain text for a SessionStart hook, never fails; the resume way in a new session, not on "resume" or "compact" (the source in the hook input on stdin). ' +
    '--edit-hook: Claude Code PostToolUse reminder when you have no task in progress, else nothing. ' +
    '--all-boards (orchestrators): then every board of this machine with its tasks not in the final status, waiting on the owner, handed in and stale first.',
  options: { hook: { type: 'boolean' }, 'edit-hook': { type: 'boolean' }, 'all-boards': { type: 'boolean' } },
  args: { min: 0, max: 0 },
  async run(c) {
    const hook = flag(c.values, 'hook');
    const edit = flag(c.values, 'edit-hook');
    // With --json the fix keeps --json and drops the hook modes (ADR-0001 §23); two hooks without it keep --hook.
    if ((hook || edit) && c.values.json === true) {
      throw new LaneboardError('USAGE', `--${hook ? 'hook' : 'edit-hook'} prints output for a hook; it cannot be combined with --json`, { edit: { drop: [{ name: 'hook' }, { name: 'edit-hook' }] } });
    }
    if (hook && edit) throw new LaneboardError('USAGE', '--hook and --edit-hook are two different hooks; pass one of them', { edit: { drop: [{ name: 'edit-hook' }] } });
    const everyBoard = flag(c.values, 'all-boards');
    if (edit && everyBoard) throw new LaneboardError('USAGE', '--edit-hook prints a reminder after an edit; --all-boards goes with prime or prime --hook', { edit: { drop: [{ name: 'all-boards' }] } });
    // The same name a write would use: --as, LANEBOARD_AGENT, else the session's default name.
    const named = resolveActor(typeof c.values.as === 'string' ? c.values.as : undefined, c.io.env);
    const agent = named.actor;
    const agentSource: ActorSource | null = named.actorSource ?? null;
    // A default name says little in the hook: an agent that passed its own --as owns its task under that name, so the reminder
    // looks at anybody's work in progress then (a session without a task is not reminded while another one has one).
    if (edit) return editHook(c.op, agentSource === 'default' ? undefined : agent, c.io.cwd, c.io.env.HOME || undefined);
    const rules = agentRules();
    // The SessionStart hook offers the tasks of earlier sessions in every new session: after /clear, and at startup too, since a solo
    // agent's restart is a new session with a new id (P5, S6l; S3b offered them after /clear only). Not on "resume" or "compact": the
    // session id stays, so its own tasks are its own, and the rest is a parallel session's. A parallel live session's task stays in
    // the list with its age; its claim --resume warns (core claimTask), the list says "resume only your own".
    const source = hook ? sessionStartSource(c.io) : undefined;
    const resumeShown = source !== 'resume' && source !== 'compact';
    let summary: SummaryResult | undefined;
    let ctx: OpContext | undefined;
    let problem: string | undefined;
    let noStore: string | undefined;
    let warnings: string[] = [];
    try {
      ctx = c.op();
      const r = await taskSummary(ctx, { assignee: agent, session_base: named.sessionBase });
      summary = r.data;
      warnings = r.warnings;
    } catch (raw) {
      const err = toLaneboardError(raw);
      // No store yet is a normal state for prime; in a hook every error becomes a line, so a session never starts with a failed hook.
      if (err.code !== 'STORE_NOT_FOUND' && !hook) throw err;
      // A pin to no folder has a fix of its own (setup, or init --dir), never the bare init of NO_STORE_FIX.
      const pinFix = err.code === 'STORE_NOT_FOUND' && err.fix !== ERRORS.STORE_NOT_FOUND.fix ? err.fix : undefined;
      if (err.code === 'STORE_NOT_FOUND') noStore = everyBoard ? noOwnBoardLine(err.message) : pinFix !== undefined ? pinLine(err.message, pinFix) : noBoardLine(err.message);
      // With --all-boards no board here is the orchestrator's usual place: the boards follow, no advice to make one (review orchestrator F17).
      const fix = !noStore ? err.fix : everyBoard ? 'none needed for the overview: the boards of this machine are below' : (pinFix ?? NO_STORE_FIX);
      problem = `${err.code}: ${err.message}; fix: ${fix}`;
    }
    // In the hook a board missing from the machine registry shows none of its texts (review security F4), whether its store loads or not:
    // the error of a broken config.json repeats its keys and values (review S6i MAJOR 1), so the registry is asked by the store path then.
    // Without HOME it cannot be told (registered null): the hook stays as it was, since only the project's own .claude/settings.json could
    // unset HOME, and that file can add a hook of its own anyway.
    const registered = summary !== undefined ? summary.registered : hook && ctx !== undefined ? inRegistry(ctx.home, ctx.store.dir, warnings) : null;
    const unregistered = hook && ctx !== undefined && registered === false;
    // The hook's own --as (setup claude-code --as, ADR §55) names the main session: its text says to pass that name on.
    const hookNamed = hook && typeof c.values.as === 'string' && c.values.as !== '' && agentSource === 'explicit';
    const data: PrimeData = {
      rules,
      agent: agent ?? null,
      agent_source: agentSource,
      ...(hookNamed ? { hook_named: true as const } : {}),
      name: summary?.name ?? null,
      description: summary?.description ?? null,
      // A store that was found but fails to load is named too: primeText then marks its error message as board data.
      store: ctx ? ctx.store.dir : null,
      prefix: summary?.prefix ?? null,
      store_warning: (summary && ctx && parentStoreWarning(ctx.store, c.io.cwd, summary.prefix, c.io.env.HOME || undefined)) || null,
      store_problem: problem ?? null,
      statuses: summary?.statuses ?? [],
      first_status: summary?.first_status ?? null,
      final_status: summary?.final_status ?? null,
      open_statuses: summary?.open_statuses ?? [],
      fields: summary?.fields ?? {},
      tasks: summary?.assigned ?? [],
      in_progress: summary?.in_progress ?? 0,
      unassigned: summary?.unassigned ?? [],
      unassigned_total: summary?.unassigned_total ?? 0,
      session_base: named.sessionBase ?? null,
      resumable: resumeShown ? (summary?.resumable ?? []) : [],
      resumable_total: resumeShown ? (summary?.resumable_total ?? 0) : 0,
      ...(summary?.roles === undefined ? {} : { roles: summary.roles }),
    };
    // The plugin hook runs in every session of every project: where laneboard is not used it prints one neutral line, not the rules.
    // A store named by --dir stays named in the commands prime prints (LANEBOARD_DIR or a walk-up may find another one).
    const own = unregistered && ctx ? unregisteredLine(ctx.store.dir, everyBoard) : hook && noStore ? noStore : primeText(data, ctx?.store.found === 'dir' ? ctx.store.dir : undefined);
    if (!everyBoard) return { data, warnings, human: own, storeWarningInText: true };
    // An unregistered current board stays out of the hook's overview too: the registry's boards only.
    const overview = await allBoards(c.io.env.HOME || undefined, summary && ctx && !unregistered ? ctx.store : undefined, warnings);
    data.boards = overview.boards;
    // Its own budget after a blank line: together at most PRIME_MAX_CHARS + OVERVIEW_MAX_CHARS.
    const section = overview.line ?? overviewText(overview.boards, new Date(), OVERVIEW_MAX_CHARS - 2);
    return { data, warnings, human: `${own}\n\n${section}`, storeWarningInText: true };
  },
};
