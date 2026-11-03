# laneboard agent guide

For AI coding agents in any harness (Claude Code, Codex, Cursor, Gemini CLI, OpenCode) and for the people who set them up.
laneboard is a task board and CLI: agents create, claim, comment and close their own tasks; people see the same tasks.
Every shell block below runs in the test suite (`test/docs/agent-guide.test.ts`) in a fresh temp project, in order, so the commands and their exit codes are real.

Conventions in this guide:

| What | Where |
|---|---|
| The project folder | the current directory; its store is `./.laneboard` |
| Your agent name | `dev-1` (use your own; letters, digits, `. _ : @ -`) |
| Task ids | `DEMO-<n>`: the prefix is set by `laneboard init --prefix DEMO` |
| A command that fails on purpose | ends with `# exit <code>` |

## 1. Install

The CLI is one global npm package (Node.js 22 or newer, macOS or Linux).

<!-- guide:skip installs globally -->
```sh
npm i -g laneboard
```

Before the package is on npm, install it from git: build a tarball and install that.

<!-- guide:skip installs globally -->
```sh
git clone https://github.com/bazarbayevabylay/laneboard.git
cd laneboard && npm ci && npm pack
npm i -g ./laneboard-*.tgz
```

Check the CLI:

```sh
laneboard --version
```

### 1.1 Create the store and connect a harness

Run both in the project root. `init` creates `./.laneboard`; `setup` registers the MCP server and adds a 3-line instruction block, pinned to that store.

```sh
laneboard init --prefix DEMO
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
| claude-code | `.mcp.json` | `CLAUDE.md` | `env.LANEBOARD_DIR` in `.claude/settings.json`, plus SessionStart and PostToolUse hooks |
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

- Before your first file change: claim your task or create one. Comment each meaningful step. When done: set the final status and add a result comment.
- Use only `laneboard` commands or the `task_*` MCP tools; never edit `.laneboard/*.json`.
- Always pass `--json` and your name (`--as <name>` or `export LANEBOARD_AGENT=<name>`). MCP write tools take `actor`.
- `laneboard prime` prints the full rules, the statuses in order (the last one is final) and the declared fields.

### 2.2 A task from start to end

Your name once for the session, then create, claim, work, finish, archive. Every write returns the task with its new `rev`.

```sh
export LANEBOARD_AGENT=dev-1
laneboard create "Fix login redirect" --status todo --assignee dev-1 --json
laneboard claim DEMO-1 --status in_progress --json
laneboard comment DEMO-1 "Cause: the redirect drops the query string" --json
laneboard update DEMO-1 --add-link branch=fix/login-redirect --field priority=1 --expected-rev 3 --json
echo "request log" > trace.txt
laneboard attach DEMO-1 trace.txt --json
laneboard update DEMO-1 --status done --expected-rev 5 --json
laneboard comment DEMO-1 "Result: fixed, regression test added" --json
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

Every error has a `fix`: run it or adapt it. On `UNKNOWN_*` copy a value from `allowed`.

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
| 4 | conflict | `REV_CONFLICT`, `ALREADY_CLAIMED`, `TASK_ARCHIVED`, `ATTACHMENT_EXISTS` | `REV_CONFLICT`: re-apply your change on `error.details.task` with its rev; `ALREADY_CLAIMED`: do not take over, comment |
| 5 | busy | `LOCK_TIMEOUT`, `LOCK_LOST` | retry the same command once |
| 6 | store | `STORE_NOT_FOUND`, `STORE_INVALID`, `STORE_TOO_NEW`, `STORE_EXISTS`, `SETUP_*` | `STORE_NOT_FOUND`: `export LANEBOARD_DIR=<abs>/.laneboard`; never `init` unless asked |

### 2.4 MCP tools

The same operations as the CLI, with snake_case parameters; every write tool needs `actor`.

| Tool | CLI |
|---|---|
| `task_create`, `task_get`, `task_list`, `task_update` | `create`, `get`, `list`, `update` |
| `task_claim`, `task_comment`, `task_attach` | `claim`, `comment`, `attach` |
| `task_archive`, `task_restore`, `task_delete`, `task_events` | `archive`, `restore`, `delete`, `events` |

`init`, `setup`, `prime`, `doctor`, `migrate` and `import` are CLI-only.

## 3. Configure

### 3.1 Statuses, fields, prefix

`.laneboard/config.json` is the only file people edit by hand; it is validated on every command, so a typo fails loudly.
`statuses` is the order of the board, the last one is final. `fields` declares the extra keys a task may carry, with a type
(`string`, `number`, `boolean`, `string[]`, `json`). `prefix` is set by `init --prefix` and should not change later.

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
| 3 | `.laneboard/` in the current directory or a parent (a parent's store adds a warning: it may be another project's) |

### 3.3 Several agents, several stores

Several agents share one store safely: writes take a file lock, `--expected-rev` stops lost updates, `claim` stops double work.
Each agent uses its own name; a task claimed by another agent fails with `ALREADY_CLAIMED`.

```sh
laneboard create "Profile the export" --status todo --as dev-2 --json
laneboard claim DEMO-4 --as dev-2 --json
laneboard claim DEMO-4 --as dev-1 --json  # exit 4
laneboard comment DEMO-4 "I can take the CSV part" --as dev-1 --json
```

Each project (or agent folder) gets its own store and setup; `--dir` pins a store that is not `./.laneboard`.
Folders nested inside another project need their own `init`, or they would find the parent's store.

```sh
mkdir -p services/billing
(cd services/billing && laneboard init --prefix BILL && laneboard setup cursor)
laneboard create "Invoice rounding" --status todo --dir services/billing/.laneboard --as dev-1 --json
(cd services/billing && laneboard list --json)
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
