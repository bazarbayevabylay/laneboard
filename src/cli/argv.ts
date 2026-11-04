// Argv checks around node:util.parseArgs (`--` handling, text that starts with "-", repeated options) and every CLI fix: the one
// place where a fix is built from the user's argv (ADR-0001 §23).
import { ERRORS, LaneboardError, shellQuote, suggestClosest } from '../core/index.ts';
import type { FixEdit } from '../core/index.ts';
import type { OptionSpec } from './commands/types.ts';

// `laneboard <argv...>` with each token quoted, except placeholder tokens like `<name>`.
export function commandLine(argv: readonly string[], placeholders: ReadonlySet<number> = new Set()): string {
  return ['laneboard', ...argv.map((t, i) => (placeholders.has(i) ? t : shellQuote(t)))].join(' ');
}

// argv with extra option tokens inserted before `--` (after it they would be read as text).
function withOptions(argv: readonly string[], extra: readonly string[]): string[] {
  const end = argv.indexOf('--');
  return end < 0 ? [...argv, ...extra] : [...argv.slice(0, end), ...extra, ...argv.slice(end)];
}

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
function optionOf(token: string, options: OptionSpec): { name: string; inline: boolean; takesValue: boolean } | undefined {
  const long = /^--([^=]+)(=.*)?$/s.exec(token);
  const name = long ? long[1] : Object.keys(options).find((o) => token.length === 2 && options[o]?.short === token[1]);
  if (name === undefined || !Object.hasOwn(options, name)) return undefined;
  return { name, inline: long?.[2] !== undefined, takesValue: options[name]?.type === 'string' };
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
    // `--stauts` is a mistyped option; `--- section` or `-- note` is text that starts with "--".
    const optionLike = /^--[A-Za-z]/.test(quoted);
    const text = optionLike ? undefined : splitArgv(args, options).positionals.find((t) => t.startsWith(quoted));
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
  // `--json=1`: a flag that takes no value; the fix keeps the flag alone (once).
  const glued = flag === undefined ? -1 : args.findIndex((t) => t.startsWith(`${flag}=`));
  if (e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' && flag !== undefined && glued >= 0 && message.includes('does not take an argument')) {
    const out = [...args];
    if (args.includes(flag)) out.splice(glued, 1);
    else out[glued] = flag;
    return new LaneboardError('USAGE', `${flag} takes no value`, { fix: commandLine([command, ...out]) });
  }
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

// CLI option name of an op parameter: the command's own map (`confirm_id` -> `confirm`), else snake_case as kebab-case.
function optionName(name: string, flags: Readonly<Record<string, string>> | undefined): string {
  return (flags?.[name] ?? `--${name.replace(/_/g, '-')}`).replace(/^--/, '');
}

// Is this token a `<placeholder>` the user fills in (printed unquoted; `"<one line: ...>"` keeps its quotes)?
function isPlaceholder(token: string): boolean {
  return /^"?<[^<>]+>"?$/.test(token) || /^--[^=]+=<[^<>]+>$/.test(token);
}

// The user's own command changed by a FixEdit: options dropped, options and arguments added; a runnable fix, or one with `<placeholders>`.
export function editedCommand(argv: readonly string[], edit: FixEdit, options: OptionSpec, flags?: Readonly<Record<string, string>>): string {
  const [command = '', ...args] = argv;
  const drop = (edit.drop ?? []).map((d) => ({ option: optionName(d.name, flags), value: d.value }));
  const end = args.indexOf('--');
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? '';
    const spec = end >= 0 && i >= end ? undefined : optionOf(token, options);
    if (!spec) {
      kept.push(token);
      continue;
    }
    const hasNext = spec.takesValue && !spec.inline && i + 1 < args.length;
    const value = spec.inline ? token.slice(token.indexOf('=') + 1) : hasNext ? args[i + 1] : undefined;
    if (drop.some((d) => d.option === spec.name && (d.value === undefined || d.value === value))) {
      if (hasNext) i++;
      continue;
    }
    kept.push(token);
    if (hasNext) kept.push(args[++i] ?? '');
  }
  const extra = (edit.add ?? []).flatMap((a) => [`--${optionName(a.name, flags)}`, a.value]);
  const out = [command, ...withOptions(kept, extra), ...(edit.args ?? [])];
  const line = commandLine(out, new Set(out.flatMap((t, i) => (isPlaceholder(t) && !argv.includes(t) ? [i] : []))));
  return edit.env === undefined ? line : `${edit.env} ${line}`;
}

