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
  | 'STORE_NOT_FOUND'
  | 'STORE_INVALID'
  | 'STORE_TOO_NEW'
  | 'STORE_EXISTS'
  | 'SETUP_UNPARSEABLE'
  | 'SETUP_CONFLICT'
  | 'SETUP_WRITE_FAILED';

export interface ErrorSpec {
  exit: number;
  http: number;
  fix: string;
}

export const ERRORS: Record<ErrorCode, ErrorSpec> = {
  INTERNAL: { exit: 1, http: 500, fix: 'retry once; if it repeats, report a bug with the command and `laneboard --version`' },
  USAGE: { exit: 2, http: 400, fix: 'check the usage: laneboard --help' },
  UNKNOWN_OPTION: { exit: 2, http: 400, fix: 'check the options: laneboard <command> --help' },
  INVALID_VALUE: { exit: 2, http: 400, fix: 'pass the value in the format the message states' },
  UNKNOWN_STATUS: { exit: 2, http: 400, fix: 'use a status from `allowed` (config.statuses)' },
  UNKNOWN_FIELD: { exit: 2, http: 400, fix: 'use a field from `allowed` or declare it in .laneboard/config.json `fields`' },
  ACTOR_REQUIRED: { exit: 2, http: 400, fix: 'pass --as <your-name> or export LANEBOARD_AGENT=<your-name>' },
  TASK_NOT_FOUND: { exit: 3, http: 404, fix: 'find the task: laneboard list --scope all --text "<words from the title>"' },
  ATTACHMENT_NOT_FOUND: { exit: 3, http: 404, fix: 'see attachment names: laneboard get <id>' },
  REV_CONFLICT: { exit: 4, http: 409, fix: 'read the task again (laneboard get <id> --json) and re-apply your change with the new --expected-rev' },
  ALREADY_CLAIMED: { exit: 4, http: 409, fix: 'do not take over: laneboard comment <id> "<note for the assignee>", or ask the orchestrator' },
  TASK_ARCHIVED: { exit: 4, http: 409, fix: 'archived tasks are read-only: laneboard restore <id>' },
  ATTACHMENT_EXISTS: { exit: 4, http: 409, fix: 'pick another --name, or remove the old one first: laneboard attach <id> --remove <name>' },
  LOCK_TIMEOUT: { exit: 5, http: 503, fix: 'the store is busy: retry the same command once' },
  LOCK_LOST: { exit: 5, http: 503, fix: 'retry the same command once' },
  STORE_NOT_FOUND: { exit: 6, http: 500, fix: 'laneboard init, or export LANEBOARD_DIR=/abs/path/.laneboard' },
  STORE_INVALID: { exit: 6, http: 500, fix: 'laneboard doctor; to roll back to the previous good version: laneboard doctor --restore-backup' },
  STORE_TOO_NEW: { exit: 6, http: 500, fix: 'upgrade laneboard: npm i -g laneboard@latest' },
  STORE_EXISTS: { exit: 6, http: 409, fix: 'use the existing store, or pass --dir <another empty directory>' },
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

export interface ErrorExtra {
  fix?: string;
  allowed?: string[];
  details?: Record<string, unknown>;
  input?: BadInput;
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

  // Build an error; fix defaults to the registry fix for the code.
  constructor(code: ErrorCode, message: string, extra: ErrorExtra = {}) {
    super(message);
    this.name = 'LaneboardError';
    this.code = code;
    this.fix = extra.fix ?? ERRORS[code].fix;
    if (extra.allowed) this.allowed = extra.allowed;
    if (extra.details) this.details = extra.details;
    if (extra.input) this.input = extra.input;
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
