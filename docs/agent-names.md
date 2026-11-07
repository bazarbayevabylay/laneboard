# Agent names and sessions

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

## Who writes

Every write is signed with a name: `--as` (MCP `actor`), else `LANEBOARD_AGENT`, else the session's default name.
Names use letters, digits and `. _ : @ -`. Names are self-chosen, so every rule about who may do what guards against an agent's
mistake, not against a hostile agent.

| What | How |
|---|---|
| Default name in Claude Code | `claude-code@<base>:<first 8 characters of the session id>`; the base is the global git `user.name` (`~/.gitconfig`, read without running git), else the OS user; `setup` writes it, Claude Code gives the session id |
| Two parallel sessions | two names, so the second one's `claim` fails with `ALREADY_CLAIMED` |
| Where a name came from | every event has `actor_source`: `explicit` or `default`; `get` marks `(default name)` |
| Subagents of one session | share its default name, so each passes its own `--as`; `prime` under the default name says so |
| Codex, Cursor, Gemini CLI, OpenCode | no default name (no session id): pass `--as` |
| You in a shell | no default name either: the pin and the name of `.claude/settings.local.json` reach only Claude Code sessions; `prime` says "your name is not set" and prints `create` with `--as <your-name>`; pick any name and keep it |

## After `/clear` or a restart

A new session id gives a new name. The rest of this section is what the CLI does about the tasks of the earlier session.

- The SessionStart hook (except resume and compaction) lists the unfinished tasks of earlier sessions with the same base and their age,
  the longest silent (abandoned) first. Past 5 it ends in `... N more (M in all): laneboard list --sessions-of <base> --json`, which
  lists them all, never your own (`prime --json`, `task_prime`: `resumable_total`). `claim <ID> --resume` takes one over.
- `ALREADY_CLAIMED` on such a task offers `--resume` once that session wrote nothing for 15 minutes, else a comment.
  `--resume` of a live session works with a warning, except a task that session itself took back with `--resume` less than 15 minutes
  ago (`ALREADY_CLAIMED`, a comment as the fix).
- A closed task is not resumed: the fix is a new task. `--resume` of a free task is a plain claim, with a warning.
- A `claim` of a task you hold or take back moves it from the first status into the work status (the second status unless final;
  with checks the one before the first check).
- A session whose task was taken over reads "no longer yours" on its next `comment`.
- On a board with checks a task handed in and waiting for a check is not resumed: the same base in any session is its author, gets
  "handed in already" and never sees it as a check of its own.

```sh
LANEBOARD_DEFAULT_AGENT=claude-code@ann CLAUDE_CODE_SESSION_ID=a1b2c3d4 laneboard create "No name given" --status todo --assignee claude-code@ann:a1b2c3d4 --json
LANEBOARD_DEFAULT_AGENT=claude-code@ann CLAUDE_CODE_SESSION_ID=e5f6a7b8 laneboard prime
LANEBOARD_DEFAULT_AGENT=claude-code@ann CLAUDE_CODE_SESSION_ID=e5f6a7b8 laneboard list --sessions-of claude-code@ann --json
LANEBOARD_DEFAULT_AGENT=claude-code@ann CLAUDE_CODE_SESSION_ID=e5f6a7b8 laneboard claim WEB-1 --resume --json
```

Orchestrators with a fixed name (`--reviewers`, `--creators`) name themselves after a restart:
[orchestrators.md](https://github.com/bazarbayevabylay/laneboard/blob/main/docs/orchestrators.md), "Your name after a restart".
