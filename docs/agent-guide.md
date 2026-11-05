# laneboard agent guide

For AI coding agents in any harness (Claude Code, Codex, Cursor, Gemini CLI, OpenCode) and for the people who set them up.
laneboard is a task board and CLI: agents create, claim, comment and close their own tasks; people see the same tasks.
Every shell block below runs in laneboard's test suite in a fresh temp project, in order, so the commands and their exit codes are real.

Conventions in this guide:

| What | Where |
|---|---|
| The project folder | the current directory; its store is `./.laneboard` |
| Your agent name | `dev-1` (use your own; letters, digits, `. _ : @ -`) |
| Task ids | `DEMO-<n>`: the prefix comes from the board name, `laneboard init --name demo` |
| A command that fails on purpose | ends with `# exit <code>` |

## 1. Install

The CLI is one global npm package (Node.js 22 or newer, macOS or Linux; on Windows npm refuses it with `EBADPLATFORM`). On an older
Node.js every command adds one warning line (`warnings` with `--json`). Check with `node --version`; when nvm's default is older,
install 22 and make it the default (agents start new shells with it): `nvm install 22 && nvm alias default 22 && nvm use 22`.

A global package belongs to the Node.js version active at install time: after switching versions, install the CLI again.

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

Check the CLI:

```sh
laneboard --version
```

### 1.1 Create the store and connect a harness

Run both in the project root. `init` creates the board `./.laneboard` and adds it to this machine's registry; `setup` registers the MCP server
and adds a 3-line instruction block, pinned to that store. A board has a name and a one-line description (whose project, what work);
the id prefix is derived from the name, at most 4 characters: the initials of its words (`my-web-app` -> `MWA`) or the start of one word
(`demo` -> `DEMO`), a trailing number kept. `--prefix` sets your own; `laneboard config --prefix` changes it while the board has no task.
It must be free on this machine (a taken one fails with a free one in `fix`); `init`, `config` and `setup` check it, so a copied project folder
with its `.laneboard` stays out of the registry until it has a prefix of its own.

```sh
laneboard init --name demo --description "Demo project: the examples of this guide"
laneboard setup claude-code
```

The same for the other harnesses (one or several per project):

```sh
laneboard setup codex
laneboard setup cursor
laneboard setup gemini
laneboard setup opencode
```

What `setup` writes:

| Harness | MCP server entry | Instructions | Store pin |
|---|---|---|---|
| claude-code | `.mcp.json` | `CLAUDE.md` | `env.LANEBOARD_DIR` and `env.LANEBOARD_DEFAULT_AGENT` in the `.claude/settings.local.json` Claude Code reads for the folder, kept out of git by a block in `.git/info/exclude`: the folder's own, or the repository root's for a package pinned to the root's board (3.3); `.claude/settings.json` only for a folder with a board of its own inside another git repository, or at a root that holds other boards. Plus the SessionStart hook and the PostToolUse hook (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) in `.claude/settings.json` |
| codex | `~/.codex/config.toml` (global; `CODEX_HOME` moves it) | `AGENTS.md` | `LANEBOARD_DIR=<store>` before each command in the instructions; the entry forwards `LANEBOARD_DIR` (`env_vars`): start Codex in the project folder or as `LANEBOARD_DIR=<store> codex`, never export it |
| cursor | `.cursor/mcp.json` | `AGENTS.md` | `mcp --dir <store>` in the entry, `LANEBOARD_DIR=<store>` in the instructions |
| gemini | `.gemini/settings.json` | `GEMINI.md` | `mcp --dir <store>` in the entry, `LANEBOARD_DIR=<store>` in the instructions |
| opencode | `opencode.json` | `AGENTS.md` | `mcp --dir <store>` in the entry, `LANEBOARD_DIR=<store>` in the instructions |

