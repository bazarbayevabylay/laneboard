// Store administration: init, migrate, doctor (CLI-only).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { buildConfig, configPath, DEFAULT_PREFIX, derivePrefix, DEFAULT_STATUSES, loadConfig, serializeConfig, validateConfig } from '../config.ts';
import { LaneboardError } from '../errors.ts';
import { ensureDir, listOrphanTmp, removeDir, removeFile, removeOrphanTmp, writeFileAtomic } from '../fsio.ts';
import { freePrefix, registerStore, registryDir, takenPrefixes, updateRegistry, upsertEntry } from '../boards.ts';
import { BoardDescription, BoardName, FILE_KINDS, PREFIX_RE, STATUS_RE, STORE_SCHEMA, STORE_VERSION } from '../schema.ts';
import type { ConfigT, FileKind } from '../schema.ts';
import { backupPath, contentSha, dedupeFiles, emptyStoreFile, maxIdNumber, readStoreFile, samePath, serializeStoreFile, STORE_DIR_NAME, storeFilePath, validateStoreJson } from '../store.ts';
import type { HeldLock, LockOptions } from '../lock.ts';
import type { LoadedFile } from '../store.ts';
import { commitFiles, withLock } from '../transact.ts';
import { attachmentDir } from './attach.ts';
import { parseInput, unique } from './common.ts';
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
    return new LaneboardError('STORE_EXISTS', `a store already exists at ${target}`, { fix: `use it (laneboard list --dir ${target}), or pass --dir <another empty directory>` });
  }
  return new LaneboardError('STORE_EXISTS', `LANEBOARD_DIR points to ${target}, which already holds a board (LANEBOARD_DIR may be set for a parent folder, e.g. by its .claude/settings.local.json)`, {
    fix: `to create the board of ${path.dirname(own)}: laneboard init --dir ${own} --name <name> --description "<whose project, what work>", then pass --dir ${own} on every command, starting with laneboard prime`,
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

// INVALID_VALUE for a prefix another live board uses, with a free one as the suggestion.
function prefixTaken(prefix: string, owner: string, taken: ReadonlyMap<string, string>): LaneboardError {
  const free = freePrefix(prefix, taken);
  return new LaneboardError('INVALID_VALUE', `prefix ${prefix} is already used by the board at ${owner}; two boards with one prefix have look-alike ids`, {
    input: { field: 'prefix', value: prefix, suggestion: free },
    details: { taken: [...taken.keys()].sort() },
    fix: `pick a free prefix: --prefix ${free}`,
  });
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
  const prefix = p.prefix ?? derived ?? DEFAULT_PREFIX;
  if (!PREFIX_RE.test(prefix)) {
    throw new LaneboardError('INVALID_VALUE', `prefix "${prefix}" must match ^[A-Z][A-Z0-9]{0,9}$`, {
      input: { field: 'prefix', value: prefix, format: '<PREFIX like WEB>', ...(PREFIX_RE.test(prefix.toUpperCase()) ? { suggestion: prefix.toUpperCase() } : {}) },
      fix: 'use 1-10 uppercase letters and digits starting with a letter, e.g. --prefix WEB',
    });
  }
  const statuses = p.statuses ?? DEFAULT_STATUSES;
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
  // `<home>/.laneboard` is the machine's board registry (with its own lock): a board there would lock itself out and hide the registry.
  if (opts.home !== undefined && samePath(target, registryDir(opts.home))) {
    throw new LaneboardError('STORE_EXISTS', `${target} is this machine's board registry (laneboard boards), so no board can be created there`, {
      fix: `create the board in the project's own folder: mkdir -p ${path.join(opts.home, '<project>')} && cd ${path.join(opts.home, '<project>')} && laneboard init --name <name> --description "<whose project, what work>"`,
    });
  }
  const outer = enclosingStore(target);
  if (outer) throw new LaneboardError('STORE_EXISTS', `${target} is inside the store ${outer}`, { fix: `run laneboard init in the project folder, not inside ${outer}` });
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
});
export type ConfigureInputT = z.infer<typeof ConfigureInput>;

export interface ConfigureResult {
  name: string | null;
  description: string | null;
  prefix: string;
  // Whether config.json was rewritten.
  changed: boolean;
}

// Show or change the board name and description (`laneboard config`); the prefix never changes (ids keep it). Refreshes the registry.
export async function configureStore(ctx: OpContext, input: ConfigureInputT): Promise<OpResult<ConfigureResult>> {
  const p = parseInput(ConfigureInput, input);
  const warnings: string[] = [];
  const change = p.name !== undefined || p.description !== undefined;
  if (change && ctx.store.readOnly) {
    throw new LaneboardError('STORE_READ_ONLY', `${ctx.store.dir} was opened with --board, which is read-only`, { fix: 'change your own board without --board' });
  }
  const name = p.name === undefined ? undefined : checkBoardText(BoardName, p.name, 'name');
  const description = p.description === undefined ? undefined : checkBoardText(BoardDescription, p.description, 'description');
  const read = (): ConfigT => loadConfig(ctx.store.dir);
  const result = (config: ConfigT, changed: boolean): ConfigureResult => ({ name: config.name ?? null, description: config.description ?? null, prefix: config.prefix, changed });
  if (!change) return { data: result(read(), false), warnings };
  const data = await withLock(ctx.store, ctx, (lock) => {
    const before = read();
    const next = validateConfig({ ...before, ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}) }, 'config.json');
    if (serializeConfig(next) === serializeConfig(before)) return result(before, false);
    lock.assertHeld();
    writeFileAtomic(configPath(ctx.store.dir), serializeConfig(next), 0o644);
    return result(next, true);
  });
  if (ctx.home !== undefined) await registerStore(ctx.home, ctx.store.dir, ctx);
  else warnings.push('HOME is not set, so the machine registry (laneboard boards) was not updated');
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

