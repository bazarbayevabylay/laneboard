// Tasks of other boards of this machine (ADR §30): task links to them are checked on their own board before the caller's lock, `get`
// shows where each linked task stands, and an id of another board gets a not-found error that names its board and reaches it.
import { boardByPrefix } from '../boards.ts';
import type { LiveBoard } from '../boards.ts';
import { loadConfig } from '../config.ts';
import { LaneboardError, toLaneboardError } from '../errors.ts';
import { ID_RE } from '../schema.ts';
import type { LinkT, TaskT } from '../schema.ts';
import { shellQuote } from '../shell.ts';
import type { StoreRef } from '../store.ts';
import { readBoth } from '../transact.ts';
import type { StoreView } from '../transact.ts';
import { finalStatuses, locate, notFound } from './common.ts';
import type { OpContext } from './common.ts';

// Board prefix of an exact id: `WEB-12` -> `WEB`.
export function idPrefix(id: string): string {
  return id.slice(0, id.lastIndexOf('-'));
}

// HOME of the board registry; none: USAGE whose CLI fix sets it before the same command (as list --all-boards, ADR §23).
function registryHome(ctx: OpContext, what: string): string {
  if (ctx.home !== undefined) return ctx.home;
  throw new LaneboardError('USAGE', `${what} is on another board, found through the board registry of this machine (<HOME>/.laneboard/boards.json), and HOME is not set`, {
    fix: 'set HOME to your home directory and run the same command again',
    edit: { env: 'HOME=<your home directory>' },
  });
}

// Both files of another board, read under its own lock (taken and released here); its errors name the board.
async function readOtherBoard(ctx: OpContext, store: StoreRef, what: string, prefix: string, warnings: string[]): Promise<StoreView> {
  const own: string[] = [];
  try {
    return await readBoth(store, { lockWaitMs: ctx.lockWaitMs, warnings: own });
  } catch (raw) {
    const err = toLaneboardError(raw);
    throw new LaneboardError(err.code, `${what}: board ${prefix} (${store.dir}): ${err.message}`, { fix: err.fix, ...(err.edit ? { edit: err.edit } : {}), ...(err.allowed ? { allowed: err.allowed } : {}) });
  } finally {
    warnings.push(...own.map((w) => `board ${prefix}: ${w}`));
  }
}

// Task links to another board's tasks (create --link, update --add-link), checked before the caller takes its own lock: the board is
// found by the id's prefix and read with readBoth, which takes and releases that board's lock, so a write never holds two locks and two
// boards linking each other cannot deadlock. Returns the refs checked here; checkTaskLinks skips them inside the write. Race named: a
// task deleted on its board between the two locks keeps the link (a delete leaves links to it on its own board too).
export async function checkForeignTaskLinks(ctx: OpContext, links: readonly LinkT[], warnings: string[]): Promise<Set<string>> {
  const refs = links.filter((l) => l.kind === 'task' && ID_RE.test(l.ref)).map((l) => l.ref);
  // A read-only store is refused by transact anyway: nothing to check for it.
  if (!refs.length || ctx.store.readOnly) return new Set();
  // The own prefix, read lock-free before the write (as create's status fix does, ADR §23); the write reads the config again.
  const own = loadConfig(ctx.store.dir).prefix;
  const foreign = refs.filter((ref) => idPrefix(ref) !== own);
  if (!foreign.length) return new Set();
  const home = registryHome(ctx, `link task=${foreign[0] ?? ''}`);
  const read = new Map<string, StoreView>();
  for (const ref of foreign) {
    const prefix = idPrefix(ref);
    const { board, prefixes } = boardByPrefix(home, prefix, ctx.store);
    if (!board) {
      throw new LaneboardError('INVALID_VALUE', `link task=${ref}: no live board with prefix ${prefix} on this machine`, { allowed: prefixes, fix: 'laneboard boards' });
    }
    const view = read.get(prefix) ?? (await readOtherBoard(ctx, board.store, `link task=${ref}`, prefix, warnings));
    read.set(prefix, view);
    if (!locate(view, ref)) {
      throw new LaneboardError('TASK_NOT_FOUND', `link task=${ref}: no such task on board ${prefix} (${board.store.dir})`, {
        fix: `laneboard list --board ${prefix} --scope all --text "<words from the title>"`,
      });
    }
  }
  return new Set(foreign);
}

