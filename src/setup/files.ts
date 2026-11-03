// Apply or roll back laneboard's part of harness files: idempotent, `.laneboard.bak` of the original, exact restore on --remove.
import fs from 'node:fs';
import path from 'node:path';
import { LaneboardError } from '../core/index.ts';

// How laneboard edits one file's text; null = the file does not exist.
export interface TextEdit {
  // Text with our part added or replaced (the same text when nothing changes).
  add(text: string | null): string;
  // Text without our part (the same text when it has none).
  strip(text: string): string;
  // Does the text hold our part (in any version: an edited entry is still ours)?
  owns(text: string): boolean;
  // Same content for restore purposes (deep-equal JSON, equal text ignoring trailing whitespace).
  same(a: string, b: string): boolean;
  // Nothing left but an empty shell ({} or blank).
  isEmpty(text: string): boolean;
}

export type FileResult = 'created' | 'updated' | 'unchanged' | 'removed' | 'restored' | 'deleted' | 'kept';

export interface PlannedFile {
  // Absolute path.
  file: string;
  // As shown to the user: relative to the project, or ~/… for global files.
  shown: string;
  scope: 'project' | 'global';
  result: FileResult;
  // Line diff for an updated file that existed before.
  diff?: string[];
  // Text to write, or null to delete the file; undefined when nothing is written.
  write?: string | null;
  // Restore from the backup: also delete the backup.
  dropBackup?: boolean;
  // Write the backup of the original first (first change of a file that holds no laneboard part yet).
  backup?: string;
  // File text before this run (null = missing): what a failed apply puts back.
  before: string | null;
  // A backup that stays after this run (reported, so it is not forgotten or committed).
  keptBackup?: boolean;
}

// Backup path of a harness file.
export function backupOf(file: string): string {
  return `${file}.laneboard.bak`;
}

// File text, or null when missing.
export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    // A missing file is a normal state here; anything else (permissions) is a real error.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// Lines removed (-) and added (+), in order (simple set-based diff; enough to show a replaced value).
function lineDiff(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  return [...a.filter((l) => !b.includes(l)).map((l) => `- ${l}`), ...b.filter((l) => !a.includes(l)).map((l) => `+ ${l}`)];
}

// Closest directory on the way up that exists (where a missing file or directory would be created).
function existingAncestor(dir: string): string {
  let current = dir;
  while (!fs.existsSync(current) && path.dirname(current) !== current) current = path.dirname(current);
  return current;
}

// Fails before any write when this file (or the directory it is created or deleted in) is not writable.
function checkWritable(p: PlannedFile): PlannedFile {
  if (p.write === undefined) return p;
  const dir = path.dirname(p.file);
  const targets = fs.existsSync(p.file) ? [p.file] : [existingAncestor(dir)];
  // The backup is created next to the file, and a delete or a dropped backup unlinks in that directory.
  if (fs.existsSync(p.file) && (p.backup !== undefined || p.write === null || p.dropBackup)) targets.push(dir);
  for (const target of targets) {
    try {
      fs.accessSync(target, fs.constants.W_OK);
    } catch (err) {
      // Not writable (or vanished): stop the whole setup before anything is written.
      const code = (err as NodeJS.ErrnoException).code ?? 'EACCES';
      throw new LaneboardError('SETUP_WRITE_FAILED', `cannot write ${target === p.file ? p.shown : `the directory of ${p.shown}`} (${code}); nothing was written`, {
        details: { file: p.shown },
        fix: `make ${target} writable (chmod u+w ${target}) and run setup again`,
      });
    }
  }
  return p;
}

// Plan the install of our part into one file (reads only).
export function planAdd(file: string, shown: string, scope: PlannedFile['scope'], edit: TextEdit): PlannedFile {
  const before = readText(file);
  const after = edit.add(before);
  if (before === after) return { file, shown, scope, result: 'unchanged', before };
  if (before === null) return checkWritable({ file, shown, scope, result: 'created', write: after, before });
  // The backup is the file as it was without laneboard: never a text that already holds our part, never overwritten.
  const backup = !edit.owns(before) && readText(backupOf(file)) === null ? before : undefined;
  return checkWritable({ file, shown, scope, result: 'updated', write: after, diff: lineDiff(before, after), before, ...(backup !== undefined ? { backup } : {}) });
}

