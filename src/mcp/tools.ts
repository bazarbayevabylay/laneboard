// MCP tools: one per core op (C3), same parameter names as the op input, results and errors as in the CLI --json envelope.
import { z } from 'zod';
import {
  ArchiveInput,
  AttachInput,
  ClaimInput,
  CommentInput,
  CreateInput,
  DeleteInput,
  ERRORS,
  EventsInput,
  FinishInput,
  GetInput,
  LaneboardError,
  ListInput,
  OPS,
  parentStoreWarning,
  resolveActor,
  resolveStore,
  RestoreInput,
  storePrefix,
  toErrorObject,
  toLaneboardError,
  UpdateInput,
  writeReply,
} from '../core/index.ts';
import type { ErrorObject, OpContext, OpName, OpResult, StoreRef, TaskView } from '../core/index.ts';

export interface ToolDef {
  name: string;
  description: string;
  // Parameters as advertised in tools/list (core input plus `actor` for writes).
  params: z.ZodObject;
  // Writes take `actor`; reads take none.
  write: boolean;
  destructive?: boolean;
  // The op returns one task: the reply is short (id, rev, status, assignee) unless `full` is passed.
  taskReply?: boolean;
}

// Where the server finds the store: same discovery as the CLI, resolved again on every call (W3).
export interface ToolEnv {
  cwd: string;
  env: Record<string, string | undefined>;
  // Value of `laneboard mcp --dir`.
  dir?: string;
  // Test-only lock overrides, as in the CLI.
  lockWaitMs?: number;
}

const actor = z
  .string()
  .optional()
  .describe('your name, e.g. dev-1 (the same one in every call); omitted: LANEBOARD_AGENT, else the session default name');

const full = z.boolean().optional().describe('true: reply with the whole task (as task_get); default: only id, rev, status, assignee');

// Advertised parameters of a write tool: the op input plus the actor (explicit, else LANEBOARD_AGENT, else the session default).
function writeParams(input: z.ZodObject): z.ZodObject {
  return input.extend({ actor });
}

// Advertised parameters of a write tool that changes one task: also `full`.
function taskWriteParams(input: z.ZodObject): z.ZodObject {
  return input.extend({ actor, full });
}