// Positional names of a usage line, like `<id>`, `<text>` (`comment <id> (<text> | --file P|-)`); the first form only.
function usageArgs(usage: string): string[] {
  const first = usage.split('  |  ')[0] ?? usage;
  return first
    .split(' ')
    .slice(1)
    .map((t) => t.replace(/^\(/, '').replace(/\.\.\.$/, ''))
    .filter((t) => /^<[^<>]+>$/.test(t));
}

interface ArgvToken {
  kind: string;
  name?: string;
  index: number;
}

// A wrong number of arguments: the missing ones as placeholders at the end, or the extra words joined into the text (title, text) or dropped;
// options the command cannot run without (`required`, like create's `--status <first status>`) are added when absent, so one fix runs.
export function argumentsFix(
  command: string,
  args: readonly string[],
  tokens: readonly ArgvToken[],
  usage: string,
  count: { min: number; max: number },
  required: ReadonlyArray<{ name: string; value: string }> = [],
): string {
  const names = usageArgs(usage);
  const at = tokens.filter((t) => t.kind === 'positional').map((t) => t.index);
  const added = required.filter((r) => !tokens.some((t) => t.kind === 'option' && t.name === r.name)).flatMap((r) => [`--${r.name}`, r.value]);
  let out: string[];
  if (at.length < count.min) {
    out = [command, ...withOptions(args, added), ...names.slice(at.length, count.min)];
  } else {
    // Extra words: an unquoted title or text (`create Fix login --status todo`) becomes one argument; anything else is dropped.
    const extra = at.slice(count.max);
    const joined = [...args];
    if (['<title>', '<text>'].includes(names[count.max - 1] ?? '')) {
      const first = at[count.max - 1] ?? 0;
      joined[first] = [first, ...extra].map((i) => args[i]).join(' ');
    }
    out = [command, ...withOptions(joined.filter((_, i) => !extra.includes(i)), added)];
  }
  return commandLine(out, new Set(out.flatMap((t, i) => (isPlaceholder(t) && !args.includes(t) ? [i] : []))));
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

// Replace the offending value in argv with the suggestion, else a format or `allowed` placeholder.
function replaceValue(argv: readonly string[], err: LaneboardError): string | undefined {
  const input = err.input;
  if (!input) return undefined;
  const replacement = input.suggestion ?? input.format ?? (err.allowed?.length ? `<${input.field} from allowed>` : undefined);
  if (replacement === undefined) return undefined;
  const value = input.value;
  // The value is a whole token, the tail of `--flag=value`, or the key of `key=value` (`--field priorty=1`).
  const rewrite = (token: string): string | undefined => {
    if (token === value) return replacement;
    if (token.endsWith(`=${value}`)) return `${token.slice(0, token.length - value.length)}${replacement}`;
    if (token.startsWith(`${value}=`)) return `${replacement}${token.slice(value.length)}`;
    const inner = new RegExp(`^(--[^=]+=)${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(=.*)$`, 's').exec(token);
    return inner ? `${inner[1] ?? ''}${replacement}${inner[2] ?? ''}` : undefined;
  };
  const flag = `--${input.field.replace(/_/g, '-')}`;
  const hits: number[] = [];
  argv.forEach((token, i) => {
    if (rewrite(token) !== undefined) hits.push(i);
  });
  const index = hits.length === 1 ? hits[0] : hits.find((i) => argv[i - 1] === flag || argv[i]?.startsWith(`${flag}=`));
  if (index === undefined) return undefined;
  const out = [...argv];
  out[index] = rewrite(out[index] ?? '') ?? replacement;
  const placeholders = input.suggestion === undefined ? new Set([index]) : new Set<number>();
  return commandLine(out, placeholders);
}

// Options that init derives or requires: when the value came from elsewhere (a derived prefix, a missing description), the fix adds the option.
const ADDABLE_OPTIONS = new Set(['prefix', 'description']);

// The edit a fix applies when the error has none of its own: add an init option that is not in argv yet, or `--as <your-name>`.
function derivedEdit(argv: readonly string[], err: LaneboardError): FixEdit | undefined {
  const input = err.input;
  if (input && ADDABLE_OPTIONS.has(input.field) && !argv.some((t) => t === `--${input.field}` || t.startsWith(`--${input.field}=`))) {
    const value = input.suggestion ?? input.format;
    return value === undefined ? undefined : { add: [{ name: input.field, value }] };
  }
  // Only the command, so it can be run as given; the LANEBOARD_AGENT alternative is in the CLI message (format.ts cliMessage).
  return err.code === 'ACTOR_REQUIRED' ? { add: [{ name: 'as', value: '<your-name>' }] } : undefined;
}

// The command a fix starts from when the command name is missing or not first: that name moved first, else `prime` (the agent's start).
export function commandFirst(argv: readonly string[], isCommand: (token: string) => boolean): string {
  const at = argv.findIndex(isCommand);
  return commandLine(at < 0 ? ['prime', ...argv] : [argv[at] ?? '', ...argv.filter((_, i) => i !== at)]);
}

// The fix shown to a CLI user: the user's command changed by the error's edit, with the bad value replaced, or with a derived option
// added; else the usage line (a USAGE without an edit), else the core fix.
export function cliFix(
  err: LaneboardError,
  argv: readonly string[],
  command: { name: string; usage: string; flags?: Readonly<Record<string, string>> } | undefined,
  options: OptionSpec,
): string {
  if (err.edit && command) return editedCommand(argv, err.edit, options, command.flags);
  const replaced = replaceValue(argv, err);
  if (replaced) return replaced;
  const edit = derivedEdit(argv, err);
  if (edit) return editedCommand(argv, edit, options, command?.flags);
  if ((err.code === 'USAGE' || err.code === 'UNKNOWN_OPTION') && err.fix === ERRORS[err.code].fix) {
    return command ? `laneboard ${command.usage}` : 'laneboard <command from allowed> [options]';
  }
  return command ? err.fix.replace('<command>', command.name) : err.fix;
}