// Number of tasks in a store file's text, or "unreadable".
function countTasks(raw: string | undefined): string {
  if (raw === undefined) return 'missing';
  try {
    const json = JSON.parse(raw) as { tasks?: unknown };
    return Array.isArray(json.tasks) ? `${json.tasks.length} tasks` : 'unreadable';
  } catch {
    // Not JSON at all.
    return 'unreadable';
  }
}

// Read a file's bytes, undefined when missing.
function readBytes(file: string): Buffer | undefined {
  try {
    return fs.readFileSync(file);
  } catch {
    // Missing or unreadable: reported by the caller.
    return undefined;
  }
}

// Swap in `<kind>.json.bak` for an invalid file; the broken file is kept next to it.
function restoreFromBackup(storeDir: string, kind: FileKind, now: string, lock: HeldLock): { ok: boolean; message: string } {
  const current = readBytes(storeFilePath(storeDir, kind));
  const backup = readBytes(backupPath(storeDir, kind));
  const counts = `current: ${countTasks(current?.toString('utf8'))}; backup: ${countTasks(backup?.toString('utf8'))}`;
  if (backup === undefined) return { ok: false, message: `invalid and no ${kind}.json.bak to restore (${counts})` };
  try {
    validateStoreJson(JSON.parse(backup.toString('utf8')), kind, `${kind}.json.bak`);
  } catch (err) {
    return { ok: false, message: `invalid, and ${kind}.json.bak is invalid too: ${(err as Error).message} (${counts})` };
  }
  lock.assertHeld();
  let kept = '';
  // Copy the broken file aside first, then replace it in one atomic step: lock-free readers never see it missing.
  if (current !== undefined) {
    const keptName = `${kind}.json.invalid-${now.replace(/[:.]/g, '-')}`;
    writeFileAtomic(path.join(storeDir, keptName), current, 0o444);
    kept = `; broken file kept as ${keptName}`;
  }
  writeFileAtomic(storeFilePath(storeDir, kind), backup, 0o444);
  return { ok: true, message: `restored from ${kind}.json.bak (${counts})${kept}` };
}