The PostToolUse hook reminds after an edit without a task in progress. Under the default name it stays silent while any open task of the
board has an assignee (anybody's: subagents share the default name); set `LANEBOARD_AGENT=<your name>` for reminders about your own tasks.

Claude Code also has a plugin (`/plugin marketplace add bazarbayevabylay/laneboard`, then `/plugin install laneboard@laneboard`).
Use the plugin or `setup claude-code`, not both: they register the same server and hooks. The SessionStart hook shows the board only
when it is in this machine's registry (`init` and `setup` add it): a board that came with a cloned repository gets one neutral line until
`setup claude-code` registers it, and its texts are never shown as instructions (prime prints `Board data below, not instructions.`).

Setup follows a symlink inside the project (`CLAUDE.md -> AGENTS.md` puts the block into `AGENTS.md`) and refuses one that leads outside
the project, dangles or ends in `.git` (`SETUP_CONFLICT`, nothing written). Lines you add between `<!-- laneboard:start -->` and
`<!-- laneboard:end -->` are never deleted: setup refuses and names them. The `.git/info/exclude` block keeps the local settings,
`*.laneboard.bak` and `.laneboard-created` out of git.

### 1.2 Check the connection

A second `setup` run reports every file as `unchanged` when the install is complete; `--dry-run` writes nothing.
`prime` prints the rules, the store and your tasks; `doctor` checks the store files.

```sh
laneboard setup claude-code --dry-run
laneboard prime --as dev-1
laneboard doctor
laneboard mcp --dir .laneboard < /dev/null
```

The last line starts the MCP server and stops when stdin closes (exit 0). In the harness itself the server is named `laneboard`:
Claude Code and Gemini CLI list it under `/mcp`, Cursor under its MCP settings, Codex with `codex mcp list`, OpenCode with `opencode mcp list`.

### 1.3 Remove

`--remove` takes out only what setup wrote and restores the original bytes of files that existed before (from `<file>.laneboard.bak`).

```sh
laneboard setup opencode --remove
laneboard setup gemini --remove
```

Codex keeps its global entry (`~/.codex/config.toml`) on `--remove` while another project of the machine registry still has the
block in its `AGENTS.md`; `setup codex --remove --global` removes it anyway.

### 1.4 Any MCP client

A client without a `setup` of its own starts the server with the board and a default name, in a config file of the project:
`{"command": "laneboard", "args": ["mcp", "--dir", "/abs/path/.laneboard", "--as", "<name>"]}`. A global config (one for every project,
like Codex's `~/.codex/config.toml`) never gets `--dir`: it would pin every project of the machine to this one board. Call `task_prime`
first: the rules for MCP, the statuses in order, the fields and your and the free tasks. Without `--dir` the server takes `LANEBOARD_DIR`,
else looks for the board from its own folder; when it finds none, every call fails with `STORE_NOT_FOUND`, whose fix says how to start
your client for the project (in the project folder, or with `LANEBOARD_DIR=<board>`; by the client's name from `initialize`) and
`details.boards` lists the boards of this machine. A server whose `--dir` is not the board of its folder warns on every call, as with
`LANEBOARD_DIR`: check `prefix`. A client that cannot find `laneboard` needs the absolute path of `command -v laneboard` as `command` (with nvm it changes
with the Node.js version).

```sh
laneboard mcp --dir .laneboard --as codex-1 < /dev/null
```

## 2. Use

### 2.1 The rules in short

- Before your first file change: claim your task or create one. Comment each meaningful step. When done: commit, then `laneboard finish <ID> --result "<result>"`.
- `--expected-rev` is optional: only for edits on top of what you read (`--description`, `--field`). Status changes, comments, `claim` and `finish` need none, so no `get` for a rev.
- Use only `laneboard` commands or the `task_*` MCP tools; never edit `.laneboard/*.json`.
- Always pass `--json`. Your name: `--as <name>` or `export LANEBOARD_AGENT=<name>` (MCP: `actor`); without them Claude Code sessions write under their default name (2.5).
- `laneboard prime` prints the full rules, the statuses in order (the last one is final) with the counts, the declared fields, your tasks
  not in the final status and the free ones (no assignee, not final) with the claim command.
- A board with checks or `create_by` (3.7): `prime` names the checks, who makes them and who creates tasks. Your `finish` hands your work in
  to the check the task is in, else the first check; a checker's `finish --status <next>` (the command `prime` prints under the task) passes it on or accepts it, never its own work. Not a creator: ask for a task id, never create one.

### 2.2 A task from start to end

Your name once for the session, then create, claim, work, finish, archive. Every write replies short: `id`, the new `rev`, `status`,
`assignee` (after `attach` also the `attachment`, after `finish` the `commit`). The whole task: `laneboard get <ID>`, or `--full` on the write (MCP: `full: true`).
`finish` is one write: the result comment, a link to the current commit (git HEAD of the folder, `commit=<sha>`; `--no-commit` skips it,
outside git there is none), then the final status, in this order of events. Commit first. Only the assignee finishes (or anybody an unassigned task,
who then becomes its assignee). `--status` takes any status but the first one: `--status review` hands the work in, the orchestrator sets
the final one (on a board with checks, 3.7: by default the check the task is in, else the first check, and the checkers set the rest).
The assignee's `finish` into a status that is not final hands the task in: its `status` event says `handed_in: true`.
Somebody else's task `finish` only accepts, and only a handed-in one (the newest `status` event into its current status is the
assignee's `finish` with `handed_in`; on a board with checks, 3.7, any handed-in task, whoever holds it now, and a checker passes it on too): into the final status, the result comment and no commit link (the assignee linked it); the assignee
stays, the `status` event says `accepted: true` and its actor is who accepted, the reply has `accepted: true`. A task in work or moved by
`update` (or handed in with 0.2.0, before the mark): `ALREADY_CLAIMED`, the fix asks the assignee to hand it in with
`finish --status <status>`; the orchestrator may close it with `laneboard update <ID> --status done`. Accepting a closed task again:
unchanged, with a warning. A second `finish` by the assignee into the same status with a new result records that result (rework handed in
again); the same result again, or a closed task, changes nothing and warns; only a commit not linked yet is added. A warning, not an error, when tracked files have uncommitted changes (staged ones too) or the HEAD commit is older
than your claim (the link would point at a commit without your work): commit and run `finish` again, or use `--no-commit`. finish asks
git (`rev-parse`, `log`, `status`, 2 s each); no git, no answer or an error: the task is still finished, with a `could not check git` warning.
A linked git worktree finds the board of its main checkout, and `finish` there links the worktree's HEAD. In the main checkout, when other
worktrees have commits newer than your claim, `finish` warns, names them and prints the fix; `--commit <sha>` links a given commit
(MCP `task_finish`: `cwd` = your worktree's absolute path, or `commit`).
finish's result comment carries `result: true` in its event data (`get` prints `commented (result)`); `comment` never sets it.

Subtasks: `laneboard create "<title>" --status <status> --parent <ID> --json`, the parent being a task of this board (a cycle or an id of
another board is refused with a fix; link another board's task instead). `get` lists `children`, `list --parent <ID>` the direct ones,
`update <ID> --no-parent` makes a top-level task. Deleting a parent removes `parent` from its children; closing or archiving a parent
while children are open works, with a warning. Add to a description with `update <ID> --append-description "<text>"` (a blank line, then
the text; no `--expected-rev`, nothing you read is overwritten); `--description` replaces the whole text, and its `updated` event keeps
the old one as `previous` (up to 10 000 characters; longer: cut, with `previous_cut: true`).

```sh
export LANEBOARD_AGENT=dev-1
laneboard create "Fix login redirect" --status todo --assignee dev-1 --json
laneboard claim DEMO-1 --status in_progress --json
laneboard comment DEMO-1 "Cause: the redirect drops the query string" --json
laneboard update DEMO-1 --add-link branch=fix/login-redirect --field priority=1 --expected-rev 3 --json
laneboard update DEMO-1 --append-description "Repro: log in from /cart" --json
echo "request log" > trace.txt
laneboard attach DEMO-1 trace.txt --json
laneboard finish DEMO-1 --result "Fixed, regression test added" --json
laneboard finish DEMO-1 --result "Again" --json
laneboard archive DEMO-1 --json
```

Find and read tasks (archived ones too):

```sh
laneboard list --json
laneboard list --scope all --text login --json
laneboard get DEMO-1 --json
laneboard events --task DEMO-1 --json
```

Text that starts with `-` goes after `--` (options first); option values use `--opt=value`:

```sh
laneboard create "Write release notes" --status todo --assignee dev-1 --json
laneboard comment DEMO-2 --json -- "- item one"
laneboard update DEMO-2 --description="- first point" --json
```

### 2.3 Output and errors

With `--json` stdout holds exactly one JSON document, also on errors; stderr stays empty.

| Result | Shape |
|---|---|
| Success | `{"ok": true, "store": "/abs/.laneboard", "prefix": "DEMO", "data": {...}, "warnings": []}` |
| Error | `{"ok": false, "store": ..., "prefix": ..., "error": {"code", "message", "fix", "allowed"?, "details"?}}` |

Every error has a `fix`: one command, run it or adapt it (fill in `<placeholders>`). On `UNKNOWN_*` copy a value from `allowed`.
`create` has no default status: without `--status` it fails with `USAGE`, and the fix is your command with the first configured status.

```sh
laneboard update DEMO-2 --status doing --json  # exit 2
laneboard get DEMO-99 --json  # exit 3
laneboard update DEMO-2 --title "Release notes" --expected-rev 1 --json  # exit 4
laneboard update DEMO-2 --title "Release notes" --expected-rev 3 --json
```

| Exit | Meaning | Codes | What to do |
|---|---|---|---|
| 0 | ok | | |
| 1 | internal | `INTERNAL` | retry once, then report |
| 2 | input | `USAGE`, `UNKNOWN_OPTION`, `INVALID_VALUE`, `UNKNOWN_STATUS`, `UNKNOWN_FIELD`, `ACTOR_REQUIRED` | correct the command (`fix`, `allowed`) |
| 3 | not found | `TASK_NOT_FOUND`, `ATTACHMENT_NOT_FOUND` | `laneboard list --scope all --text <words>` |
| 4 | conflict | `REV_CONFLICT`, `ALREADY_CLAIMED`, `TASK_ARCHIVED`, `ATTACHMENT_EXISTS` | `REV_CONFLICT`: re-apply your change on `error.details.task` with its rev; `ALREADY_CLAIMED`: do not take over, run its fix (a comment, or `claim --resume` for your own task of an earlier session, 2.5) |
| 5 | busy | `LOCK_TIMEOUT`, `LOCK_LOST` | retry the same command once |
| 6 | store | `STORE_NOT_FOUND`, `STORE_INVALID`, `STORE_TOO_NEW`, `STORE_EXISTS`, `STORE_READ_ONLY`, `SETUP_*` | `STORE_NOT_FOUND`: find your board with `laneboard boards --json` and pass `--dir <its path>` on every command (MCP: set the server's `args`, 1.4); none for this project: `init --name <name> --description "<…>"`, then `laneboard prime` (3.4). `STORE_READ_ONLY`: a write through `--board`, or a machine registry that cannot be written (`boards --forget`). `doctor` also exits 6 while a problem is left (`data.healthy: false`) |

### 2.4 MCP tools

The same operations as the CLI, with snake_case parameters. Write tools take `actor`; without it the server uses its `mcp --as`, then
`LANEBOARD_AGENT`, else the default name of the session that started it. Every result has a second text block `{"store", "prefix", "warnings"}`, like the CLI envelope.
The server's instructions are the rules with an MCP preamble (CLI command -> `task_<command>`, options -> parameters, no `--json`).

| Tool | CLI |
|---|---|
| `task_prime` (read-only; call it first) | `prime --json` |
| `task_create`, `task_get`, `task_list`, `task_update` | `create`, `get`, `list`, `update` |
| `task_claim`, `task_comment`, `task_finish`, `task_attach` | `claim`, `comment`, `finish`, `attach` |
| `task_archive`, `task_restore`, `task_events` | `archive`, `restore`, `events` |

`init`, `config`, `setup`, `view`, `boards`, `doctor`, `migrate` and `import` are CLI-only; so are `delete` and `redact`,
which are for people (2.6).

### 2.5 Your name

Every write is signed with a name, in this order: `--as` (MCP `actor`), `LANEBOARD_AGENT`, the session's default name.
In Claude Code the default is `claude-code@<git user.name or OS user>:<first 8 characters of the session id>`: `setup` writes the base
(`LANEBOARD_DEFAULT_AGENT`), Claude Code sets `CLAUDE_CODE_SESSION_ID` for Bash, hooks and MCP servers. Two parallel sessions therefore
get two names, and `claim` keeps them apart. Each event records `actor_source`: `explicit` or `default`.

```sh
unset LANEBOARD_AGENT
LANEBOARD_DEFAULT_AGENT=claude-code@ann CLAUDE_CODE_SESSION_ID=aaaa1111 laneboard create "Session A work" --status todo --json
LANEBOARD_DEFAULT_AGENT=claude-code@ann CLAUDE_CODE_SESSION_ID=aaaa1111 laneboard claim DEMO-3 --json
LANEBOARD_DEFAULT_AGENT=claude-code@ann CLAUDE_CODE_SESSION_ID=bbbb2222 laneboard claim DEMO-3 --json  # exit 4
LANEBOARD_DEFAULT_AGENT=claude-code@ann CLAUDE_CODE_SESSION_ID=bbbb2222 laneboard prime
LANEBOARD_DEFAULT_AGENT=claude-code@ann CLAUDE_CODE_SESSION_ID=cccc3333 laneboard claim DEMO-3 --resume --json
LANEBOARD_DEFAULT_AGENT=claude-code@ann CLAUDE_CODE_SESSION_ID=cccc3333 laneboard claim DEMO-2 --resume --json  # exit 4
export LANEBOARD_AGENT=dev-1
```

After `/clear` or a restart Claude Code gives the session a new id, so its default name changes and its task in progress looks like another
session's. The default name's base is the global git `user.name` (read from `~/.gitconfig` without running git), else the OS user.
`prime` under the default name lists unfinished tasks of the same base with another session id ("Your earlier sessions", with the age
of the last update), and `claim <ID> --resume` takes one over: an `assigned` event with `resumed: true` (`get` shows "resumed from <old name>"),
`resumed_from` in the reply. Only a task its holder took itself under its default name (the event says `actor_source: default`) of the
same user and harness qualifies; a task of an explicit name (`dev-1` above, or `claude-code@ann:reviewer`) stays `ALREADY_CLAIMED` without
`--resume`. `ALREADY_CLAIMED` on a task of an earlier session offers `claim <ID> --resume --json` as its fix once that session has written
nothing for 15 minutes; before that the fix is a comment and the message names `--resume`, and a `--resume` then works with a warning
(a parallel live session of the same user has the same base: resume only your own work that matches the current request).
The SessionStart hook (`prime --hook`) shows the section on every start but resume and compaction, which keep the id; `claim --resume`
of a subtask names a parent held by the same session. The MCP server keeps the id it started with.

Copying the default name into `--as` changes nothing: a name equal to the session's default is recorded as `default`. Subagents of one session share its default name: give each its own `--as`.
So under the default name `prime` starts by saying that a subagent or parallel worker runs `prime --as <its own name>` and passes that `--as` everywhere. Codex, Cursor, Gemini CLI and OpenCode get no default name
(they expose no session id, and one shared name would merge parallel sessions again), so pass `--as` there.

### 2.6 Delete and redact (people only)

Agents do not delete or redact: there is no MCP tool for either, and an agent that thinks a task should go asks the owner.
`laneboard delete <ID> --confirm <ID>` (an active or an archived task) removes its description, labels, links, fields, attachments and
history; the archive keeps a trace: id, title, status, dates, one `archived` event with `deleted: true` and `deleted {at, by}`.
`restore` and a second `delete` of it fail with `INVALID_VALUE` (`DEMO-1 was deleted at <time> by owner`); `next_id` never goes back.

A secret pasted into a task (comment, description, an old description kept by `update --description`, title, link, field):
`laneboard redact <ID> --text-file <file>` (`-` reads stdin; never on the command line, which the shell history keeps) replaces every
exact occurrence in that task with `[redacted]`, adds an `updated {redacted: {count, backups}}` event (who and when, not the text) and writes both
store files and their `.bak` anew, so no backup keeps it (also a task deleted before the redact: its copy in a `.bak` is found).
One trailing newline of the file is ignored. `INVALID_VALUE`, nothing written: no occurrence; a text under 4 characters or a part of `[redacted]`,
the task id, the prefix, a status or an actor name (or a part of one); the text also in a label or an attachment name (remove them first:
`update <ID> --remove-label <label>`, `attach <ID> --remove <name>`, then redact again). Not covered: other tasks (a warning names them),
copies outside the store files (git history).

```sh
printf 'query string\n' > secret.txt
laneboard redact DEMO-1 --text-file secret.txt --as owner --json
laneboard redact DEMO-1 --text-file secret.txt --as owner --json  # exit 2
laneboard delete DEMO-1 --confirm DEMO-1 --as owner --json
laneboard restore DEMO-1 --as owner --json  # exit 2
laneboard get DEMO-1 --json
```

## 3. Configure

### 3.1 Statuses, fields, prefix

`.laneboard/config.json` holds the board's settings. People (the owner, the orchestrator) change them with `laneboard config`, agents
never; the file is validated on every command, so a hand edit with a typo fails loudly. `statuses` is the order of the board (at least 2),
the last one is final. `fields` declares the extra keys a task may carry, with a type (`string`, `number`, `boolean`, `string[]`, `json`):
`config --field <key>:<type>[:<description>]` declares or changes one (the description is everything after the second colon; without it
the current one stays), `--drop-field <key>` removes one. A dropped field that active tasks hold, or a new type their values do not fit,
fails with `INVALID_VALUE` naming the tasks, and its fix unsets those values one by one; archived tasks only warn. A number field takes
decimal notation only (`-?digits[.digits]`). `prefix` is set by `init` (`--prefix`, else derived from the name); `laneboard config --prefix`
changes it only while the board has no task, active or archived. `attachments.deny_names` refuses attachments named like secrets; a board
created by 0.4.0 also refuses `id_dsa*`, `id_ecdsa*`, `id_xmss*`, `*credentials*`, `.netrc`, `.npmrc`, `*.p12`, `*.pfx` and `*.kdbx`
(an older board keeps its list). Labels: lowercase Latin letters, digits and `. _ -`, starting with a letter or digit, up to 40; an invalid
one fails with the normalized label in the fix (`zone:api` -> `zone-api`).

```sh
laneboard config --statuses todo,in_progress,review,blocked,done --json
laneboard config --field priority:number:"0 = highest" --field project:string --field 'acceptance:string[]:acceptance criteria' --field source_id:string:"id in the old tracker" --json
```

`init --statuses` sets the statuses at the start; `prime` shows the current ones. The owner or the orchestrator changes them later with
`laneboard config --statuses a,b,c`: the whole list in order, the last one final; adding and reordering are free. Agents never change statuses.
A status that active tasks are in cannot be dropped: the error names their count and ids, and its `fix` lists them (`list --status <s> --dir <store>`);
move each with `update <ID> --status <status>`, then run `config` again. Archived tasks keep a dropped status and read as an unknown one.
A new name for a status: add it, move the tasks, drop the old one. A new final status gives a warning: tasks in the old final one count as open again,
and acceptance, in-work and stale marks follow the new list.

```sh
laneboard prime --as dev-1
laneboard create "Pick a CSV library" --status blocked --field project=reports --field acceptance=streaming,utf-8 --json
```

```sh
laneboard config --statuses todo,in_progress,review,blocked,qa,done --json
laneboard config --statuses todo,in_progress,review,done --json  # exit 2
laneboard config --statuses todo,in_progress,review,blocked,done --json
```

### 3.2 Which store a command uses

The first match wins, and every `--json` reply names it in `store` and `prefix`.

| Order | Source |
|---|---|
| 1 | `--dir <path to .laneboard>` |
| 2 | `LANEBOARD_DIR` |
| 3 | `.laneboard/` in the current directory or a parent; a linked git worktree without a board of its own uses its main checkout's board. A parent's store adds a warning when a project marker lies between, because then it may be another project's board: inside a git repository only a `.git` (a nested repository, a submodule) or a board of its own marks one, so a package with its own `AGENTS.md` or `CLAUDE.md` uses the root's board without a warning; outside git also `.claude`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`. `~/.laneboard` is the machine's registry, never a store |

### 3.3 Several agents, several stores

Several agents share one store safely: writes take a file lock, `--expected-rev` stops lost updates, `claim` stops double work.
Each agent uses its own name; a task claimed by another agent fails with `ALREADY_CLAIMED`.

```sh
laneboard create "Profile the export" --status todo --as dev-2 --json
laneboard claim DEMO-5 --as dev-2 --json
laneboard claim DEMO-5 --as dev-1 --json  # exit 4
laneboard comment DEMO-5 "I can take the CSV part" --as dev-1 --json
```

Taking over a claimed task: `claim` never takes a task from another name, and an agent never does. When its holder stopped, the
orchestrator (or the owner) reassigns it with `update --assignee` and comments why; the new holder works on it as usual.

```sh
laneboard update DEMO-5 --assignee dev-1 --as orchestrator --json
laneboard comment DEMO-5 "dev-2 stopped; dev-1 takes over the export" --as orchestrator --json
```

Each project (or agent folder) gets its own store and setup; `--dir` pins a store that is not `./.laneboard`.
A git repository has one board by default: in a subfolder or linked worktree of a repository whose board lies above, a plain `init`
is refused (`STORE_EXISTS`, fix `laneboard prime`), and `setup` pins the folder to the root's board (Claude Code: in the root's
`.claude/settings.local.json`, so the package commits no machine path; an older pin in the package's `.claude/settings.json` is moved
there with a warning). A package with a board of its own: `init --dir <folder>/.laneboard`, then `setup` in that folder pins it there.
A `LANEBOARD_DIR` that names no folder any more (a moved project) gives way to the folder's own board: `setup` re-pins, `init` refuses
with the `setup` command as its fix.

```sh
mkdir -p services/billing
laneboard init --dir services/billing/.laneboard --prefix BILL --description "Billing service: invoices and payments"
(cd services/billing && laneboard setup cursor)
laneboard create "Invoice rounding" --status todo --dir services/billing/.laneboard --as dev-1 --json
(cd services/billing && laneboard list --json)
```

### 3.4 Boards on this machine

`init` and `setup` add each board to `~/.laneboard/boards.json`. `laneboard boards` lists them: prefix, name, active tasks per status,
last change, path and description; a path without a store any more is `missing` (`list --all-boards` skips it without a warning, the
`prime --all-boards` overview names it). `laneboard boards --forget <prefix|name|path>` removes such an entry (a live board is never
forgotten). A registry that cannot be written gives a warning on `init`, `config` and `setup` (the board works, it is just not listed)
and `STORE_READ_ONLY` on `--forget`. Not sure which board is yours (no store found, or the warning above)? Pick yours from `boards --json`
by `description` and `path`; none for this project: `init --name --description` in its root.

A project folder moved to another place: run `laneboard setup <harness>` in the new folder (it re-pins), then
`laneboard boards --forget <old path>/.laneboard`. Another machine: copy the project with its `.laneboard/`, install the CLI and run
`setup` there (pins are paths of one machine).

```sh
laneboard boards --json
laneboard config --name demo --description "Demo project: the examples of this guide, billing included"
```

`--board <prefix|name|path>` opens another board read-only for `view`, `list`, `get`, `events` and `board`; a write through it fails with `STORE_READ_ONLY`.

```sh
laneboard list --board BILL --json
laneboard create "Not here" --status todo --board BILL --json  # exit 6
```

A task that depends on a task of another board links it: `create --link task=WEB-12` or `update <ID> --add-link task=WEB-12`. The link is
checked on board WEB (found by its prefix in the registry, so `HOME` must be set) before your write; `get` lists every task link in
`linked_tasks` with its board, status and whether that status is final (`links: task=WEB-12 (WEB in_progress: <title>)`); nothing is
blocked by it. An id of another board on your board's commands fails with `TASK_NOT_FOUND` naming that board: the fix is your command
with `--board WEB` for a read (`get`, `events --task`, `list --parent`) and with `--dir <its store>` for a write.

For orchestrators: `list --all-boards` reads every board of this machine (the current one first) and merges their tasks, newest update
first; `--open` leaves out each board's own final status, `data.boards` names the boards read (one that cannot be read is skipped with a
warning). It needs `HOME` (the registry lives there) and does not go with `--board`. `prime --all-boards` (also with `--hook`) adds a
section of at most 3000 characters after the usual prime: per board its counts, then its tasks not in the final status, the urgent first
(`waiting-owner`, `handed in`, `stale` = in work with no change for 4 hours, `in work`, `open`), each with its newest comment line.
With many boards the section first keeps one counts line per board (board headers past the room are counted:
`+K more boards: laneboard boards --json`), then the urgent classes across all boards (waiting-owner, handed in, stale), each with its
share of the room and `+N more: <command>` for the rest; it is cut only at a line end. Outside any board `prime --all-boards` still shows
the overview and gives no init advice. `list` and `list --all-boards` items carry `handed_in`, `in_work` and `stale` too;
`list` and `events` show 20 by default (fewer when the board's `list_limit_max` is lower).
A task that waits for the owner's answer gets the label `waiting-owner` plus a comment with the question; the usual `--label` filters find it.

```sh
laneboard list --all-boards --open --json
laneboard list --all-boards --label waiting-owner --json
laneboard prime --all-boards --as orchestrator
```

### 3.5 The board for people

`laneboard view` draws the board in the terminal: one column per configured status, each card with id, title, assignee and time in status
(cards by `priority`, 0 first and none last, then the latest update; a default name drops its harness and keeps the session part);
a narrow terminal gets a list grouped by status, and colors appear only on a terminal without `NO_COLOR`. Filters: `--assignee`, `--label`,
`--text`. Active tasks are those not in the final status (footer `3 active tasks, 12 done`); the final column lists the newest 5 updates and
`+7 more: laneboard list --status done` with the view's filters and `--dir`/`--board` (no auto-archive: `laneboard archive`). `laneboard view --watch` redraws after every write until Ctrl+C. Agents use `list --json` instead.
A card's second line adds `waiting-owner`, `^LB-3` for a subtask and `2/5` (children final/total) for a parent; under it the newest comment, `> <first line>` (finish's result: `= <first line>`).
`list` prints the same line under a row. In `view --json` and `list --json` it is `last_comment {at, actor, text, result}`; cards also carry
`parent`, `children {total, final}`, `updated_at`, `handed_in` (awaiting acceptance), `in_work` and `stale`.

```sh
laneboard view --board BILL
COLUMNS=60 laneboard view --text export
```

### 3.6 Board in the browser

For people, not agents (agents keep to `list --json`). The page is read-only by design: tasks change through the CLI and MCP only.
`laneboard board` in a project folder starts a local server and prints `http://127.0.0.1:7420/` (`--json`: `{url, port}`); it serves until Ctrl+C.
- Port: `--port N`, else `board.port` of config.json (7420); a busy port is `PORT_IN_USE` (exit 5), whose fix `--port 0` takes a free one.
- `--board <prefix|name|path>` opens another board of this machine as the first tab; the other boards are tabs too.
- Access: 127.0.0.1 only, a new token per run that the page reads by itself; other sites and other hosts get 403.
- Live: a write shows within 1-2 s without a reload; the board is read again every minute, so `Stale` appears without a write.
- A source checkout needs `npm run build` first; until then `/` says how to build it or to reinstall the package (`npm i -g laneboard`).

Cards show the core's marks from `view --json` (§3.5): `Waiting for acceptance` (`handed_in`), `Stale` (`stale`), the `waiting-owner`
label, `^LB-3` on a subtask, `1/2` (children final/total) on a parent and the newest comment; counters of these marks sit next to the
board title. The task panel shows fields, parent and subtasks, `Result` (finish's comments, `data.result`), description, history and
attachments: png, jpeg, gif and webp get a preview, every file has a download link (other types are never shown inline).

A script or a check reads the same data over HTTP: fetch `/`, take the token from `<meta name="laneboard-token" content="...">`, and send
it as the header `X-Laneboard-Token` on `GET` routes: `/api/boards` (the tabs), `/api/board` (the view of one board: `?board=`,
`assignee`, `label`, `text`), `/api/tasks` (`scope`, `status`, `assignee`, `label`, `text`, `limit`, `offset`), `/api/tasks/<id>`.
Replies are the CLI's JSON envelopes; `/api/events` is a server-sent event stream of changes (token as `?token=`). Any other method is 405.

### 3.7 Checks in N steps and who creates tasks

For an orchestrator that runs subagents. Both keys are optional; a board without them works as above, and `config.json` stays
`laneboard/config@1` (with one of them it is `config@2`, which laneboard 0.3.1 refuses). Names are self-chosen (`--as`), so this guards
against an agent's mistake, not against a hostile agent.

- `--review-statuses a,b`: the checks in order, statuses between the first and the final one. The assignee's `finish` hands in to the
  check the task is in, else the first check (a later check or the final status: `INVALID_VALUE`). A checker names where the task goes:
  `finish <ID> --status <next>` passes the handed-in task on to the next check (reply `passed: true`, `from`; still handed in, not in work)
  and from the last one `--status <final>` accepts it (`accepted: true`).
- A checker's `finish` without `--status`, with the check the task is in, or past the next status is refused (`INVALID_VALUE`): it may
  come from a read before another checker passed the task on, so it would pass the next check unseen. The fix only reads the task,
  `laneboard get <ID>`; the message names both exact commands, the pass (`finish <ID> --status <next> --result "<result of your check>"`)
  and the return for rework (below). The same command run again after a lost reply (the same `--status`) changes nothing.
- A task enters a check only with `finish` (handed in by its holder, or passed on by the check before), so it always shows in the
  checkers' queue: `update`, `claim`, `create` and `import` into a check are refused. The fix of the holder (or of anybody for an
  unassigned task) is the hand-in, `laneboard finish <ID> --status <check> --result "<what you did, how you checked it>"`; of a checker
  of a waiting task `laneboard get <ID>` with both commands; of anybody else a comment that asks the holder to hand it in. A closed task
  is reopened first: the fix is `laneboard update <ID> --status <work status> && laneboard finish <ID> --status <check> ...`.
- The hand-in belongs to the task: a new holder (`update --assignee`, `--unassign`) keeps a waiting task handed in and in the
  checkers' queue. Holding it makes that name an author of the work: it never passes the task on or accepts it.
- Nobody claims a task waiting in a check (with or without `--status`): a check needs no claim, and holding the task would make the
  checker an author. A checker's `claim` gets `INVALID_VALUE`, fix `laneboard get <ID>`, the message names the pass and the return;
  the author's the "handed in already" refusal; anybody else's a comment (`ALREADY_CLAIMED` when held). `prime` and `task_prime` list
  such a task under the waiting ones, never among the free tasks (`unassigned`).
- No checker left: when every name in `--reviewers` worked on a waiting task (the orchestrator gave it to the only checker), nobody
  may pass it on. The refusals, `prime` (MCP `roles.no_checker {ids, fix}`) and `doctor` (check `checks`, exit 6) name the owner's way
  out: `laneboard config --reviewers "<names there>,<another checker>"`.
- `config --review-statuses` that turns a status with tasks in work into a check warns, naming each task and the hand-in its holder
  runs (`laneboard finish <ID> --status <check> --result "..." --as <holder>`); `doctor` reports them in the check `checks` (exit 6)
  until they are handed in. A move of a handed-in task by `update` or `claim` warns with the hand-in that puts it back in the queue.
- `--reviewers x,y`: who checks (default: anybody but the author of the work). Any of them makes any check, both in a row too: the
  two lists are not paired. A checker's `finish` applies to the check the task is in now, whoever passed it there. The author of the
  work (any name that held the task or handed it in) never passes it on or accepts it, by `finish`, `update`, `claim`, `create` or `import`.
- A task waiting in a check (handed in, or passed on) is handed in already: the author's `finish`, `update` or `claim` into another check
  or the final status gets `INVALID_VALUE` "handed in already, waits in <check> for the check of <checkers>", its fix a comment; it never
  goes back to an earlier check. `finish` without `--status` there records a new result after rework, the status stays.
- Return for rework: the checker comments why, then `update <ID> --status <work status>` (the hand-in is gone, with a warning); the
  assignee's `prime` shows that comment under its task (`last comment by <checker>`) and hands in again with `finish`. A checker's
  `finish --status` with an earlier check, a work status (wherever it lies, also between two checks) or the first status is refused
  (`INVALID_VALUE`): its fix is this return,
  `laneboard comment <ID> --as <checker> -- '<result>' && laneboard update <ID> --status <work status> --as <checker>`, never a `finish`
  that passes the task on or accepts it. A fix never changes what the refused command meant.
- `--creators x,y` (`create_by`): only these names create tasks, subtasks and imports; anybody else gets `INVALID_VALUE` (exit 2), its fix
  a comment on its own task (or the parent) asking for the task. `prime` of such an agent prints no create command.
- `prime` names the checks, the checkers and the creators, lists the tasks waiting for your check, each with its ready command
  (`pass: laneboard finish <ID> --status <next> --result "<result of your check>"`; MCP `task_prime`: `roles.waiting[].next_status`), and
  claims into the status before the first check. `none` turns each key off (`config@1` again when all are off).

```sh
laneboard config --review-statuses review --reviewers lead --creators lead --json
laneboard create "Rate limit the API" --status todo --as dev-3 --json  # exit 2
laneboard create "Rate limit the API" --status todo --assignee dev-3 --as lead --json
laneboard claim DEMO-6 --status in_progress --as dev-3 --json
laneboard finish DEMO-6 --result "Limiter added, 5 req/min" --no-commit --as dev-3 --json
laneboard finish DEMO-6 --status done --result "Self-accept" --no-commit --as dev-3 --json  # exit 2
laneboard prime --as lead
laneboard comment DEMO-6 "Admins need a higher limit" --as lead --json
laneboard update DEMO-6 --status in_progress --as lead --json
laneboard prime --as dev-3
laneboard finish DEMO-6 --result "Admins get 50 req/min" --no-commit --as dev-3 --json
laneboard finish DEMO-6 --result "Checked with an admin token" --as lead --json  # exit 2
laneboard finish DEMO-6 --status done --result "Checked with an admin token" --as lead --json
laneboard config --review-statuses none --reviewers none --creators none --json
```

## 4. Migrate: import existing tasks

`laneboard import` creates tasks from another tracker's files, in one write. Each task gets the link `file=<path from the project folder>`,
so a second run skips files imported before and creates only new ones. An undeclared key or a status that is neither configured
nor mapped stops the import before anything is written and lists every value found; `--dry-run` shows the result without writing.
On a board with `create_by` only those names import; a task imported right into a check or the final status follows the rule of
`create` (3.7): never into a check (a task enters one only with `finish`), and into the final status only by a checker, not by its assignee.

| Option | Meaning |
|---|---|
| `--status-key K` | the source key with the status (required) |
| `--status-map from=to` | rename a source status to a configured one (repeat per value) |
| `--title-key K` | the source key with the title (default `title`) |
| `--assignee-key K`, `--labels-key K` | keys for the assignee and labels |
| `--field-map key=field` | store a source key as a declared field with another name |
| `--ignore-key K` | drop a key |
| `--exclude NAME` | skip files by name (`*`, `?` wildcards) |
| `--description-key K`, `--history-key K` | json only: the description (default `description`) and a list of history entries |

### 4.1 Markdown with YAML frontmatter

One file per task: frontmatter keys become the title, status and fields; the body becomes the description.
Files without frontmatter (a README, an index) are left out with a warning.

```sh
mkdir -p old-tasks
cat > old-tasks/2026-01-10-login.md <<'EOF'
---
title: Login form validation
stage: dev
owner: lead
project: web
---
Show field errors under each input.
EOF
cat > old-tasks/2026-01-11-export.md <<'EOF'
---
title: Export reports as CSV
stage: research
owner: lead
project: reports
---
Find out which columns finance needs.
EOF
echo "# Old tasks" > old-tasks/README.md
laneboard import markdown old-tasks --status-key stage --dry-run --json  # exit 2
laneboard import markdown old-tasks --status-key stage --status-map dev=in_progress --status-map research=todo --ignore-key owner --dry-run --json
laneboard import markdown old-tasks --status-key stage --status-map dev=in_progress --status-map research=todo --ignore-key owner --json
laneboard import markdown old-tasks --status-key stage --status-map dev=in_progress --status-map research=todo --ignore-key owner --json
```

The first run fails with `UNKNOWN_FIELD`: `details.unknown_fields` names `owner`, `details.unknown_statuses` names `dev` and `research`.
The last run creates nothing and lists both files under `skipped`.

### 4.2 JSON task files with history

One task object per file. Keys are mapped by flags; history entries become events with their original time:
an entry with `from`/`to` becomes a `status` event (statuses mapped like the task's), any other a `commented` event;
an entry without a usable time becomes a comment at import time that keeps the raw entry.

```sh
mkdir -p old-json
cat > old-json/T-001.json <<'EOF'
{
  "id": "T-001",
  "title": "Nightly export job",
  "description": "Export orders every night at 02:00.",
  "state": "testing",
  "assignee": "dev-bot",
  "labels": ["jobs"],
  "acceptance_criteria": ["file lands in the bucket"],
  "history": [
    {"at": "2026-01-01T11:00:00Z", "actor": "pm-bot", "event": "created"},
    {"at": "2026-01-02T09:30:00Z", "actor": "dev-bot", "from": "in_progress", "to": "testing"}
  ]
}
EOF
laneboard import json old-json --status-key state --status-map testing=review --assignee-key assignee --labels-key labels --history-key history --field-map id=source_id --field-map acceptance_criteria=acceptance --json
laneboard list --text "Nightly export" --json
```

### 4.3 A Markdown TODO list

A Markdown TODO list (`- [ ]` / `- [x]`): `laneboard import checklist TODO.md --status <status> [--done-status <status>] [--heading-labels] --dry-run`,
then without `--dry-run`. Each item is a task; checked items get the final status (or `--done-status`); an indented item becomes a
subtask of the item above it. The link `file=TODO.md#<item text>` makes a re-run skip imported items; an edited item text makes a new
task. `import markdown` reads only files with YAML frontmatter and names this command when it meets checkboxes.

```sh
cat > TODO.md <<'EOF'
# TODO
- [x] Set up the schema
- [ ] Dark mode toggle
  - [ ] Keep the choice after a reload
EOF
laneboard import checklist TODO.md --status todo --dry-run --json
laneboard import checklist TODO.md --status todo --json
laneboard import checklist TODO.md --status todo --json
```
