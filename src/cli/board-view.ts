// Human views of boards for people in a terminal: the kanban of `laneboard view` and the table of `laneboard boards`.
// Plain text by default; ANSI styles only on a terminal without NO_COLOR (no-color.org).
import type { BoardInfo, BoardsResult, ViewCard, ViewResult } from '../core/index.ts';

// Narrowest column that still shows an id and a few words; below it the board becomes a list grouped by status.
export const MIN_COLUMN = 18;
const GAP = '  ';
// Width used when stdout is not a terminal and COLUMNS is not set.
export const DEFAULT_WIDTH = 100;

export interface RenderOptions {
  width: number;
  color: boolean;
  // Current time, for "how long in this status".
  now: Date;
  // Store directory shown in the header.
  store: string;
  // Filters in use, shown in the footer.
  filters: string[];
  watching?: boolean;
}

type Style = 'bold' | 'id' | 'dim';
const CODES: Record<Style, string> = { bold: '\u001b[1m', id: '\u001b[36m', dim: '\u001b[2m' };
const RESET = '\u001b[0m';

// A piece of text with an optional style (styles never change the width).
interface Piece {
  text: string;
  style?: Style;
}

// Length in code points (what a terminal shows for the Latin and Cyrillic text of titles).
function width(text: string): number {
  return [...text].length;
}

// `text` cut to `room` code points, with an ellipsis when cut.
export function fit(text: string, room: number): string {
  const chars = [...text];
  if (chars.length <= room) return text;
  return `${chars.slice(0, Math.max(0, room - 1)).join('')}…`;
}

// Pieces cut to `room` columns in total.
function fitPieces(pieces: Piece[], room: number): Piece[] {
  const out: Piece[] = [];
  let left = room;
  const total = pieces.reduce((n, p) => n + width(p.text), 0);
  if (total <= room) return pieces;
  for (const p of pieces) {
    if (left <= 0) break;
    const w = width(p.text);
    if (w < left) {
      out.push(p);
      left -= w;
      continue;
    }
    out.push({ ...p, text: fit(p.text, left) });
    left = 0;
  }
  return out;
}

// Pieces as one string, padded with spaces to `pad` columns (styles applied when `color`).
function paint(pieces: Piece[], color: boolean, pad = 0): string {
  const used = pieces.reduce((n, p) => n + width(p.text), 0);
  const body = pieces.map((p) => (color && p.style && p.text ? `${CODES[p.style]}${p.text}${RESET}` : p.text)).join('');
  return body + ' '.repeat(Math.max(0, pad - used));
}

// How long ago, short: <1m, 12m, 5h, 3d.
export function age(since: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - Date.parse(since));
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// The id and the first words of the title on one line, the rest of the title on a second line (cut when longer).
function titleLines(card: ViewCard, room: number): Piece[][] {
  const head = `${card.id} `;
  const words = card.title.split(' ');
  let first = '';
  while (words.length && width(head) + width(first ? `${first} ${words[0]}` : (words[0] ?? '')) <= room) first = first ? `${first} ${words.shift()}` : (words.shift() ?? '');
  const rest = words.join(' ');
  if (!first) return [fitPieces([{ text: head, style: 'id' }, { text: card.title }], room)];
  const lines: Piece[][] = [[{ text: head, style: 'id' }, { text: first }]];
  if (rest) lines.push([{ text: fit(`  ${rest}`, room) }]);
  return lines;
}

// Who has the card and for how long it has been in this status; the time comes first, so a long name cut short keeps it.
function holder(card: ViewCard, now: Date): string {
  return `${age(card.status_since, now)} · ${card.assignee ?? 'unassigned'}`;
}

// Lines of one card: id and title, then the time in status and who has it.
function cardLines(card: ViewCard, room: number, now: Date): Piece[][] {
  return [...titleLines(card, room), [{ text: fit(`  ${holder(card, now)}`, room), style: 'dim' }]];
}

// Column title: status (count); a status no longer in config is marked with "?".
function columnTitle(c: ViewResult['columns'][number]): string {
  return `${c.status}${c.known ? '' : '?'} (${c.cards.length})`;
}