// Check the store and optionally repair it: config, files, checksums, duplicates, next_id, tmp files, attachments.
export async function doctor(ctx: OpContext, input: DoctorInputT): Promise<OpResult<DoctorResult>> {
  const p = parseInput(DoctorInput, input);
  const fix = p.fix === true;
  const dir = ctx.store.dir;
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, message: string, fixed = false): void => {
    checks.push({ name, ok, fixed, message });
  };
  await withLock(ctx.store, ctx, (lock) => {
    const now = new Date().toISOString();
    try {
      loadConfig(dir);
      add('config', true, 'valid');
    } catch (err) {
      add('config', false, (err as Error).message);
      return;
    }
    const files: LoadedFile[] = [];
    const force = new Set<FileKind>();
    for (const kind of FILE_KINDS) {
      const shaWarnings: string[] = [];
      let file: LoadedFile | undefined;
      try {
        file = readStoreFile(dir, kind, shaWarnings);
        add(`${kind}.json`, true, `valid, ${file.data.tasks.length} tasks, rev ${file.data.rev}`);
      } catch (err) {
        if (!p.restore_backup) {
          add(`${kind}.json`, false, `${(err as Error).message}; to roll back: laneboard doctor --restore-backup`);
          continue;
        }
        const restored = restoreFromBackup(dir, kind, now, lock);
        add(`${kind}.json`, false, restored.message, restored.ok);
        if (!restored.ok) continue;
        file = readStoreFile(dir, kind, shaWarnings);
      }
      files.push(file);
      if (file.version > STORE_VERSION) add(`${kind}.json schema`, false, `${file.data.schema} is newer than ${STORE_SCHEMA}; upgrade laneboard`);
      if (contentSha(file.data.tasks) !== file.data.content_sha256) {
        if (fix) force.add(kind);
        add(`${kind}.json checksum`, false, fix ? 'content_sha256 mismatch (hand edit): accepted and rewritten' : 'content_sha256 mismatch: the file was edited by hand; --fix accepts the edit', fix);
      }
    }
    const active = files.find((f) => f.kind === 'active');
    const archive = files.find((f) => f.kind === 'archive');
    if (!active || !archive || files.some((f) => f.version > STORE_VERSION)) return;

    const archivedIds = new Set(archive.data.tasks.map((t) => t.id));
    const duplicates = active.data.tasks.filter((t) => archivedIds.has(t.id)).map((t) => t.id);
    if (duplicates.length) {
      if (fix) dedupeFiles(active.data, archive.data);
      add('duplicates', false, `ids in both files: ${duplicates.join(', ')}${fix ? ' (kept the copy with the higher rev)' : '; --fix keeps the copy with the higher rev'}`, fix);
    } else add('duplicates', true, 'no id in both files');

    const max = maxIdNumber(active.data.tasks, archive.data.tasks);
    const nextId = active.data.next_id ?? 0;
    if (nextId <= max) {
      if (fix) active.data.next_id = max + 1;
      add('next_id', false, `next_id ${nextId} is not above the highest id number ${max}${fix ? `; set to ${max + 1}` : '; --fix sets it above'}`, fix);
    } else add('next_id', true, `next_id ${nextId} > highest id number ${max}`);

    // Every repair below deletes or rewrites files: only while the lock is surely still ours.
    if (fix) lock.assertHeld();
    const tmp = listOrphanTmp(dir);
    if (tmp.length) {
      if (fix) removeOrphanTmp(dir);
      add('tmp files', false, `${tmp.length} orphan tmp file(s) from a crashed writer${fix ? ' removed' : '; --fix removes them'}`, fix);
    } else add('tmp files', true, 'none');

    const known = new Map<string, Set<string>>();
    for (const t of [...active.data.tasks, ...archive.data.tasks]) known.set(t.id, new Set(t.attachments.map((a) => a.name)));
    const orphans: string[] = [];
    const root = path.join(dir, 'attachments');
    for (const id of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      if (!fs.statSync(attachmentDir(dir, id)).isDirectory()) continue;
      const names = known.get(id);
      const entries = fs.readdirSync(attachmentDir(dir, id));
      if (!names) {
        orphans.push(`${id}/`);
        if (fix) removeDir(attachmentDir(dir, id));
        continue;
      }
      for (const entry of entries) {
        if (names.has(entry)) continue;
        orphans.push(`${id}/${entry}`);
        if (fix) removeFile(path.join(attachmentDir(dir, id), entry));
      }
    }
    if (orphans.length) add('attachment files', false, `files without metadata: ${orphans.join(', ')}${fix ? ' (removed)' : '; --fix removes them'}`, fix);
    else add('attachment files', true, 'every file has metadata');

    const missing: string[] = [];
    for (const t of [...active.data.tasks, ...archive.data.tasks]) {
      for (const a of t.attachments) if (!fs.existsSync(path.join(attachmentDir(dir, t.id), a.name))) missing.push(`${t.id}/${a.name}`);
    }
    if (missing.length) add('attachment metadata', false, `metadata without file: ${missing.join(', ')}; remove each with laneboard attach <id> --remove <name>`);
    else add('attachment metadata', true, 'every attachment has its file');

    if (fix) commitFiles(dir, files, { now, lock, force });
  });
  return { data: { healthy: checks.every((c) => c.ok || c.fixed), checks }, warnings: [] };
}

