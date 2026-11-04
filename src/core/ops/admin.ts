// Store administration: init, migrate, doctor (CLI-only).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { buildConfig, configPath, DEFAULT_PREFIX, derivePrefix, DEFAULT_STATUSES, loadConfig, serializeConfig, validateConfig } from '../config.ts';
import { ERRORS, LaneboardError } from '../errors.ts';
import { shellQuote } from '../shell.ts';
import { ensureDir, listOrphanTmp, removeOrphanTmp, writeFileAtomic } from '../fsio.ts';
import { checkPrefixFree, prefixTaken, registryDir, takenPrefixes, updateRegistry, upsertEntry } from '../boards.ts';
import { BoardDescription, BoardName, FILE_KINDS, PREFIX_RE, STATUS_RE, STORE_SCHEMA, STORE_VERSION } from '../schema.ts';
import type { ConfigT, FileKind, TaskT } from '../schema.ts';
import { contentSha, dedupeFiles, emptyStoreFile, maxIdNumber, readStoreFile, samePath, serializeStoreFile, STORE_DIR_NAME, storeFilePath } from '../store.ts';
import type { LockOptions } from '../lock.ts';
import type { LoadedFile } from '../store.ts';
import { commitFiles, withLock } from '../transact.ts';
import { attachmentDir } from './attach.ts';
import { actorSourceOf, parseInput, unique } from './common.ts';
import {
  attachmentContent,
  copyAttachments,
  describeRepeats,
  fieldCheck,
  isRestorePlan,
  keepDamagedFiles,
  keptDamagedFloor,
  orphanFiles,
  parentCheck,
  planRestore,
  readFailure,
  recoverAfterRestore,
  removeMovedSources,
  renumberRepeats,
  statusCheck,
} from './doctor-checks.ts';
import type { AttachmentMoves, CheckResult, RestorePlan } from './doctor-checks.ts';
import type { OpContext, OpResult } from './common.ts';

export const InitInput = z.strictObject({
  // Board name (default: the project folder's name); the prefix is derived from it unless given.
  name: z.string().optional(),
  // One line: whose project and what work (required, so a board can be told apart in `laneboard boards`).
  description: z.string().optional(),
  prefix: z.string().optional(),
  statuses: z.array(z.string()).min(1).optional(),
  // Write `.laneboard/.gitignore` with `*` (default true).
  gitignore: z.boolean().optional(),
});
export type InitInputT = z.infer<typeof InitInput>;

export interface InitResult {
  store: string;
  config: ConfigT;
  // Whether the board was added to the machine registry (needs HOME).
  registered: boolean;
}

export interface InitOptions extends LockOptions {
  // Home directory of the machine registry (`<home>/.laneboard/boards.json`); without it nothing is registered.
  home?: string;
  // The folder init runs in, set when the target came from LANEBOARD_DIR (not --dir). That variable may be a pin set for a parent
  // folder (Claude Code applies the repository root's local settings in every folder), so an existing board there is not offered.
  envCwd?: string;
}

// STORE_EXISTS for a target that already holds a board. From LANEBOARD_DIR, the fix creates this folder's own board by --dir:
// a bare init would take LANEBOARD_DIR again.
function storeExists(target: string, envCwd: string | undefined): LaneboardError {
  const own = envCwd === undefined ? undefined : path.join(path.resolve(envCwd), STORE_DIR_NAME);
  if (own === undefined || samePath(own, target)) {
    return new LaneboardError('STORE_EXISTS', `a store already exists at ${target}`, { fix: `use it (laneboard list --dir ${shellQuote(target)}), or pass --dir <another empty directory>` });
  }
  return new LaneboardError('STORE_EXISTS', `LANEBOARD_DIR points to ${target}, which already holds a board (LANEBOARD_DIR may be set for a parent folder, e.g. by its .claude/settings.local.json)`, {
    fix: `to create the board of ${path.dirname(own)}: laneboard init --dir ${shellQuote(own)} --name <name> --description "<whose project, what work>", then pass --dir ${shellQuote(own)} on every command, starting with laneboard prime`,
  });
}

