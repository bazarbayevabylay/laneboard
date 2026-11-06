// Read-only JSON API of the web board (ADR-0001 §31): every route calls a core read op on a read-only store reference,
// answers with the CLI envelope {ok, store, prefix, data, warnings} and maps errors to their registry HTTP status.
import path from 'node:path';
import { DEFAULT_LIST_LIMIT, ERRORS, LaneboardError, getTask, listBoards, listTasks, loadConfig, samePath, storePrefix, toErrorObject, toLaneboardError, viewBoard } from '../../core/index.ts';
import type { BoardInfo, ListItem, StoreRef, ViewResult } from '../../core/index.ts';

// One tab of the web board: the board the command was started for comes first, then the other boards of the registry.
export interface BoardTab {
  // What the UI passes back as ?board= (the prefix: unique among live boards of a machine).
  key: string;
  prefix: string;
  name: string | null;
  description: string | null;
  path: string;
  current: boolean;
  // No store at this path any more, or a store that cannot be read: the tab is shown, not opened.
  missing: boolean;
  problem: string | null;
  // Tasks not in the final status (the CLI's "active tasks").
  active: number;
}

export interface ApiReply {
  status: number;
  body: unknown;
}

export interface ApiContext {
  // Home directory of the board registry; without it the tabs are the current board only.
  home?: string;
  // The board the server was started for (own board or --board), opened read-only.
  current: StoreRef;
}

// Active tasks of a readable board by the same rule as `laneboard view` (viewBoard's total: not in the final status).
async function activeTasks(dir: string): Promise<number> {
  return (await viewBoard({ store: { dir, found: 'board', readOnly: true } }, {})).data.total;
}

// A registry entry as a tab (its active count is filled in by boardTabs).
function tabOf(info: BoardInfo): BoardTab {
  return {
    key: info.prefix,
    prefix: info.prefix,
    name: info.name,
    description: info.description,
    path: info.path,
    current: false,
    missing: info.missing || info.problem !== null,
    problem: info.problem,
    active: 0,
  };
}

// The current board as a tab, from its own config (it may be missing from the registry, or there may be no HOME);
// a config that cannot be read makes it an unreadable tab instead of failing every request.
function currentTab(ref: StoreRef): BoardTab {
  try {
    const config = loadConfig(ref.dir);
    return { key: config.prefix, prefix: config.prefix, name: config.name ?? null, description: config.description ?? null, path: ref.dir, current: true, missing: false, problem: null, active: 0 };
  } catch (err) {
    // Broken config.json: the tab says why; the routes on this board answer with the core error.
    const prefix = storePrefix(ref.dir) ?? path.basename(path.dirname(ref.dir));
    return { key: prefix, prefix, name: null, description: null, path: ref.dir, current: true, missing: true, problem: toLaneboardError(err).message, active: 0 };
  }
}

// Tabs without counts: the current board first, then every other board of the registry once by prefix (a live board wins over a
// dead path). A broken registry leaves the current board only, and says why (`problem`).
async function tabList(ctx: ApiContext): Promise<{ tabs: BoardTab[]; problem: string | null }> {
  const tabs = [currentTab(ctx.current)];
  if (!ctx.home) return { tabs, problem: null };
  let registry: BoardInfo[];
  try {
    registry = (await listBoards(ctx.home)).data.boards;
  } catch (err) {
    // boards.json that cannot be read must not take the started board down with it.
    return { tabs, problem: toLaneboardError(err).message };
  }
  const others = registry.filter((b) => !samePath(b.path, ctx.current.dir));
  const isLive = (b: BoardInfo): boolean => !b.missing && b.problem === null;
  // A dead path never takes the key of a live board with the same prefix (a dead path frees its prefix); order stays the registry's.
  const livePrefixes = new Set([...tabs.map((t) => t.key), ...others.filter(isLive).map((b) => b.prefix)]);
  for (const b of others) {
    if (tabs.some((t) => t.key === b.prefix)) continue;
    if (!isLive(b) && livePrefixes.has(b.prefix)) continue;
    tabs.push(tabOf(b));
  }
  return { tabs, problem: null };
}

// Tabs with their active counts; a board whose store cannot be read (the started one too) becomes an unreadable tab with the reason.
export async function boardTabs(ctx: ApiContext): Promise<{ tabs: BoardTab[]; problem: string | null }> {
  const { tabs, problem } = await tabList(ctx);
  for (const tab of tabs) {
    if (tab.missing) continue;
    try {
      tab.active = await activeTasks(tab.path);
    } catch (err) {
      // A broken active.json of one board must not fail the tabs of the others.
      tab.missing = true;
      tab.problem = toLaneboardError(err).message;
    }
  }
  return { tabs, problem };
}

