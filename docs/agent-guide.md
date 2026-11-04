# laneboard agent guide

For AI coding agents in any harness (Claude Code, Codex, Cursor, Gemini CLI, OpenCode) and for the people who set them up.
laneboard is a task board and CLI: agents create, claim, comment and close their own tasks; people see the same tasks.
Every shell block below runs in the test suite (`test/docs/agent-guide.test.ts`) in a fresh temp project, in order, so the commands and their exit codes are real.

Conventions in this guide:

| What | Where |
|---|---|
| The project folder | the current directory; its store is `./.laneboard` |
| Your agent name | `dev-1` (use your own; letters, digits, `. _ : @ -`) |
| Task ids | `DEMO-<n>`: the prefix comes from the board name, `laneboard init --name demo` |
| A command that fails on purpose | ends with `# exit <code>` |

## 1. Install

The CLI is one global npm package (Node.js 22 or newer, macOS or Linux). Check with `node --version`; when nvm's default is older,
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
It must be free on this machine (a taken one fails with a free one in `fix`).

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
| claude-code | `.mcp.json` | `CLAUDE.md` | `env.LANEBOARD_DIR` and `env.LANEBOARD_DEFAULT_AGENT` in `.claude/settings.local.json`, kept out of git by a block in `.git/info/exclude` (in a folder inside another git repository, or at a repository root that holds other boards: `.claude/settings.json`), plus SessionStart and PostToolUse hooks in `.claude/settings.json` |
| codex | `~/.codex/config.toml` (global; `CODEX_HOME` moves it) | `AGENTS.md` | `LANEBOARD_DIR=<store>` in the instructions; the entry forwards `LANEBOARD_DIR` (`env_vars`) |
| cursor | `.cursor/mcp.json` | `AGENTS.md` | `mcp --dir <store>` in the entry, `LANEBOARD_DIR=<store>` in the instructions |
| gemini | `.gemini/settings.json` | `GEMINI.md` | `mcp --dir <store>` in the entry, `LANEBOARD_DIR=<store>` in the instructions |
| opencode | `opencode.json` | `AGENTS.md` | `mcp --dir <store>` in the entry, `LANEBOARD_DIR=<store>` in the instructions |

Claude Code also has a plugin (`/plugin marketplace add bazarbayevabylay/laneboard`, then `/plugin install laneboard@laneboard`).
Use the plugin or `setup claude-code`, not both: they register the same server and hooks.

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

## 2. Use

### 2.1 The rules in short

- Before your first file change: claim your task or create one. Comment each meaningful step. When done: commit, then `laneboard finish <ID> --result "<result>"`.
- `--expected-rev` is optional: only for edits on top of what you read (`--description`, `--field`). Status changes, comments, `claim` and `finish` need none, so no `get` for a rev.
- Use only `laneboard` commands or the `task_*` MCP tools; never edit `.laneboard/*.json`.
- Always pass `--json`. Your name: `--as <name>` or `export LANEBOARD_AGENT=<name>` (MCP: `actor`); without them Claude Code sessions write under their default name (2.5).
- `laneboard prime` prints the full rules, the statuses in order (the last one is final) with the counts, the declared fields, your tasks
  not in the final status and the free ones (no assignee, not final) with the claim command.

### 2.2 A task from start to end

Your name once for the session, then create, claim, work, finish, archive. Every write replies short: `id`, the new `rev`, `status`,
`assignee` (after `attach` also the `attachment`, after `finish` the `commit`). The whole task: `laneboard get <ID>`, or `--full` on the write (MCP: `full: true`).
`finish` is one write: the result comment, a link to the current commit (git HEAD of the folder, `commit=<sha>`; `--no-commit` skips it,
outside git there is none), then the final status, in this order of events. Commit first. Only the assignee finishes (or anybody an unassigned task,
who then becomes its assignee). `--status` takes any status but the first one: `--status review` hands the work in, the orchestrator sets
the final one. The assignee's `finish` into a status that is not final hands the task in: its `status` event says `handed_in: true`.
Somebody else's task `finish` only accepts, and only a handed-in one (the newest `status` event into its current status is the
assignee's `finish` with `handed_in`): into the final status, the result comment and no commit link (the assignee linked it); the assignee
stays, the `status` event says `accepted: true` and its actor is who accepted, the reply has `accepted: true`. A task in work or moved by
`update` (or handed in with 0.2.0, before the mark): `ALREADY_CLAIMED`, the fix asks the assignee to hand it in with
`finish --status <status>`; the orchestrator may close it with `laneboard update <ID> --status done`. Accepting a closed task again:
unchanged, with a warning. A second `finish` by the assignee into the same status (or of a closed task) keeps the status and the result and warns; only a commit not
linked yet is added. A warning, not an error, when tracked files have uncommitted changes (staged ones too) or the HEAD commit is older
than your claim (the link would point at a commit without your work): commit and run `finish` again, or use `--no-commit`. finish asks
git (`rev-parse`, `log`, `status`, 2 s each); no git, no answer or an error: the task is still finished, with a `could not check git` warning.
finish's result comment carries `result: true` in its event data (`get` prints `commented (result)`); `comment` never sets it.

