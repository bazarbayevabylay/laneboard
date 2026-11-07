# Configuration: setup, MCP, prefix, statuses, fields

Back to the [README](https://github.com/bazarbayevabylay/laneboard/blob/main/README.md).
Every `sh` block below runs in laneboard's test suite, in order, in a fresh project, so the commands and exit codes are real.
The examples need the CLI and a board:

<!-- guide:skip installs globally -->
```sh
npm i -g laneboard
```

```sh
laneboard init --name web --description "ACME web shop: catalog and cart"
```

## What setup writes

`laneboard setup <harness>` in the project root registers the MCP server `laneboard`, adds a 3-line instruction block and pins the
project to its board. Several harnesses per project are fine. A second run reports `unchanged`; `--dry-run` writes nothing.

```sh
laneboard setup claude-code
laneboard setup cursor --dry-run
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
  share the default name), except a task of an earlier session of the same default name that wrote nothing for 15 minutes (closed by
  `/clear` or a restart). For reminders about your own tasks only, set `LANEBOARD_AGENT=<your name>`.
- `setup codex` in a folder below the root of a git repository warns: Codex reads `AGENTS.md` from the repository root down to the
  folder it starts in, so a Codex started at the root never sees that block.
- On a board with `--reviewers` or `--creators`, a session with no name of its own reads one line with those names and
  `laneboard prime --as <name>` ([orchestrators.md](https://github.com/bazarbayevabylay/laneboard/blob/main/docs/orchestrators.md), "Your name after a restart"). No file setup writes carries a name.
- A board that came with a cloned repository is not shown to the agent by the hook until `laneboard setup claude-code` registers it.
- Claude Code plugin instead of `setup claude-code`: `/plugin marketplace add bazarbayevabylay/laneboard`, then
  `/plugin install laneboard@laneboard`. Use one of them, not both: they register the same server and hooks. The plugin does not
  install the CLI ([install.md](https://github.com/bazarbayevabylay/laneboard/blob/main/docs/install.md)).
- A symlink inside the project is followed (`CLAUDE.md -> AGENTS.md` puts the block into `AGENTS.md`). A link leading outside the
  project, a dangling one or one into `.git` is refused (`SETUP_CONFLICT`), nothing written.
- Text you put between `<!-- laneboard:start -->` and `<!-- laneboard:end -->` is never deleted: setup refuses and names the lines.
- `.git/info/exclude` gets a laneboard block: the local settings, `*.laneboard.bak` backups and `.laneboard-created` markers stay out of git.
- What to commit for Claude Code: `.mcp.json` (`laneboard mcp`, no path), `CLAUDE.md` and `.claude/settings.json` (the hooks), so the
  team shares the server, rules and hooks; each machine runs `setup claude-code` once for its own `.claude/settings.local.json`.
  The other harnesses put `--dir <board>`, a path of this machine, into their MCP entry or instructions.

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
- Your name on writes: the tool's `actor`, else `mcp --as`, else `LANEBOARD_AGENT`, else the session's default name; with none,
  `task_prime` warns to pass `actor`.
- An error's `fix` and the warnings name tool calls, not CLI commands: `task_comment {"id":"WEB-1","text":"<note>","actor":"codex-1"}`,
  two of them joined by `, then`. A command no tool runs (`boards`, `init`, `config`, `doctor`, `--dir`) stays a CLI command.
  `structuredContent` is the CLI `data`, plus `warnings` when there are any.
- The client cannot find `laneboard`? Put the absolute path from `command -v laneboard` into `command`; with nvm that path changes
  with the Node.js version, so update it after switching.
- 12 tools: `task_prime`, `task_create`, `task_get`, `task_list`, `task_update`, `task_claim`, `task_comment`, `task_finish`,
  `task_attach`, `task_archive`, `task_restore`, `task_events`. `init`, `config`, `setup`, `delete`, `redact`, `import` and `doctor` are CLI-only.

```sh
laneboard mcp --dir .laneboard --as codex-1 < /dev/null
```

## Board name and id prefix

A board has a name and a one-line description: whose project, what work. The id prefix comes from the name, at most 4 characters:
the initials of its words (`my-web-app` -> `MWA-1`) or the start of one word (`laneboard` -> `LANE-1`), a trailing number kept.
Your own prefix: `init --prefix WEB`; `laneboard config --prefix WEB` changes it while the board has no task. It must differ from every
other board's prefix on this machine (`init`, `config` and `setup` check it).

```sh
laneboard config --prefix SHOP --json
laneboard config --prefix WEB --json
```

## Statuses, fields and labels

- Statuses are the board's columns, in order; the last one is final. `init --statuses todo,in_progress,review,done` (the default) sets
  them, `laneboard config --statuses a,b,c` changes the whole list later (at least 2). A status that active tasks are in is dropped only
  after they move. Agents never change statuses.
- Fields are typed extra keys. `init` declares one, `priority` (number, 0 = highest), and prints it;
  `laneboard config --field <key>:<type>[:<description>]` declares or changes one (`string`, `number`, `boolean`, `string[]`, `json`),
  `--drop-field <key>` removes it once no active task holds a value. Number fields take decimal notation only (`-?digits[.digits]`):
  `0x10`, `1e3` and `Infinity` are refused.
- Labels: lowercase Latin letters, digits and `. _ -`, starting with a letter or a digit, up to 40 (`ui-bug`, `zone-api`).
  `zone:api` is refused with a fix that holds the normalized label.

```sh
laneboard config --field priority:number:"0 = highest" --field area:string --json
laneboard create "Fix the cart total" --status todo --label ui-bug --field priority=1 --field area=cart --as dev-1 --json
laneboard create "Zone label" --status todo --label zone:api --as dev-1 --json  # exit 2
```
