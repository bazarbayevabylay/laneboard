// Shapes shared by CLI commands.
import type { ParseArgsConfig } from 'node:util';
import type { DiscoveryInput, OpContext } from '../../core/index.ts';

export type OptionSpec = NonNullable<ParseArgsConfig['options']>;
export type Values = Record<string, string | boolean | Array<string | boolean> | undefined>;

// Everything a CLI process gets from the outside world (injected for tests).
export interface CliIo {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  readStdin(): string;
  // stdin is a terminal: nothing is piped in, so a hook does not wait for input.
  stdinIsTTY?: boolean;
  stdout(text: string): void;
  stderr(text: string): void;
  // Override of the 15 s lock wait budget (tests only).
  lockWaitMs?: number;
  // Override of the 5 s write deadline after the lock acquire (tests only).
  lockMaxHoldMs?: number;
  // Terminal width and whether stdout is a terminal (view layout and colors); undefined when stdout is not a terminal.
  columns?: number;
  isTTY?: boolean;
  // Aborted on Ctrl+C (SIGINT): ends `view --watch`.
  signal?: AbortSignal;
  // Poll interval of `view --watch` (tests only; default 2 s).
  watchPollMs?: number;
  // Leave fs.watch out, so only the poll notices changes (tests only).
  watchNoEvents?: boolean;
  // The Node.js version the CLI runs on (tests only; default process.versions.node).
  nodeVersion?: string;
}

export interface CommandContext {
  values: Values;
  positionals: string[];
  io: CliIo;
  discovery: DiscoveryInput;
  // Resolve the store (records it for the envelope) and build the op context.
  op(): OpContext;
  // Record the store path for the envelope (init).
  setStore(dir: string): void;
}

export interface CommandOutput {
  data: unknown;
  warnings: string[];
  human: string;
  // Print nothing (the MCP server owns stdout).
  silent?: boolean;
  // The human text already shows the parent-directory store warning (prime), so it is not repeated on stderr.
  storeWarningInText?: boolean;
  // Exit code of a result that is not an error but must not read as success (doctor on an unhealthy store: 6); default 0.
  exitCode?: number;
}

export interface CommandDef {
  name: string;
  usage: string;
  summary: string;
  options: OptionSpec;
  args: { min: number; max: number };
  // Op parameter name -> CLI flag, for messages like "status is required".
  flags?: Record<string, string>;
  // Options the command cannot run without, with the value a wrong-number-of-arguments fix adds when one is absent (create: --status <first>).
  required?(discovery: DiscoveryInput): Array<{ name: string; value: string }>;
  // Only reads a store, so it may open another board with --board (read-only).
  readOnly?: boolean;
  run(c: CommandContext): Promise<CommandOutput>;
}
