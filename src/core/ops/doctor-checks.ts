// Doctor's checks and repairs (ADR-0001 W8, audit A3, A8, A10): restore from .bak without losing what the other files still know,
// ids used twice in one file, attachment files without metadata, and report-only checks of tasks against config.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { idNumber, parseStoreFile, repeatedIds, validateStoreJson, backupPath, storeFilePath } from '../store.ts';
import type { LoadedFile } from '../store.ts';
import { ensureDir, moveEntry, removeEmptyDir, removeFile, writeFileAtomic } from '../fsio.ts';
import { shellQuote } from '../shell.ts';
import { FILE_KINDS, ID_RE } from '../schema.ts';
import type { ConfigT, FileKind, StoreFileT, TaskT } from '../schema.ts';
import type { ActorSource } from '../agent-name.ts';
import { attachmentDir } from './attach.ts';
import { addEvent, matchesType, touch } from './common.ts';

// Folder under attachments/ where doctor --fix puts files no task names (never deleted: a restore may have dropped their metadata).
export const ORPHANED_DIR = '.orphaned';

// One line of the doctor report.
export interface CheckResult {
  ok: boolean;
  message: string;
  fixed?: boolean;
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
    // Missing or unreadable: the caller checked readFailure first, so this is "missing".
    return undefined;
  }
}

// Error code of reading `file` other than "missing" (EACCES, EPERM, ELOOP, EISDIR, EIO...), undefined when it reads or is missing.
// Such a file may be intact and the newest version: a restore would overwrite what it could not even read.
export function readFailure(file: string): string | undefined {
  try {
    fs.readFileSync(file);
    return undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return code === 'ENOENT' ? undefined : code;
  }
}

// A restore decided but not yet written: the .bak loaded as the file's new content, and the damaged bytes to keep aside.
export interface RestorePlan {
  kind: FileKind;
  // The .bak as a loaded store file; `raw` is the .bak's own text, so the commit leaves the .bak as it is.
  file: LoadedFile;
  // The damaged file's bytes (undefined when it is missing) and the name it is kept under.
  current?: Buffer;
  keptName: string;
  message: string;
}

// Plan swapping in `<kind>.json.bak` for a damaged file, without writing anything: the restore is written by the same commit as
// what it implies (next_id floor, returned tasks, A3), so no exit between them leaves a restored file without its floor.
export function planRestore(storeDir: string, kind: FileKind, now: string): RestorePlan | CheckResult {
  const current = readBytes(storeFilePath(storeDir, kind));
  const backup = readBytes(backupPath(storeDir, kind));
  const counts = `current: ${countTasks(current?.toString('utf8'))}; backup: ${countTasks(backup?.toString('utf8'))}`;
  if (backup === undefined) return { ok: false, message: `invalid and no ${kind}.json.bak to restore (${counts})` };
  let file: LoadedFile;
  try {
    // A .bak with an id used twice is still a good base: the duplicate-ids check gives the later copy a new id.
    file = parseStoreFile(backup.toString('utf8'), backupPath(storeDir, kind), kind, `${kind}.json.bak`, [], { allowDuplicateIds: true });
  } catch (err) {
    return { ok: false, message: `invalid, and ${kind}.json.bak is invalid too: ${(err as Error).message} (${counts})` };
  }
  const keptName = `${kind}.json.invalid-${now.replace(/[:.]/g, '-')}`;
  const kept = current !== undefined ? `; broken file kept as ${keptName}` : '';
  return { kind, file, current, keptName, message: `restored from ${kind}.json.bak (${counts})${kept}` };
}

// Is this a restore plan (and not the line of a restore that cannot be done)?
export function isRestorePlan(r: RestorePlan | CheckResult): r is RestorePlan {
  return 'file' in r;
}

// Keep the damaged files of planned restores as `<kind>.json.invalid-<time>`; called right before the commit that replaces them.
export function keepDamagedFiles(storeDir: string, plans: readonly RestorePlan[]): void {
  for (const plan of plans) {
    if (plan.current !== undefined) writeFileAtomic(path.join(storeDir, plan.keptName), plan.current, 0o444);
  }
}