// Header: board name, prefix and description, then where it is.
function header(d: ViewResult, o: RenderOptions): string[] {
  const title: Piece[] = [{ text: d.name ?? 'board', style: 'bold' }, { text: ` (prefix ${d.prefix})` }];
  if (d.description) title.push({ text: ` - ${d.description}` });
  // The path is never cut: a cut path cannot be copied.
  return [paint(fitPieces(title, o.width), o.color), paint([{ text: o.store, style: 'dim' }], o.color)];
}

// Footer: how many tasks are shown, the filters, and how to leave watch mode.
function footer(d: ViewResult, o: RenderOptions): string {
  const count = o.filters.length ? `${d.shown} of ${d.total} active tasks shown (${o.filters.join(', ')})` : `${d.total} active tasks`;
  return fit(o.watching ? `${count} · watching for changes, Ctrl+C to exit` : count, o.width);
}

// The kanban: one column per status side by side, or a list grouped by status when the terminal is too narrow.
export function renderBoard(d: ViewResult, o: RenderOptions): string {
  const n = d.columns.length;
  const columnWidth = Math.floor((o.width - GAP.length * (n - 1)) / n);
  const lines = [...header(d, o), ''];
  if (columnWidth < MIN_COLUMN) {
    for (const c of d.columns) {
      lines.push(paint([{ text: fit(columnTitle(c), o.width), style: 'bold' }], o.color));
      for (const card of c.cards) {
        // Time and holder come before the title, so cutting a long title keeps them.
        lines.push(paint(fitPieces([{ text: '  ' }, { text: card.id, style: 'id' }, { text: `  ${holder(card, o.now)}`, style: 'dim' }, { text: `  ${card.title}` }], o.width), o.color));
      }
    }
  } else {
    const columns = d.columns.map((c) => {
      const body: Piece[][] = [];
      c.cards.forEach((card, i) => {
        if (i > 0) body.push([]);
        body.push(...cardLines(card, columnWidth, o.now));
      });
      return [[{ text: fit(columnTitle(c), columnWidth), style: 'bold' as Style }], [{ text: '-'.repeat(columnWidth) }], ...body];
    });
    const rows = Math.max(...columns.map((c) => c.length));
    for (let r = 0; r < rows; r++) {
      const cells = columns.map((c, i) => paint(c[r] ?? [], o.color, i === n - 1 ? 0 : columnWidth));
      lines.push(cells.join(GAP).trimEnd());
    }
  }
  lines.push('', footer(d, o));
  return lines.join('\n');
}

// Tasks per status of one board, short: `todo 2, done 1`.
function counts(b: BoardInfo): string {
  if (b.missing) return 'missing (no store at this path)';
  if (b.problem) return `unreadable: ${b.problem}`;
  const parts = b.counts.filter((c) => c.count > 0).map((c) => `${c.status} ${c.count}`);
  return parts.length ? parts.join(', ') : 'no active tasks';
}

// `laneboard boards`: one row per board (prefix, name, tasks per status, last change, path) and its description under it.
export function boardsText(r: BoardsResult): string {
  if (!r.boards.length) return `no boards registered in ${r.registry} yet (laneboard init and laneboard setup add them)`;
  const rows = [['PREFIX', 'NAME', 'TASKS', 'UPDATED', 'PATH'], ...r.boards.map((b) => [b.prefix, b.name ?? '-', counts(b), b.updated_at ?? '-', b.path])];
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((row) => width(row[i] ?? '')))) ?? [];
  const line = (row: string[]): string => row.map((cell, i) => (i === row.length - 1 ? cell : cell + ' '.repeat((widths[i] ?? 0) - width(cell)))).join('  ');
  const out = [line(rows[0] ?? [])];
  r.boards.forEach((b, i) => {
    out.push(line(rows[i + 1] ?? []));
    out.push(`  ${b.description ?? '(no description: laneboard config --description "<whose project, what work>" in that project)'}`);
  });
  return out.join('\n');
}