// Plan the removal of our part: restore the original bytes when nothing else changed, delete a file we created.
export function planRemove(file: string, shown: string, scope: PlannedFile['scope'], edit: TextEdit): PlannedFile {
  const before = readText(file);
  const original = readText(backupOf(file));
  const keptBackup = original !== null;
  if (before === null || !edit.owns(before)) return { file, shown, scope, result: 'unchanged', before, keptBackup };
  const stripped = edit.strip(before);
  // The backup itself is compared (not the backup without our part): one that holds our part never matches, so it never brings the entry back.
  if (original !== null && edit.same(original, stripped)) {
    return checkWritable({ file, shown, scope, result: 'restored', write: original, dropBackup: true, before });
  }
  if (original === null && edit.isEmpty(stripped)) return checkWritable({ file, shown, scope, result: 'deleted', write: null, before });
  return checkWritable({ file, shown, scope, result: 'removed', write: stripped, before, keptBackup });
}

// A shared file that another harness still needs: left as it is.
export function planKeep(file: string, shown: string, scope: PlannedFile['scope']): PlannedFile {
  return { file, shown, scope, result: 'kept', before: readText(file) };
}

// Marker file setup writes into a directory it created for a harness file (.cursor/, .gemini/, .claude/, ~/.codex/).
export const CREATED_DIR_MARKER = '.laneboard-created';
const CREATED_DIR_TEXT = 'laneboard setup created this directory; laneboard setup <harness> --remove deletes it again when nothing else is in it.\n';

// After our file was deleted: delete its directory only if setup created it (marker) and nothing else is in it; drop the marker either way.
function dropCreatedDir(dir: string, roots: readonly string[]): void {
  const marker = path.join(dir, CREATED_DIR_MARKER);
  if (roots.includes(dir) || !fs.existsSync(marker)) return;
  fs.unlinkSync(marker);
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

// Put a file back to `text` (null: it did not exist); `created` is the first directory this run made for it.
function putBack(file: string, text: string | null, created?: string): void {
  if (readText(file) === text) return;
  if (text !== null) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  fs.rmSync(file, { force: true });
  if (created) fs.rmSync(created, { recursive: true, force: true });
}

// Write a plan: backups first (with the original's mode), then files; a deleted file also takes its now-empty directory
// when setup created it (marker), never a directory the user had, never a root. When a write fails, everything this run changed is put back and one SETUP_WRITE_FAILED reports it.
export function applyPlan(plan: readonly PlannedFile[], roots: readonly string[]): void {
  // Undo steps, each with the file it puts back.
  const undo: Array<{ shown: string; run: () => void }> = [];
  let current: PlannedFile | undefined;
  try {
    for (const p of plan) {
      if (p.backup === undefined) continue;
      current = p;
      const bak = backupOf(p.file);
      const mode = fs.statSync(p.file).mode & 0o777;
      undo.push({ shown: `${p.shown}.laneboard.bak`, run: () => fs.rmSync(bak, { force: true }) });
      fs.writeFileSync(bak, p.backup, { mode });
      // The mode given at creation is narrowed by umask; set it exactly (a 0600 config keeps a 0600 backup).
      fs.chmodSync(bak, mode);
    }
    for (const p of plan) {
      if (p.write === undefined) continue;
      current = p;
      if (p.write === null) {
        undo.push({ shown: p.shown, run: () => putBack(p.file, p.before) });
        fs.unlinkSync(p.file);
        dropCreatedDir(path.dirname(p.file), roots);
        continue;
      }
      const dir = path.dirname(p.file);
      const created = fs.mkdirSync(dir, { recursive: true });
      undo.push({ shown: p.shown, run: () => putBack(p.file, p.before, created) });
      // Remember that this directory is ours, so --remove may delete it later (a directory the user had is never deleted).
      if (created !== undefined && !roots.includes(dir)) fs.writeFileSync(path.join(dir, CREATED_DIR_MARKER), CREATED_DIR_TEXT);
      fs.writeFileSync(p.file, p.write);
      if (p.dropBackup) {
        const bak = backupOf(p.file);
        const restored = p.write;
        const mode = fs.statSync(bak).mode & 0o777;
        undo.push({
          shown: `${p.shown}.laneboard.bak`,
          run: () => {
            fs.writeFileSync(bak, restored, { mode });
            fs.chmodSync(bak, mode);
          },
        });
        fs.unlinkSync(bak);
      }
    }
  } catch (err) {
    // A write failed after the plan passed its checks (disk full, a dangling symlink, a race): undo this run, newest first.
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
    const stuck: string[] = [];
    for (const step of undo.reverse()) {
      try {
        step.run();
      } catch {
        // Keep undoing the other files; the ones that could not be put back are named in the error.
        stuck.push(step.shown);
      }
    }
    const shown = current?.shown ?? 'a file';
    const after = stuck.length ? `; could not put back: ${stuck.join(', ')}` : '; the files changed before it were put back';
    throw new LaneboardError('SETUP_WRITE_FAILED', `writing ${shown} failed (${code})${after}`, {
      details: { file: shown },
      fix: `make ${shown} and its directory writable (a symlink must point to a writable place) and run setup again`,
    });
  }
}