// Damaged store files kept by earlier restores (`*.json.invalid-*`), as name and text.
function keptDamagedTexts(storeDir: string): Array<{ name: string; text: string }> {
  const names = fs.existsSync(storeDir) ? fs.readdirSync(storeDir).filter((n) => /^(active|archive)\.json\.invalid-/.test(n)) : [];
  return names.flatMap((name) => {
    const bytes = readBytes(path.join(storeDir, name));
    return bytes === undefined ? [] : [{ name, text: bytes.toString('utf8') }];
  });
}

// Lowest next_id that gives no id seen in a kept damaged file (`*.invalid-*`) again, and that file's name; a second guard for a
// restore whose floor never reached the disk (a crash between the files).
export function keptDamagedFloor(storeDir: string): { floor: number; name?: string } {
  let best: { floor: number; name?: string } = { floor: 1 };
  for (const { name, text } of keptDamagedTexts(storeDir)) {
    const floor = Math.max(textNextId(text) ?? 1, ...textIds(text).map((id) => idNumber(id) + 1));
    if (floor > best.floor) best = { floor, name };
  }
  return best;
}

// next_id written in a store file's text, also when the rest is damaged (it comes early in the file).
function textNextId(text: string | undefined): number | undefined {
  const m = text === undefined ? null : /"next_id"\s*:\s*(\d+)/.exec(text);
  return m ? Number(m[1]) : undefined;
}

// Task ids named by `"id": "..."` in a store file's text, also when it is not valid JSON.
function textIds(text: string | undefined): string[] {
  if (text === undefined) return [];
  return [...text.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1] as string).filter((id) => ID_RE.test(id));
}

// Tasks of a .bak file, undefined when it is missing or not a valid store file.
function backupTasks(storeDir: string, kind: FileKind): TaskT[] | undefined {
  const raw = readBytes(backupPath(storeDir, kind));
  if (raw === undefined) return undefined;
  try {
    return validateStoreJson(JSON.parse(raw.toString('utf8')), kind, `${kind}.json.bak`, { allowDuplicateIds: true }).data.tasks;
  } catch {
    // A damaged .bak has nothing reliable to return; its text still counts for next_id below.
    return undefined;
  }
}

// Numbers of this board's ids (`<prefix>-N`) in a text.
function prefixedNumbers(text: string, prefix: string): number[] {
  return [...text.matchAll(new RegExp(`(?<![A-Za-z0-9])${prefix}-([1-9][0-9]*)(?![0-9])`, 'g'))].map((m) => Number(m[1]));
}

// Highest id number this board's tasks name anywhere but in free text: their ids, parents, task links, and the id, parent and
// links of their events (an id once renumbered or linked), plus the attachment folders (a task may be gone, its files not).
function highestNamedId(storeDir: string, tasks: readonly TaskT[], prefix: string): number {
  const texts: string[] = [];
  for (const t of tasks) {
    texts.push(t.id, t.parent ?? '', ...t.links.filter((l) => l.kind === 'task').map((l) => l.ref));
    for (const e of t.events) texts.push(JSON.stringify([e.data.id, e.data.parent, e.data.links]));
  }
  const root = path.join(storeDir, 'attachments');
  if (fs.existsSync(root)) texts.push(...fs.readdirSync(root).filter((name) => ID_RE.test(name)));
  return Math.max(0, ...texts.flatMap((text) => prefixedNumbers(text, prefix)));
}

// "LB-3, LB-4" for up to 10 ids, else "LB-3..LB-40 (38 ids)".
function idList(prefix: string, numbers: readonly number[]): string {
  if (numbers.length <= 10) return numbers.map((n) => `${prefix}-${n}`).join(', ');
  return `${prefix}-${numbers[0]}..${prefix}-${numbers.at(-1)} (${numbers.length} ids)`;
}

