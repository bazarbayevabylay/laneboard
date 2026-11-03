// Argv checks around node:util.parseArgs: `--` handling, text that starts with "-", repeated options, and fixes rebuilt from argv.
import { LaneboardError, suggestClosest } from '../core/index.ts';
import type { OptionSpec } from './commands/types.ts';
import { commandLine } from './format.ts';

// Is `--json` among the options (tokens after `--` are text, not options)?
export function jsonRequested(argv: readonly string[]): boolean {
  const end = argv.indexOf('--');
  return (end < 0 ? argv : argv.slice(0, end)).includes('--json');
}

interface SplitArgv {
  // Option tokens with their values, in order.
  options: string[];
  // Positionals before `--`.
  positionals: string[];
  // Everything after `--`.
  rest: string[];
}

// Spec of a known option token (`--name`, `--name=value` or a short `-x`), or undefined.
function optionOf(token: string, options: OptionSpec): { inline: boolean; takesValue: boolean } | undefined {
  const long = /^--([^=]+)(=.*)?$/s.exec(token);
  const name = long ? long[1] : Object.keys(options).find((o) => token.length === 2 && options[o]?.short === token[1]);
  if (name === undefined || !Object.hasOwn(options, name)) return undefined;
  return { inline: long?.[2] !== undefined, takesValue: options[name]?.type === 'string' };
}

// Split argv after the command into options and positionals by the option spec (no validation).
function splitArgv(args: readonly string[], options: OptionSpec): SplitArgv {
  const out: SplitArgv = { options: [], positionals: [], rest: [] };
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? '';
    if (token === '--') {
      out.rest = args.slice(i + 1);
      break;
    }
    const spec = optionOf(token, options);
    if (!spec) {
      out.positionals.push(token);
      continue;
    }
    out.options.push(token);
    if (spec.takesValue && !spec.inline && i + 1 < args.length) out.options.push(args[++i] ?? '');
  }
  return out;
}

// A dash token that reads as text (a list item, a number, a sentence) rather than a mistyped option.
function looksLikeText(token: string, known: readonly string[]): boolean {
  if (/^--[A-Za-z]/.test(token)) return false;
  // `-status` is a typo of `--status`; `-x` with no close option is text.
  if (/^-[A-Za-z][A-Za-z0-9-]*$/.test(token)) return !known.includes(`-${token}`) && suggestClosest(`-${token}`, known) === undefined;
  return true;
}

// The same command with options first and the text that starts with "-" (and what follows it) after `--`.
function withTerminator(command: string, args: readonly string[], options: OptionSpec, text: string): string {
  const split = splitArgv(args, options);
  const at = split.positionals.indexOf(text);
  return commandLine([command, ...split.positionals.slice(0, at), ...split.options, '--', ...split.positionals.slice(at), ...split.rest]);
}

// Map a parseArgs error to UNKNOWN_OPTION or USAGE with a fix rebuilt from argv.
export function parseError(err: unknown, command: string, args: readonly string[], options: OptionSpec): LaneboardError {
  const e = err as { code?: string; message?: string };
  const message = e.message ?? String(err);
  const known = Object.keys(options).map((o) => `--${o}`);
  const quoted = /'([^']+)'/.exec(message)?.[1] ?? '';
  if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    const text = quoted.startsWith('--') ? undefined : splitArgv(args, options).positionals.find((t) => t.startsWith(quoted));
    if (text !== undefined && looksLikeText(text, known)) {
      return new LaneboardError('UNKNOWN_OPTION', `${JSON.stringify(text)} starts with "-", so it was read as an option; text that starts with "-" goes after --`, {
        fix: withTerminator(command, args, options, text),
      });
    }
    const option = text ?? quoted;
    const suggestion = suggestClosest(option.replace(/^-+/, '--').split('=')[0] ?? option, known);
    return new LaneboardError('UNKNOWN_OPTION', `unknown option ${option} for ${command}`, {
      allowed: known,
      input: suggestion ? { field: 'option', value: option, suggestion } : { field: 'option', value: option },
    });
  }
  const flag = /^--[^ ]+/.exec(quoted)?.[0];
  const at = flag === undefined ? -1 : args.findIndex((t, i) => t === flag && i < (args.includes('--') ? args.indexOf('--') : args.length));
  if (e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' && flag !== undefined && at >= 0) {
    const next = args[at + 1];
    const out = [...args];
    // `--status --as a`: the value is missing; `--description "- a"`: the value starts with "-" and needs `--name=value`.
    if (next === undefined || optionOf(next, options) !== undefined || next === '--') {
      out.splice(at + 1, 0, '<value>');
      return new LaneboardError('USAGE', `${flag} needs a value`, { fix: commandLine([command, ...out], new Set([at + 2])) });
    }
    out.splice(at, 2, `${flag}=${next}`);
    return new LaneboardError('USAGE', `the value of ${flag} starts with "-"; pass it as ${flag}=<value>`, { fix: commandLine([command, ...out]) });
  }
  return new LaneboardError('USAGE', message.split('\n')[0] ?? message);
}

interface OptionToken {
  kind: string;
  name?: string;
  index: number;
  value?: string;
  inlineValue?: boolean;
}

// Every option without `multiple` may appear once: `--status a --status b` is an error, not "last one wins".
export function rejectRepeated(tokens: readonly OptionToken[], command: string, args: readonly string[], options: OptionSpec): void {
  const seen = new Map<string, OptionToken[]>();
  for (const t of tokens) {
    if (t.kind !== 'option' || t.name === undefined || options[t.name]?.multiple) continue;
    seen.set(t.name, [...(seen.get(t.name) ?? []), t]);
  }
  for (const [name, list] of seen) {
    const [first, ...repeats] = list;
    if (!first || repeats.length === 0) continue;
    const values = [...new Set(list.map((t) => t.value).filter((v): v is string => v !== undefined))];
    const drop = new Set(repeats.flatMap((t) => (t.value !== undefined && !t.inlineValue ? [t.index, t.index + 1] : [t.index])));
    const kept = args.filter((_, i) => !drop.has(i));
    const placeholders = new Set<number>();
    if (values.length > 1) {
      // Different values: which one was meant is unknown, so the fix names them instead of guessing.
      const at = first.inlineValue ? first.index : first.index + 1;
      const pos = at - [...drop].filter((i) => i < at).length;
      const choice = `<one of: ${values.join(', ')}>`;
      kept[pos] = first.inlineValue ? `--${name}=${choice}` : choice;
      placeholders.add(pos + 1);
    }
    const shown = values.length ? ` (${values.map((v) => JSON.stringify(v)).join(', ')})` : '';
    throw new LaneboardError('USAGE', `--${name} is given ${list.length} times${shown}; pass it once`, { fix: commandLine([command, ...kept], placeholders) });
  }
}
