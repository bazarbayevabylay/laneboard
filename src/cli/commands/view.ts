// laneboard view: the board as a kanban for people in a terminal (agents use list --json).
import { LaneboardError, shellQuote, toLaneboardError, viewBoard, watchStore } from '../../core/index.ts';
import type { OpContext, ViewInputT } from '../../core/index.ts';
import { DEFAULT_WIDTH, renderBoard } from '../board-view.ts';
import { errorText } from '../format.ts';
import { flag, list as many, str } from './args.ts';
import type { CliIo, CommandDef, Values } from './types.ts';

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
    // One frame: the board, or the error of a store being repaired or replaced (that must not end the watch).
    const draw = async (first: boolean): Promise<void> => {
      let frame: string;
      try {
        frame = (await render()).human;
      } catch (raw) {
        const err = toLaneboardError(raw);
        frame = errorText(err, err.fix).trimEnd();
      }
      c.io.stdout(`${c.io.isTTY ? CLEAR : first ? '' : '\n'}${frame}\n`);
    };
    await draw(true);
    await watchStore(ctx.store.dir, () => draw(false), { signal: c.io.signal, pollMs: c.io.watchPollMs, events: c.io.watchNoEvents !== true });
    return { data: null, warnings: [], human: '', silent: true };
  },
};