// After a restore (A3): put back every task that only a .bak still holds (the lost write moved it between the files), and keep
// next_id above every id the store ever used (the damaged file, both .bak files, kept damaged files, ids the tasks and their events
// name, attachment folders), so no id is given twice.
export function recoverAfterRestore(storeDir: string, files: Record<FileKind, StoreFileT>, broken: Map<FileKind, string | undefined>, prefix: string): CheckResult {
  const present = new Set([...files.active.tasks, ...files.archive.tasks].map((t) => t.id));
  const returned: string[] = [];
  for (const kind of FILE_KINDS) {
    for (const task of backupTasks(storeDir, kind) ?? []) {
      if (present.has(task.id)) continue;
      files[kind].tasks.push(task);
      present.add(task.id);
      returned.push(`${task.id} "${task.title}" (to ${kind}.json)`);
    }
  }
  // Ids the damaged files named that are still nowhere: their last change is lost with the write that made it.
  const lost = [...broken.values()].flatMap((text) => textIds(text)).filter((id, i, all) => !present.has(id) && all.indexOf(id) === i);
  const texts = [
    ...broken.values(),
    ...FILE_KINDS.map((kind) => readBytes(backupPath(storeDir, kind))?.toString('utf8')),
    ...keptDamagedTexts(storeDir).map((k) => k.text),
  ];
  let floor = 1;
  for (const text of texts) {
    floor = Math.max(floor, textNextId(text) ?? 1, ...textIds(text).map((id) => idNumber(id) + 1));
  }
  const tasks = [...files.active.tasks, ...files.archive.tasks];
  floor = Math.max(floor, highestNamedId(storeDir, tasks, prefix) + 1);
  const next = files.active.next_id ?? 1;
  // active.json is one write ahead of its .bak. When the damaged file shows no next_id, that write may have created tasks from the
  // .bak's next_id on (one create: one id; an import: several, A3): every id up to the floor is skipped and named, at least one.
  const blind = broken.has('active') && textNextId(broken.get('active')) === undefined;
  if (blind) floor = Math.max(floor, next + 1);
  const parts: string[] = [];
  if (returned.length) parts.push(`returned tasks found only in a .bak: ${returned.join(', ')}; if one was deleted on purpose, delete it again`);
  if (lost.length) parts.push(`lost with the damaged file: ${lost.join(', ')} (their last change; the damaged file is kept as .invalid-*)`);
  if (blind) {
    const unused = Array.from({ length: floor - next }, (_, i) => next + i).filter((n) => !present.has(`${prefix}-${n}`));
    parts.push(
      `the last write to active.json is lost and may have created ${idList(prefix, unused)}; those ids are not given again, ` +
        `but an import there may have created more, and nothing on disk shows them: ids its reply named above these can be given again`,
    );
  }
  if (floor > next) {
    files.active.next_id = floor;
    parts.push(`next_id ${next} -> ${floor}, so no id used before is given again`);
  }
  if (!parts.length) return { ok: true, message: 'every task of the .bak files is on the board; next_id is above every id used' };
  return { ok: false, fixed: true, message: parts.join('; ') };
}

// Attachment files to copy before the store is written and their sources to remove after it, for renumbered tasks.
export interface AttachmentMoves {
  copies: Array<{ from: string; to: string }>;
  // Sources no task names any more once the store is written (removed after the commit, skipped by the orphan check before it).
  removeAfter: Set<string>;
}

// Ids used twice in each file, as "GG-2 in active.json ("a", "b")" (report text).
export function describeRepeats(files: Record<FileKind, StoreFileT>): string[] {
  const out: string[] = [];
  for (const kind of FILE_KINDS) {
    for (const id of repeatedIds(files[kind].tasks)) {
      const titles = files[kind].tasks.filter((t) => t.id === id).map((t) => JSON.stringify(t.title));
      out.push(`${id} in ${kind}.json (${titles.join(', ')})`);
    }
  }
  return out;
}

// Tasks whose parent or task link names `id` (other than `except`), as "LB-4 (parent LB-2)" with the command to point it at `newId`.
function referencesTo(files: Record<FileKind, StoreFileT>, id: string, newId: string, except: TaskT): string[] {
  const out: string[] = [];
  for (const t of [...files.active.tasks, ...files.archive.tasks]) {
    if (t === except) continue;
    if (t.parent === id) out.push(`${t.id} (parent ${id}; if it meant the renumbered one: laneboard update ${t.id} --parent ${newId})`);
    if (t.links.some((l) => l.kind === 'task' && l.ref === id)) {
      out.push(`${t.id} (link task=${id}; if it meant the renumbered one: laneboard update ${t.id} --remove-link task=${id} --add-link task=${newId})`);
    }
  }
  return out;
}

