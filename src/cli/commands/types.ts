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
  stdout(text: string): void;
  stderr(text: string): void;
  // Override of the 15 s lock wait budget (tests only).
  lockWaitMs?: number;
  // Override of the 5 s write deadline after the lock acquire (tests only).
  lockMaxHoldMs?: number;
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
}

export interface CommandDef {
  name: string;
  usage: string;
  summary: string;
  options: OptionSpec;
  args: { min: number; max: number };
  // Op parameter name -> CLI flag, for messages like "status is required".
  flags?: Record<string, string>;
  run(c: CommandContext): Promise<CommandOutput>;
}