// One entry per core op: an MCP tool, or "cli-only" (typecheck fails when a new op is not listed).
export const TOOLS: Record<OpName, ToolDef | 'cli-only'> = {
  createTask: {
    name: 'task_create',
    description: 'Create a task. status must be a configured status; fields keys must be declared in config.fields. Returns its id, rev, status, assignee (full: the whole task).',
    params: taskWriteParams(CreateInput.omit({ field_args: true })),
    write: true,
    taskReply: true,
  },
  getTask: {
    name: 'task_get',
    description: 'Get one task by exact id (like LB-12); searches the archive too, the result has "archived". events: keep only the newest N events.',
    params: GetInput,
    write: false,
  },
  listTasks: {
    name: 'task_list',
    description: 'List task summaries, newest update first (default scope active, limit 20). Use task_get for a full task.',
    params: ListInput,
    write: false,
  },
  updateTask: {
    name: 'task_update',
    description:
      'Change a task (at least one change). assignee null unassigns. description replaces the whole text. expected_rev is optional: pass it (the rev of your last read or write) only for edits on top of what you read (description, fields); a status change needs none. Closing a task: task_finish.',
    params: taskWriteParams(UpdateInput.omit({ field_args: true })),
    write: true,
    taskReply: true,
  },
  claimTask: {
    name: 'task_claim',
    description:
      'Take a task: assignee := actor, optionally set status. Held by someone else: ALREADY_CLAIMED, do not take it over. resume: true takes over a task of another session of your session default name (your own work before /clear, listed by laneboard prime) - only one you did yourself that matches the current request.',
    params: taskWriteParams(ClaimInput),
    write: true,
    taskReply: true,
  },
  commentTask: {
    name: 'task_comment',
    description: 'Add a comment to a task (notes, results). A comment is a change: rev +1; task_get shows it as an event of type commented.',
    params: taskWriteParams(CommentInput),
    write: true,
    taskReply: true,
  },
  finishTask: {
    name: 'task_finish',
    description:
      'Close a task in one call: the result comment, a link to the current git commit (HEAD of the server folder; no_commit: true for none), then the final status (status: any but the first one, e.g. review to hand in). Only the assignee, or anybody for an unassigned task; into a status that is not final it hands the task in (status event handed_in: true); a task of somebody else only to accept it after its assignee handed it in, into the final status, without a commit link (reply accepted: true, commit null). No expected_rev. Commit first: uncommitted changes (staged too) or a HEAD commit older than your claim give a warning (git is asked; without it: a warning). Already in that status or final: unchanged, with a warning (a new commit of the assignee is still linked). Returns id, rev, status, assignee, commit.',
    params: taskWriteParams(FinishInput),
    write: true,
    taskReply: true,
  },
  attachFile: {
    name: 'task_attach',
    description: 'Attach a file (path: absolute path, optional name) or remove an attachment (remove: its name). Exactly one of path and remove.',
    params: taskWriteParams(AttachInput),
    write: true,
    taskReply: true,
  },
  archiveTasks: {
    name: 'task_archive',
    description: 'Archive tasks by ids, or in bulk by status + updated_before (days like 14d); dry_run lists without writing. Archived tasks are read-only.',
    params: writeParams(ArchiveInput),
    write: true,
  },
  restoreTask: {
    name: 'task_restore',
    description: 'Move an archived task back to active.',
    params: taskWriteParams(RestoreInput),
    write: true,
    taskReply: true,
  },
  deleteTask: {
    name: 'task_delete',
    description: 'Delete a task and its attachments for good (active or archive). confirm_id must repeat the id.',
    params: writeParams(DeleteInput),
    write: true,
    destructive: true,
  },
  listEvents: {
    name: 'task_events',
    description: 'Event feed, newest first: one task (task) or all tasks of a scope; since is exclusive.',
    params: EventsInput,
    write: false,
  },
  taskSummary: 'cli-only',
  initStore: 'cli-only',
  migrateStore: 'cli-only',
  doctor: 'cli-only',
  importTasks: 'cli-only',
  configureStore: 'cli-only',
  viewBoard: 'cli-only',
  listBoards: 'cli-only',
};

interface ToolEntry {
  op: OpName;
  def: ToolDef;
}

// Exposed tools in registry order.
export const TOOL_LIST: readonly ToolEntry[] = (Object.entries(TOOLS) as Array<[OpName, ToolDef | 'cli-only']>).flatMap(([op, def]) => (def === 'cli-only' ? [] : [{ op, def }]));

// tools/list entry: name, description, JSON Schema of the parameters, annotations.
export function toolListing(def: ToolDef): { name: string; description: string; inputSchema: { type: 'object'; [k: string]: unknown }; annotations: Record<string, boolean> } {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(def.params, { io: 'input' }) as { $schema?: string; [k: string]: unknown };
  return {
    name: def.name,
    description: def.description,
    inputSchema: { ...schema, type: 'object' },
    annotations: { readOnlyHint: !def.write, destructiveHint: def.destructive === true, idempotentHint: false, openWorldHint: false },
  };
}

// Parameter list for a fix, required ones first: `id, text, actor` style.
function paramList(def: ToolDef): string {
  const shape = def.params.shape as Record<string, z.ZodType>;
  const names = Object.keys(shape);
  const required = names.filter((n) => !shape[n]?.safeParse(undefined).success);
  const optional = names.filter((n) => !required.includes(n));
  return [...required, ...optional.map((n) => `${n}?`)].join(', ');
}

