# Orchestrators: checks, reviewers, creators

Back to the [README](https://github.com/bazarbayevabylay/laneboard/blob/main/README.md). For boards where one agent (the orchestrator)
hands out the work and others check it.
Every `sh` block below runs in laneboard's test suite, in order, in a fresh project, so the commands and exit codes are real.
The examples need the CLI and a board:

<!-- guide:skip installs globally -->
```sh
npm i -g laneboard
```

```sh
laneboard init --name web --description "ACME web shop: catalog and cart"
```

## Checks in N steps, reviewers, creators

Optional keys of the board; a board without them works as the README shows. Turning one on writes `config.json` as `laneboard/config@2`
(laneboard 0.3.x refuses such a board); `none` turns each off again.

```sh
laneboard config --review-statuses review --reviewers lead --json
laneboard create "Add rate limiting" --status todo --assignee dev-1 --as lead --json
laneboard claim WEB-1 --status in_progress --as dev-1 --json
laneboard finish WEB-1 --result "Limiter added, 5 req/min" --as dev-1 --json
laneboard finish WEB-1 --status done --result "Self-accept" --as dev-1 --json  # exit 2
laneboard finish WEB-1 --result "Checked again" --as lead --json  # exit 2
laneboard finish WEB-1 --status done --result "Checked with an admin token" --as lead --json
laneboard config --review-statuses none --reviewers none --json
```

- `--review-statuses code_review,qa`: the checks in order (between the first and the final status, in the order of the statuses: another
  order is refused, its fix in that order). The assignee's `finish` hands in
  to the check the task is in, else the first check. A checker names where the task goes: `finish <ID> --status <next>` passes it to
  the next check, from the last one `--status <final>` accepts it.
- A hand-in goes only to a check, where the checkers see it: the assignee's `finish --status <work status>` (say `blocked`) is refused.
  Its fix keeps the meaning without a hand-in, `comment <ID> -- '<result>' && update <ID> --status <that status>`; the message names
  the hand-in, `finish <ID> --status <check>` (for a task waiting in a check: handed in already). Older such hand-ins: `config` warns
  and `doctor` reports them (check `checks`, exit 6).
- Work status: the status before the first check (`todo,in_progress,blocked,code_review,qa,done` gives `blocked`; the first status when
  the first check follows it). Claims from `prime` and returns for rework go there. `config` prints `work status: <status>` (JSON
  `review.work_status`); to change it, reorder: `laneboard config --statuses todo,blocked,in_progress,code_review,qa,done`.
- A checker's `finish` without `--status`, with the check the task is in or past the next one is refused: the task may have moved on
  since your read (two checkers on one queue). Its fix only reads the task (`laneboard get <ID>`); the message names both commands:
  the pass (`finish --status <next>`) and the return for rework with a placeholder for its reason, `-- '<why it goes back>'`, not your
  `--result`. No fix of a checker's refusal passes on or accepts a task.
- `--reviewers rev,orch`: who checks (default: anybody but the author of the work). The author never passes on or accepts its own work.
  A Claude Code session writes as `claude-code@<user>:<session>`, so `--reviewers claude-code@<user>` warns: that name never checks.
- Any of the reviewers makes any check, both in a row too: the two lists are not paired (`rev` is not bound to `code_review`).
  A checker's `finish` applies to the check the task is in now, whoever passed it there.
- A task waiting in a check is handed in: the author's `finish`, `update` or `claim` into another check or the final status gets
  `INVALID_VALUE` "handed in already, waits in <check> for the check of <checkers>", its fix a comment. Never back to an earlier check.
- A task enters a check only with `finish`, so the checkers always see it: `update`, `claim`, `create` and `import` into a check are
  refused. The holder's fix is the hand-in with `finish`; a checker's is `get` with both commands; anybody else's a comment to the holder.
  A closed task is reopened first: the fix is `update <ID> --status <work status> && finish <ID> --status <check> ...`.
- The checks are never bypassed: `update --status <final>` closes only a task waiting in the last check (with a warning: no result
  of a check, no acceptance mark). A task in work is `ALREADY_CLAIMED` with a comment that asks its holder to hand it in, one returned
  for rework `ALREADY_CLAIMED` with `laneboard get <ID>`, an unassigned one `INVALID_VALUE` with the hand-in, one waiting in an earlier
  check `INVALID_VALUE` with `laneboard get <ID>`. A board without checks closes by update as before.
- A new holder keeps the hand-in: `update --assignee` or `--unassign` of a task waiting in a check leave it in the
  checkers' queue. The new holder is an author of the work all the same and never passes it on or accepts it. When the new holder
  could check it (a checker's `update <ID> --assignee <itself>`), the write warns: it never checks this task now, the check stays with
  the checkers left, else the owner's `config --reviewers`. A check needs no assignment: `finish <ID> --status <next>`.
  A name that may not check a waiting task and did not work on it neither takes it (`update --assignee <itself>`) nor moves it out of
  the check (`update --status <work status>`), in either order: `ALREADY_CLAIMED` (unassigned: `INVALID_VALUE`), its fix a comment.
- Nobody claims a task waiting in a check: a check needs no claim (`finish --status <next>`), and the claim would make the checker
  an author. A checker's `claim` gets the fix `laneboard get <ID>`, the message names the pass and the return (with the same
  placeholder); anybody else a comment.
  `prime` lists such a task under "Waiting for your check", never among the free tasks.
- No checker left (every name in `--reviewers` worked on a waiting task, say the orchestrator gave it to the only checker): the
  refusals, `prime` and `doctor` (check `checks`, exit 6) name the owner's way out, `laneboard config --reviewers "<names>,<another checker>" --json`.
  `config --reviewers` that leaves a waiting task so, and a hand-in while `--reviewers` names only its author, warn with that command.
- A checker's queue skips a check it passed the task into, unless no other checker may make it (say `--reviewers rev` on two checks):
  then the task stays there, marked "(you passed the previous check)", with its pass command.
- `config --review-statuses` that turns a status with tasks in work into a check warns with each task and its holder's
  `finish <ID> --status <check> ...`; until then `doctor` reports them (check `checks`, exit 6).
- `--creators orch`: only these names create tasks, subtasks and imports; others get `INVALID_VALUE` with a fix that asks for a task.
- Return for rework: the checker comments why, then `update <ID> --status <work status>`. The reply confirms it with no warning:
  `returned for rework to <assignee>`, the reason, and that the assignee hands it in again with `finish` (JSON and MCP:
  `returned {to, reason}`). The assignee's `prime` (and the SessionStart hook, for a task of an earlier session) shows that comment: only the returner's comment since the last hand-in, never one from an
  earlier round. A return with no comment warns the returner with `laneboard comment <ID> --as <checker> -- '<why it goes back>'`, and
  the assignee's `prime` says "returned for rework by <checker> at <time> with no reason - ask them or see laneboard get <ID>".
  Another checker's stale `finish` (or `update` into a check) of the returned task gets the fix `laneboard get <ID>`, the message names
  who returned it, when and why (the returner's comment since the hand-in), also after the assignee moved it (say to `blocked`), until
  it is handed in again. No fix writes a comment there: the assignee reworks the task, and under it the assignee's `prime` shows only
  the returner's comment since the hand-in, never a note of another name. The author's own move out of a check is no return.
  A checker's `finish --status` with an earlier check or any work status (also one between two checks) is refused; its fix is that
  comment and update in one line.
- Subagents learn their part from `laneboard prime`: the checks, the checkers, "Waiting for your check" with the ready
  `pass: laneboard finish <ID> --status <next> ...` under each task (MCP `task_prime`: `roles.waiting[].next_status`).
- Boards created before 0.4.0 keep working as they were; checks are turned on only by hand with `laneboard config`.

## Your name after a restart

The orchestrator's name is in `--reviewers` or `--creators` (say `orch`), but after a restart or `/clear` a Claude Code session gets
a new default name. So the orchestrator's first command after a restart is:

```sh
laneboard prime --as orch
```

- Then it passes `--as orch` on every command (MCP: `actor`). Its `prime` shows "Waiting for your check" with the pass commands and
  the create command.
- Keep the name in the orchestrator's own instructions (its prompt, or the note it reads after a restart), never in a shared file.
- Why not a shared file: `.claude/settings.json`, `.claude/settings.local.json`, `CLAUDE.md` and the env reach every session that
  reads them: a colleague's clone, a second window, a worker in a linked worktree (Claude Code shares the local file with them too).
  Such a worker would write as `orch`, and the real `orch` could not check its task: the author never checks its own work.
  So `setup` takes no `--as` (`USAGE`).
- Until a session names itself, the SessionStart hook and `prime` print one line on such a board: "Named roles here: reviewers rev,
  orch; creators orch. If you are one of them: `laneboard prime --as <name>`, then --as <name> on every command."
  A named session (`--as`, `LANEBOARD_AGENT`) does not see it.
- `export LANEBOARD_AGENT=<name>` suits a single agent with no subagents (say in Codex or a script). Never in an orchestrator's
  session: its subagents inherit it, and one without `--as` would write as `orch`.

## Taking over a claimed task

`claim` never takes a task from another name. The orchestrator reassigns it and says why:

```sh
laneboard create "Profile the export" --status todo --as dev-1 --json
laneboard claim WEB-2 --status in_progress --as dev-1 --json
laneboard claim WEB-2 --as dev-2 --json  # exit 4
laneboard update WEB-2 --assignee dev-2 --as lead --json
laneboard comment WEB-2 "dev-1 stopped; dev-2 takes over" --as lead --json
```

## All boards at once

`list --all-boards` merges the tasks of every board of this machine (`--open`: without final statuses). `prime --all-boards` adds a
section of at most 3000 characters: one counts line per board, then the urgent tasks across boards (`waiting-owner`, handed in, stale =
in work with no change for 4 hours), each class with `+N more: <command>` when cut. The label `waiting-owner` plus a comment with the
question marks a task that waits for the owner.

```sh
laneboard list --all-boards --open --json
laneboard prime --all-boards --as lead
```
