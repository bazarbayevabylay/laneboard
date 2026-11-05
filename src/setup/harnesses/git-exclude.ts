// The marked block every harness keeps in the repository's .git/info/exclude (git's own ignore list, never committed): the files setup
// leaves in the working tree stay out of commits without touching the project's .gitignore. They are Claude Code's local settings
// (a machine path and the user's name), the `.laneboard.bak` backups of the user's files and the `.laneboard-created` markers of
// folders setup made (newcomer F6). Every harness writes the same block, so `--remove` of one keeps it while another still uses it.
import fs from 'node:fs';
import path from 'node:path';
import { linkedWorktree } from '../../core/index.ts';
import type { TextEdit } from '../files.ts';
import { blockEdit } from '../md-block.ts';
import type { Markers } from '../md-block.ts';
import type { HarnessContext, HarnessFile } from './common.ts';

export const GIT_EXCLUDE = '.git/info/exclude';
// gitignore syntax: `#` starts a comment, so the markers are comments.
const EXCLUDE_MARKERS: Markers = { start: '# laneboard:start', end: '# laneboard:end' };
// The last two lines are the block 0.2.0 and 0.3.1 wrote (a block of those versions is laneboard's and is updated); the pattern for
// the local settings file is the one Claude Code adds to the global excludes for it. Patterns without a slash match in every folder.
const EXCLUDE_BODY = [
  '# backups of your files (laneboard setup --remove restores them) and markers of folders laneboard setup made',
  '*.laneboard.bak',
  '.laneboard-created',
  "# .claude/settings.local.json holds this machine's store path and your name (laneboard setup claude-code)",
  '**/.claude/settings.local.json',
].join('\n');

// Closest folder from cwd up that holds `.git`, or undefined.
export function gitRoot(cwd: string): string | undefined {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

// The repository's exclude file when cwd lies in a repository with a `.git` directory; in a linked worktree (`git worktree add`, its
// `.git` is a file) the one in the repository's common git directory, which git reads for every worktree (`git rev-parse --git-path
// info/exclude` names it; A18). Else undefined: no repository, or a submodule (its `.git` file names no common directory).
export function excludeFile(c: HarnessContext): string | undefined {
  const root = gitRoot(c.cwd);
  if (root === undefined) return undefined;
  if (fs.statSync(path.join(root, '.git')).isDirectory()) return path.join(root, GIT_EXCLUDE);
  const tree = linkedWorktree(c.cwd);
  return tree === undefined ? undefined : path.join(tree.commonDir, 'info', 'exclude');
}

// Text with patterns of its own: a line that is neither blank nor a comment. `git init` writes an exclude file of comments only.
function hasPatterns(text: string): boolean {
  return text.split('\n').some((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
}

// Edit of the exclude file. A file of comments only (git's default) gets no backup: --remove takes the block out and gives back the
// same text, and a backup of git's template only made setup warn about a file nobody wrote (newcomer F11).
function excludeEdit(file: string): TextEdit {
  const edit = blockEdit(file, EXCLUDE_MARKERS, EXCLUDE_BODY);
  // An empty file (0 bytes) is still backed up, so --remove gives it back instead of deleting it.
  return { ...edit, ownsExclusive: (text) => edit.owns(text) || (text !== '' && !hasPatterns(text)) };
}

// The exclude file as a harness file: written in every git repository with a `.git` directory and in a linked worktree; at the
// repository root it is ./.git/info/exclude, else (a folder inside the repository, the home directory as the root, a worktree) the
// repository's one.
export const gitExclude: HarnessFile = {
  path: GIT_EXCLUDE,
  scope: 'project',
  edit: (f) => excludeEdit(f),
  moved: (c) => {
    const file = excludeFile(c);
    return file === path.join(c.cwd, GIT_EXCLUDE) ? undefined : file;
  },
  applies: (c) => excludeFile(c) !== undefined,
};
