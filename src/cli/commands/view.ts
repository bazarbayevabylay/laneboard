// laneboard view: the board as a kanban for people in a terminal (agents use list --json).
import fs from 'node:fs';
import path from 'node:path';
import { LaneboardError, shellQuote, toLaneboardError, viewBoard } from '../../core/index.ts';
import type { OpContext, ViewInputT } from '../../core/index.ts';
import { DEFAULT_WIDTH, renderBoard } from '../board-view.ts';
import { errorText } from '../format.ts';
import { flag, list as many, str } from './args.ts';
import type { CliIo, CommandDef, Values } from './types.ts';

// Fallback poll for --watch when fs.watch misses an event (network drives, some editors): every 2 s.
const POLL_MS = 2000;
// fs.watch reports one write as several events: render once after they settle.
const DEBOUNCE_MS = 100;
const CLEAR = '\u001b[H\u001b[2J';

// Terminal width: COLUMNS, else the terminal's own, else DEFAULT_WIDTH.
function terminalWidth(io: CliIo): number {
  const fromEnv = Number(io.env.COLUMNS);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  return io.columns && io.columns > 0 ? io.columns : DEFAULT_WIDTH;
}

// Colors only on a terminal, and never with NO_COLOR set to anything (no-color.org).
function useColor(io: CliIo): boolean {
  return io.isTTY === true && !io.env.NO_COLOR;
}

// What changes when the store is written: size, mtime and inode of its files (an atomic write renames a new inode in).
function signature(storeDir: string): string {
  return ['active.json', 'config.json']
    .map((f) => {
      try {
        const st = fs.statSync(path.join(storeDir, f));
        return `${st.ino}:${st.size}:${st.mtimeMs}`;
      } catch {
        // A file missing for a moment (or for good) is part of the signature too.
        return 'missing';
      }
    })
    .join('|');
}

// Wait until the store changes (fs.watch, with a poll as the safety net) or the signal is aborted; true = changed.
function nextChange(storeDir: string, signal: AbortSignal | undefined, pollMs: number, events: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const before = signature(storeDir);
    let timer: NodeJS.Timeout | undefined;
    let watcher: fs.FSWatcher | undefined;
    const done = (changed: boolean): void => {
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      watcher?.close();
      signal?.removeEventListener('abort', onAbort);
      resolve(changed);
    };
    const onAbort = (): void => done(false);
    const check = (): void => {
      if (signature(storeDir) !== before) done(true);
    };
    const poll = setInterval(check, pollMs);
    try {
      if (events) {
        watcher = fs.watch(storeDir, () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(check, DEBOUNCE_MS);
        });
        // A watcher that fails later (the directory went away) leaves the poll in charge.
        watcher.on('error', () => watcher?.close());
      }
    } catch {
      // fs.watch is not available here: the poll alone notices changes.
      watcher = undefined;
    }
    signal?.addEventListener('abort', onAbort);
  });
}

// The view's filters and board as options of `laneboard list`, for the command under the final column: --dir as the resolved store
// (copyable from any folder), --board as given (review S4 MINOR).
function viewListOptions(input: ViewInputT, values: Values, storeDir: string): string {
  const parts = [
    ...(input.assignee !== undefined ? [`--assignee ${shellQuote(input.assignee)}`] : []),
    ...(input.labels ?? []).map((l) => `--label ${shellQuote(l)}`),
    ...(input.text !== undefined ? [`--text ${shellQuote(input.text)}`] : []),
    ...(typeof values.dir === 'string' ? [`--dir ${shellQuote(storeDir)}`] : []),
    ...(typeof values.board === 'string' ? [`--board ${shellQuote(values.board)}`] : []),
  ];
  return parts.map((part) => ` ${part}`).join('');
}

export const view: CommandDef = {
  name: 'view',
  usage: 'view [--assignee A] [--label L]... [--text Q] [--watch] [--board <prefix|name|path>]',
  summary:
    'Show the board as columns by status (id, title, assignee, time in status); a list grouped by status in a narrow terminal. ' +
    '--watch redraws on every change until Ctrl+C. --board opens another board of this machine read-only (laneboard boards).',
  options: { assignee: { type: 'string' }, label: { type: 'string', multiple: true }, text: { type: 'string' }, watch: { type: 'boolean' } },
  args: { min: 0, max: 0 },
  readOnly: true,
  async run(c) {
    const watch = flag(c.values, 'watch');
    // With --json the fix keeps --json and drops --watch (ADR-0001 §23).
    if (watch && c.values.json === true) throw new LaneboardError('USAGE', '--watch redraws the board for people; it cannot be combined with --json', { edit: { drop: [{ name: 'watch' }] } });
    const input: ViewInputT = { assignee: str(c.values, 'assignee'), labels: many(c.values, 'label'), text: str(c.values, 'text') };
    const filters = [
      ...(input.assignee ? [`assignee=${input.assignee}`] : []),
      ...(input.labels ?? []).map((l) => `label=${l}`),
      ...(input.text ? [`text=${input.text}`] : []),
    ];
    const ctx: OpContext = c.op();
    const listOptions = viewListOptions(input, c.values, ctx.store.dir);
    const render = async (): Promise<{ data: unknown; warnings: string[]; human: string }> => {
      const r = await viewBoard(ctx, input);
      const human = renderBoard(r.data, { width: terminalWidth(c.io), color: useColor(c.io), now: new Date(), store: ctx.store.dir, filters, listOptions, watching: watch });
      return { data: r.data, warnings: r.warnings, human };
    };
    if (!watch) return render();
    const signal = c.io.signal;
    for (let first = true; ; first = false) {
      let frame: string;
      try {
        frame = (await render()).human;
      } catch (raw) {
        // A store being repaired or replaced must not end the watch: show the error and wait for the next change.
        const err = toLaneboardError(raw);
        frame = errorText(err, err.fix).trimEnd();
      }
      c.io.stdout(`${c.io.isTTY ? CLEAR : first ? '' : '\n'}${frame}\n`);
      if (!(await nextChange(ctx.store.dir, signal, c.io.watchPollMs ?? POLL_MS, c.io.watchNoEvents !== true))) break;
    }
    return { data: null, warnings: [], human: '', silent: true };
  },
};