// Validate a board name or description with its schema; INVALID_VALUE names the option.
function checkBoardText(schema: z.ZodType, value: string, option: string): string {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new LaneboardError('INVALID_VALUE', `--${option}: ${r.error.issues[0]?.message ?? 'invalid'}`, {
      input: { field: option, value },
      fix: `pass --${option} as one line of visible text (${option === 'name' ? 'at most 60' : 'at most 200'} characters)`,
    });
  }
  return value;
}

// A store directory that `target` would be inside of (init into .laneboard/... of an existing board).
function enclosingStore(target: string): string | undefined {
  for (let dir = path.dirname(target); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    if (path.basename(dir) === STORE_DIR_NAME && fs.existsSync(configPath(dir))) return dir;
  }
  return undefined;
}

// A prefix in the id format (1-10 uppercase letters and digits, starting with a letter); INVALID_VALUE otherwise.
function checkPrefix(prefix: string): string {
  if (!PREFIX_RE.test(prefix)) {
    throw new LaneboardError('INVALID_VALUE', `prefix "${prefix}" must match ^[A-Z][A-Z0-9]{0,9}$`, {
      input: { field: 'prefix', value: prefix, format: '<PREFIX like WEB>', ...(PREFIX_RE.test(prefix.toUpperCase()) ? { suggestion: prefix.toUpperCase() } : {}) },
      fix: 'use 1-10 uppercase letters and digits starting with a letter, e.g. --prefix WEB',
    });
  }
  return prefix;
}

// A status list (init, config --statuses): each status in the status format and listed once; the order is the board's, the last is final.
function checkStatuses(statuses: readonly string[]): string[] {
  for (const status of statuses) {
    if (!STATUS_RE.test(status)) {
      throw new LaneboardError('INVALID_VALUE', `status "${status}" must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$`, {
        input: { field: 'statuses', value: status },
        fix: 'use letters, digits, dot, dash or underscore in each status, comma-separated: --statuses todo,doing,done',
      });
    }
  }
  if (unique(statuses).length !== statuses.length) {
    throw new LaneboardError('INVALID_VALUE', `statuses contain duplicates: ${statuses.join(',')}`, { fix: `list each status once: --statuses ${unique(statuses).join(',')}` });
  }
  return [...statuses];
}

// Folder whose name gives the default prefix: the project of `<project>/.laneboard`, else the store directory itself.
function prefixSource(target: string): string {
  return path.basename(target) === STORE_DIR_NAME ? path.basename(path.dirname(target)) : path.basename(target);
}

