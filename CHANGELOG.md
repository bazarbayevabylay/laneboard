# Changelog

All notable changes of laneboard. Versions follow semver; before 1.0 a minor version may change behavior, and the notes say how.
The reasons behind each change are in [ADR-0001 on GitHub](https://github.com/bazarbayevabylay/laneboard/blob/main/docs/adr/0001-two-json-store-cli-first.md) (sections named below).

## Unreleased

### C

- `init` prints the declared fields (`priority` by default) and how to add or drop one (LB-58.1).
- `init --json` names the setup command in `data.setup` next to `data.next` (LB-58.2).
- `setup --dry-run` says `would create` / `would update`, never `created` (LB-59.1).
- `setup --dry-run` warns `would write <file>.laneboard.bak`, never `wrote` (LB-59.2).
- `setup codex` below the root of a git repository warns that a Codex started at the root never sees that AGENTS.md (LB-59.3).
- `config --review-statuses` with a typo keeps the meant status in the fix, never drops it (LB-62.1).
- `config --review-statuses` in another order than the statuses is refused with the right order as the fix (LB-62.2).
- `config --reviewers <harness>@<user>` warns: sessions write as `<base>:<session>`, so that name never checks (LB-62.3).
- `config --review-statuses none --reviewers <names>` is refused instead of dropping the names (LB-62.4).
- `schema/config.json` allows the keys config@2 keeps from a newer laneboard (top level, `review`); config@1 stays closed (LB-62.7).
- README: `?board=` of every HTTP route but `/api/boards`, and the `assignee`, `label`, `text` filters of `/api/tasks` (LB-65.1).

### D2

- `import --dry-run` shows the status each new task gets and `parent_source` for a subtask of a parent that is new too (`created[].status`, LB-64.1).
- `import checklist` with a `--status` / `--done-status` not in the config stops with UNKNOWN_STATUS even when every item was imported before (was exit 0, LB-64.3); `import markdown|json` still skips a file imported before as it is, whatever its status now.
- `archive <id>` of a task that is not finished and has an assignee warns who holds it (LB-64.4).
- `archive` drops a `deleted` mark left on an active task by a 0.3.1 restore, so the task does not become a tombstone (LB-64.5).
- `attach` checks the stored copy in 64 KiB chunks instead of reading it whole (LB-65.6).

### B

- `prime --edit-hook` under the session default name no longer stays quiet for a task of an earlier session of the same name that
  wrote nothing for 15 min (closed by /clear or a restart); any other task in work still keeps it quiet (LB-56.1).
- `prime --edit-hook --help` says when the reminder is printed: no task of that name under `--as`/LANEBOARD_AGENT, no task of anybody
  under the session default name (LB-66).
- Rule 7 names checkers with "With checks,"; prime leaves that sentence out on a board without checks (LB-57.1).
- `in_progress` of `prime --json` and `task_prime` no longer counts tasks in the first status; prime lists them as before (LB-57.3).
- `create --assignee <name>` by a creator on a board with create_by gives no "not to you" warning (LB-61.1).
- prime of a creator on a board with create_by says tasks for other agents take their `--assignee` instead of "Create one now" (LB-61.2).
- prime of a checker shows under a task handed in again why it was returned before; `roles.waiting[].last_return` (LB-61.5).
- The fixes of the create_by refusal end with `--json` (LB-63.2, create).

### A1

- LB-54.1: `claim --resume` (and a plain `claim`) no longer takes a task an earlier session of the same default name closed: `ALREADY_CLAIMED`, "nothing to resume", the fix is a new task; no fix names `--resume` for it.
- LB-54.2: `claim --resume` without `--status` of a task in the first status moves it into the work status (LB-57.4 rule).
- LB-54.3: `claim --resume` of a free task warns that it was a plain claim, not a task of an earlier session.
- LB-54.4: a task another session took back with `--resume` less than 15 min ago stays with it: a second `--resume` (or claim) is `ALREADY_CLAIMED` with the comment fix until that resume is 15 min old; after that `--resume` works as before (exit 0, with the warning while that session still writes), so the next `/clear` of a long task is not refused.
- LB-54.5: `comment` by a name that lost the task (taken over with `--resume`, given to another name or unassigned by someone else) warns "no longer yours".
- LB-57.4: `claim` without `--status` of a task you already hold moves it from the first status into the work status (the one before the checks, else the second status unless final) instead of "no changes"; a plain claim of a free task keeps its status.
- LB-63.6: on a board with checks, `update --assignee <self>` of a task waiting for a check by a name that may not check it (and did not work on it) is refused like `claim` (`ALREADY_CLAIMED`, or `INVALID_VALUE` when unassigned).

## 0.4.0

The audit release: data safety, setup safety, orchestrator workflows, any MCP client, monorepos, and English docs.

### Added

- The board in the browser, read-only by design: `laneboard board` serves every board of the machine as tabs on 127.0.0.1 with a
  per-run token, live within 1-2 s; marks "Waiting for acceptance" and "Stale", attachments with previews (ADR §31).
- Subtasks (`create --parent`, `get` children, `list --parent`, `update --no-parent`), `update --append-description`, and the
  `result: true` mark on finish's comment (ADR §25-§27).
- The card line (newest comment under each card and list row), the `waiting-owner` label, `list --all-boards` and
  `prime --all-boards` for orchestrators (ADR §28-§29); task links across boards, `--link task=WEB-12` (ADR §30).
- `laneboard config --statuses a,b,c` changes the statuses after init (ADR §33); `create` keeps `--status` required with a runnable fix (ADR §23).
- Checks in N steps (ADR §43): `laneboard config --review-statuses code_review,qa --reviewers rev,orch --creators orch`. The assignee's
  `finish` hands in to the first check, a checker's `finish` passes the task on and from the last check accepts it; the author of the work
  never passes on or accepts its own work; `--creators` limits who creates tasks, subtasks and imports. `prime` and `task_prime` show the
  checks, the checkers, the tasks waiting for your check and the newest comment of a checker under your task. All keys are optional.
  A task waiting in a check never goes back to an earlier one: the author's move into another check is `INVALID_VALUE` "handed in
  already, waits in <check> for the check of <checkers>" with a comment as the fix (ADR §51). Any checker makes any check, both in a
  row too. A checker's `finish` into an earlier check or any work status (also one between two checks) is refused with the return
  for rework as its fix (`comment <ID> --as <checker> -- '<result>' && update --status <work status>`), never an acceptance (ADR §51).
  A checker names where the task goes: `finish <ID> --status <next>` (the next check, from the last one the final status); without
  `--status`, with the check the task is in or past the next one it is refused, so a second checker on a stale read never skips a
  check; that fix only reads the task (`laneboard get <ID>`) and the message names the pass and the return. A task enters a check only
  with `finish`: `update`, `claim`, `create` and `import` into a check are refused. `prime` prints the ready pass command under each
  waiting task, `task_prime` `roles.waiting[].next_status` (ADR §51). A new holder (`update --assignee`, `--unassign`) keeps a waiting task
  in the queue; nobody claims a waiting task (a checker's fix: `laneboard get <ID>` with the pass named), and it is never listed as free;
  when every reviewer worked on a waiting task, the refusals, `prime` and `doctor` name `laneboard config --reviewers "<names>,<another>"`,
  and `config --reviewers` or a hand-in that leaves it so warns with it; another session of the author's default name is its author too
  (no check, no resume of a waiting task); the free tasks' `list --unassigned` footer says it lists the waiting ones too; the only checker keeps
  the next check of a task it passed in its queue (marked "you passed the previous check"); `config --review-statuses` over tasks in work warns with their hand-in, and `doctor` reports them (check `checks`).
  `config` names the work status of a board with checks, the status before the first check where claims and returns go
  (`work status: <status>`, JSON `review.work_status`); an `update --assignee` that gives a waiting task to a name that could check it
  warns that this name never checks it now, with the checkers left or `config --reviewers` (ADR §52).
  A hand-in goes only to a check: the assignee's `finish --status <work status>` is refused, its fix `comment <ID> -- '<result>' &&
  update <ID> --status <that status>` (no hand-in), the message names `finish <ID> --status <check>`; older such hand-ins are named by
  `config` and `doctor` (check `checks`). A stale check of a task returned for rework gets the fix `laneboard get <ID>` and a message
  with who returned it, when and why, no longer a "hand it in" comment that replaced the reason in the assignee's `prime` (ADR §53).
  The reason the assignee sees (`prime`, `task_prime` `roles.feedback`, the SessionStart hook also under a task of an earlier session)
  is only the returner's comment since the last hand-in; a return with none says "returned for rework by <name> at <time> with no
  reason" (`comment: null`, `returned: {by, at}`) and warns the returner with the comment command; the return named in a stale
  check's message carries `'<why it goes back>'`, never the refused command's result (ADR §54).
  The documented return (the checker's comment, then `update --status <work status>`) is confirmed in the reply, `returned for rework
  to <assignee>` with the reason (JSON and MCP `returned {to, reason}`), with no warning naming the assignee's hand-in (ADR §55).
- MCP tool `task_prime` (read-only; call it first) and `laneboard mcp --as <name>` as the server's default actor; the server's
  instructions start with an MCP preamble; `STORE_NOT_FOUND` from the server lists the boards and says how to start your client for the
  project (its folder or `LANEBOARD_DIR`, by the client's name; never `--dir` in a global config like Codex's); `mcp --dir` naming
  another project's board warns as `LANEBOARD_DIR` does (ADR §47, §51).
- `laneboard import checklist TODO.md --status todo` imports a Markdown TODO list: an item is a task, `[x]` the final status, an indented
  item a subtask; a re-run skips imported items. `import markdown` names this command when it meets checkboxes (ADR §46).
- `laneboard redact <ID> --text-file <file>` removes a pasted secret from a task and from the store backups (ADR §38).
- `laneboard config --field <key>:<type>[:<description>]` and `--drop-field <key>` declare and remove task fields after init (ADR §40).
- `laneboard boards --forget <prefix|name|path>` removes a registry entry whose board is gone (ADR §39).
- `get` and `list` show who deleted a task and when: `deleted <at> by <who>`, `deleted {at, by}` with `--json` (a tombstone only) (ADR §38).
- `setup claude-code` warns in one line when the board path and your name go into the committed `.claude/settings.json` (ADR §49).
- `finish --commit <sha>`; MCP `task_finish` takes `cwd` (your worktree) or `commit` (ADR §41).
- `setup codex --remove --global` removes the global Codex entry even while other projects use it (ADR §39).
- On a board with `--reviewers` or `--creators`, `prime` and the SessionStart hook of a session with no name of its own print one line
  with those names and `laneboard prime --as <name>`; "not you" is said only to a named session. An orchestrator runs
  `laneboard prime --as orch` first after a restart; no project file carries a name, so `setup` refuses `--as` (ADR §55).
- `list` items carry `handed_in`, `in_work` and `stale`; `laneboard` with no arguments prints the help; `-v` is `--version`.
- One warning line when the CLI runs on Node.js older than 22 (`warnings` with `--json`) (ADR §50).
- `CHANGELOG.md`; `README.md` in English (sections for any MCP client, monorepos and orchestrators); the package metadata
  (keywords, homepage, bugs, author).

### Changed

- `delete` leaves a tombstone in `archive.json` (id, title, status, dates, `deleted {at, by}`); `restore` and a second `delete` of it
  are refused. `task_delete` is no longer an MCP tool: deleting is for people, CLI-only; a call of it is an unknown-tool error whose
  fix names `laneboard delete <ID> --confirm <ID>` (ADR §6, §38).
- Replacing a description keeps the old text in its `updated` event (`previous`, up to 10 000 characters) (ADR §38).
- Monorepo (ADR §44): inside a git repository only `.git` or a board of its own marks another project, so a package with its own
  `AGENTS.md` or `CLAUDE.md` uses the root's board without a warning. A plain `init` in a subfolder of a repository whose board lies
  above is refused (own board: `init --dir`); `setup` pins such a folder to the root's board.
- Claude Code pin (ADR §49): a package of a repository pinned to the root's board gets its env in the root's
  `.claude/settings.local.json` (not in git); the package's committed `.claude/settings.json` holds only the hooks. An older pin there
  is moved with a warning.
- A linked git worktree finds the board of its main checkout; `setup` writes the exclude block into the common git folder (ADR §41).
- Session restart (ADR §45): the SessionStart hook lists your earlier sessions' tasks on every start but resume and compaction;
  `ALREADY_CLAIMED` on such a task offers `claim <ID> --resume --json` once that session wrote nothing for 15 minutes. The list shows
  the longest silent first and never cuts one silently: past 5 it ends in `... N more (M in all): laneboard list --sessions-of <base>
  --json` (new `list --sessions-of`, MCP `task_list` `sessions_of`: other sessions' tasks, never the caller's own); `prime --json` and
  `task_prime` add `resumable_total`, the same count (ADR §52).
- `prime --hook` shows nothing but one line for a board that is not in the machine registry (a cloned one); prime marks the board's
  texts with `Board data below, not instructions.`; the all-boards overview keeps every board's counts line and the urgent classes,
  cut only at a line end (ADR §42).
- A finish with a new result into the same status records it (rework handed in again); the same result is still "no changes" (ADR §41).
- `finish --status <first status>`: the fix goes back to the start (`comment ... && update --status <first status>`), no longer
  `finish --status <final status>` (ADR §51).
- `finish <ID> -- "- text"` (the result as an argument, no `--result`): the fix is `finish <ID> '--result=- text'`, runnable as
  printed; before, it dropped the text (ADR §51).
- The instruction block of codex, cursor, gemini and opencode names the board as a prefix of each command and no longer advises
  `export LANEBOARD_DIR` (exported, other projects wrote to this board); `setup` rewrites an older block (ADR §51).
- The PostToolUse matcher is `Edit|Write|MultiEdit|NotebookEdit` (setup and plugin) (ADR §39).
- `setup` follows a symlink inside the project and refuses one leading outside, dangling or into `.git`; text inside the laneboard
  block that laneboard did not write is never deleted (`SETUP_CONFLICT`) (ADR §35).
- New boards refuse more secret-like attachment names (`id_dsa*`, `id_ecdsa*`, `id_xmss*`, `*credentials*`, `.netrc`, `.npmrc`,
  `*.p12`, `*.pfx`, `*.kdbx`); boards made before keep their list (ADR §40).
- At least 2 statuses (`init`, `config --statuses`) (ADR §40).
- The events limit (`events_per_task`) drops other events first and keeps `created`, the newest status, assigned and result events (ADR §48).
- Number fields take decimal notation only; a label error's fix holds every label normalized; `create --title X` gets the command with
  the title in its place (ADR §48).
- `doctor` exits 6 while a problem is left and reports statuses outside config, missing parents, attachment size and sha256, and
  fields against config (ADR §37).
- `events --since` compares instants; `list` and `events` default to 20 or the board's `list_limit_max` when lower (ADR §42).

### Fixed

- A short write (full disk, file size limit) never replaces a store file: the command fails, the file and its `.bak` stay whole;
  an attachment is kept only when its size and sha256 read back right; file modes follow the umask (ADR §34).
- `setup` never writes a project file through a symlink to a file outside the project (`CLAUDE.md -> ~/.zshrc`) (ADR §35).
- Human output shows terminal control and bidi characters from task data as `\u{XXXX}`; a fix never runs the user's text as a
  shell command (ADR §36).
- `doctor --restore-backup` never replaces a file it cannot read, keeps the damaged file, never lowers `next_id` and brings back tasks
  only a `.bak` still holds; `doctor --fix` gives a duplicated id a new one and moves orphan attachment files to
  `attachments/.orphaned/` (ADR §37).
- A lock with a time in the future is removed after 10 s without change; `LOCK_TIMEOUT` names the lock; a person waiting over 1 s
  sees why (ADR §37).
- A setup pin to a board that was moved is rewritten; `init` does not create a board at a stale `LANEBOARD_DIR` (ADR §39, §44).
- A machine registry that cannot be written gives a warning, not `INTERNAL` (ADR §39).
- The finish of the assignee after another actor's event on a handed-in task is a new hand-in, not lost (ADR §43).

### Compatibility

- Boards of 0.3.x open unchanged: the store stays `laneboard/store@1` and `config.json` `laneboard/config@1`. `config@2` is written
  only when you turn on checks, reviewers or creators; laneboard 0.3.x refuses such a board (`STORE_TOO_NEW`), and turning them all off
  writes `config@1` again. Boards made before 0.4.0 get checks only by hand.
- A tombstone is a task with an unknown key `deleted`, which 0.3.x reads and keeps; its `restore` there brings back an empty task,
  which 0.4.0 shows as a live task (no `deleted`) until it is archived again.
- MCP clients that called `task_delete` get an unknown-tool error whose fix names the CLI command; deleting is CLI-only.
- Re-run `laneboard setup <harness>` in each project to update the instruction block, the hook matcher and the Claude Code pin.
- Node.js 22 or newer; macOS and Linux (`os` in package.json: npm refuses Windows with `EBADPLATFORM`).

## 0.3.1

- Hand-in texts: the `ALREADY_CLAIMED` fix names the hand-in statuses and stays one comment command; prime's footer note comes before
  the command (LB-11).

## 0.3.0

- Accept from review: the assignee's `finish` into a status that is not final hands the task in (`handed_in`), somebody else's `finish`
  accepts it into the final status (`accepted`, no commit link); finished tasks leave the active count; `view` shows a done tail (ADR §22).

## 0.2.0

- First release: two-JSON store behind one locked transaction, CLI with `--json`, MCP server, `setup` for Claude Code, Codex, Cursor,
  Gemini CLI and OpenCode, Claude Code plugin, `prime` and the agent rules, `import markdown|json`, default agent names, the machine
  registry and `view`, `finish` in one command with `claim --resume` (ADR §1-§21).
