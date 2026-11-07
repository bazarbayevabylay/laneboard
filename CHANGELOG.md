# Changelog

All notable changes of laneboard. Versions follow semver; before 1.0 a minor version may change behavior, and the notes say how.
The reasons behind each change are in [ADR-0001 on GitHub](https://github.com/bazarbayevabylay/laneboard/blob/main/docs/adr/0001-two-json-store-cli-first.md) (sections named below).

## Unreleased

### Docs

- npm shows the English README: the Russian one is `README-ru.md` (npm took `README.ru.md`, the first `README.*` of the folder, as the package page); the README is short, the details are in `docs/*.md` (ADR §57).

## 0.4.1

The 0.4.1 patch: fixes from dogfooding 0.4.0 (LB-54..LB-66; ADR §56).

### Compatibility

- `PORT_IN_USE` exits 4 (conflict, http 409), not 5 (busy, http 503): a script that retried on 5 stops at once, the port stays taken (LB-63.5).
- On a board with checks `update --status <final>` closes only a task that waits in the last check; any other task is refused
  (`ALREADY_CLAIMED`, `INVALID_VALUE`). A board without checks closes by update as before.
- On a board with checks `update --status <work status>` and `update --assignee <self>` of another name's task that waits for a check are
  refused for a name that may not check it and did not work on it (`ALREADY_CLAIMED`, `INVALID_VALUE` when unassigned) (LB-63.6).
- `update --status <check>` of a task returned for rework or not handed in is `ALREADY_CLAIMED`, as `finish` (was `INVALID_VALUE`, LB-63.1).
- `claim` without `--status` of your own task, or one you take back with `--resume`, moves it from the first status into the work status
  (was "no changes"); `claim --resume` of a task an earlier session closed, or one another session took back less than 15 min ago, is
  `ALREADY_CLAIMED` (LB-54.1, LB-54.2, LB-54.4, LB-57.4).
- `import checklist` with a `--status` / `--done-status` not in the config is UNKNOWN_STATUS also when every item was imported before
  (was exit 0, LB-64.3); `config --review-statuses` out of the order of the statuses, and `--review-statuses none --reviewers <names>`,
  are refused (LB-62.2, LB-62.4).
- `in_progress` of `prime --json` and `task_prime` no longer counts tasks in the first status (LB-57.3).
- Fix and warning texts changed: every command in them carries `--json`; over MCP they name tool calls, and `structuredContent`
  carries `warnings`. Scripts that match these texts exactly need an update (LB-60.1, LB-60.3, LB-63.2).
- A repeated `--json`, and `--as` repeated with the same value, now run the command (was `USAGE`, exit 2); `--as` with different
  values and a repeat of any other option are still `USAGE` (ADR §5).

### Added

- `init --json` names the setup command in `data.setup` next to `data.next` (LB-58.2).
- The `finish --json` reply of a hand-in (a status that is not final) says `handed_in: true`; over MCP `task_finish` too (LB-63.3).
- prime of a checker shows under a task handed in again why it was returned before; `roles.waiting[].last_return` (LB-61.5).
- `import --dry-run` shows the status each new task gets and `parent_source` for a subtask of a parent that is new too (`created[].status`, LB-64.1).
- MCP `structuredContent` carries `warnings` too, when there are any (LB-60.3).

### Changed

- LB-63.2: every laneboard command in the fix of an error or in a warning carries `--json` (rule 3): the default fixes of the error
  codes and the fixes and warnings of `create`, `claim`, `comment`, `finish`, `update`, `get`, `attach`, `archive`, `restore`, `redact`,
  `boards`, `init`, `config`, `doctor`, `setup` and `import`. A test reads the fix and warning texts in `src/`, with the names and calls
  they are built from in the same or an imported file, and fails on a command there without `--json`. Error messages, help, doctor reports and human output keep plain commands.
- A repeated `--json`, and `--as` repeated with the same value, run the command: agents add both to a fix that already carries them.
- LB-60.1: over MCP the `fix` of an error and the warnings name tool calls, not CLI commands: `task_comment {"id":"LB-1","text":"<note>","actor":"dev-2"}`,
  two commands joined by `, then`. A command no tool runs (`boards`, `init`, `config`, `doctor`, `--board`, `--dir`, `--file`) stays as it is.
- LB-60.2: over MCP a link or `fields` parameter in the CLI form (`"commit=abc"`, `"priority=2"`, a link that is no `{kind, ref}` object)
  gets a fix that names the form (`add_links: [{"kind": "commit", "ref": "<sha>"}]`); a link of the right form with a wrong value (`ref`
  empty or over 2000 characters, an unknown `kind`) keeps the fix of that value. The MCP preamble maps `--add-link` and `--field`.
- LB-60.4: `task_prime` without a name (agent `null`) warns to pass `actor`.
- MCP: a store found in a parent directory that looks like another project's warns with the client's fix (a board of its own, then
  start the client for it), not with the CLI's `--dir` on every command and `laneboard prime`.
- MCP tool descriptions: `task_update` names the refusals on a board with checks (`ALREADY_CLAIMED` for another name's task), `task_claim`
  the first status and the closed task, `task_finish` `handed_in`, `task_prime` `tasks` vs `in_progress` and `roles.waiting[].last_return`.
- Check bypass: on a board with checks `update --status <final>` closes only a task that waits in the last check (A17 warning as before);
  a task in work or returned for rework is `ALREADY_CLAIMED` (unassigned: `INVALID_VALUE` with the hand-in), a task waiting in an earlier
  check `INVALID_VALUE` with a read as the fix. A board without checks closes by update as before.
- LB-63.6: on a board with checks `update --assignee <self>` and `update --status <work status>` of a task waiting for a check, by a name
  that may not check it (and did not work on it), are refused like `claim` (`ALREADY_CLAIMED`, `INVALID_VALUE` when unassigned), so it
  never takes the task in two steps, in either order; its checkers and its author still move it.
- LB-63.1: a check of a task returned for rework, or of one its holder did not hand in, is `ALREADY_CLAIMED` by `update --status <check>`
  as by `finish` (was `INVALID_VALUE`).
- LB-54.1: `claim --resume` (and a plain `claim`) no longer takes a task an earlier session of the same default name closed:
  `ALREADY_CLAIMED`, "nothing to resume", the fix is a new task; no fix names `--resume` for it.
- LB-54.2, LB-57.4: `claim` without `--status` of a task you hold or take back with `--resume` moves it from the first status into the
  work status (the one before the checks, else the second status unless final) instead of "no changes"; a plain claim of a free task
  keeps its status.
- LB-54.3: `claim --resume` of a free task warns that it was a plain claim, not a task of an earlier session.
- LB-54.4: a task another session took back with `--resume` less than 15 min ago stays with it: a second `--resume` (or claim) is
  `ALREADY_CLAIMED` with the comment fix until that resume is 15 min old; after that `--resume` works as before (exit 0, with the warning
  while that session still writes), so the next `/clear` of a long task is not refused.
- LB-54.5: `comment` by a name that lost the task (taken over with `--resume`, given to another name or unassigned by someone else) warns
  "no longer yours".
- LB-55.1: `finish` warns "commit <sha> is already linked to <ID>" when the commit it links is linked to a task (active or archived)
  another name holds, with the command that links the commit of your work instead.
- LB-63.4: an id with the prefix of another board that board does not hold either is TASK_NOT_FOUND "not on this board, nor on board X",
  with a search there as the fix (was "X-9 is on board X").
- LB-63.5: `PORT_IN_USE` exits 4 (conflict, http 409), not 5 "busy, retry once": the same port stays taken.
- Rule 7 names checkers with "With checks,"; prime leaves that sentence out on a board without checks (LB-57.1).
- `in_progress` of `prime --json` and `task_prime` no longer counts tasks in the first status; prime lists them as before (LB-57.3).
- `init` prints the declared fields (`priority` by default) and how to add or drop one (LB-58.1).
- `setup codex` below the root of a git repository warns that a Codex started at the root never sees that AGENTS.md (LB-59.3).
- `config --review-statuses` in another order than the statuses is refused with the right order as the fix (LB-62.2).
- `config --reviewers claude-code@<user>` without `:<session>` warns: sessions write as `<base>:<session>`, so that name never checks;
  `codex@<user>` or `alice@corp` get no warning (LB-62.3).
- `config --review-statuses none --reviewers <names>` is refused instead of dropping the names (LB-62.4).
- `import checklist` with a `--status` / `--done-status` not in the config stops with UNKNOWN_STATUS even when every item was imported
  before (was exit 0, LB-64.3); `import markdown|json` still skips a file imported before as it is, whatever its status now.
- `archive <id>` of a task that is not finished and has an assignee warns who holds it (LB-64.4).
- `GIT_PROJECT_MARKERS` and `ReworkReturn` are no longer exported (LB-65.9).

### Fixed

- `prime --edit-hook` under the session default name no longer stays quiet for a task of an earlier session of the same name that
  wrote nothing for 15 min (closed by /clear or a restart); any other task in work still keeps it quiet (LB-56.1).
- `prime --edit-hook --help` says when the reminder is printed: no task of that name under `--as`/LANEBOARD_AGENT, no task of anybody
  under the session default name (LB-66).
- `claim --help` says that, without `--status`, one's own task or one taken back with `--resume` leaves the first status for the work
  status, and that a closed task is not resumed (LB-54.1, LB-57.4).
- `create --assignee <name>` by a creator on a board with create_by gives no "not to you" warning (LB-61.1).
- prime of a creator on a board with create_by says tasks for other agents take their `--assignee` instead of "Create one now" (LB-61.2).
- LB-55.2: the worktree warning of `finish` in the main checkout with several worktrees names one command: the finish with the sha of
  your worktree, then `&&` the removal of the wrong link (run as printed it changes nothing).
- LB-55.3: with that worktree warning `finish` no longer also warns "HEAD has not moved since you claimed".
- `finish` in a main checkout with several worktrees, its commit linked to another name's task already: one warning (the worktree one,
  naming those tasks), not two with almost the same command.
- LB-60.5: STORE_NOT_FOUND over MCP names a relative `--dir` or `LANEBOARD_DIR` of the server resolved against its folder.
- `setup --dry-run` says `would create` / `would update`, never `created` (LB-59.1).
- `setup --dry-run` warns `would write <file>.laneboard.bak`, never `wrote` (LB-59.2).
- `setup claude-code --dry-run` over a pin of an earlier setup in `.claude/settings.json` says `would move the env`, never `moved` (LB-59.2).
- `setup claude-code --dry-run` over a pin an earlier setup left in the repository root's `.claude/settings.local.json` says
  `would take it out`, never `took it out` (LB-59.2).
- `config --review-statuses` with a typo keeps the meant status in the fix, never drops it (LB-62.1).
- `schema/config.json` allows the keys config@2 keeps from a newer laneboard (top level, `review`); config@1 stays closed (LB-62.7).
- `archive` drops a `deleted` mark left on an active task by a 0.3.1 restore, so the task does not become a tombstone (LB-64.5).
- `attach` checks the stored copy in 64 KiB chunks instead of reading it whole (LB-65.6).
- README: `?board=` of every HTTP route but `/api/boards`, and the `assignee`, `label`, `text` filters of `/api/tasks` (LB-65.1).

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