// Create a store at `target` with an explicit config and empty files; refuses an existing or non-empty directory and a directory
// inside another store. Without a prefix it is derived from the board name; a prefix another live board of this machine uses is
// refused with a free one suggested (ids like CLAIMSPORT-3 must not look the same on two boards). Registers the board (HOME).
export async function initStore(target: string, input: InitInputT, opts: InitOptions = {}): Promise<OpResult<InitResult>> {
  const p = parseInput(InitInput, input);
  const warnings: string[] = [];
  if (p.description === undefined) {
    throw new LaneboardError('USAGE', 'description is required', {
      input: { field: 'description', value: '', format: '"<one line: whose project and what work>"' },
      fix: 'laneboard init --name <name> --description "<one line: whose project and what work>"',
    });
  }
  const description = checkBoardText(BoardDescription, p.description, 'description');
  const name = checkBoardText(BoardName, p.name ?? prefixSource(target), 'name');
  const derived = p.prefix === undefined ? derivePrefix(name) : undefined;
  if (p.prefix === undefined && derived === undefined) {
    warnings.push(`no prefix could be derived from the name "${name}", so ids use ${DEFAULT_PREFIX}; pick one with laneboard init --prefix <PREFIX>`);
  }
  const prefix = checkPrefix(p.prefix ?? derived ?? DEFAULT_PREFIX);
  const statuses = checkStatuses(p.statuses ?? DEFAULT_STATUSES);
  // `<home>/.laneboard` is the machine's board registry (with its own lock): a board there would lock itself out and hide the registry.
  if (opts.home !== undefined && samePath(target, registryDir(opts.home))) {
    throw new LaneboardError('STORE_EXISTS', `${target} is this machine's board registry (laneboard boards), so no board can be created there`, {
      // --dir, not a bare init in that folder: a bare init takes LANEBOARD_DIR, which may be this very folder (ADR-0001 §16).
      fix: `create the board in the project's own folder: laneboard init --dir ${shellQuote(opts.home)}/<project>/.laneboard --name <name> --description "<whose project, what work>", then pass --dir ${shellQuote(opts.home)}/<project>/.laneboard on every command, starting with laneboard prime`,
    });
  }
  const outer = enclosingStore(target);
  if (outer) {
    throw new LaneboardError('STORE_EXISTS', `${target} is inside the store ${outer}`, {
      fix: `use that board (laneboard prime --dir ${shellQuote(outer)}), or create a board for another project in its own folder: laneboard init --dir <project folder>/.laneboard --name <name> --description "<whose project, what work>"`,
    });
  }
  const config = validateConfig(buildConfig(prefix, [...statuses], { name, description }), 'config.json');
  const create = async (): Promise<void> => {
    ensureDir(target);
    await withLock({ dir: target }, opts, (lock) => {
      if (fs.existsSync(configPath(target))) throw storeExists(target, opts.envCwd);
      const other = fs.readdirSync(target).filter((n) => n !== 'lock');
      if (other.length) throw new LaneboardError('STORE_EXISTS', `${target} is not empty (${other.slice(0, 3).join(', ')})`);
      const now = new Date().toISOString();
      lock.assertHeld();
      for (const kind of FILE_KINDS) writeFileAtomic(storeFilePath(target, kind), serializeStoreFile(emptyStoreFile(kind, now)), 0o444);
      ensureDir(path.join(target, 'attachments'));
      if (p.gitignore !== false) writeFileAtomic(path.join(target, '.gitignore'), '*\n', 0o644);
      // config.json last: its presence marks a complete store.
      writeFileAtomic(configPath(target), serializeConfig(config), 0o644);
    });
  };
  if (opts.home === undefined) {
    await create();
    warnings.push('HOME is not set, so this board is not in the machine registry (laneboard boards) and its prefix was not checked against other boards');
    return { data: { store: target, config, registered: false }, warnings };
  }
  // The registry lock is held around the check and the create, so two inits cannot take the same prefix.
  await updateRegistry(opts.home, opts, async (entries) => {
    const taken = takenPrefixes(entries, target);
    const owner = taken.get(prefix);
    if (owner !== undefined) throw prefixTaken(prefix, owner, taken);
    await create();
    return { entries: upsertEntry(entries, { path: target, prefix, name, description, registered_at: new Date().toISOString() }), result: undefined };
  });
  return { data: { store: target, config, registered: true }, warnings };
}

export const ConfigureInput = z.strictObject({
  name: z.string().optional(),
  description: z.string().optional(),
  // New id prefix: only while the board has no task at all (active or archived), since ids carry it.
  prefix: z.string().optional(),
  // The whole new status list in order, the last one final (`config --statuses a,b,c`): add and reorder freely; a status dropped from
  // the list must hold no active task (ADR-0001 §33).
  statuses: z.array(z.string()).min(1).optional(),
});
export type ConfigureInputT = z.infer<typeof ConfigureInput>;

export interface ConfigureResult {
  name: string | null;
  description: string | null;
  prefix: string;
  // Statuses in order; the last one is final.
  statuses: string[];
  // Whether config.json was rewritten.
  changed: boolean;
}

// INVALID_VALUE when the board holds any task (active or archived): its ids, links and comments carry the old prefix.
function checkNoTasks(storeDir: string, from: string, to: string): void {
  const warnings: string[] = [];
  const count = readStoreFile(storeDir, 'active', warnings).data.tasks.length + readStoreFile(storeDir, 'archive', warnings).data.tasks.length;
  if (count === 0) return;
  throw new LaneboardError('INVALID_VALUE', `the prefix of a board with tasks never changes: this board has ${count} task(s) with ids like ${from}-1, so it cannot become ${to}`, {
    input: { field: 'prefix', value: to },
    fix: `keep the prefix ${from}, or create a new board with the prefix you want: laneboard init --dir <project folder>/.laneboard --prefix ${to} --name <name> --description "<whose project, what work>"`,
  });
}

// Ids shown in a message before "+N more".
const IDS_SHOWN = 5;

