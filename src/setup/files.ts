// Apply or roll back laneboard's part of harness files: idempotent, `.laneboard.bak` of the original, exact restore on --remove.
import fs from 'node:fs';
import path from 'node:path';
import { LaneboardError, shellQuote } from '../core/index.ts';

// How laneboard edits one file's text; null = the file does not exist.
export interface TextEdit {
  // Text with our part added or replaced (the same text when nothing changes).
  add(text: string | null): string;
  // Text without our part (the same text when it has none).
  strip(text: string): string;
  // Does the text hold our part (in any version: an edited entry is still ours)?
  owns(text: string): boolean;
  // Does the text hold a part only laneboard writes (default: owns)? A value the user may have set too (env.LANEBOARD_DIR) is no proof:
  // a file with only such values still gets a backup, and --remove restores it when the rest equals the backup without our parts.
  ownsExclusive?(text: string): boolean;
  // Same content for restore purposes (deep-equal JSON, equal text ignoring trailing whitespace).
  same(a: string, b: string): boolean;
  // Nothing left but an empty shell ({} or blank).
  isEmpty(text: string): boolean;
}

export type FileResult = 'created' | 'updated' | 'unchanged' | 'removed' | 'restored' | 'deleted' | 'kept';

// Which file is open: the same dev and inode as when the plan was made (bigint, so a large inode number is never rounded).
interface Identity {
  dev: bigint;
  ino: bigint;
}

export interface PlannedFile {
  // Absolute path.
  file: string;
  // As shown to the user: relative to the project, or ~/… for global files.
  shown: string;
  scope: 'project' | 'global';
  // The file setup really reads and writes: a project file's real path inside the project (`CLAUDE.md -> AGENTS.md` gives AGENTS.md),
  // a global file's end of its symlink chain (a dotfiles link), else `file`.
  target: string;
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
  // Project files: the folder the real path must stay in (checked again right before the writes).
  root?: string;
  // Project files that existed when planned: the write goes only into this same file (dev/inode of the open descriptor).
  identity?: Identity;
}

// Backup path of a harness file.
export function backupOf(file: string): string {
  return `${file}.laneboard.bak`;
}

// Where a planned file's backup is: next to the real project file (two harnesses writing one file through a link share it),
// next to the global path itself (a dotfiles folder the link points into gets no backup files).
function backupPath(p: Pick<PlannedFile, 'file' | 'scope' | 'target'>): string {
  return backupOf(p.scope === 'project' ? p.target : p.file);
}

// Largest file setup reads: harness configs and instruction files are kilobytes; a bigger file or a link to /dev/zero is never read.
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;

// The first folder on the way down to a path that cannot be opened (no search permission), or undefined when every folder can be.
function closedFolder(file: string): string | undefined {
  const folders: string[] = [];
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    folders.unshift(dir);
    if (path.dirname(dir) === dir) break;
  }
  return folders.find((dir) => {
    try {
      fs.accessSync(dir, fs.constants.X_OK);
      return false;
    } catch {
      // This folder cannot be searched: it is the one that blocks the path.
      return true;
    }
  });
}

// SETUP_WRITE_FAILED for a path setup cannot look at or read (permissions, I/O): before any write, with the chmod that opens it.
function cannotRead(file: string, err: unknown): LaneboardError {
  const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
  const denied = code === 'EACCES' || code === 'EPERM';
  const folder = denied ? closedFolder(file) : undefined;
  const fix = !denied
    ? `check ${shellQuote(file)} and run setup again`
    : folder !== undefined
      ? `let yourself open the folder (chmod u+rx ${shellQuote(folder)}) and run setup again`
      : `let yourself read the file (chmod u+r ${shellQuote(file)}) and run setup again`;
  return new LaneboardError('SETUP_WRITE_FAILED', `cannot read ${file} (${code}); nothing was written`, { details: { file }, fix });
}