// The store a request names with ?board= (absent: the current board); always read-only. Resolved from the tab list without
// reading any board's tasks, so a broken board never blocks the others.
export async function storeFor(ctx: ApiContext, key: string | null): Promise<StoreRef> {
  if (key === null || key === '') return { ...ctx.current, readOnly: true };
  const { tabs } = await tabList(ctx);
  const tab = tabs.find((t) => t.key === key);
  if (!tab || tab.missing) {
    throw new LaneboardError('INVALID_VALUE', `board ${key} is not one of the readable boards of this machine`, {
      allowed: tabs.filter((t) => !t.missing).map((t) => t.key),
      fix: 'pick a board from `allowed` (laneboard boards --json lists them)',
    });
  }
  return { dir: tab.path, found: 'board', readOnly: true };
}

// The success envelope of the CLI.
function ok(store: StoreRef | null, data: unknown, warnings: string[] = []): ApiReply {
  const dir = store?.dir ?? null;
  return { status: 200, body: { ok: true, store: dir, prefix: dir ? storePrefix(dir) : null, data, warnings } };
}

// The error envelope of the CLI with the registry's HTTP status.
export function errorReply(raw: unknown, store: StoreRef | null = null): ApiReply {
  const err = toLaneboardError(raw);
  const dir = store?.dir ?? null;
  return { status: ERRORS[err.code].http, body: { ok: false, store: dir, prefix: dir ? storePrefix(dir) : null, error: toErrorObject(err) } };
}

// A query parameter as an optional string ('' counts as absent: an empty filter field filters nothing).
function param(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null || value === '' ? undefined : value;
}

// A repeated query parameter (label=a&label=b) as a list, or undefined when absent.
function params(url: URL, name: string): string[] | undefined {
  const values = url.searchParams.getAll(name).filter((v) => v !== '');
  return values.length ? values : undefined;
}

// An integer query parameter; a malformed one goes to the op as NaN, so the core rejects it with INVALID_VALUE.
function intParam(url: URL, name: string): number | undefined {
  const value = param(url, name);
  return value === undefined ? undefined : Number(value);
}

// Everyone assigned and every label among the board's active tasks (the choices of the filter menus), sorted.
async function filterChoices(store: StoreRef): Promise<{ assignees: string[]; labels: string[] }> {
  const items: ListItem[] = [];
  for (let offset = 0; ; offset += DEFAULT_LIST_LIMIT) {
    const page = (await listTasks({ store }, { scope: 'active', limit: DEFAULT_LIST_LIMIT, offset })).data;
    items.push(...page.items);
    if (offset + DEFAULT_LIST_LIMIT >= page.total) break;
  }
  const assignees = new Set(items.flatMap((i) => (i.assignee === null ? [] : [i.assignee])));
  const labels = new Set(items.flatMap((i) => i.labels));
  return { assignees: [...assignees].sort(), labels: [...labels].sort() };
}

// The task id of /api/tasks/:id; a malformed %-escape is bad input (400), not a server bug.
export function taskId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // URIError: the address itself is broken (a lone or truncated %), so no task can have this id.
    throw new LaneboardError('INVALID_VALUE', `task id ${raw} in the address is not valid URL encoding`, { fix: 'use an exact id like LB-12 (see laneboard list --json)' });
  }
}

export type BoardData = ViewResult & { assignees: string[]; labels: string[] };

// Route one GET /api/... request (the token is already checked); null = no such route.
export async function apiRoute(ctx: ApiContext, url: URL): Promise<ApiReply | null> {
  let store: StoreRef | null = null;
  try {
    if (url.pathname === '/api/boards') {
      const { tabs, problem } = await boardTabs(ctx);
      return ok({ ...ctx.current, readOnly: true }, { boards: tabs, current: tabs[0]?.key ?? null, registry_problem: problem });
    }
    if (url.pathname === '/api/board') {
      store = await storeFor(ctx, url.searchParams.get('board'));
      const view = await viewBoard({ store }, { assignee: param(url, 'assignee'), labels: params(url, 'label'), text: param(url, 'text') });
      const data: BoardData = { ...view.data, ...(await filterChoices(store)) };
      return ok(store, data, view.warnings);
    }
    if (url.pathname === '/api/tasks') {
      store = await storeFor(ctx, url.searchParams.get('board'));
      const scope = param(url, 'scope');
      const r = await listTasks(
        { store },
        {
          scope: scope as 'active' | 'archive' | 'all' | undefined,
          status: params(url, 'status'),
          assignee: param(url, 'assignee'),
          labels: params(url, 'label'),
          text: param(url, 'text'),
          limit: intParam(url, 'limit'),
          offset: intParam(url, 'offset'),
        },
      );
      return ok(store, r.data, r.warnings);
    }
    const one = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
    if (one?.[1] !== undefined) {
      store = await storeFor(ctx, url.searchParams.get('board'));
      const r = await getTask({ store, home: ctx.home }, { id: taskId(one[1]) });
      return ok(store, r.data, r.warnings);
    }
    return null;
  } catch (err) {
    return errorReply(err, store);
  }
}

// The store an event stream watches (the same ?board= rule as the routes).
export function eventStore(ctx: ApiContext, url: URL): Promise<StoreRef> {
  return storeFor(ctx, url.searchParams.get('board'));
}