// INVALID_VALUE for dropping statuses that active tasks are still in: nothing is written, the tasks move first (one update each), so
// no task is left in a status the board no longer has. The fix lists exactly those tasks.
function statusInUse(storeDir: string, inUse: ReadonlyArray<{ status: string; tasks: string[] }>): LaneboardError {
  const total = inUse.reduce((n, u) => n + u.tasks.length, 0);
  const named = inUse.map((u) => {
    const more = u.tasks.length > IDS_SHOWN ? `, +${u.tasks.length - IDS_SHOWN} more` : '';
    return `${u.status} (${u.tasks.length}: ${u.tasks.slice(0, IDS_SHOWN).join(', ')}${more})`;
  });
  return new LaneboardError(
    'INVALID_VALUE',
    `cannot remove ${inUse.length === 1 ? 'a status' : 'statuses'} that ${total} active task(s) are in: ${named.join('; ')}; ` +
      'move each of them to a status you keep (laneboard update <ID> --status <status>), then run this command again ' +
      '(a new name for a status: add the new name, move the tasks, then drop the old name)',
    {
      details: { in_use: inUse.map((u) => ({ status: u.status, tasks: u.tasks })) },
      fix: `laneboard list ${inUse.map((u) => `--status ${u.status}`).join(' ')} --dir ${shellQuote(storeDir)} --json`,
    },
  );
}

// The warning of a new final status (the last of the list): which active tasks stop or start counting as closed, and what follows it.
function finalChanged(before: readonly string[], after: readonly string[], active: readonly TaskT[]): string | undefined {
  const from = before.at(-1);
  const to = after.at(-1);
  if (from === undefined || to === undefined || from === to) return undefined;
  const count = (status: string): number => active.filter((t) => t.status === status).length;
  return (
    `the final status changes from ${from} to ${to}: active tasks in ${from} (${count(from)}) no longer count as closed, those in ${to} (${count(to)}) do; ` +
    `finish, accepting handed-in tasks and the in-work and stale marks now use ${to}`
  );
}

// Show or change the board name, description, prefix and statuses (`laneboard config`); the prefix changes only while the board has
// no task (ids keep it) and must be free on this machine; a status leaves the list only when no active task is in it. Name,
// description and prefix refresh the registry, whose check keeps the prefix unique among live boards (also for an unchanged one).
export async function configureStore(ctx: OpContext, input: ConfigureInputT): Promise<OpResult<ConfigureResult>> {
  const p = parseInput(ConfigureInput, input);
  const warnings: string[] = [];
  const registers = p.name !== undefined || p.description !== undefined || p.prefix !== undefined;
  const change = registers || p.statuses !== undefined;
  if (change && ctx.store.readOnly) {
    throw new LaneboardError('STORE_READ_ONLY', `${ctx.store.dir} was opened with --board, which is read-only`, { fix: 'change your own board without --board' });
  }
  const name = p.name === undefined ? undefined : checkBoardText(BoardName, p.name, 'name');
  const description = p.description === undefined ? undefined : checkBoardText(BoardDescription, p.description, 'description');
  const prefix = p.prefix === undefined ? undefined : checkPrefix(p.prefix);
  const statuses = p.statuses === undefined ? undefined : checkStatuses(p.statuses);
  const read = (): ConfigT => loadConfig(ctx.store.dir);
  const result = (config: ConfigT, changed: boolean): ConfigureResult => ({
    name: config.name ?? null,
    description: config.description ?? null,
    prefix: config.prefix,
    statuses: [...config.statuses],
    changed,
  });
  if (!change) return { data: result(read(), false), warnings };
  // Under the store lock, the lock of every task write (transact): no task can enter a dropped status between the check and the write.
  const write = (): Promise<ConfigureResult> =>
    withLock(ctx.store, ctx, (lock) => {
      const before = read();
      if (prefix !== undefined && prefix !== before.prefix) checkNoTasks(ctx.store.dir, before.prefix, prefix);
      let active: TaskT[] = [];
      if (statuses !== undefined) {
        active = readStoreFile(ctx.store.dir, 'active', warnings).data.tasks;
        const archived = readStoreFile(ctx.store.dir, 'archive', warnings).data.tasks;
        const removed = before.statuses.filter((st) => !statuses.includes(st));
        const inUse = removed.map((status) => ({ status, tasks: active.filter((t) => t.status === status).map((t) => t.id) })).filter((u) => u.tasks.length > 0);
        if (inUse.length) throw statusInUse(ctx.store.dir, inUse);
        // Archived tasks are read-only: they keep a dropped status and are read as an unknown one (§2), so they do not block.
        for (const status of removed) {
          const n = archived.filter((t) => t.status === status).length;
          if (n) warnings.push(`${n} archived task(s) keep the removed status ${status}: they stay readable as an unknown status, and restore brings them back in it (then laneboard update <ID> --status <status>)`);
        }
      }
      const next = validateConfig(
        {
          ...before,
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(prefix !== undefined ? { prefix } : {}),
          ...(statuses !== undefined ? { statuses } : {}),
        },
        'config.json',
      );
      if (serializeConfig(next) === serializeConfig(before)) return result(before, false);
      lock.assertHeld();
      writeFileAtomic(configPath(ctx.store.dir), serializeConfig(next), 0o644);
      const final = finalChanged(before.statuses, next.statuses, active);
      if (final !== undefined) warnings.push(final);
      return result(next, true);
    });
  // The registry holds no statuses: a status change alone leaves it alone.
  if (!registers) return { data: await write(), warnings };
  if (ctx.home === undefined) {
    const data = await write();
    warnings.push(`HOME is not set, so the machine registry (laneboard boards) was not updated${prefix !== undefined ? ' and the prefix was not checked against other boards' : ''}`);
    return { data, warnings };
  }
  // Like init, the registry lock is held around the prefix check and the write, so two boards cannot take one prefix. An unchanged
  // prefix is checked too: a copied project folder must not register a second board with the same ids (review S5c MINOR); the board
  // registered first under its path keeps working next to such a copy (checkPrefixFree, ADR §33).
  const data = await updateRegistry(ctx.home, ctx, async (entries) => {
    const current = read().prefix;
    if (prefix === undefined || prefix === current) warnings.push(...checkPrefixFree(entries, ctx.store.dir, current));
    else {
      const taken = takenPrefixes(entries, ctx.store.dir);
      const owner = taken.get(prefix);
      if (owner !== undefined) throw prefixTaken(prefix, owner, taken);
    }
    const written = await write();
    const entry = { path: ctx.store.dir, prefix: written.prefix, name: written.name, description: written.description, registered_at: new Date().toISOString() };
    return { entries: upsertEntry(entries, entry), result: written };
  });
  return { data, warnings };
}