// The not-found error of an id with the prefix of another live board of this machine: it names that board, and the CLI fix reaches it
// there - a read (`get`, `events --task`, `list --parent`) with --board <prefix>, a write with --dir <its store path>. The MCP server is
// pinned to its own store, so MCP gets the CLI command as text. Undefined for an id of this board or of no live board.
export function foreignTask(ctx: OpContext, id: string, prefix: string, use: 'read' | 'write'): LaneboardError | undefined {
  const other = idPrefix(id);
  if (other === prefix || ctx.home === undefined) return undefined;
  let board: LiveBoard | undefined;
  try {
    board = boardByPrefix(ctx.home, other, ctx.store).board;
  } catch {
    // A broken registry only costs the hint: the plain not-found stays (the commands that need the registry report it with its fix).
    return undefined;
  }
  if (!board) return undefined;
  const where = `${id} is on board ${other} (${board.store.dir}), not on this board (${prefix})`;
  if (use === 'read') {
    return new LaneboardError('TASK_NOT_FOUND', where, {
      fix: `read it on its board: laneboard get ${id} --board ${other} --json`,
      edit: { drop: [{ name: 'dir' }, { name: 'board' }], add: [{ name: 'board', value: other }] },
    });
  }
  return new LaneboardError('TASK_NOT_FOUND', where, {
    fix: `write on its board: the same laneboard command with --dir ${shellQuote(board.store.dir)} (an MCP server writes to its own board only)`,
    edit: { drop: [{ name: 'dir' }], add: [{ name: 'dir', value: board.store.dir }] },
  });
}

// TASK_NOT_FOUND for an id this board does not hold: with the board it is on when its prefix is another board's (foreignTask).
export function missingTask(ctx: OpContext, id: string, prefix: string, use: 'read' | 'write'): LaneboardError {
  return foreignTask(ctx, id, prefix, use) ?? notFound(id);
}

// A task link as `get` shows it: the board of its id, whether the task is there, its title, status, whether that status is the final
// one of its board and whether it is archived; `problem` when the board cannot be found or read (then `found` is false).
export interface LinkedTask {
  ref: string;
  board: string;
  found: boolean;
  title?: string;
  status?: string;
  final?: boolean;
  archived?: boolean;
  problem?: string;
}

// Another board for `get`: both files, or why they cannot be read (reads fail open: the task itself is still shown).
async function readLinkedBoard(ctx: OpContext, prefix: string): Promise<StoreView | string> {
  if (ctx.home === undefined) return 'HOME is not set, so the board registry cannot be read';
  try {
    const { board } = boardByPrefix(ctx.home, prefix, ctx.store);
    if (!board) return `no live board with prefix ${prefix} on this machine`;
    return await readBoth(board.store, { lockWaitMs: ctx.lockWaitMs, warnings: [] });
  } catch (err) {
    return toLaneboardError(err).message;
  }
}

// Every task link of `task` in link order: links to this board from `view` (read already), links to other boards from a read of each
// board after it, one after another (each read takes and releases its own lock: never two at once).
export async function linkedTasks(ctx: OpContext, task: TaskT, view: StoreView): Promise<LinkedTask[]> {
  const own = view.config.prefix;
  const boards = new Map<string, StoreView | string>([[own, view]]);
  const out: LinkedTask[] = [];
  for (const link of task.links) {
    if (link.kind !== 'task') continue;
    const prefix = ID_RE.test(link.ref) ? idPrefix(link.ref) : own;
    const read = boards.get(prefix) ?? (await readLinkedBoard(ctx, prefix));
    boards.set(prefix, read);
    if (typeof read === 'string') {
      out.push({ ref: link.ref, board: prefix, found: false, problem: read });
      continue;
    }
    const found = locate(read, link.ref);
    if (!found) {
      out.push({ ref: link.ref, board: prefix, found: false });
      continue;
    }
    const status = found.task.status;
    out.push({ ref: link.ref, board: prefix, found: true, title: found.task.title, status, final: finalStatuses(read.config.statuses).includes(status), archived: found.archived });
  }
  return out;
}