// What renumberRepeats did: "LB-2 "b" -> LB-5" lines, and tasks whose parent or link names an old id (which copy they meant is not
// known: they keep the first one until a person moves them).
export interface Renumbered {
  changes: string[];
  references: string[];
}

// Give every later copy of an id used twice in one file the next free id (A8): the copy created first (created_at; on a tie, the one
// earlier in the file) keeps the id. The renumbered task gets an `updated {id: [old, new]}` event and its attachment files move to
// the new id's folder. Links and subtasks that name the old id keep pointing to the first copy and are named in `references`.
// Call only after next_id is above every id in the store.
export function renumberRepeats(
  storeDir: string,
  files: Record<FileKind, StoreFileT>,
  config: ConfigT,
  who: { now: string; actor: string; source: ActorSource },
  moves: AttachmentMoves,
): Renumbered {
  const changes: string[] = [];
  const references: string[] = [];
  for (const kind of FILE_KINDS) {
    for (const id of repeatedIds(files[kind].tasks)) {
      const copies = files[kind].tasks.map((task, index) => ({ task, index })).filter((c) => c.task.id === id);
      copies.sort((a, b) => a.task.created_at.localeCompare(b.task.created_at) || a.index - b.index);
      const keeper = copies[0]?.task as TaskT;
      const keptNames = new Set(keeper.attachments.map((a) => a.name));
      const renamed: string[] = [];
      for (const { task } of copies.slice(1)) {
        const nextId = files.active.next_id ?? 1;
        const newId = `${config.prefix}-${nextId}`;
        files.active.next_id = nextId + 1;
        for (const a of task.attachments) {
          const from = path.join(attachmentDir(storeDir, id), a.name);
          if (!fs.existsSync(from)) continue;
          moves.copies.push({ from, to: path.join(attachmentDir(storeDir, newId), a.name) });
          // A name the first copy also has stays where it is for it; a name only this copy had leaves the old folder.
          if (!keptNames.has(a.name)) moves.removeAfter.add(from);
        }
        task.id = newId;
        touch(task, who.now, who.actor);
        addEvent(task, config, who.now, who.actor, 'updated', { id: [id, newId] }, who.source);
        changes.push(`${id} "${task.title}" -> ${newId}`);
        renamed.push(newId);
      }
      // Every task that names the old id may have meant a renumbered copy: one line per such task and new id.
      for (const newId of renamed) references.push(...referencesTo(files, id, newId, keeper));
    }
  }
  return { changes, references };
}

// Copy the attachment files of renumbered tasks to their new folders (before the store is written: a crash leaves a spare copy).
export function copyAttachments(storeDir: string, moves: AttachmentMoves): void {
  for (const { from, to } of moves.copies) {
    ensureDir(path.dirname(to));
    writeFileAtomic(to, fs.readFileSync(from), 0o444, { tmpDir: storeDir });
  }
}

// Remove the old copies once the store names the new ones (after the commit: a crash before it leaves a spare copy, not a loss).
export function removeMovedSources(moves: AttachmentMoves): void {
  for (const from of moves.removeAfter) {
    removeFile(from);
    removeEmptyDir(path.dirname(from));
  }
}

// Unused path for a file put aside under attachments/.orphaned/<id>/ (a second orphan of the same name gets a time suffix).
function orphanTarget(storeDir: string, id: string, name: string, now: string): string {
  const base = path.join(storeDir, 'attachments', ORPHANED_DIR, id, name);
  return fs.existsSync(base) ? `${base}.${now.replace(/[:.]/g, '-')}` : base;
}

