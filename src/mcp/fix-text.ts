// CLI commands in the texts an MCP caller gets (error fix, warnings) as tool calls (LB-60.1): the core writes its fixes for the CLI
// (`laneboard comment LB-1 "<note>" --as dev-1 --json`), an MCP client has no shell, so each command of a task tool becomes the tool
// with its parameters (`task_comment {"id":"LB-1","text":"<note>","actor":"dev-1"}`), `&&` between two of them `, then`. A command
// the tools cannot run (no tool: boards, init, config, doctor; an option no tool has: --dir, --board, --file) stays as it is.

// How one CLI option becomes a tool parameter: a string, an integer (a placeholder stays a string), a flag (true), a flag that clears
// a parameter (null), a repeated value (list), a link `kind=ref` ({kind, ref} in a list), a field `key=value` ({key: value}), or dropped.
type Kind = 'string' | 'int' | 'true' | 'null' | 'list' | 'link' | 'field' | 'drop';

interface CommandSpec {
  tool: string;
  // Parameter names of the positional arguments, in order; `rest`: every further positional goes to this list parameter (archive ids).
  args: string[];
  rest?: string;
  options: Record<string, [param: string, kind: Kind]>;
}

// Options every task command takes: --as is the actor, --json is the MCP reply anyway, --full the same parameter.
const COMMON: Record<string, [string, Kind]> = { as: ['actor', 'string'], json: ['', 'drop'], full: ['full', 'true'] };

// The CLI commands that have a tool, with the options their tool takes (the CLI's own option names, see src/cli/commands).
const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  prime: { tool: 'task_prime', args: [], options: {} },
  create: {
    tool: 'task_create',
    args: ['title'],
    options: {
      status: ['status', 'string'],
      description: ['description', 'string'],
      assignee: ['assignee', 'string'],
      parent: ['parent', 'string'],
      label: ['labels', 'list'],
      link: ['links', 'link'],
      field: ['fields', 'field'],
    },
  },
  claim: { tool: 'task_claim', args: ['id'], options: { status: ['status', 'string'], 'expected-rev': ['expected_rev', 'int'], resume: ['resume', 'true'] } },
  comment: { tool: 'task_comment', args: ['id', 'text'], options: {} },
  finish: {
    tool: 'task_finish',
    args: ['id'],
    options: { result: ['result', 'string'], status: ['status', 'string'], commit: ['commit', 'string'], 'no-commit': ['no_commit', 'true'], 'add-link': ['add_links', 'link'] },
  },
  get: { tool: 'task_get', args: ['id'], options: { events: ['events', 'int'] } },
  list: {
    tool: 'task_list',
    args: [],
    options: {
      status: ['status', 'list'],
      assignee: ['assignee', 'string'],
      unassigned: ['unassigned', 'true'],
      'sessions-of': ['sessions_of', 'string'],
      label: ['labels', 'list'],
      text: ['text', 'string'],
      parent: ['parent', 'string'],
      'all-boards': ['all_boards', 'true'],
      open: ['open', 'true'],
      scope: ['scope', 'string'],
      limit: ['limit', 'int'],
      offset: ['offset', 'int'],
    },
  },
  update: {
    tool: 'task_update',
    args: ['id'],
    options: {
      title: ['title', 'string'],
      description: ['description', 'string'],
      'append-description': ['append_description', 'string'],
      status: ['status', 'string'],
      assignee: ['assignee', 'string'],
      unassign: ['assignee', 'null'],
      parent: ['parent', 'string'],
      'no-parent': ['parent', 'null'],
      'add-label': ['add_labels', 'list'],
      'remove-label': ['remove_labels', 'list'],
      'add-link': ['add_links', 'link'],
      'remove-link': ['remove_links', 'link'],
      field: ['fields', 'field'],
      'unset-field': ['unset_fields', 'list'],
      'expected-rev': ['expected_rev', 'int'],
    },
  },
  attach: { tool: 'task_attach', args: ['id', 'path'], options: { name: ['name', 'string'], remove: ['remove', 'string'] } },
  archive: {
    tool: 'task_archive',
    args: [],
    rest: 'ids',
    options: { 'expected-rev': ['expected_rev', 'int'], status: ['status', 'string'], 'updated-before': ['updated_before', 'string'], 'dry-run': ['dry_run', 'true'] },
  },
  restore: { tool: 'task_restore', args: ['id'], options: {} },
  events: { tool: 'task_events', args: [], options: { task: ['task', 'string'], since: ['since', 'string'], limit: ['limit', 'int'], scope: ['scope', 'string'] } },
};

// Punctuation of the sentence right after a command (`(laneboard get LB-1), then`): not part of its last argument.
const SENTENCE_END = /[;,).:]+$/;

// One shell word of a command: its value (quotes removed), whether it was written as a bare option (`--x`), and where it ends;
// `tail`: sentence punctuation after it that ends the command.
interface Word {
  value: string;
  option: boolean;
  end: number;
  tail: string;
}

