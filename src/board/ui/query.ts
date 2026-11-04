// Page state in the address (?board=&task=&view=&assignee=&label=&text=&q=) and the query strings of the API calls (no DOM, unit-tested).

export type PageView = 'board' | 'archive';

export interface PageState {
  // Tab key (board prefix); null = the board the server was started for.
  board: string | null;
  // The task open in the side panel.
  task: string | null;
  view: PageView;
  assignee: string | null;
  label: string | null;
  // Board text filter.
  text: string;
  // Archive search text.
  q: string;
}

export interface BoardFilters {
  assignee: string | null;
  label: string | null;
  text: string;
}

// A query value as a non-empty string, else null.
function value(params: URLSearchParams, name: string): string | null {
  const v = params.get(name);
  return v === null || v === '' ? null : v;
}

// Page state from location.search; unknown or empty values fall back to the defaults.
export function parseState(search: string): PageState {
  const p = new URLSearchParams(search);
  return {
    board: value(p, 'board'),
    task: value(p, 'task'),
    view: p.get('view') === 'archive' ? 'archive' : 'board',
    assignee: value(p, 'assignee'),
    label: value(p, 'label'),
    text: p.get('text') ?? '',
    q: p.get('q') ?? '',
  };
}

// A query string from the set (non-empty) values, in a fixed order; '' when nothing is set.
function build(entries: Array<[string, string | null | undefined]>): string {
  const p = new URLSearchParams();
  for (const [k, v] of entries) if (v !== null && v !== undefined && v !== '') p.append(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

// location.search for a page state (only what differs from the defaults).
export function stateSearch(s: PageState): string {
  return build([
    ['board', s.board],
    ['view', s.view === 'archive' ? 'archive' : null],
    ['assignee', s.assignee],
    ['label', s.label],
    ['text', s.text.trim()],
    ['q', s.view === 'archive' ? s.q.trim() : null],
    ['task', s.task],
  ]);
}

// Are any board filters set?
export function hasFilters(f: BoardFilters): boolean {
  return f.assignee !== null || f.label !== null || f.text.trim() !== '';
}

// GET /api/board query: the board's filters go to the core as they are (core taskMatches decides, not the UI).
export function boardQuery(board: string | null, f: BoardFilters): string {
  return build([
    ['board', board],
    ['assignee', f.assignee],
    ['label', f.label],
    ['text', f.text.trim()],
  ]);
}

// GET /api/tasks query for the rest of the final column (same filters as the board) or the archive search.
export function tasksQuery(board: string | null, q: { scope?: 'active' | 'archive'; status?: string; assignee?: string | null; label?: string | null; text?: string; limit: number; offset: number }): string {
  return build([
    ['board', board],
    ['scope', q.scope],
    ['status', q.status],
    ['assignee', q.assignee],
    ['label', q.label],
    ['text', q.text?.trim()],
    ['limit', String(q.limit)],
    ['offset', String(q.offset)],
  ]);
}

// GET /api/tasks/:id query.
export function taskQuery(board: string | null): string {
  return build([['board', board]]);
}

// GET /api/events query (EventSource cannot send headers, so the token rides in the query).
export function eventsQuery(board: string | null, token: string): string {
  return build([
    ['board', board],
    ['token', token],
  ]);
}

// Address of one attachment file for an <img> or a download link; the token rides in the query (neither can send a header).
export function attachmentHref(id: string, name: string, board: string | null, token: string): string {
  const query = build([
    ['board', board],
    ['token', token],
  ]);
  return `/api/tasks/${encodeURIComponent(id)}/attachments/${encodeURIComponent(name)}${query}`;
}

// The plain refresh of the board (ages, the stale mark, which the server decides by its clock without any write) every 60 s.
export const REFRESH_MS = 60_000;
// The shortest refresh the address may ask for (the e2e test does, so it does not wait a minute).
export const MIN_REFRESH_MS = 500;

// Refresh interval from the address: ?refresh_ms=<n> within MIN_REFRESH_MS…REFRESH_MS, else REFRESH_MS.
export function refreshInterval(search: string): number {
  const raw = new URLSearchParams(search).get('refresh_ms');
  const n = raw === null || !/^\d+$/.test(raw) ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(REFRESH_MS, Math.max(MIN_REFRESH_MS, n)) : REFRESH_MS;
}