// Attachment files no task names (A3 (5)): reported; --fix moves them to attachments/.orphaned/<id>/, from where they can be attached
// again. Never deleted: after a restore or a hand edit the file may be the only copy of a report.
export function orphanFiles(storeDir: string, tasks: readonly TaskT[], fix: boolean, now: string, pending: ReadonlySet<string>): CheckResult {
  const known = new Map<string, Set<string>>();
  for (const t of tasks) {
    const names = known.get(t.id) ?? new Set<string>();
    for (const a of t.attachments) names.add(a.name);
    known.set(t.id, names);
  }
  const orphans: string[] = [];
  const moved: string[] = [];
  const root = path.join(storeDir, 'attachments');
  for (const id of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    // The put-aside folder and other dot entries are not task folders.
    if (id.startsWith('.') || !fs.statSync(attachmentDir(storeDir, id)).isDirectory()) continue;
    const names = known.get(id);
    for (const entry of fs.readdirSync(attachmentDir(storeDir, id))) {
      const file = path.join(attachmentDir(storeDir, id), entry);
      if (names?.has(entry) || pending.has(file)) continue;
      orphans.push(`${id}/${entry}`);
      if (!fix) continue;
      const target = orphanTarget(storeDir, id, entry, now);
      moveEntry(file, target);
      moved.push(target);
    }
    if (fix && !names) removeEmptyDir(attachmentDir(storeDir, id));
  }
  if (!orphans.length) return { ok: true, message: 'every file has metadata' };
  if (!fix) return { ok: false, message: `files without metadata: ${orphans.join(', ')}; --fix moves them to attachments/${ORPHANED_DIR}/ (nothing is deleted)` };
  const again = moved.length === 1 ? `; attach it again: laneboard attach <id> ${shellQuote(moved[0] as string)}` : '; attach one again: laneboard attach <id> <its path>';
  return { ok: false, fixed: true, message: `files without metadata moved to ${path.join(root, ORPHANED_DIR)}: ${orphans.join(', ')}${again}` };
}

// sha256 of a file's bytes.
function fileSha(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Attachment files whose size or sha256 differ from their metadata (report only: which bytes are right is not known).
export function attachmentContent(storeDir: string, tasks: readonly TaskT[]): CheckResult {
  const bad: string[] = [];
  for (const t of tasks) {
    for (const a of t.attachments) {
      const file = path.join(attachmentDir(storeDir, t.id), a.name);
      if (!fs.existsSync(file)) continue;
      const size = fs.statSync(file).size;
      if (size !== a.size) bad.push(`${t.id}/${a.name} (${size} bytes, metadata ${a.size})`);
      else if (fileSha(file) !== a.sha256) bad.push(`${t.id}/${a.name} (sha256 differs)`);
    }
  }
  if (!bad.length) return { ok: true, message: 'every attachment matches its size and sha256' };
  return { ok: false, message: `files that differ from their metadata: ${bad.join(', ')}; remove each (laneboard attach <id> --remove <name>) and attach the right file again` };
}

// Active tasks in a status the config no longer lists (archived ones may keep an old status).
export function statusCheck(config: ConfigT, active: readonly TaskT[]): CheckResult {
  const bad = active.filter((t) => !config.statuses.includes(t.status)).map((t) => `${t.id} (${t.status})`);
  if (!bad.length) return { ok: true, message: 'every active task is in a status of config.statuses' };
  return { ok: false, message: `active tasks in a status not in config.statuses: ${bad.join(', ')}; move each: laneboard update <id> --status <one of: ${config.statuses.join(', ')}>` };
}

// Subtasks whose parent is on neither file of the board.
export function parentCheck(active: readonly TaskT[], archive: readonly TaskT[]): CheckResult {
  const ids = new Set([...active, ...archive].map((t) => t.id));
  const bad = [...active, ...archive].filter((t) => t.parent !== undefined && !ids.has(t.parent)).map((t) => `${t.id} (parent ${t.parent})`);
  if (!bad.length) return { ok: true, message: 'every parent exists' };
  return { ok: false, message: `subtasks whose parent is not on the board: ${bad.join(', ')}; make each top-level: laneboard update <id> --no-parent (an archived one: laneboard restore <id> first)` };
}

// Field values against config.fields: undeclared keys and values of the wrong type.
export function fieldCheck(config: ConfigT, tasks: readonly TaskT[]): CheckResult {
  const bad: string[] = [];
  for (const t of tasks) {
    for (const [key, value] of Object.entries(t.fields)) {
      const def = Object.hasOwn(config.fields, key) ? config.fields[key] : undefined;
      if (!def) bad.push(`${t.id} ${key} (not declared)`);
      else if (!matchesType(def.type, value)) bad.push(`${t.id} ${key} (not ${def.type})`);
    }
  }
  if (!bad.length) return { ok: true, message: 'every field is declared and of its type' };
  return { ok: false, message: `fields that do not match config.fields: ${bad.join(', ')}; set a valid value (laneboard update <id> --field <key>=<value>) or drop it (laneboard update <id> --unset-field <key>)` };
}
