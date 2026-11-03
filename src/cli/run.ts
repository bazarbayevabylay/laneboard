// CLI runner: parse argv strictly, call one core op, print one result (thin adapter, testable in-process).
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { ERRORS, LaneboardError, resolveStore, suggestClosest, toLaneboardError } from '../core/index.ts';
import type { StoreRef } from '../core/index.ts';
import { jsonRequested, parseError, rejectRepeated } from './argv.ts';
import { COMMANDS, findCommand } from './commands/index.ts';
import type { CliIo, CommandDef, OptionSpec, Values } from './commands/types.ts';
import { cliFix, errorEnvelope, errorText, okEnvelope, warningText } from './format.ts';

export type { CliIo } from './commands/types.ts';

const GLOBAL_OPTIONS: OptionSpec = {
  json: { type: 'boolean' },
  dir: { type: 'string' },
  as: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

// Package version from package.json (same relative path from src/cli and dist/cli).
export function version(): string {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

// Top-level help text.
export function globalHelp(): string {
  return [
    'laneboard <command> [options] - task board & CLI for AI coding agents',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.usage}`),
    '',
    'Global options (every command):',
    '  --json         print one JSON document on stdout, also on errors',
    '  --dir <path>   store directory (.laneboard); else LANEBOARD_DIR; else search up from cwd',
    '  --as <actor>   who is writing; else LANEBOARD_AGENT (required for writes)',
    '  --help, -h     usage of a command: laneboard <command> --help',
    '  --version      print the version',
    '  --             end of options: text that starts with "-" goes after it',
    '                 (laneboard comment LB-1 --as me -- "- item"); option values: --description="- item"',
    '',
    'Exit codes: 0 ok, 1 internal, 2 input, 3 not found, 4 conflict, 5 busy (retry once), 6 store',
  ].join('\n');
}

// Help text of one command.
function commandHelp(def: CommandDef): string {
  return [
    `laneboard ${def.usage}`,
    '',
    def.summary,
    '',
    'Global options: --json, --dir <path>, --as <actor>, --help',
    'Text that starts with "-": after -- (options first), or as --option=<value>.',
  ].join('\n');
}

// Strict parse of a command's argv; parse errors become UNKNOWN_OPTION or USAGE with a rebuilt fix.
function parseStrict(command: string, args: string[], options: OptionSpec) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true, tokens: true });
  } catch (err) {
    throw parseError(err, command, args, options);
  }
}

// Rename op parameter names to CLI flags in "x is required" messages.
function flagMessage(err: LaneboardError, def: CommandDef | undefined): LaneboardError {
  const m = /^([a-z_]+) is required$/.exec(err.message);
  const name = m?.[1];
  if (err.code !== 'USAGE' || !name || !def) return err;
  const flagName = def.flags?.[name] ?? `--${name.replace(/_/g, '-')}`;
  return new LaneboardError('USAGE', `${flagName} is required`, { fix: err.fix });
}

interface Printed {
  json: boolean;
  store: string | null;
}

// Run one CLI invocation; returns the exit code.
export async function runCli(io: CliIo): Promise<number> {
  const argv = io.argv;
  const out: Printed = { json: jsonRequested(argv), store: null };
  let def: CommandDef | undefined;
  try {
    const [name, ...rest] = argv;
    if (name === '--help' || name === '-h' || name === 'help') return print(io, out, { help: globalHelp() }, [], globalHelp());
    if (name === '--version') return print(io, out, { version: version() }, [], version());
    if (name === undefined || name.startsWith('-')) {
      throw new LaneboardError('USAGE', name === undefined ? 'missing command' : `the command comes first: laneboard <command> [options], got ${name}`, {
        allowed: COMMANDS.map((c) => c.name),
      });
    }
    def = findCommand(name);
    if (!def) {
      const names = COMMANDS.map((c) => c.name);
      const suggestion = suggestClosest(name, names);
      throw new LaneboardError('USAGE', `unknown command "${name}"`, {
        allowed: names,
        input: suggestion ? { field: 'command', value: name, suggestion } : { field: 'command', value: name },
      });
    }
    const command = def;
    const options = { ...GLOBAL_OPTIONS, ...command.options };
    const parsed = parseStrict(command.name, rest, options);
    rejectRepeated(parsed.tokens, command.name, rest, options);
    const values: Values = parsed.values;
    const positionals = parsed.positionals;
    out.json = values.json === true;
    if (values.help === true) return print(io, out, { help: commandHelp(command) }, [], commandHelp(command));
    if (positionals.length < command.args.min || positionals.length > command.args.max) {
      throw new LaneboardError('USAGE', `wrong number of arguments for ${command.name} (got ${positionals.length}): laneboard ${command.usage}`);
    }
    const discovery = {
      dir: typeof values.dir === 'string' ? values.dir : undefined,
      envDir: io.env.LANEBOARD_DIR,
      cwd: io.cwd,
    };
    let store: StoreRef | undefined;
    const actor = typeof values.as === 'string' ? values.as : io.env.LANEBOARD_AGENT;
    const result = await command.run({
      values,
      positionals,
      io,
      discovery,
      op: () => {
        store ??= resolveStore(discovery);
        out.store = store.dir;
        return { store, actor: actor === '' ? undefined : actor, lockWaitMs: io.lockWaitMs, lockMaxHoldMs: io.lockMaxHoldMs };
      },
      setStore: (dir) => {
        out.store = dir;
      },
    });
    if (result.silent) return 0;
    return print(io, out, result.data, result.warnings, result.human);
  } catch (raw) {
    const err = flagMessage(toLaneboardError(raw), def);
    const fix = cliFix(err, argv, def);
    if (out.json) io.stdout(errorEnvelope(out.store, err, fix));
    else io.stderr(errorText(err, fix));
    return ERRORS[err.code].exit;
  }
}

// Print a successful result: JSON envelope, or human text on stdout and warnings on stderr.
function print(io: CliIo, out: Printed, data: unknown, warnings: string[], human: string): number {
  if (out.json) {
    io.stdout(okEnvelope(out.store, data, warnings));
  } else {
    io.stdout(`${human}\n`);
    if (warnings.length) io.stderr(warningText(warnings));
  }
  return 0;
}