export interface MigrateResult {
  schema: string;
  migrated: string[];
}

// Upgrade older store files under the lock; store@1 is the first version, so this only verifies.
export async function migrateStore(ctx: OpContext): Promise<OpResult<MigrateResult>> {
  const warnings: string[] = [];
  const migrated: string[] = [];
  await withLock(ctx.store, ctx, () => {
    loadConfig(ctx.store.dir);
    for (const kind of FILE_KINDS) {
      const file = readStoreFile(ctx.store.dir, kind, warnings);
      if (file.version > STORE_VERSION) {
        throw new LaneboardError('STORE_TOO_NEW', `${kind}.json is ${file.data.schema}; this laneboard supports ${STORE_SCHEMA}`);
      }
    }
  });
  return { data: { schema: STORE_SCHEMA, migrated }, warnings };
}

export const DoctorInput = z.strictObject({
  fix: z.boolean().optional(),
  restore_backup: z.boolean().optional(),
});
export type DoctorInputT = z.infer<typeof DoctorInput>;

export interface DoctorCheck {
  name: string;
  ok: boolean;
  fixed: boolean;
  message: string;
}

export interface DoctorResult {
  healthy: boolean;
  checks: DoctorCheck[];
}

// Fix part of a doctor line for a store file that does not load: its own fix when it has one (chmod, merge conflict), else the restore.
function loadFailureHint(err: unknown, restoreAsked: boolean): string {
  const own = err instanceof LaneboardError && err.fix !== ERRORS[err.code].fix ? err.fix : undefined;
  if (own) return `; fix: ${own}`;
  return restoreAsked ? '' : '; to roll back: laneboard doctor --restore-backup';
}

