// Error registry: every error code has an exit code, an HTTP status and a default fix (C5).

export type ErrorCode =
  | 'INTERNAL'
  | 'USAGE'
  | 'UNKNOWN_OPTION'
  | 'INVALID_VALUE'
  | 'UNKNOWN_STATUS'
  | 'UNKNOWN_FIELD'
  | 'ACTOR_REQUIRED'
  | 'TASK_NOT_FOUND'
  | 'ATTACHMENT_NOT_FOUND'
  | 'REV_CONFLICT'
  | 'ALREADY_CLAIMED'
  | 'TASK_ARCHIVED'
  | 'ATTACHMENT_EXISTS'
  | 'LOCK_TIMEOUT'
  | 'LOCK_LOST'
  | 'PORT_IN_USE'
  | 'STORE_NOT_FOUND'
  | 'STORE_INVALID'
  | 'STORE_TOO_NEW'
  | 'STORE_EXISTS'
  | 'STORE_READ_ONLY'
  | 'SETUP_UNPARSEABLE'
  | 'SETUP_CONFLICT'
  | 'SETUP_WRITE_FAILED';

export interface ErrorSpec {
  exit: number;
  http: number;
  fix: string;
}

// STORE_READ_ONLY fix for a write to a board opened with --board (read-only), shared by the registry default and the store's refusals.
export const READ_ONLY_BOARD_FIX = 'drop --board and write to your own board (laneboard boards --json shows which one is yours)';

export const ERRORS: Record<ErrorCode, ErrorSpec> = {
  INTERNAL: { exit: 1, http: 500, fix: 'retry once; if it repeats, report a bug with the command and `laneboard --version`' },
  USAGE: { exit: 2, http: 400, fix: 'check the usage: laneboard --help' },
  UNKNOWN_OPTION: { exit: 2, http: 400, fix: 'check the options: laneboard <command> --help' },
  INVALID_VALUE: { exit: 2, http: 400, fix: 'pass the value in the format the message states' },
  UNKNOWN_STATUS: { exit: 2, http: 400, fix: 'use a status from `allowed` (config.statuses)' },
  UNKNOWN_FIELD: { exit: 2, http: 400, fix: 'use a field from `allowed`, or ask the board owner to declare it: laneboard config --field <key>:<type> --json' },
  ACTOR_REQUIRED: { exit: 2, http: 400, fix: 'pass --as <your-name> (or export LANEBOARD_AGENT=<your-name> only if no subagent runs under you)' },
  TASK_NOT_FOUND: { exit: 3, http: 404, fix: 'find the task: laneboard list --scope all --text "<words from the title>" --json' },
  ATTACHMENT_NOT_FOUND: { exit: 3, http: 404, fix: 'see attachment names: laneboard get <id> --json' },
  REV_CONFLICT: { exit: 4, http: 409, fix: 'read the task again (laneboard get <id> --json) and re-apply your change with the new --expected-rev' },
  ALREADY_CLAIMED: { exit: 4, http: 409, fix: 'do not take over: laneboard comment <id> "<note for the assignee>" --json, or ask the orchestrator' },
  TASK_ARCHIVED: { exit: 4, http: 409, fix: 'archived tasks are read-only: laneboard restore <id> --json' },
  ATTACHMENT_EXISTS: { exit: 4, http: 409, fix: 'pick another --name, or remove the old one first: laneboard attach <id> --remove <name> --json' },
  LOCK_TIMEOUT: { exit: 5, http: 503, fix: 'the store is busy: retry the same command once' },
  LOCK_LOST: { exit: 5, http: 503, fix: 'retry the same command once' },
  // laneboard board: the port is taken (another board or program); the OS picks a free one with --port 0. A conflict (exit 4), not
  // "busy, retry once" (exit 5, LB-63.5): the same command again finds the port taken again.
  PORT_IN_USE: { exit: 4, http: 409, fix: 'laneboard board --port 0 (the system picks a free port)' },
  STORE_NOT_FOUND: {
    exit: 6,
    http: 500,
    fix: 'find this project\'s board: laneboard boards --json, then pass --dir <its path> on every command; none for this project: in its root laneboard init --name <name> --description "<whose project, what work>" --json, then laneboard prime --json',
  },
  STORE_INVALID: { exit: 6, http: 500, fix: 'laneboard doctor --json; to roll back to the previous good version: laneboard doctor --restore-backup --json' },
  STORE_TOO_NEW: { exit: 6, http: 500, fix: 'upgrade laneboard: npm i -g laneboard@latest' },
  STORE_EXISTS: { exit: 6, http: 409, fix: 'use the existing store, or pass --dir <another empty directory>' },
  // A write through --board (another board, opened to read), or a machine registry that cannot be written (boards --forget).
  // The default names both; the store's own refusals (transact, config) use its --board half, the CLI and boards --forget a more concrete one.
  STORE_READ_ONLY: {
    exit: 6,
    http: 409,
    fix: `a write through --board: ${READ_ONLY_BOARD_FIX}; boards --forget: make the machine registry folder writable and run it again`,
  },
  SETUP_UNPARSEABLE: { exit: 6, http: 500, fix: 'add the snippet from `details` to the file by hand, or fix the file and run setup again' },
  SETUP_CONFLICT: { exit: 6, http: 409, fix: 'remove the laneboard entry that is outside the laneboard block and run setup again, or add the snippet from `details` by hand' },
  SETUP_WRITE_FAILED: { exit: 6, http: 500, fix: 'make the file and its directory writable and run setup again' },
};