// The error object an MCP caller gets: the CLI error, with CLI-only usage fixes replaced by the tool's parameters.
export function mcpError(err: LaneboardError, def: ToolDef | undefined): ErrorObject {
  if (def && err.code === 'ACTOR_REQUIRED') return toErrorObject(err, `pass actor: "<your-name>" (e.g. dev-1) to ${def.name}`);
  if (def && (err.code === 'USAGE' || err.code === 'UNKNOWN_OPTION') && err.fix === ERRORS[err.code].fix) {
    return toErrorObject(err, `call ${def.name} with these parameters (? = optional): ${paramList(def)}`);
  }
  return toErrorObject(err);
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

// Split call arguments into the actor, `full` and the op input; unknown parameters fail like unknown op input keys.
function splitArgs(def: ToolDef, args: Record<string, unknown>): { actor?: string; full: boolean; input: Record<string, unknown> } {
  const known = Object.keys(def.params.shape);
  const unknown = Object.keys(args).filter((k) => !known.includes(k));
  if (unknown.length) throw new LaneboardError('USAGE', `unknown parameter: ${unknown.join(', ')}`);
  if (!def.write) return { full: false, input: args };
  const { actor: who, full: wantFull, ...input } = args;
  if (who !== undefined && typeof who !== 'string') {
    throw new LaneboardError('INVALID_VALUE', `actor must be a string like dev-1, got ${JSON.stringify(who)}`, { fix: `pass actor: "<your-name>" (e.g. dev-1) to ${def.name}` });
  }
  if (wantFull !== undefined && typeof wantFull !== 'boolean') {
    throw new LaneboardError('INVALID_VALUE', `full must be true or false, got ${JSON.stringify(wantFull)}`, { fix: `pass full: true to ${def.name} for the whole task, or leave it out` });
  }
  return { actor: who, full: wantFull === true, input };
}

// Run one tool call: parse arguments, call the core op, map the result (thin adapter).
export async function callTool(name: string, rawArgs: unknown, env: ToolEnv): Promise<ToolResult> {
  const entry = TOOL_LIST.find((t) => t.def.name === name);
  let store: StoreRef | undefined;
  try {
    if (!entry) {
      throw new LaneboardError('USAGE', `unknown tool "${name}"`, { allowed: TOOL_LIST.map((t) => t.def.name), fix: 'call one of the tools in `allowed`' });
    }
    const args = rawArgs ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) throw new LaneboardError('USAGE', 'arguments must be an object');
    const { actor: who, full: wantFull, input } = splitArgs(entry.def, args as Record<string, unknown>);
    store = resolveStore({ dir: env.dir, envDir: env.env.LANEBOARD_DIR, cwd: env.cwd, home: env.env.HOME || undefined });
    // Same order as the CLI: the actor parameter, LANEBOARD_AGENT, then the session's default name (recorded as such on events).
    const named = entry.def.write ? resolveActor(who, env.env) : {};
    const ctx: OpContext = { store, ...named, cwd: env.cwd, lockWaitMs: env.lockWaitMs };
    const op = OPS[entry.op] as unknown as (c: OpContext, i: unknown) => Promise<OpResult<Record<string, unknown>>>;
    const result = await op(ctx, input);
    // Same short reply as the CLI unless the whole task is asked for (the attachment added rides along, as in the CLI).
    const data = entry.def.taskReply && !wantFull ? { ...writeReply(result.data as unknown as TaskView, entry.op === 'attachFile' && input.remove === undefined, result.reply) } : result.data;
    // Same notice as the CLI: a store found in a parent directory may belong to another project.
    const prefix = storePrefix(store.dir);
    const parent = parentStoreWarning(store, env.cwd, prefix, env.env.HOME || undefined);
    const warnings = parent ? [parent, ...result.warnings] : result.warnings;
    // The CLI envelope's store, prefix and warnings, next to the data (structuredContent stays the CLI `data`).
    const content = [
      { type: 'text' as const, text: JSON.stringify(data) },
      { type: 'text' as const, text: JSON.stringify({ store: store.dir, prefix, warnings }) },
    ];
    return { content, structuredContent: data };
  } catch (raw) {
    const error = mcpError(toLaneboardError(raw), entry?.def);
    const where = { store: store?.dir ?? null, prefix: store ? storePrefix(store.dir) : null };
    return { content: [{ type: 'text', text: JSON.stringify(error) }, { type: 'text', text: JSON.stringify(where) }], structuredContent: { ...error }, isError: true };
  }
}
