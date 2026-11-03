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
  GetInput,
  LaneboardError,
  ListInput,
  OPS,
  resolveStore,
  RestoreInput,
  toErrorObject,
  toLaneboardError,
  UpdateInput,
} from '../core/index.ts';
import type { ErrorObject, OpContext, OpName, OpResult } from '../core/index.ts';

export interface ToolDef {
  name: string;
  description: string;
  // Parameters as advertised in tools/list (core input plus `actor` for writes).
  params: z.ZodObject;
  // Writes take `actor`; reads take none.
  write: boolean;
  destructive?: boolean;
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

const actor = z.string().describe('your name, e.g. dev-1 (the same one in every call)');

// Advertised parameters of a write tool: the op input plus a required actor.
function writeParams(input: z.ZodObject): z.ZodObject {
  return input.extend({ actor });
}

// One entry per core op: an MCP tool, or "cli-only" (typecheck fails when a new op is not listed).
export const TOOLS: Record<OpName, ToolDef | 'cli-only'> = {
  createTask: {
    name: 'task_create',
    description: 'Create a task. status must be a configured status; fields keys must be declared in config.fields. Returns the task with its id.',
    params: writeParams(CreateInput.omit({ field_args: true })),
    write: true,
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
    description: 'Change a task (at least one change); status changes only here. assignee null unassigns. description replaces the whole text. Pass expected_rev from your last read or write (every write returns the new rev).',
    params: writeParams(UpdateInput.omit({ field_args: true })),
    write: true,
  },
  claimTask: {
    name: 'task_claim',
    description: 'Take a task: assignee := actor, optionally set status. Held by someone else: ALREADY_CLAIMED, do not take it over.',
    params: writeParams(ClaimInput),
    write: true,
  },
  commentTask: {
    name: 'task_comment',
    description: 'Add a comment to a task (notes, results). A comment is a change: rev +1; task_get shows it as an event of type commented.',
    params: writeParams(CommentInput),
    write: true,
  },
  attachFile: {
    name: 'task_attach',
    description: 'Attach a file (path: absolute path, optional name) or remove an attachment (remove: its name). Exactly one of path and remove.',
    params: writeParams(AttachInput),
    write: true,
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
    params: writeParams(RestoreInput),
    write: true,
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

// Split call arguments into the actor and the op input; unknown parameters fail like unknown op input keys.
function splitArgs(def: ToolDef, args: Record<string, unknown>): { actor?: string; input: Record<string, unknown> } {
  const known = Object.keys(def.params.shape);
  const unknown = Object.keys(args).filter((k) => !known.includes(k));
  if (unknown.length) throw new LaneboardError('USAGE', `unknown parameter: ${unknown.join(', ')}`);
  if (!def.write) return { input: args };
  const { actor: who, ...input } = args;
  if (who !== undefined && typeof who !== 'string') {
    throw new LaneboardError('INVALID_VALUE', `actor must be a string like dev-1, got ${JSON.stringify(who)}`, { fix: `pass actor: "<your-name>" (e.g. dev-1) to ${def.name}` });
  }
  return { actor: who, input };
}

// Run one tool call: parse arguments, call the core op, map the result (thin adapter).
export async function callTool(name: string, rawArgs: unknown, env: ToolEnv): Promise<ToolResult> {
  const entry = TOOL_LIST.find((t) => t.def.name === name);
  try {
    if (!entry) {
      throw new LaneboardError('USAGE', `unknown tool "${name}"`, { allowed: TOOL_LIST.map((t) => t.def.name), fix: 'call one of the tools in `allowed`' });
    }
    const args = rawArgs ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) throw new LaneboardError('USAGE', 'arguments must be an object');
    const { actor: who, input } = splitArgs(entry.def, args as Record<string, unknown>);
    const ctx: OpContext = {
      store: resolveStore({ dir: env.dir, envDir: env.env.LANEBOARD_DIR, cwd: env.cwd }),
      actor: who === '' ? undefined : who,
      lockWaitMs: env.lockWaitMs,
    };
    const op = OPS[entry.op] as unknown as (c: OpContext, i: unknown) => Promise<OpResult<Record<string, unknown>>>;
    const result = await op(ctx, input);
    const content = [{ type: 'text' as const, text: JSON.stringify(result.data) }];
    if (result.warnings.length) content.push({ type: 'text', text: JSON.stringify({ warnings: result.warnings }) });
    return { content, structuredContent: result.data };
  } catch (raw) {
    const error = mcpError(toLaneboardError(raw), entry?.def);
    return { content: [{ type: 'text', text: JSON.stringify(error) }], structuredContent: { ...error }, isError: true };
  }
}