// All error codes, in registry order.
export const ERROR_CODES = Object.keys(ERRORS) as ErrorCode[];

// The input value that caused an error, so a facade can rebuild a corrected command.
export interface BadInput {
  field: string;
  value: string;
  // A concrete corrected value (only for an obvious typo).
  suggestion?: string;
  // Placeholder naming the expected format, like `priority=<number>`; shown in a rebuilt command.
  format?: string;
}

// How a facade turns the caller's own command into the fix: what to add to it or drop from it (CLI; MCP keeps `fix`).
export interface FixEdit {
  // Options to add, by op parameter name (`status`, `updated_before`), each with a concrete value or a `<placeholder>`.
  add?: Array<{ name: string; value: string }>;
  // Positional arguments to add at the end, like `<id>`.
  args?: string[];
  // Options to drop, by op parameter name: every occurrence, or only the one with this value.
  drop?: Array<{ name: string; value?: string }>;
  // An environment assignment put before the command, like `HOME=<your home directory>`.
  env?: string;
}

export interface ErrorExtra {
  fix?: string;
  allowed?: string[];
  details?: Record<string, unknown>;
  input?: BadInput;
  edit?: FixEdit;
}

// Plain error object as it appears in JSON envelopes.
export interface ErrorObject {
  code: ErrorCode;
  message: string;
  fix: string;
  allowed?: string[];
  details?: Record<string, unknown>;
}

// Domain error with a registry code and a concrete fix.
export class LaneboardError extends Error {
  readonly code: ErrorCode;
  readonly fix: string;
  readonly allowed?: string[];
  readonly details?: Record<string, unknown>;
  readonly input?: BadInput;
  readonly edit?: FixEdit;

  // Build an error; fix defaults to the registry fix for the code.
  constructor(code: ErrorCode, message: string, extra: ErrorExtra = {}) {
    super(message);
    this.name = 'LaneboardError';
    this.code = code;
    this.fix = extra.fix ?? ERRORS[code].fix;
    if (extra.allowed) this.allowed = extra.allowed;
    if (extra.details) this.details = extra.details;
    if (extra.input) this.input = extra.input;
    if (extra.edit) this.edit = extra.edit;
  }
}

// Convert anything thrown into a LaneboardError (unknown errors become INTERNAL without a stack).
export function toLaneboardError(err: unknown): LaneboardError {
  if (err instanceof LaneboardError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new LaneboardError('INTERNAL', message);
}

// Serialize an error for a JSON envelope with an explicit field list.
export function toErrorObject(err: LaneboardError, fix: string = err.fix): ErrorObject {
  const out: ErrorObject = { code: err.code, message: err.message, fix };
  if (err.allowed) out.allowed = err.allowed;
  if (err.details) out.details = err.details;
  return out;
}
