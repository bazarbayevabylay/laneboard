// Apply or roll back laneboard's part of harness files: idempotent, `.laneboard.bak` of the original, exact restore on --remove.
import fs from 'node:fs';
import path from 'node:path';

// How laneboard edits one file's text; null = the file does not exist.
export interface TextEdit {
  // Text with our part added or replaced (the same text when nothing changes).
  add(text: string | null): string;
  // Text without our part (the same text when it has none).
  strip(text: string): string;
  // Same content for restore purposes (deep-equal JSON, equal text ignoring trailing whitespace).
  same(a: string, b: string): boolean;
  // Nothing left but an empty shell ({} or blank).
  isEmpty(text: string): boolean;
}

export type FileResult = 'created' | 'updated' | 'unchanged' | 'removed' | 'restored' | 'deleted';

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
  // Write the backup of the original first (first change of a pre-existing file).
  backup?: string;
}

// Backup path of a harness file.
export function backupOf(file: string): string {
  return `${file}.laneboard.bak`;
}

// File text, or null when missing.
function readText(file: string): string | null {
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

// Plan the install of our part into one file (reads only).
export function planAdd(file: string, shown: string, scope: PlannedFile['scope'], edit: TextEdit): PlannedFile {
  const before = readText(file);
  const after = edit.add(before);
  if (before === after) return { file, shown, scope, result: 'unchanged' };
  if (before === null) return { file, shown, scope, result: 'created', write: after };
  const backup = readText(backupOf(file)) === null ? before : undefined;
  return { file, shown, scope, result: 'updated', write: after, diff: lineDiff(before, after), ...(backup !== undefined ? { backup } : {}) };
}

// Plan the removal of our part: restore the original bytes when nothing else changed, delete a file we created.
export function planRemove(file: string, shown: string, scope: PlannedFile['scope'], edit: TextEdit): PlannedFile {
  const before = readText(file);
  if (before === null) return { file, shown, scope, result: 'unchanged' };
  const stripped = edit.strip(before);
  if (stripped === before) return { file, shown, scope, result: 'unchanged' };
  const original = readText(backupOf(file));
  if (original !== null && edit.same(edit.strip(original), stripped)) return { file, shown, scope, result: 'restored', write: original, dropBackup: true };
  if (original === null && edit.isEmpty(stripped)) return { file, shown, scope, result: 'deleted', write: null };
  return { file, shown, scope, result: 'removed', write: stripped };
}

// Write a plan: backups first, then files; a deleted file also takes its now-empty directory (not the project or home root).
export function applyPlan(plan: readonly PlannedFile[], roots: readonly string[]): void {
  for (const p of plan) if (p.backup !== undefined) fs.writeFileSync(backupOf(p.file), p.backup);
  for (const p of plan) {
    if (p.write === undefined) continue;
    if (p.write === null) {
      fs.unlinkSync(p.file);
      const dir = path.dirname(p.file);
      if (!roots.includes(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      continue;
    }
    fs.mkdirSync(path.dirname(p.file), { recursive: true });
    fs.writeFileSync(p.file, p.write);
    if (p.dropBackup) fs.unlinkSync(backupOf(p.file));
  }
}