Subtasks: `laneboard create "<title>" --status <status> --parent <ID> --json`, the parent being a task of this board (a cycle or an id of
another board is refused with a fix; link another board's task instead). `get` lists `children`, `list --parent <ID>` the direct ones,
`update <ID> --no-parent` makes a top-level task. Deleting a parent removes `parent` from its children; closing or archiving a parent
while children are open works, with a warning. Add to a description with `update <ID> --append-description "<text>"` (a blank line, then
the text; no `--expected-rev`, nothing you read is overwritten); `--description` replaces the whole text.

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
| 4 | conflict | `REV_CONFLICT`, `ALREADY_CLAIMED`, `TASK_ARCHIVED`, `ATTACHMENT_EXISTS` | `REV_CONFLICT`: re-apply your change on `error.details.task` with its rev; `ALREADY_CLAIMED`: do not take over, comment (a task in review: `finish` accepts it) |
| 5 | busy | `LOCK_TIMEOUT`, `LOCK_LOST` | retry the same command once |
| 6 | store | `STORE_NOT_FOUND`, `STORE_INVALID`, `STORE_TOO_NEW`, `STORE_EXISTS`, `STORE_READ_ONLY`, `SETUP_*` | `STORE_NOT_FOUND`: find your board with `laneboard boards --json` and pass `--dir <its path>` on every command; none for this project: `init --name <name> --description "<…>"`, then `laneboard prime` (3.4) |

### 2.4 MCP tools

The same operations as the CLI, with snake_case parameters. Write tools take `actor`; without it the server uses `LANEBOARD_AGENT`,
else the default name of the session that started it. Every result has a second text block `{"store", "prefix", "warnings"}`, like the CLI envelope.

| Tool | CLI |
|---|---|
| `task_create`, `task_get`, `task_list`, `task_update` | `create`, `get`, `list`, `update` |
| `task_claim`, `task_comment`, `task_finish`, `task_attach` | `claim`, `comment`, `finish`, `attach` |
| `task_archive`, `task_restore`, `task_delete`, `task_events` | `archive`, `restore`, `delete`, `events` |

`init`, `config`, `setup`, `prime`, `view`, `boards`, `doctor`, `migrate` and `import` are CLI-only.

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

After `/clear` Claude Code gives the session a new id, so its default name changes and its task in progress looks like another session's.
`prime` under the default name lists unfinished tasks of the same base with another session id ("Your earlier sessions", with the age
of the last update), and `claim <ID> --resume` takes one over: an `assigned` event with `resumed: true` (`get` shows "resumed from <old name>"),
`resumed_from` in the reply. Only a task its holder took itself under its default name (the event says `actor_source: default`) of the
same user and harness qualifies; a task of an explicit name (`dev-1` above, or `claude-code@ann:reviewer`) stays `ALREADY_CLAIMED`, which
never suggests `--resume`. A parallel live session of the same user has the same base, so resume only a task you did yourself before `/clear`
that matches the current request; the SessionStart hook (`prime --hook`) shows the section only after `/clear` (`source: "clear"` in the
hook input), not to a fresh session. Compaction and `claude --resume <id>` keep the id; the MCP server keeps the id it started with.

Copying the default name into `--as` changes nothing: a name equal to the session's default is recorded as `default`. Subagents of one session share its default name: give each its own `--as`.
So under the default name `prime` starts by saying that a subagent or parallel worker runs `prime --as <its own name>` and passes that `--as` everywhere. Codex, Cursor, Gemini CLI and OpenCode get no default name
(they expose no session id, and one shared name would merge parallel sessions again), so pass `--as` there.

## 3. Configure

### 3.1 Statuses, fields, prefix

`.laneboard/config.json` is the only file people edit by hand; it is validated on every command, so a typo fails loudly.
`statuses` is the order of the board, the last one is final. `fields` declares the extra keys a task may carry, with a type
(`string`, `number`, `boolean`, `string[]`, `json`). `prefix` is set by `init` (`--prefix`, else derived from the name); `laneboard config --prefix` changes it only while the board has no task, active or archived.

```json file=.laneboard/config.json
{
  "schema": "laneboard/config@1",
  "prefix": "DEMO",
  "statuses": ["todo", "in_progress", "review", "blocked", "done"],
  "fields": {
    "priority": { "type": "number", "description": "0 = highest" },
    "project": { "type": "string" },
    "acceptance": { "type": "string[]", "description": "acceptance criteria" },
    "source_id": { "type": "string", "description": "id in the old tracker" }
  },
  "limits": { "events_per_task": 500, "attachment_bytes": 26214400, "list_limit_max": 200 },
  "attachments": { "deny_names": [".env*", "*.pem", "*.key", "id_rsa*", "id_ed25519*"] },
  "board": { "port": 7420 }
}
```

`init --statuses` sets the statuses at the start; `prime` shows the current ones.

```sh
laneboard prime --as dev-1
laneboard create "Pick a CSV library" --status blocked --field project=reports --field acceptance=streaming,utf-8 --json
```

### 3.2 Which store a command uses

The first match wins, and every `--json` reply names it in `store` and `prefix`.

| Order | Source |
|---|---|
| 1 | `--dir <path to .laneboard>` |
| 2 | `LANEBOARD_DIR` |
| 3 | `.laneboard/` in the current directory or a parent; a parent's store adds a warning when a project marker (`.git`, `.claude`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) lies between, because then it may be another project's board (a git worktree of the same repository, such as Claude Code's `.claude/worktrees/<name>`, is the same project); `~/.laneboard` is the machine's registry, never a store |

### 3.3 Several agents, several stores

Several agents share one store safely: writes take a file lock, `--expected-rev` stops lost updates, `claim` stops double work.
Each agent uses its own name; a task claimed by another agent fails with `ALREADY_CLAIMED`.

```sh
laneboard create "Profile the export" --status todo --as dev-2 --json
laneboard claim DEMO-5 --as dev-2 --json
laneboard claim DEMO-5 --as dev-1 --json  # exit 4
laneboard comment DEMO-5 "I can take the CSV part" --as dev-1 --json
```

Each project (or agent folder) gets its own store and setup; `--dir` pins a store that is not `./.laneboard`.
Folders nested inside another project need their own `init`, or they would find the parent's store. A `LANEBOARD_DIR` set for the
parent (Claude Code reads the repository root's `.claude/settings.local.json` in every folder of the repository) warns there too:
in a folder with a project marker under the pinned project, and in a folder with its own store wherever the pinned store lies
(also `setup --dir ~/boards/...`). With that variable set, create the nested board with `init --dir <folder>/.laneboard` and pass
that `--dir` on every command. `setup claude-code` in the nested folder refuses such a root pin with the commands that move it to the
root's `.claude/settings.json`.

```sh
mkdir -p services/billing
(cd services/billing && laneboard init --prefix BILL --description "Billing service: invoices and payments" && laneboard setup cursor)
laneboard create "Invoice rounding" --status todo --dir services/billing/.laneboard --as dev-1 --json
(cd services/billing && laneboard list --json)
```

### 3.4 Boards on this machine

`init` and `setup` add each board to `~/.laneboard/boards.json`. `laneboard boards` lists them: prefix, name, active tasks per status,
last change, path and description; a path without a store any more is `missing`. Not sure which board is yours (no store found, or the
warning above)? Pick yours from `boards --json` by `description` and `path`; none for this project: `init --name --description` in its root.

```sh
laneboard boards --json
laneboard config --name demo --description "Demo project: the examples of this guide, billing included"
```

`--board <prefix|name|path>` opens another board read-only for `view`, `list`, `get` and `events`; a write through it fails with `STORE_READ_ONLY`.

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

## 4. Migrate: import existing tasks

`laneboard import` creates tasks from another tracker's files, in one write. Each task gets the link `file=<path from the project folder>`,
so a second run skips files imported before and creates only new ones. An undeclared key or a status that is neither configured
nor mapped stops the import before anything is written and lists every value found; `--dry-run` shows the result without writing.

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