// Check the store and optionally repair it: config, files, checksums, duplicates, next_id, tmp files, attachments, task values.
// --restore-backup swaps in the .bak of a damaged file (never of one it cannot read) and keeps what the other files still know.
export async function doctor(ctx: OpContext, input: DoctorInputT): Promise<OpResult<DoctorResult>> {
  const p = parseInput(DoctorInput, input);
  const fix = p.fix === true;
  const dir = ctx.store.dir;
  const checks: DoctorCheck[] = [];
  const warnings: string[] = [];
  const add = (name: string, r: CheckResult): void => {
    checks.push({ name, ok: r.ok, fixed: r.fixed === true, message: r.message });
  };
  await withLock(ctx.store, { ...ctx, warnings }, (lock) => {
    const now = new Date().toISOString();
    let config: ConfigT;
    try {
      config = loadConfig(dir);
      add('config', { ok: true, message: 'valid' });
    } catch (err) {
      add('config', { ok: false, message: (err as Error).message });
      return;
    }
    const files: LoadedFile[] = [];
    const force = new Set<FileKind>();
    // Restores this run will write (with the commit below, never before it), and files that do not load and are not restored.
    const restores: Array<{ plan: RestorePlan; line: number; error: string }> = [];
    const notLoaded: string[] = [];
    for (const kind of FILE_KINDS) {
      const shaWarnings: string[] = [];
      let file: LoadedFile | undefined;
      try {
        file = readStoreFile(dir, kind, shaWarnings, { allowDuplicateIds: true });
        add(`${kind}.json`, { ok: true, message: `valid, ${file.data.tasks.length} tasks, rev ${file.data.rev}` });
      } catch (err) {
        const message = (err as Error).message;
        // A file that is there but cannot be read (permissions, a symlink loop, a directory) may be intact and the newest version.
        if (readFailure(storeFilePath(dir, kind)) !== undefined) {
          const refused = p.restore_backup ? '; not restored: it may be the newest version, fix the read error first' : '';
          add(`${kind}.json`, { ok: false, message: `${message}${loadFailureHint(err, true)}${refused}` });
          notLoaded.push(`${kind}.json`);
          continue;
        }
        if (!p.restore_backup) {
          add(`${kind}.json`, { ok: false, message: `${message}${loadFailureHint(err, false)}` });
          notLoaded.push(`${kind}.json`);
          continue;
        }
        const plan = planRestore(dir, kind, now);
        if (!isRestorePlan(plan)) {
          add(`${kind}.json`, plan);
          notLoaded.push(`${kind}.json`);
          continue;
        }
        // The line says "restored" now and is taken back below if the restore cannot be written.
        restores.push({ plan, line: checks.length, error: message });
        add(`${kind}.json`, { ok: false, fixed: true, message: plan.message });
        file = plan.file;
      }
      files.push(file);
      if (file.version > STORE_VERSION) {
        add(`${kind}.json schema`, { ok: false, message: `${file.data.schema} is newer than ${STORE_SCHEMA}; upgrade laneboard` });
        notLoaded.push(`${kind}.json (newer schema)`);
      }
      if (contentSha(file.data.tasks) !== file.data.content_sha256) {
        // A restored file is rewritten anyway, with its checksum.
        const accepted = fix || restores.some((r) => r.plan.kind === kind);
        if (accepted) force.add(kind);
        add(`${kind}.json checksum`, {
          ok: false,
          fixed: accepted,
          message: accepted ? 'content_sha256 mismatch (hand edit): accepted and rewritten' : 'content_sha256 mismatch: the file was edited by hand; --fix accepts the edit',
        });
      }
    }
    // A restore without what it implies (next_id floor, returned tasks) gives ids twice (A3): restore only when both files load.
    // Nothing has been written yet.
    if (notLoaded.length) {
      for (const r of restores) {
        checks[r.line] = {
          name: `${r.plan.kind}.json`,
          ok: false,
          fixed: false,
          message: `${r.error}; not restored, nothing was written: ${notLoaded.join(', ')} must load first (its line says how), then run laneboard doctor --restore-backup again`,
        };
      }
      return;
    }
    const active = files.find((f) => f.kind === 'active') as LoadedFile;
    const archive = files.find((f) => f.kind === 'archive') as LoadedFile;
    const data = { active: active.data, archive: archive.data };

    // A restore is written even without --fix, in one commit with what it returns and the next_id floor (A3).
    if (restores.length) {
      for (const r of restores) force.add(r.plan.kind);
      const broken = new Map(restores.map((r) => [r.plan.kind, r.plan.current?.toString('utf8')]));
      add('after restore', recoverAfterRestore(dir, data, broken, config.prefix));
    }

    const archivedIds = new Set(archive.data.tasks.map((t) => t.id));
    const duplicates = unique(active.data.tasks.filter((t) => archivedIds.has(t.id)).map((t) => t.id));
    if (duplicates.length) {
      if (fix) dedupeFiles(active.data, archive.data);
      add('duplicates', {
        ok: false,
        fixed: fix,
        message: `ids in both files: ${duplicates.join(', ')}${fix ? ' (kept the copy with the higher rev)' : '; --fix keeps the copy with the higher rev'}`,
      });
    } else add('duplicates', { ok: true, message: 'no id in both files' });

    // next_id above every id on the board and every id a damaged file kept by a restore still shows (a floor that never got written).
    const max = maxIdNumber(active.data.tasks, archive.data.tasks);
    const kept = keptDamagedFloor(dir);
    const needed = Math.max(max + 1, kept.floor);
    const nextId = active.data.next_id ?? 0;
    if (nextId < needed) {
      if (fix) active.data.next_id = needed;
      const why = needed > max + 1 ? `below ${needed}: ids up to ${config.prefix}-${needed - 1} were used (${kept.name})` : `not above the highest id number ${max}`;
      add('next_id', { ok: false, fixed: fix, message: `next_id ${nextId} is ${why}${fix ? `; set to ${needed}` : '; --fix sets it above'}` });
    } else add('next_id', { ok: true, message: `next_id ${nextId} > highest id number ${max}` });

    // Two tasks with one id in a file (a git merge of the board, a hand edit): commands reach only the first one (A8).
    const moves: AttachmentMoves = { copies: [], removeAfter: new Set() };
    const repeats = describeRepeats(data);
    if (!repeats.length) add('duplicate ids', { ok: true, message: 'every id is used once in its file' });
    else if (!fix) add('duplicate ids', { ok: false, message: `one id on two tasks: ${repeats.join('; ')}; --fix gives the copy created later a new id` });
    else {
      const renamed = renumberRepeats(dir, data, config, { now, actor: ctx.actor ?? 'doctor', source: actorSourceOf(ctx) }, moves);
      const refs = renamed.references.length
        ? `; these name the old id and now reach the first copy, check which one each meant: ${renamed.references.join(', ')}`
        : '; no task names the old id';
      add('duplicate ids', { ok: false, fixed: true, message: `gave the later copy a new id: ${renamed.changes.join(', ')}${refs}` });
    }

    // Every repair below deletes, moves or rewrites files: only while the lock is surely still ours.
    if (fix) lock.assertHeld();
    const tmp = listOrphanTmp(dir);
    if (tmp.length) {
      if (fix) removeOrphanTmp(dir);
      add('tmp files', { ok: false, fixed: fix, message: `${tmp.length} orphan tmp file(s) from a crashed writer${fix ? ' removed' : '; --fix removes them'}` });
    } else add('tmp files', { ok: true, message: 'none' });

    const tasks = [...active.data.tasks, ...archive.data.tasks];
    add('attachment files', orphanFiles(dir, tasks, fix, now, moves.removeAfter));
    const missing: string[] = [];
    for (const t of tasks) {
      for (const a of t.attachments) {
        const file = path.join(attachmentDir(dir, t.id), a.name);
        if (!fs.existsSync(file) && !moves.copies.some((c) => c.to === file)) missing.push(`${t.id}/${a.name}`);
      }
    }
    if (missing.length) add('attachment metadata', { ok: false, message: `metadata without file: ${missing.join(', ')}; remove each with laneboard attach <id> --remove <name>` });
    else add('attachment metadata', { ok: true, message: 'every attachment has its file' });

    // Written before the slow report-only checks below, so hashing large attachments never pushes the commit past the lock deadline.
    if (fix || restores.length) {
      copyAttachments(dir, moves);
      lock.assertHeld();
      keepDamagedFiles(dir, restores.map((r) => r.plan));
      commitFiles(dir, files, { now, lock, force });
      removeMovedSources(moves);
    }

    // Report only (A10): what a person decides, not doctor.
    add('attachment content', attachmentContent(dir, tasks));
    add('statuses', statusCheck(config, active.data.tasks));
    add('parents', parentCheck(active.data.tasks, archive.data.tasks));
    add('fields', fieldCheck(config, tasks));
  });
  return { data: { healthy: checks.every((c) => c.ok || c.fixed), checks }, warnings };
}
