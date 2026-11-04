// CLI runner: parse argv strictly, call one core op, print one result (thin adapter, testable in-process).
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { ERRORS, LaneboardError, parentStoreWarning, resolveActor, resolveBoard, resolveStore, storePrefix, suggestClosest, toLaneboardError } from '../core/index.ts';
import type { StoreRef } from '../core/index.ts';
import { argumentsFix, cliFix, commandFirst, jsonRequested, parseError, rejectRepeated } from './argv.ts';
import { COMMANDS, findCommand } from './commands/index.ts';
import type { CliIo, CommandDef, OptionSpec, Values } from './commands/types.ts';
import { safeText } from './display.ts';
import { cliMessage, errorEnvelope, errorText, okEnvelope, warningText } from './format.ts';

export type { CliIo } from './commands/types.ts';

const GLOBAL_OPTIONS: OptionSpec = {
  json: { type: 'boolean' },
  dir: { type: 'string' },
  as: { type: 'string' },
  board: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

// Commands whose human text carries its own terminal styles (view's colors): they make the data in it safe themselves (board-view.ts),
// so the runner prints their text as it is; every other human text is made safe here (display.ts).
const STYLED_COMMANDS = new Set(['view']);

// Commands that may open another board with --board (they only read).
const READ_COMMANDS = (): string[] => COMMANDS.filter((c) => c.readOnly).map((c) => c.name);

// Package version from package.json (same relative path from src/cli and dist/cli).
export function version(): string {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

// Top-level help text.
export function globalHelp(): string {
  return [
    'Agents: start with `laneboard prime` - it prints the rules, your board and the command that creates your task.',
    'laneboard <command> [options] - task board & CLI for AI coding agents',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.usage}`),
    '',
    'Global options (every command):',
    '  --json         print one JSON document on stdout, also on errors',
    '  --dir <path>   store directory (.laneboard); else LANEBOARD_DIR; else search up from cwd (pass it on every command to use another board)',
    '  --as <actor>   who is writing; else LANEBOARD_AGENT; else the session default name (LANEBOARD_DEFAULT_AGENT, Claude Code session)',
    `  --board <b>    open another board read-only by prefix, name or path (${READ_COMMANDS().join(', ')})`,
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
    `Global options: --json, --dir <path>, --as <actor>, --help${def.readOnly ? ', --board <prefix|name|path> (read-only)' : ''}`,
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

// The value placeholder of an option in a usage line: `--confirm <id>` -> `<id>`; `--result T` -> `<result>`.
function usagePlaceholder(usage: string, flagName: string): string {
  const value = new RegExp(`${flagName} (\\S+)`).exec(usage)?.[1];
  return value !== undefined && /^<[^<>]+>$/.test(value) ? value : `<${flagName.replace(/^--/, '')}>`;
}

// Rename op parameter names to CLI flags in "x is required" messages; the fix adds the option to the user's command.
function flagMessage(err: LaneboardError, def: CommandDef | undefined): LaneboardError {
  const m = /^([a-z_]+) is required$/.exec(err.message);
  const name = m?.[1];
  if (err.code !== 'USAGE' || !name || !def) return err;
  const flagName = def.flags?.[name] ?? `--${name.replace(/_/g, '-')}`;
  // An error with its own fix or input (init's description) keeps it; the bare registry fix becomes the user's command plus the option.
  const generic = !err.input && err.fix === ERRORS.USAGE.fix;
  const edit = err.edit ?? (generic ? { add: [{ name, value: usagePlaceholder(def.usage, flagName) }] } : undefined);
  return new LaneboardError('USAGE', `${flagName} is required`, { fix: err.fix, ...(edit ? { edit } : {}), ...(err.allowed ? { allowed: err.allowed } : {}), ...(err.input ? { input: err.input } : {}) });
}

interface Printed {
  json: boolean;
  store: string | null;
  // The store as discovery found it (to tell a store in a parent directory apart).
  ref?: StoreRef;
}

// Run one CLI invocation; returns the exit code.
export async function runCli(io: CliIo): Promise<number> {
  const argv = io.argv;
  const out: Printed = { json: jsonRequested(argv), store: null };
  let def: CommandDef | undefined;
  try {
    const [name, ...rest] = argv;
    // `laneboard` alone is a person looking around: the help, not an error.
    if (name === undefined || name === '--help' || name === '-h' || name === 'help') return print(io, out, { help: globalHelp() }, [], globalHelp());
    if (name === '--version' || name === '-v') return print(io, out, { version: version() }, [], version());
    if (name.startsWith('-')) {
      throw new LaneboardError('USAGE', `the command comes first: laneboard <command> [options], got ${name}`, {
        allowed: COMMANDS.map((c) => c.name),
        fix: commandFirst(argv, (t) => findCommand(t) !== undefined),
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
    const discovery = {
      dir: typeof values.dir === 'string' ? values.dir : undefined,
      envDir: io.env.LANEBOARD_DIR,
      cwd: io.cwd,
      home: io.env.HOME || undefined,
    };
    if (positionals.length < command.args.min || positionals.length > command.args.max) {
      throw new LaneboardError('USAGE', `wrong number of arguments for ${command.name} (got ${positionals.length}): laneboard ${command.usage}`, {
        fix: argumentsFix(command.name, rest, parsed.tokens, command.usage, command.args, command.required?.(discovery)),
      });
    }
    const board = typeof values.board === 'string' ? values.board : undefined;
    // Another board is opened only to read it: a write never reaches it (transact refuses read-only stores too).
    if (board !== undefined && !command.readOnly) {
      throw new LaneboardError('STORE_READ_ONLY', `--board opens another board read-only; ${command.name} is not a read command (${READ_COMMANDS().join(', ')})`, {
        fix: `drop --board: laneboard ${command.name} works on your own board (--dir / LANEBOARD_DIR; laneboard boards --json shows which one is yours)`,
      });
    }
    if (board !== undefined && discovery.dir !== undefined) throw new LaneboardError('USAGE', '--board and --dir cannot be combined', { edit: { drop: [{ name: 'dir' }] } });
    let store: StoreRef | undefined;
    const named = resolveActor(typeof values.as === 'string' ? values.as : undefined, io.env);
    const result = await command.run({
      values,
      positionals,
      io,
      discovery,
      op: () => {
        store ??= board !== undefined ? resolveBoard(io.env.HOME, board, io.cwd) : resolveStore(discovery);
        out.store = store.dir;
        out.ref = store;
        // A person waiting for a busy lock hears why the command is slow; --json output stays one document.
        const onLockWait = out.json ? undefined : (message: string) => io.stderr(`${safeText(message)}\n`);
        return { store, ...named, cwd: io.cwd, home: io.env.HOME || undefined, lockWaitMs: io.lockWaitMs, lockMaxHoldMs: io.lockMaxHoldMs, onLockWait };
      },
      setStore: (dir) => {
        out.store = dir;
      },
    });
    if (result.silent) return 0;
    // A store found in a parent directory (or pinned for one) may be another project's: every result says so (prime prints it in its text).
    const parent = out.ref ? parentStoreWarning(out.ref, io.cwd, storePrefix(out.ref.dir), io.env.HOME || undefined) : undefined;
    const warnings = parent && (out.json || !result.storeWarningInText) ? [parent, ...result.warnings] : result.warnings;
    const code = print(io, out, result.data, warnings, STYLED_COMMANDS.has(command.name) ? result.human : safeText(result.human));
    return result.exitCode ?? code;
  } catch (raw) {
    const err = cliMessage(flagMessage(toLaneboardError(raw), def));
    // One command rebuilt from the user's own argv (argv.ts), else the core fix.
    const fix = cliFix(err, argv, def, { ...GLOBAL_OPTIONS, ...def?.options });
    if (out.json) io.stdout(errorEnvelope(out.store, out.store ? storePrefix(out.store) : null, err, fix));
    else io.stderr(errorText(err, fix));
    return ERRORS[err.code].exit;
  }
}

// Print a successful result: JSON envelope (with the store's prefix), or human text on stdout and warnings on stderr.
function print(io: CliIo, out: Printed, data: unknown, warnings: string[], human: string): number {
  if (out.json) {
    io.stdout(okEnvelope(out.store, out.store ? storePrefix(out.store) : null, data, warnings));
  } else {
    io.stdout(`${human}\n`);
    if (warnings.length) io.stderr(warningText(warnings));
  }
  return 0;
}
