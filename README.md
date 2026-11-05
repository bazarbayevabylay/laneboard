# laneboard

laneboard is a task board and CLI with which AI coding agents run their own tasks: they create, claim, comment and close them.
People see the same tasks and can step in at any moment.

It works with Claude Code, Codex, Cursor, Gemini CLI, OpenCode and any other MCP client. No server, no database: the store is
two JSON files in the project folder.

| What | Where |
|---|---|
| Guide for agents: install, the task cycle, errors, configuration, import | [docs/agent-guide.md](docs/agent-guide.md) (in the package) |
| What changed in each version | [CHANGELOG.md](CHANGELOG.md) (in the package) |
| Architecture decision and specification | [ADR-0001 on GitHub](https://github.com/bazarbayevabylay/laneboard/blob/main/docs/adr/0001-two-json-store-cli-first.md) |
| Russian version of this file | [README.ru.md](README.ru.md) |
| License | MIT, [LICENSE](LICENSE) |

Every `sh` block of this file runs in laneboard's test suite, in order, in a fresh project, so the commands and exit codes are real.

## Install

Node.js 22 or newer, on macOS or Linux. The CLI is installed once per machine.
Windows is not supported: npm refuses the package there with `EBADPLATFORM`.
On an older Node.js every command prints one warning line (`warnings` with `--json`): install Node.js 22 and the CLI again.

Check with `node --version`. When nvm's default is older, install 22 and make it the default (agents start new shells with it):
`nvm install 22 && nvm alias default 22 && nvm use 22`. A global package belongs to the Node.js version active at install time:
after switching versions, install the CLI again.

<!-- guide:skip installs globally -->
```sh
npm i -g laneboard
```

Without the npm registry, install from git: clone, build, then install the folder or a tarball.

<!-- guide:skip installs globally -->
```sh
git clone https://github.com/bazarbayevabylay/laneboard.git
cd laneboard && npm ci && npm run build
npm i -g .
```

| Way | Result |
|---|---|
| `npm i -g .` | a link to the clone: `git pull && npm ci && npm run build` updates the CLI |
| `npm pack && npm i -g ./laneboard-*.tgz` | a copy from the tarball: the clone can be deleted afterwards |

Check: the command prints the version (`-v` too). `laneboard` alone prints the help.

```sh
laneboard --version
```

## Quick start

Two commands in the project root. `init` creates the board `./.laneboard` and adds it to this machine's registry; `setup` connects a
harness; from then on the agent works by itself.

A board has a name and a one-line description: whose project, what work. The id prefix comes from the name, at most 4 characters:
the initials of its words (`my-web-app` -> `MWA-1`) or the start of one word (`laneboard` -> `LANE-1`), a trailing number kept.
Your own prefix: `init --prefix WEB`; `laneboard config --prefix WEB` changes it while the board has no task. It must differ from every
other board's prefix on this machine (`init`, `config` and `setup` check it).

```sh
laneboard init --name web --description "ACME web shop: catalog and cart"
laneboard setup claude-code
```

This is the agent's work; it runs the same commands itself:

```sh
laneboard create "Fix the redirect after login" --status todo --assignee dev-1 --as dev-1 --json
laneboard claim WEB-1 --status in_progress --as dev-1 --json
laneboard comment WEB-1 "Cause: the redirect drops the query string" --as dev-1 --json
laneboard update WEB-1 --append-description "Repro: log in from /cart" --as dev-1 --json
laneboard finish WEB-1 --result "Fixed, redirect test added" --as dev-1 --json
laneboard list --scope all --json
```

`create` needs `--status` (no default): without it the error's `fix` is the same command with the first configured status.
The title is an argument, not an option: `create --title X` fails with the right command as its fix.
Every write replies short: `id`, the new `rev`, `status`, `assignee` (`attach` adds `attachment`, `finish` adds `commit`);
the whole task is `laneboard get WEB-1` or `--full` on the write. People read better without `--json`: `list`, `get`, `events`, `view`.

## Connect a harness

`laneboard setup <harness>` in the project root registers the MCP server `laneboard`, adds a 3-line instruction block and pins the
project to its board. Several harnesses per project are fine. A second run reports `unchanged`; `--dry-run` writes nothing.

```sh
laneboard setup codex
```

| Harness | MCP entry | Instructions | Board pin |
|---|---|---|---|
| claude-code | `.mcp.json` | `CLAUDE.md` | `env.LANEBOARD_DIR` and `env.LANEBOARD_DEFAULT_AGENT` in `.claude/settings.local.json` (kept out of git by `.git/info/exclude`); in a folder with a board of its own inside another git repository, or at a repository root that holds other boards, they go to the committed `.claude/settings.json` (Claude Code reads the local file only at the repository root, so a pin there would reach every board) — do not commit that machine path, or keep one board per repository; plus the SessionStart and PostToolUse hooks in `.claude/settings.json` |
| codex | `~/.codex/config.toml` (global; `CODEX_HOME` moves it) | `AGENTS.md` | `LANEBOARD_DIR=<board>` before each command in the instructions; the entry forwards `LANEBOARD_DIR`: start Codex in the project folder or as `LANEBOARD_DIR=<board> codex`, never export it (Codex in other projects would write to this board) |
| cursor | `.cursor/mcp.json` | `AGENTS.md` | `mcp --dir <board>` in the entry, `LANEBOARD_DIR=<board>` in the instructions |
| gemini | `.gemini/settings.json` | `GEMINI.md` | `mcp --dir <board>` in the entry, `LANEBOARD_DIR=<board>` in the instructions |
| opencode | `opencode.json` | `AGENTS.md` | `mcp --dir <board>` in the entry, `LANEBOARD_DIR=<board>` in the instructions |

- Claude Code hooks: SessionStart prints the rules, the board and your tasks (`laneboard prime --hook`); after `Edit`, `Write`,
  `MultiEdit` or `NotebookEdit` without a task in progress, one reminder line. Edits made through Bash are not seen.
- Under the default name the edit reminder stays silent while any open task of the board has an assignee (anybody's: subagents
  share the default name). For reminders about your own tasks only, set `LANEBOARD_AGENT=<your name>`.
- A board that came with a cloned repository is not shown to the agent by the hook until `laneboard setup claude-code` registers it.
- Claude Code plugin instead of `setup claude-code`: `/plugin marketplace add bazarbayevabylay/laneboard`, then
  `/plugin install laneboard@laneboard`. Use one of them, not both: they register the same server and hooks.
- A symlink inside the project is followed (`CLAUDE.md -> AGENTS.md` puts the block into `AGENTS.md`). A link leading outside the
  project, a dangling one or one into `.git` is refused (`SETUP_CONFLICT`), nothing written.
- Text you put between `<!-- laneboard:start -->` and `<!-- laneboard:end -->` is never deleted: setup refuses and names the lines.
- `.git/info/exclude` gets a laneboard block: the local settings, `*.laneboard.bak` backups and `.laneboard-created` markers stay out of git.

## Any MCP client

Any client that starts stdio MCP servers can use laneboard. Give the server the board and a default name in a config file of
the project (a global config would pin every project of the machine to this one board):

```json
{ "command": "laneboard", "args": ["mcp", "--dir", "/abs/path/to/project/.laneboard", "--as", "codex-1"] }
```

- Call `task_prime` first: it returns the rules for MCP, the statuses in order, the declared fields and your and the free tasks.
- Without `--dir` the server finds the board from the folder the client starts it in, or takes `LANEBOARD_DIR`. A server that finds
  none answers every call with `STORE_NOT_FOUND`: its `fix` says how to start your client for the project (Codex: in the project folder
  or `LANEBOARD_DIR=<board> codex`, never `--dir` in the global `~/.codex/config.toml`), and `details.boards` lists the boards.
- A server whose `--dir` is not the board of its folder warns on every call, as `LANEBOARD_DIR` does: check `prefix` in each reply.
- Your name on writes: the tool's `actor`, else `mcp --as`, else `LANEBOARD_AGENT`, else the session's default name.
- The client cannot find `laneboard`? Put the absolute path from `command -v laneboard` into `command`; with nvm that path changes
  with the Node.js version, so update it after switching.
- 12 tools: `task_prime`, `task_create`, `task_get`, `task_list`, `task_update`, `task_claim`, `task_comment`, `task_finish`,
  `task_attach`, `task_archive`, `task_restore`, `task_events`. `init`, `config`, `setup`, `delete`, `redact`, `import` and `doctor` are CLI-only.

```sh
laneboard mcp --dir .laneboard --as codex-1 < /dev/null
```

## Agent names

Every write is signed with a name: `--as` (MCP `actor`), else `LANEBOARD_AGENT`, else the session's default name.
Names use letters, digits and `. _ : @ -`. Names are self-chosen, so every rule about who may do what guards against an agent's
mistake, not against a hostile agent.

| What | How |
|---|---|
| Default name in Claude Code | `claude-code@<base>:<first 8 characters of the session id>`; the base is the global git `user.name` (`~/.gitconfig`, read without running git), else the OS user; `setup` writes it, Claude Code gives the session id |
| Two parallel sessions | two names, so the second one's `claim` fails with `ALREADY_CLAIMED` |
| Where a name came from | every event has `actor_source`: `explicit` or `default`; `get` marks `(default name)` |
| Subagents of one session | share its default name, so each passes its own `--as`; `prime` under the default name says so |
| After `/clear` or a restart | a new session id, a new name. The SessionStart hook (except resume and compaction) lists the unfinished tasks of earlier sessions with the same base and their age; `claim <ID> --resume` takes one over. `ALREADY_CLAIMED` on such a task offers `--resume` once that session wrote nothing for 15 minutes, else a comment; `--resume` of a live session works with a warning |
| Codex, Cursor, Gemini CLI, OpenCode | no default name (no session id): pass `--as` |

```sh
LANEBOARD_DEFAULT_AGENT=claude-code@ann CLAUDE_CODE_SESSION_ID=a1b2c3d4 laneboard create "No name given" --status todo --assignee claude-code@ann:a1b2c3d4 --json
LANEBOARD_DEFAULT_AGENT=claude-code@ann CLAUDE_CODE_SESSION_ID=e5f6a7b8 laneboard prime
LANEBOARD_DEFAULT_AGENT=claude-code@ann CLAUDE_CODE_SESSION_ID=e5f6a7b8 laneboard claim WEB-2 --resume --json
```

## Finishing work

`finish` is one write: the result comment (`result: true` in its event), a link to the current git commit (`commit=<HEAD>`;
`--no-commit` skips it, outside git there is none), then the status. Commit first: uncommitted changes or a HEAD older than the claim
give a warning; git is asked with a 2-second limit, and without git the task is still finished.

- `--status` takes any status but the first. The assignee's `finish` into a status that is not final hands the task in (`handed_in: true`).
  Somebody else's task `finish` only accepts, into the final status, and only after its assignee handed it in (`accepted: true`).
- Handed in again into the same status with a new result: the result is recorded; the same result again changes nothing.
- Git worktree: the board of the main checkout is found by itself, and `finish` there links the worktree's HEAD.
  `finish` in the main checkout while other worktrees have newer commits warns with the fix; `--commit <sha>` names the commit
  (MCP: `cwd` = your worktree's absolute path, or `commit`).
- Subtasks: `create ... --parent WEB-1` (a task of the same board); `get` lists `children`, `list --parent WEB-1` the direct ones.
- `update --append-description` adds a paragraph without `--expected-rev`; `--description` replaces the text and keeps the old one in its event.
- `--expected-rev` is needed only for edits on top of what you read (description, fields); never for status, comment, claim or finish.

## Orchestrators

### Checks in N steps, reviewers, creators

Optional keys of the board; a board without them works as above. Turning one on writes `config.json` as `laneboard/config@2`
(laneboard 0.3.x refuses such a board); `none` turns each off again.

```sh
laneboard config --review-statuses review --reviewers lead --json
laneboard create "Add rate limiting" --status todo --assignee dev-1 --as lead --json
laneboard claim WEB-3 --status in_progress --as dev-1 --json
laneboard finish WEB-3 --result "Limiter added, 5 req/min" --as dev-1 --json
laneboard finish WEB-3 --status done --result "Self-accept" --as dev-1 --json  # exit 2
laneboard finish WEB-3 --result "Checked again" --as lead --json  # exit 2
laneboard finish WEB-3 --status done --result "Checked with an admin token" --as lead --json
laneboard config --review-statuses none --reviewers none --json
```

- `--review-statuses code_review,qa`: the checks in order (between the first and the final status). The assignee's `finish` hands in
  to the check the task is in, else the first check. A checker names where the task goes: `finish <ID> --status <next>` passes it to
  the next check, from the last one `--status <final>` accepts it.
- A checker's `finish` without `--status`, with the check the task is in or past the next one is refused: the task may have moved on
  since your read (two checkers on one queue). Its fix only reads the task (`laneboard get <ID>`); the message names both commands,
  the pass (`finish --status <next>`) and the return for rework. No fix of a checker's refusal passes on or accepts a task.
- `--reviewers rev,orch`: who checks (default: anybody but the author of the work). The author never passes on or accepts its own work.
- Any of the reviewers makes any check, both in a row too: the two lists are not paired (`rev` is not bound to `code_review`).
  A checker's `finish` applies to the check the task is in now, whoever passed it there.
- A task waiting in a check is handed in: the author's `finish`, `update` or `claim` into another check or the final status gets
  `INVALID_VALUE` "handed in already, waits in <check> for the check of <checkers>", its fix a comment. Never back to an earlier check.
- A task enters a check only with `finish`, so the checkers always see it: `update`, `claim`, `create` and `import` into a check are
  refused. The holder's fix is the hand-in with `finish`; a checker's is `get` with both commands; anybody else's a comment to the holder.
- `--creators orch`: only these names create tasks, subtasks and imports; others get `INVALID_VALUE` with a fix that asks for a task.
- Return for rework: the checker comments why, then `update <ID> --status <work status>`; the assignee's `prime` shows that comment.
  A checker's `finish --status` with an earlier check or any work status (also one between two checks) is refused; its fix is that
  comment and update in one line.
- Subagents learn their part from `laneboard prime`: the checks, the checkers, "Waiting for your check" with the ready
  `pass: laneboard finish <ID> --status <next> ...` under each task (MCP `task_prime`: `roles.waiting[].next_status`).
- Boards created before 0.4.0 keep working as they were; checks are turned on only by hand with `laneboard config`.

### Taking over a claimed task

`claim` never takes a task from another name. The orchestrator reassigns it and says why:

```sh
laneboard create "Profile the export" --status todo --as dev-1 --json
laneboard claim WEB-4 --status in_progress --as dev-1 --json
laneboard claim WEB-4 --as dev-2 --json  # exit 4
laneboard update WEB-4 --assignee dev-2 --as lead --json
laneboard comment WEB-4 "dev-1 stopped; dev-2 takes over" --as lead --json
```

### All boards at once

`list --all-boards` merges the tasks of every board of this machine (`--open`: without final statuses). `prime --all-boards` adds a
section of at most 3000 characters: one counts line per board, then the urgent tasks across boards (`waiting-owner`, handed in, stale =
in work with no change for 4 hours), each class with `+N more: <command>` when cut. The label `waiting-owner` plus a comment with the
question marks a task that waits for the owner.

```sh
laneboard list --all-boards --open --json
laneboard prime --all-boards --as lead
```

## Statuses, fields and labels

- Statuses are the board's columns, in order; the last one is final. `init --statuses todo,in_progress,review,done` (the default) sets
  them, `laneboard config --statuses a,b,c` changes the whole list later (at least 2). A status that active tasks are in is dropped only
  after they move. Agents never change statuses.
- Fields are typed extra keys: `laneboard config --field <key>:<type>[:<description>]` declares or changes one (`string`, `number`,
  `boolean`, `string[]`, `json`), `--drop-field <key>` removes it once no active task holds a value. Number fields take decimal
  notation only (`-?digits[.digits]`): `0x10`, `1e3` and `Infinity` are refused.
- Labels: lowercase Latin letters, digits and `. _ -`, starting with a letter or a digit, up to 40 (`ui-bug`, `zone-api`).
  `zone:api` is refused with a fix that holds the normalized label.

```sh
laneboard config --field priority:number:"0 = highest" --field area:string --json
laneboard create "Fix the cart total" --status todo --label ui-bug --field priority=1 --field area=cart --as dev-1 --json
laneboard create "Zone label" --status todo --label zone:api --as dev-1 --json  # exit 2
```

## Monorepo and several boards

One board per git repository is the default: a package with its own `AGENTS.md` or `CLAUDE.md` uses the board at the repository root,
with no warning. Inside git only a `.git` (a nested repository, a submodule) or a board of its own marks another project.

- `setup` in a package pins it to the root's board. Claude Code: the board path goes to the root's `.claude/settings.local.json`
  (git does not see it); the package commits only the hooks. An older pin in `.claude/settings.json` is moved with a warning: commit that change.
  The exception: a package with a board of its own, or any folder of a repository whose root holds other boards, keeps its pin in
  the committed `.claude/settings.json` (the root's local file would pin every board in the repository). Do not commit that file's
  `env` (a machine path), or keep one board per repository. setup says so in one warning whenever the pin goes to that file.
- A package with a board of its own: `laneboard init --dir packages/<name>/.laneboard`; a plain `init` in a package of a repository
  whose board lies above is refused with the fix.
- Which board a command uses: `--dir <path>`, else `LANEBOARD_DIR`, else `.laneboard/` in the current folder or above (a linked git
  worktree: its main checkout's). Every reply names `store` and `prefix`. Not sure which board is yours: `laneboard boards --json`.
- `--board <prefix|name|path>` opens another board read-only (`view`, `list`, `get`, `events`, `board`); a write through it is `STORE_READ_ONLY`.
- A task of another board is linked with `--link task=BILL-1` (`update --add-link`); `get` shows its status.

```sh
mkdir -p packages/billing
laneboard init --dir packages/billing/.laneboard --name billing --description "Billing package: invoices and payments"
laneboard create "Invoice rounding" --status todo --dir packages/billing/.laneboard --as dev-1 --json
laneboard boards --json
laneboard list --board BILL --json
```

## Viewing boards

`laneboard view` draws the board in the terminal: a column per status, cards with id, title, assignee and time in status, the newest
comment under each (`> text`; finish's result `= text`). Filters: `--assignee`, `--label`, `--text`; `view --watch` redraws after
every write. `laneboard boards` lists the boards of this machine (`~/.laneboard/boards.json`); a path without a board any more is `missing`.

```sh
laneboard view
laneboard view --assignee dev-1
```

### Board in the browser

The browser board is read-only by design: tasks change through agents, the CLI and MCP. `laneboard board` in the project folder
prints `http://127.0.0.1:7420/` and serves until Ctrl+C.

| What | How |
|---|---|
| Port | `--port N`, else `board.port` of `config.json` (7420); busy: `PORT_IN_USE`, `--port 0` takes a free one |
| Boards | every board of this machine is a tab; `--board <prefix\|name\|path>` opens another one first |
| Access | this machine only (127.0.0.1), a new token per run |
| Live | a write shows within 1-2 s; the page reloads data every minute |

Read the same data over HTTP (a check script, a test): take the token from `<meta name="laneboard-token" content="...">` of the page
`/`, send it as the header `X-Laneboard-Token`. Read-only `GET` routes: `/api/boards`, `/api/board` (`?board=`, `assignee`, `label`,
`text`), `/api/tasks` (`scope`, `status`, `limit`, `offset`), `/api/tasks/<id>`; `/api/events` streams changes (token as `?token=`).

## Storage and safety

Everything lives in the project's `.laneboard/`: `config.json` (settings), `active.json`, `archive.json`, their `.bak` (the previous
version), `attachments/<id>/`, and a `lock` folder only while a write runs. Every write takes the lock, reads fresh, checks and replaces
the file atomically, so many agents write at once without losing data; a stale `--expected-rev` is `REV_CONFLICT`.

- Do not commit `.laneboard/`: `init` puts a `.gitignore` there. A board in git is not supported: a merge can give two tasks one id;
  `laneboard doctor --fix` gives the later copy a new id and names the tasks that point to the old one.
- One machine. The lock is a folder, so network drives and folders synced between machines (Dropbox, iCloud) are not supported.
- A full disk: the command fails with `INTERNAL` and "free disk space"; the board and its `.bak` stay whole. File modes follow your umask.
- `laneboard doctor` checks and exits 6 while a problem is left; `--fix` repairs what it can (attachment files without metadata go
  to `attachments/.orphaned/`, never deleted); `--restore-backup` brings back the `.bak` version. A lock with a time in the future is
  removed after 10 s without change.
- `laneboard delete <ID> --confirm <ID>` is for people: the archive keeps a trace (id, title, who and when); `get` and
  `list --scope archive` show it as `deleted <at> by <who>` (`deleted {at, by}` with `--json`). A pasted secret:
  `laneboard redact <ID> --text-file <file>` removes it from the task and from the `.bak`; redact first, then delete.
- Attachments named like keys or secrets (`.env*`, `*.pem`, `id_rsa*`, `*credentials*`, `.npmrc` and more, `attachments.deny_names`)
  are refused; `*credentials*` may refuse a harmless name too: rename the file.

```sh
laneboard doctor
```

## Moving a folder or a machine

A moved project folder: run `laneboard setup <harness>` in the new folder (it re-pins), then `laneboard boards --forget <old path>/.laneboard`.
Another machine: copy the project with its `.laneboard/`, install the CLI, run `laneboard setup <harness>` there: the board path in the
project's files is this machine's.

## Import existing tasks

`laneboard import markdown <folder>` (files with YAML frontmatter), `import json <folder|file>` (task files with history) and
`import checklist TODO.md --status todo` (a Markdown TODO list: an item is a task, `[x]` the final status, an indented item a subtask).
An unknown key or status stops the import and lists every value; `--dry-run` writes nothing; a second run skips what it imported.
Options and examples: [docs/agent-guide.md](docs/agent-guide.md#4-migrate-import-existing-tasks).

```sh
printf '# TODO\n- [x] Set up the schema\n- [ ] Dark mode toggle\n  - [ ] Keep the choice after a reload\n' > TODO.md
laneboard import checklist TODO.md --status todo --as dev-1 --json
```

## Uninstall

`setup <harness> --remove` takes out only what setup wrote and restores the bytes files had before it. Codex keeps the global entry
while another project of the machine still uses it; `setup codex --remove --global` removes it anyway.

```sh
laneboard setup codex --remove
laneboard setup claude-code --remove
```

Then, if laneboard is no longer needed: delete the project's `.laneboard/` and the CLI (`npm uninstall -g laneboard`).

## Upgrading from 0.3.x

- Boards of 0.3.x open as they are: store and `config.json` keep their format; the new config keys (checks, reviewers, creators) are
  optional, and `config@2` is written only when you turn one on. 0.3.x reads every board that has none of them.
- MCP: `task_delete` is gone (delete is for people, CLI-only; a call of it is an unknown-tool error whose fix names `laneboard delete`); `task_prime` is new.
- Re-run `laneboard setup <harness>` in each project: the instruction block, the hook matcher and the Claude Code pin are updated in place.
- The new `deny_names` defaults apply to boards created by 0.4.0; an older board keeps its list.

## Limits

| What | Why |
|---|---|
| macOS and Linux only | the atomic rename and the lock are tested there; Windows is not in CI |
| One machine, local disks | the lock is a folder in the file system |
| Up to about 10 000 tasks per board | every command reads the file whole; archive old tasks |
| The board path of this machine in project files | `setup` pins it; on another machine run `setup` again |
| The browser board is read-only | agents, the CLI and MCP change tasks |