// Read the shell word at `start` (after spaces): bare text, '…' (with the '\'' escape shellQuote writes), "…", and <placeholder with
// spaces> as one word. undefined at the end of the text or at `&&`.
function readWord(text: string, start: number): Word | undefined {
  let i = start;
  while (text[i] === ' ') i++;
  if (i >= text.length || text.startsWith('&&', i)) return undefined;
  let value = '';
  let bare = '';
  let quoted = false;
  while (i < text.length && text[i] !== ' ') {
    const c = text[i] ?? '';
    const close = c === "'" ? "'" : c === '"' ? '"' : c === '<' ? '>' : undefined;
    const end = close === undefined ? -1 : text.indexOf(close, i + 1);
    if (close !== undefined && end > i) {
      value += c === '<' ? text.slice(i, end + 1) : text.slice(i + 1, end);
      bare = '';
      quoted = quoted || c !== '<';
      i = end + 1;
      continue;
    }
    if (c === '\\' && i + 1 < text.length) {
      value += text[i + 1];
      bare = '';
      i += 2;
      continue;
    }
    value += c;
    bare += c;
    i++;
  }
  // Only bare punctuation at the very end belongs to the sentence ("LB-1)," in "(laneboard get LB-1), then").
  const tail = SENTENCE_END.exec(bare)?.[0] ?? '';
  const raw = value.slice(0, value.length - tail.length);
  return { value: raw, option: !quoted && raw.startsWith('--'), end: i - tail.length, tail };
}

// The value of a link option `kind=ref`, as the tools take it.
function linkValue(value: string): { kind: string; ref: string } | undefined {
  const at = value.indexOf('=');
  return at > 0 ? { kind: value.slice(0, at), ref: value.slice(at + 1) } : undefined;
}

// Put one option value into the parameters; false when it cannot be put (the command stays CLI text).
function setOption(params: Record<string, unknown>, param: string, kind: Kind, value: string | undefined): boolean {
  if (kind === 'drop') return true;
  if (kind === 'true' || kind === 'null') {
    params[param] = kind === 'true' ? true : null;
    return true;
  }
  if (value === undefined) return false;
  if (kind === 'string') params[param] = value;
  if (kind === 'int') params[param] = /^\d+$/.test(value) ? Number(value) : value;
  if (kind === 'list' || kind === 'link') {
    const item = kind === 'link' ? linkValue(value) : value;
    if (item === undefined) return false;
    params[param] = [...((params[param] as unknown[] | undefined) ?? []), item];
  }
  if (kind === 'field') {
    const at = value.indexOf('=');
    if (at <= 0) return false;
    const raw = value.slice(at + 1);
    params[param] = { ...((params[param] as Record<string, unknown> | undefined) ?? {}), [value.slice(0, at)]: /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw };
  }
  return true;
}

// The tool call for the CLI command whose words start at `start` (right after `laneboard <command>`): the call text and where the
// command ends in `text`; undefined when the tools cannot run it.
function toolCall(text: string, start: number, spec: CommandSpec): { call: string; end: number } | undefined {
  const params: Record<string, unknown> = {};
  const options = { ...COMMON, ...spec.options };
  let positional = 0;
  let afterDashes = false;
  let end = start;
  for (;;) {
    const word = readWord(text, end);
    if (word === undefined) break;
    let tail = word.tail;
    if (word.option && !afterDashes) {
      if (word.value === '--') {
        afterDashes = true;
        end = word.end;
        if (tail) break;
        continue;
      }
      const eq = word.value.indexOf('=');
      const name = word.value.slice(2, eq === -1 ? undefined : eq);
      const known = Object.hasOwn(options, name) ? options[name] : undefined;
      if (known === undefined) return undefined;
      const [param, kind] = known;
      let value: string | undefined = eq === -1 ? undefined : word.value.slice(eq + 1);
      end = word.end;
      if (value === undefined && kind !== 'true' && kind !== 'null' && kind !== 'drop' && !tail) {
        const next = readWord(text, end);
        value = next?.value;
        if (next !== undefined) {
          end = next.end;
          tail = next.tail;
        }
      }
      if (!setOption(params, param, kind, value)) return undefined;
    } else {
      const name = spec.args[positional] ?? spec.rest;
      // A word after the last argument is the sentence again ("run laneboard finish LB-1 again").
      if (name === undefined) break;
      if (positional < spec.args.length) params[name] = word.value;
      else params[name] = [...((params[name] as string[] | undefined) ?? []), word.value];
      positional++;
      end = word.end;
    }
    if (tail) break;
  }
  const call = Object.keys(params).length === 0 ? spec.tool : `${spec.tool} ${JSON.stringify(params)}`;
  return { call, end };
}

// A CLI command at the start of `text.slice(at)`: `laneboard <command>` of a command with a tool.
const COMMAND_RE = /laneboard ([a-z]+)\b/g;

// The text with each CLI command of a task tool as its tool call (see the file comment); every other word as it is.
export function mcpText(text: string): string {
  let out = '';
  let from = 0;
  // Where the previous tool call ended, for `&&` between two of them.
  let lastCall = -1;
  COMMAND_RE.lastIndex = 0;
  for (let m = COMMAND_RE.exec(text); m !== null; m = COMMAND_RE.exec(text)) {
    const spec = Object.hasOwn(COMMANDS, m[1] ?? '') ? COMMANDS[m[1] ?? ''] : undefined;
    const done = spec === undefined ? undefined : toolCall(text, m.index + m[0].length, spec);
    if (done === undefined) continue;
    const between = text.slice(from, m.index);
    out += lastCall === from && /^\s*&&\s*$/.test(between) ? ', then ' : between;
    out += done.call;
    from = done.end;
    lastCall = done.end;
    COMMAND_RE.lastIndex = done.end;
  }
  return out + text.slice(from);
}