// SETUP_CONFLICT for a path that is no regular file (a folder, a device like /dev/zero, a FIFO or socket): setup never reads or writes it.
function notRegularFile(file: string, shown: string, stat: fs.Stats | fs.BigIntStats): LaneboardError {
  return new LaneboardError('SETUP_CONFLICT', `${shown} is not a regular file (${stat.isDirectory() ? 'a directory' : 'a device, FIFO or socket'}); nothing was written`, {
    details: { file: shown },
    fix: `move ${shellQuote(file)} away and run setup again`,
  });
}

// What is at a path, following symlinks, or undefined when nothing is there.
function statOrMissing(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch (err) {
    // Missing (or a parent missing) is a normal state here; anything else (permissions) gets an error with its fix.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw cannotRead(file, err);
  }
}

// File text, or null when missing. Only a regular file of at most MAX_TEXT_BYTES is read (SETUP_CONFLICT otherwise): a link from a
// cloned repository to /dev/zero or a FIFO must not eat the memory or hang setup, whoever calls this (planning, ownsNow, checkRootPin).
export function readText(file: string): string | null {
  // A missing file is never opened (its absence is the answer).
  if (statOrMissing(file) === undefined) return null;
  let fd: number;
  try {
    // O_NONBLOCK: a FIFO put at the path does not block the open; the fstat below refuses it.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (err) {
    // Removed since the stat: missing; anything else (permissions) gets an error with its fix.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cannotRead(file, err);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw notRegularFile(file, file, stat);
    // Read up to one byte over the limit, whatever the size said: a file that grows while it is read is caught too.
    const buffer = Buffer.allocUnsafe(MAX_TEXT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (read === 0) break;
      size += read;
    }
    if (size > MAX_TEXT_BYTES) {
      throw new LaneboardError('SETUP_CONFLICT', `${file} is larger than ${MAX_TEXT_BYTES / 1024 / 1024} MiB, too big for a harness file; nothing was written`, {
        details: { file },
        fix: `add laneboard's entry to ${file} by hand, or move the file away and run setup again`,
      });
    }
    return buffer.toString('utf8', 0, size);
  } finally {
    fs.closeSync(fd);
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
  const targets = fs.existsSync(p.target) ? [p.target] : [existingAncestor(path.dirname(p.target))];
  // The backup is created next to the file (a global one next to its link), and a delete or a dropped backup unlinks there.
  if (fs.existsSync(p.target) && (p.backup !== undefined || p.write === null || p.dropBackup)) targets.push(path.dirname(p.target), path.dirname(backupPath(p)));
  for (const target of targets) {
    try {
      fs.accessSync(target, fs.constants.W_OK);
    } catch (err) {
      // Not writable (or vanished): stop the whole setup before anything is written.
      const code = (err as NodeJS.ErrnoException).code ?? 'EACCES';
      throw new LaneboardError('SETUP_WRITE_FAILED', `cannot write ${target === p.target ? p.shown : `the directory of ${p.shown}`} (${code}); nothing was written`, {
        details: { file: p.shown },
        fix: `make ${target} writable (chmod u+w ${shellQuote(target)}) and run setup again`,
      });
    }
  }
  return p;
}

// The folder a project file must stay in: the project for a file shown by its path relative to it (index.ts `locate`), else the
// file's own directory (a moved project file, the repository's .git/info/exclude: laneboard computes that place, and git never
// checks out a path through `.git`, so a clone cannot plant a link there).
function projectRoot(file: string, shown: string): string {
  if (path.isAbsolute(shown) || shown.startsWith('~/')) return path.dirname(file);
  let root = file;
  for (let i = shown.split('/').length; i > 0; i--) root = path.dirname(root);
  return path.join(root, shown) === file ? root : path.dirname(file);
}

// What is at a path without following a symlink, or undefined when nothing is there yet (setup then creates a real file or folder).
function lstatOrMissing(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    // Missing (or a parent missing) is the normal state of a file setup creates; anything else (permissions) gets an error with its fix.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw cannotRead(p, err);
  }
}

