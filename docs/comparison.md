# laneboard next to the alternatives: sources

Back to the [README](https://github.com/bazarbayevabylay/laneboard/blob/main/README.md#how-it-compares). The README table, row by row,
with the page each fact about another tool comes from. All pages were read on 2026-11-07; versions are the latest releases on that day.
Tools change: if a fact here is out of date, open an issue. "—" in the table means we did not find it in their docs, not that it cannot be done.

Every `sh` block below runs in laneboard's test suite, in order, in a fresh project, so the commands and exit codes are real.
The examples need the CLI and a board:

<!-- guide:skip installs globally -->
```sh
npm i -g laneboard
```

```sh
laneboard init --name web --description "ACME web shop: catalog and cart"
```

## laneboard

- Where and across machines: two JSON files in `.laneboard/`, one machine, not in git
  ([docs/storage.md](https://github.com/bazarbayevabylay/laneboard/blob/main/docs/storage.md)).
- Two agents, one task: the guard goes by name. Two names, the second `claim` is `ALREADY_CLAIMED` (exit 4); subagents of one
  Claude Code session share a name unless each passes `--as`
  ([docs/orchestrators.md](https://github.com/bazarbayevabylay/laneboard/blob/main/docs/orchestrators.md#subagents-a-name-for-each)).

```sh
laneboard create "Fix the redirect after login" --status todo --as dev-1 --json
laneboard claim WEB-1 --status in_progress --as dev-1 --json
laneboard claim WEB-1 --as dev-2 --json  # exit 4
```

- Dependencies: a task may link another (`--link task=WEB-12`), but the link blocks nothing and there is no ready queue
  ([agent-guide.md](https://github.com/bazarbayevabylay/laneboard/blob/main/docs/agent-guide.md)).
- Checker roles: optional reviewers and check steps; the author never accepts its own work
  ([docs/orchestrators.md](https://github.com/bazarbayevabylay/laneboard/blob/main/docs/orchestrators.md)).
- Needs: macOS or Linux, Node.js 22 or newer; npm refuses Windows (`EBADPLATFORM`).

## Claude Code Tasks and agent teams

Built into Claude Code (official docs, code.claude.com):

- [Task list](https://code.claude.com/docs/en/interactive-mode#task-list): "Tasks persist across context compactions"; "To share a task list
  across sessions, set `CLAUDE_CODE_TASK_LIST_ID` to use a named directory in `~/.claude/tasks/`"; `Ctrl+T` shows "up to five tasks at a time".
- [Tools reference](https://code.claude.com/docs/en/tools-reference#task-tool-availability): `TaskUpdate` "updates task status, dependencies,
  details"; the task tools are "available by default only on Opus 4.7, Sonnet 4.6, Haiku 4.5, and earlier models" (others opt in).
- [Agent teams](https://code.claude.com/docs/en/agent-teams): "Agent teams are experimental and disabled by default"; "Task claiming uses
  file locking to prevent race conditions"; "A task can also depend on other tasks and shows as blocked"; the task list is stored
  under `~/.claude/tasks/{team-name}/`.
- We found no checker role (an author that may not accept its own task) in these pages.

## beads

[README of gastownhall/beads](https://github.com/gastownhall/beads) (v1.3.4, 2026-11-04):

- "Distributed graph issue tracker for AI agents, powered by Dolt"; embedded mode (default) is a "single writer", server mode is
  "for multiple concurrent writers".
- "Cross-machine sync uses `bd dolt push` / `bd dolt pull`" against your git remote.
- "`bd ready`: List tasks with no open blockers"; "`bd update <id> --claim`: Atomically claim a task".
- `bd setup` for Codex, Claude Code, Cursor and more; "Platforms: macOS, Linux, Windows, FreeBSD".
- A board: no built-in one; the README points to "community-built UIs" (docs/community-tools.md).

## Backlog.md

[README of MrLesk/Backlog.md](https://github.com/MrLesk/Backlog.md) (v1.55.3, 2026-10-23):

- "every task is a plain `.md` file in your repo"; "Git is optional".
- "Milestones & dependencies"; "`backlog board` paints a live board in your shell"; "`backlog browser` serves a local Kanban board
  with drag-and-drop and task editing forms".
- "works with Claude Code, Gemini CLI, Codex, Kiro & any other MCP or CLI compatible AI assistant"; "Cross-platform (macOS, Linux, Windows)".
- The README does not describe a claim lock for two agents on one task, nor a checker role; we did not read the source, so the
  table says "—", not "no".

## GitHub Issues through the GitHub MCP server

- [github/github-mcp-server](https://github.com/github/github-mcp-server) (v2.1.0, 2026-11-03): "Create, update, and manage issues and pull
  requests"; the remote server at `https://api.githubcopilot.com/mcp/`, OAuth or a personal access token; `issue_write` takes `assignees`.
- [Issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies):
  "see which issues are blocked by, or blocking, other work".
- [Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects): "an adaptable
  table, board, and roadmap that integrates with your issues and pull requests".
- We did not check whether the MCP server sets dependencies or locks an issue against a second agent.

## `TODO.md`

A text file in the repo: nothing records who works on an item, and two agents editing it at once overwrite each other.
laneboard can take it over: `laneboard import checklist TODO.md --status todo`
([docs/storage.md](https://github.com/bazarbayevabylay/laneboard/blob/main/docs/storage.md#import-existing-tasks)).