// Real path of an existing path as the kernel resolves it, or the errno code when it leads nowhere (a dangling link, a loop).
// Always realpathSync.native: the JS fs.realpathSync folds a link's `..` by text (`conf -> .`, `.claude -> conf/..` gives the project),
// the kernel walks it (the project's parent), so a check by the JS path could pass a write that lands elsewhere.
function realOrCode(p: string): { real: string } | { code: string } {
  try {
    return { real: fs.realpathSync.native(p) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
    // A missing target or a loop is the link's own fault (SETUP_CONFLICT by the caller); permissions get an error with its fix.
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return { code };
    throw cannotRead(p, err);
  }
}

// Real path of a folder that may not exist yet (HOME/.git/info before the exclude file is made): its closest existing ancestor resolved,
// the missing rest appended.
function realFolder(dir: string): string {
  const existing = existingAncestor(dir);
  return path.join(fs.realpathSync.native(existing), path.relative(existing, dir));
}

// Is a real path inside the real project folder (or the folder itself)?
function inside(realRoot: string, real: string): boolean {
  const rel = path.relative(realRoot, real);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Is a real path inside a repository's .git folder below the project (git's own data: config, hooks, the exclude file)?
function insideGit(realRoot: string, real: string): boolean {
  return inside(realRoot, real) && path.relative(realRoot, real).split(path.sep).includes('.git');
}

// Path as shown in messages: relative to the project (with /), or absolute for a file setup shows absolute or as ~/….
function shownOf(realRoot: string, real: string, shown: string): string {
  return path.isAbsolute(shown) || shown.startsWith('~/') ? real : path.relative(realRoot, real).split(path.sep).join('/');
}

// The real file a project file names, refused (SETUP_CONFLICT) before any read or write when a symlink on its path leads outside the
// project folder (a cloned repository may hold `CLAUDE.md -> ~/.zshrc` or `.claude -> ~/.claude`; chains and `..` are followed to
// their end) or nowhere (dangling, a loop), or when the file is not a regular file. A link whose end is inside the project
// (`CLAUDE.md -> AGENTS.md`, `.claude -> conf/claude`) is fine: setup reads and writes the real file it ends at.
function resolveInsideProject(file: string, shown: string, root: string): { target: string; identity?: Identity } {
  const realRoot = realFolder(root);
  const steps = path.relative(root, file).split(path.sep);
  let current = root;
  let found = 0;
  for (const [i, step] of steps.entries()) {
    current = path.join(current, step);
    const stat = lstatOrMissing(current);
    if (stat === undefined) break;
    found = i + 1;
    if (!stat.isSymbolicLink()) continue;
    const link = path.isAbsolute(shown) || shown.startsWith('~/') ? shown : steps.slice(0, i + 1).join('/');
    const linkTo = fs.readlinkSync(current);
    const kind = i === steps.length - 1 ? 'file' : 'folder';
    const end = realOrCode(current);
    if ('code' in end) {
      throw new LaneboardError('SETUP_CONFLICT', `${link} is a symlink to ${linkTo}, which leads nowhere (${end.code}: a missing target or a loop); setup does not write ${shown} through it; nothing was written`, {
        details: { file: shown, link, target: linkTo },
        fix: `point ${shellQuote(current)} at an existing ${kind} inside the project or replace it with a real ${kind}, then run setup again`,
      });
    }
    if (!inside(realRoot, end.real)) {
      throw new LaneboardError('SETUP_CONFLICT', `${link} is a symlink to ${linkTo}, which leads outside the project (${end.real}); setup does not write ${shown} through it (a cloned repository can point a link at your files); nothing was written`, {
        details: { file: shown, link, target: linkTo, resolved: end.real },
        fix: `setup writes only inside the project: replace the symlink ${shellQuote(current)} with a real ${kind} (or point it inside the project) and run setup again, or add laneboard's entry to ${shown} by hand`,
      });
    }
    // A link into .git (`CLAUDE.md -> .git/config`) would put our block into git's own data; the exclude file setup writes is named
    // by its own path, never reached through a link.
    if (insideGit(realRoot, end.real)) {
      throw new LaneboardError('SETUP_CONFLICT', `${link} is a symlink to ${linkTo}, which leads into the repository's .git folder (${end.real}); setup does not write ${shown} through it (git reads that folder as its own data); nothing was written`, {
        details: { file: shown, link, target: linkTo, resolved: end.real },
        fix: `replace the symlink ${shellQuote(current)} with a real ${kind} outside .git and run setup again, or add laneboard's entry to ${shown} by hand`,
      });
    }
  }
  // The deepest part of the path that exists, resolved by the kernel (inside the project: every link on the way was checked above, and
  // a step that is no link stays in its folder); the rest does not exist yet and is created as real folders and file.
  const existing = found === 0 ? realRoot : fs.realpathSync.native(path.join(root, ...steps.slice(0, found)));
  const target = path.join(existing, ...steps.slice(found));
  const identity = checkPhysical(realRoot, target, shown);
  return identity === undefined ? { target } : { target, identity };
}

// The resolved path itself, checked once more step by step below the project folder (a belt behind the resolution above): it must lie
// inside, no step may be a symlink, and an existing file must be a regular file, whose dev/inode is returned (undefined: not there yet).
function checkPhysical(realRoot: string, target: string, shown: string): Identity | undefined {
  const changed = (at: string): LaneboardError =>
    new LaneboardError('SETUP_CONFLICT', `${shown}: ${at} is a symlink or lies outside the project, as setup checked the path again; nothing was written`, {
      details: { file: shown, path: at },
      fix: `replace ${shellQuote(at)} with a real file or folder inside the project and run setup again`,
    });
  if (!inside(realRoot, target)) throw changed(target);
  let current = realRoot;
  let stat: fs.BigIntStats | undefined;
  for (const step of path.relative(realRoot, target).split(path.sep)) {
    if (step === '') continue;
    current = path.join(current, step);
    try {
      stat = fs.lstatSync(current, { bigint: true });
    } catch (err) {
      // Missing: this step and the rest are created by setup as real folders and file.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
      throw cannotRead(current, err);
    }
    if (stat.isSymbolicLink()) throw changed(current);
  }
  if (stat === undefined) return undefined;
  if (!stat.isFile()) throw notRegularFile(target, shownOf(realRoot, target, shown), stat);
  return { dev: stat.dev, ino: stat.ino };
}

// SETUP_CONFLICT when a project file's backup (next to its real file) is a symlink or not a regular file: a backup is read and written only
// as a real file, never through a link, also one inside the project.
function checkBackup(bak: string, shown: string): void {
  const stat = lstatOrMissing(bak);
  if (stat === undefined) return;
  if (stat.isSymbolicLink()) {
    const linkTo = fs.readlinkSync(bak);
    throw new LaneboardError('SETUP_CONFLICT', `${shown} is a symlink to ${linkTo}; setup reads and writes its backup only as a real file; nothing was written`, {
      details: { file: shown, link: shown, target: linkTo },
      fix: `move the symlink ${shellQuote(bak)} away and run setup again`,
    });
  }
  if (!stat.isFile()) throw notRegularFile(bak, shown, stat);
}

// The end of a global file's symlink chain, also when the last link points at a file not created yet (a dotfiles manager links
// ~/.codex/config.toml into its own folder): setup creates it there, as a write through the link would. A loop is SETUP_CONFLICT.
function linkChainEnd(file: string, shown: string): string {
  let current = file;
  for (let hops = 0; hops < 40; hops++) {
    const stat = lstatOrMissing(current);
    if (stat === undefined || !stat.isSymbolicLink()) return current;
    // A relative link is relative to the folder it really lies in (that folder may itself be reached through a link).
    current = path.resolve(fs.realpathSync.native(path.dirname(current)), fs.readlinkSync(current));
  }
  throw new LaneboardError('SETUP_CONFLICT', `${shown} is a symlink loop; nothing was written`, {
    details: { file: shown },
    fix: `point ${shellQuote(file)} at a real file and run setup again`,
  });
}

// Where a planned file is read and written, checked before anything is read: a project file's real path (its backup a real file next to
// it) inside the project, a global file's end of its symlink chain.
function locateFile(file: string, shown: string, scope: PlannedFile['scope']): Pick<PlannedFile, 'target' | 'root' | 'identity'> {
  if (scope !== 'project') return { target: linkChainEnd(file, shown) };
  const root = projectRoot(file, shown);
  const { target, identity } = resolveInsideProject(file, shown, root);
  checkBackup(backupOf(target), `${shownOf(realFolder(root), target, shown)}.laneboard.bak`);
  return { target, root, ...(identity !== undefined ? { identity } : {}) };
}

// Text of a located file. A project file that is there although the check found none (no dev/inode: it appeared since) is refused:
// every write into an existing project file needs the identity the check took.
function readLocated(at: Pick<PlannedFile, 'shown' | 'scope' | 'target' | 'identity'>): string | null {
  const text = readText(at.target);
  if (at.scope === 'project' && text !== null && at.identity === undefined) {
    const err = replacedWhileRunning(at);
    throw new LaneboardError(err.code, `${err.message}; nothing was written`, { details: err.details ?? {}, fix: err.fix });
  }
  return text;
}

// Plan the install of our part into one file (reads only).
export function planAdd(file: string, shown: string, scope: PlannedFile['scope'], edit: TextEdit): PlannedFile {
  const at = { file, shown, scope, ...locateFile(file, shown, scope) };
  const before = readLocated(at);
  const after = edit.add(before);
  if (before === after) return { ...at, result: 'unchanged', before };
  if (before === null) return checkWritable({ ...at, result: 'created', write: after, before });
  // The backup is the file as it was without laneboard: never a text that already holds our part, never overwritten.
  const exclusive = edit.ownsExclusive ?? edit.owns;
  const backup = !exclusive(before) && readText(backupPath(at)) === null ? before : undefined;
  return checkWritable({ ...at, result: 'updated', write: after, diff: lineDiff(before, after), before, ...(backup !== undefined ? { backup } : {}) });
}

// Plan the removal of our part: restore the original bytes when nothing else changed, delete a file we created.
export function planRemove(file: string, shown: string, scope: PlannedFile['scope'], edit: TextEdit): PlannedFile {
  const at = { file, shown, scope, ...locateFile(file, shown, scope) };
  const before = readLocated(at);
  const original = readText(backupPath(at));
  const keptBackup = original !== null;
  if (before === null || !edit.owns(before)) return { ...at, result: 'unchanged', before, keptBackup };
  const stripped = edit.strip(before);
  // The backup itself is compared (not the backup without our part): one that holds our part never matches, so it never brings the entry back.
  // A backup without exclusive parts may hold values the user set before setup (env.LANEBOARD_DIR): equal apart from those, it is restored.
  const exclusive = edit.ownsExclusive ?? edit.owns;
  const sameAsBackup = original !== null && (edit.same(original, stripped) || (!exclusive(original) && edit.same(edit.strip(original), stripped)));
  if (original !== null && sameAsBackup) {
    return checkWritable({ ...at, result: 'restored', write: original, dropBackup: true, before });
  }
  if (original === null && edit.isEmpty(stripped)) return checkWritable({ ...at, result: 'deleted', write: null, before });
  return checkWritable({ ...at, result: 'removed', write: stripped, before, keptBackup });
}

// A shared file that another harness still needs: left as it is.
export function planKeep(file: string, shown: string, scope: PlannedFile['scope']): PlannedFile {
  return { file, shown, scope, target: file, result: 'kept', before: readText(file) };
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

// Write a file setup deleted or made itself (undo, a backup put back, the created-folder marker) without following a symlink at its
// name: O_NOFOLLOW fails with ELOOP on a link put there since, so the write never lands outside through it.
function writeNoFollow(file: string, text: string, mode = 0o666): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, mode);
  try {
    fs.writeFileSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

// Put a file back to `text` (null: it did not exist); a directory this run made for it is removed by its own undo step.
function putBack(file: string, text: string | null): void {
  if (readText(file) === text) return;
  if (text !== null) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeNoFollow(file, text);
    return;
  }
  fs.rmSync(file, { force: true });
}

// Create a file that must not exist yet (`wx`: a link or file that appeared at the path since planning fails with EEXIST and is
// left alone), then write it; `owned` runs once the file is ours, so the undo of this run never deletes what it did not make.
function writeNewFile(file: string, text: string, mode: number, owned: () => void): void {
  const fd = fs.openSync(file, 'wx', mode);
  owned();
  try {
    fs.writeFileSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

// Same file as planned (both missing counts as the same).
function sameIdentity(a: Identity | undefined, b: Identity | undefined): boolean {
  return a === undefined || b === undefined ? a === b : a.dev === b.dev && a.ino === b.ino;
}

// SETUP_CONFLICT: a project file was replaced (another file, a link) between planning and its write.
function replacedWhileRunning(p: Pick<PlannedFile, 'shown'>): LaneboardError {
  return new LaneboardError('SETUP_CONFLICT', `${p.shown} was replaced while setup ran (another file or a symlink is at its path now)`, {
    details: { file: p.shown },
    fix: 'run setup again',
  });
}

// Overwrite an existing file. A project file is opened without following a link and without truncating; only when the open file is the
// planned one (dev/inode) is it truncated and written, so a link or file swapped in after the checks is never written through.
// `owned` runs once the write may start (the undo of this run then puts the old text back).
function writeExisting(p: PlannedFile, text: string, owned: () => void = () => {}): void {
  // A project file is written only into the file the check identified; a global one follows its link chain (dotfiles).
  if (p.identity === undefined && p.scope === 'project') throw replacedWhileRunning(p);
  if (p.identity === undefined) {
    owned();
    fs.writeFileSync(p.target, text);
    return;
  }
  let fd: number;
  try {
    // O_NONBLOCK: a FIFO swapped in does not block the open (its inode differs anyway).
    fd = fs.openSync(p.target, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    // O_NOFOLLOW on a symlink fails with ELOOP: a link was put at the path after the checks.
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw replacedWhileRunning(p);
    throw err;
  }
  try {
    if (!sameIdentity(fs.fstatSync(fd, { bigint: true }), p.identity)) throw replacedWhileRunning(p);
    owned();
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

// After a new project file is created: its folder must still be inside the project (a folder swapped for a link after the checks).
function checkCreatedInside(p: PlannedFile): void {
  if (p.root === undefined) return;
  if (!inside(realFolder(p.root), fs.realpathSync.native(path.dirname(p.target)))) throw replacedWhileRunning(p);
}

// Write a plan: backups first (with the original's mode), then files; a deleted file also takes its now-empty directory
// when setup created it (marker), never a directory the user had, never a root. When a write fails, everything this run changed is put back
// and one error reports it (SETUP_WRITE_FAILED, or SETUP_CONFLICT for a project file replaced while setup ran).
export function applyPlan(plan: readonly PlannedFile[], roots: readonly string[]): void {
  // Undo steps, each with the file it puts back.
  const undo: Array<{ shown: string; run: () => void }> = [];
  // Directories a deleted file was in: checked once every file is done (two files of ours may share one, .claude/).
  const emptied = new Set<string>();
  let current: PlannedFile | undefined;
  // Again right before the first write: a project file whose path now leads elsewhere (a link put in place after planning, another
  // file) is refused too (SETUP_CONFLICT, nothing written).
  for (const p of plan) {
    if (p.root === undefined || p.write === undefined) continue;
    const now = resolveInsideProject(p.file, p.shown, p.root);
    if (now.target !== p.target || !sameIdentity(now.identity, p.identity)) {
      const err = replacedWhileRunning(p);
      throw new LaneboardError(err.code, `${err.message}; nothing was written`, { details: err.details ?? {}, fix: err.fix });
    }
  }
  try {
    for (const p of plan) {
      if (p.backup === undefined) continue;
      current = p;
      const bak = backupPath(p);
      const mode = fs.statSync(p.target).mode & 0o777;
      writeNewFile(bak, p.backup, mode, () => undo.push({ shown: `${p.shown}.laneboard.bak`, run: () => fs.rmSync(bak, { force: true }) }));
      // The mode given at creation is narrowed by umask; set it exactly (a 0600 config keeps a 0600 backup).
      fs.chmodSync(bak, mode);
    }
    for (const p of plan) {
      if (p.write === undefined) continue;
      current = p;
      if (p.write === null) {
        // unlink does not follow a link at the last component (it removes the link itself, never its target). Folders on the way are
        // followed: the real path was checked again above, and a folder swapped for a link after that check (a live local attacker)
        // would delete a same-named file there — the residual of the `wx` create below, which Node cannot close without openat.
        undo.push({ shown: p.shown, run: () => putBack(p.target, p.before) });
        fs.unlinkSync(p.target);
        emptied.add(path.dirname(p.target));
        continue;
      }
      const dir = path.dirname(p.target);
      const created = fs.mkdirSync(dir, { recursive: true });
      if (created !== undefined) undo.push({ shown: p.shown, run: () => fs.rmSync(created, { recursive: true, force: true }) });
      // Remember that this directory is ours, so --remove may delete it later (a directory the user had is never deleted).
      if (created !== undefined && !roots.includes(dir)) writeNoFollow(path.join(dir, CREATED_DIR_MARKER), CREATED_DIR_TEXT);
      if (p.before === null) {
        writeNewFile(p.target, p.write, 0o666, () => undo.push({ shown: p.shown, run: () => putBack(p.target, null) }));
        checkCreatedInside(p);
      } else {
        const before = p.before;
        writeExisting(p, p.write, () => undo.push({ shown: p.shown, run: () => writeExisting(p, before) }));
      }
      if (p.dropBackup) {
        const bak = backupPath(p);
        const restored = p.write;
        const mode = fs.statSync(bak).mode & 0o777;
        undo.push({
          shown: `${p.shown}.laneboard.bak`,
          run: () => {
            writeNoFollow(bak, restored, mode);
            fs.chmodSync(bak, mode);
          },
        });
        fs.unlinkSync(bak);
      }
    }
    current = undefined;
    for (const dir of emptied) dropCreatedDir(dir, roots);
  } catch (err) {
    // A write failed after the plan passed its checks (disk full, a race): undo this run, newest first.
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
    // A file replaced while setup ran keeps its own code and fix, with what happened to the files written before it.
    if (err instanceof LaneboardError) throw new LaneboardError(err.code, `${err.message}${after}`, { details: err.details ?? {}, fix: err.fix });
    throw new LaneboardError('SETUP_WRITE_FAILED', `writing ${shown} failed (${code})${after}`, {
      details: { file: shown },
      fix:
        code === 'EEXIST'
          ? `${shown} appeared while setup ran and was left as it is: look at it and run setup again`
          : `make ${shown} and its directory writable (a symlink must point to a writable place) and run setup again`,
    });
  }
}
