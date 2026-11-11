laneboard agent rules (task board & CLI for AI coding agents):
1. MANDATORY for every request, even when nobody mentions tasks and the board is empty: before your first file change, claim your task or create one (`prime` says how, or whom to ask); at once your plan, then each item or commit: `laneboard comment <ID> "<text>"`; when done: commit, then `laneboard finish <ID> --result "<result>" --json`. No untracked work.
2. Use only `laneboard` commands (or the task_* MCP tools). Never edit .laneboard/*.json by hand.
3. Always pass `--json`. Your name: without `--as` and LANEBOARD_AGENT writes use the session's default name (`prime` shows it). Your own: `--as <name>` on every command, one per subagent or worker; LANEBOARD_AGENT only if none (inherited).
4. New task: `laneboard create "<title>" --status <status> --assignee <your name> --json` (subtask: `--parent <ID>`). Start work: `laneboard claim <ID> --status <status> --json`. `laneboard prime` prints both with your name.
5. `--expected-rev` is optional: only for edits on top of what you read (`--description` replaces the whole text; `--field`), pass the rev from your last read or write. Status, comment, claim, finish, `--append-description`: without it, and no `get` for it.
6. REV_CONFLICT: re-apply your change on `error.details.task` (keep others' edits, merge the description) with its rev. Never retry blindly.
7. ALREADY_CLAIMED: do not take over; run its `fix` (`--resume`: only your own task from before /clear or a restart). With checks, a checker's `finish` accepts a task handed in with `finish` or passes it to the next check, never its own work.
8. Statuses (in order; the last one is final) and typed fields come from config; `laneboard prime` lists them. On UNKNOWN_* copy a value from `allowed`.
9. `get` shows comments as type `commented`. Files: `laneboard attach <ID> <path>`. Links: `--add-link branch=<name>` / `pr=<url>` / `commit=<sha>` (finish links HEAD).
10. Finished tasks: `laneboard archive <ID>`. Old ones: `laneboard list --scope all --text <q>`.
11. Ids are exact and carry the board prefix, e.g. WEB-12. Every reply names `store` and `prefix` (the --json envelope): write only to your project's board.
12. Not sure which board is yours (store not found, or warned as another project's): `laneboard boards --json`, pick yours by `description` and `path`, then pass `--dir <path>` on every command. None for this project: in its root `laneboard init --dir .laneboard --name <name> --description "<whose project, what work>"`, then the `next` command it prints.
13. Every error has `fix`: run it or adapt it. Exit codes: 2 input, 3 not found, 4 conflict, 5 busy (retry once), 6 store.
14. Text starting with "-" or "--" (list items, "--- section"): options first, then `--`, then the text (`laneboard comment <ID> --json -- "- item"`); option values as `--description="- item"`. Text with quotes, tabs or newlines: from stdin, `laneboard comment <ID> - --json <<'EOF'` (`--result-file -`, `--append-description-file -`).

<!-- short forms: not part of the rules above. When prime runs out of room it prints these instead of the rules of the same number
(src/cli/format.ts). Line: `short <n> <first 8 hex of the sha256 of rule n>: <text>`. Changed rule n? Re-read its short form so it says
the same, then put the new hash (the test in test/cli/s3c.test.ts prints it). -->
short 1 81d67270: MANDATORY for every request, even on an empty board: claim or create your task before your first edit; at once, your plan, then each item or commit: `laneboard comment <ID> "<text>"`; when done: commit, then `laneboard finish <ID> --result "<result>" --json`.
short 3 cb709e9e: Always `--json`. Name: the session default (prime shows it), or your own `--as <name>` on every command, one per subagent/worker; LANEBOARD_AGENT only if none.
short 4 4e66f42e: New task, start: the create and claim commands below (`--status`, `--assignee`, `--json` set; subtask: `--parent <ID>`).
short 5 75e18f80: `--expected-rev` only for edits on top of what you read (`--description`, `--field`): your last rev. Not for status, comment, claim, finish, `--append-description`.
short 6 1573e298: REV_CONFLICT: re-apply your change on `error.details.task` with its rev (keep others' edits); never retry blindly.
short 7 3ee89210: ALREADY_CLAIMED: do not take over; run its `fix` (`--resume`: only your own task from before /clear or a restart).
short 8 49f53a24: Statuses (in order; last is final), typed fields: the lines below the store. On UNKNOWN_* copy a value from `allowed`.
short 9 ab6ee06c: Files: `laneboard attach <ID> <path>`; links: `--add-link commit=<sha>` (branch=, pr=; finish links HEAD).
short 11 56896973: Ids are exact, with the board prefix (WEB-12). Every `--json` reply names `store` and `prefix`: write only to your project's board.
short 12 a7dd5e3c: Which board is yours? `laneboard boards --json`, pick by `description` and `path`, then `--dir <path>` on every command. None: in the project root `laneboard init --dir .laneboard --name <name> --description "<whose project, what work>"`.
short 14 bbb708cd: Text starting with "-": options, `--`, then the text (`laneboard comment <ID> --json -- "- item"`; `--description="- item"`). Quotes, tabs, newlines: stdin (`laneboard comment <ID> - --json <<'EOF'`, `--result-file -`, `--append-description-file -`).

<!-- mcp forms: not part of the rules above. The MCP server's instructions are its preamble (src/mcp/tools.ts) and these forms, the same
rules for a client with tools and no shell (lb-tokens experiment: rules that name CLI commands sent MCP agents to the shell). Line:
`mcp <n> <hash as for the short forms>: <text>`; text `-`: the rule has no MCP form (shell only). Changed rule n? Re-read its mcp form so
it says the same, then put the new hash (the test in test/mcp/agent-ux.test.ts prints it). -->
mcp 1 81d67270: MANDATORY for every request, even when nobody mentions tasks and the board is empty: before your first file change, take your task with task_claim or create one with task_create (task_prime says how, or whom to ask); at once task_comment with your plan, then with each step (a plan item, a commit); when done: commit, then task_finish with result. No untracked work.
mcp 2 f856612e: Use only the task_* tools (or the `laneboard` CLI). Never edit .laneboard/*.json by hand.
mcp 3 cb709e9e: Your name is the parameter actor: without it writes use the server's `laneboard mcp --as`, else LANEBOARD_AGENT, else the session's default name (task_prime: agent). Each subagent or worker passes its own actor on every call.
mcp 4 4e66f42e: New task: task_create with title, status and assignee: your name (subtask: parent). Start work: task_claim with id and status (the working one).
mcp 5 75e18f80: expected_rev is optional: only for edits on top of what you read (description replaces the whole text; fields): the rev of your last read or write. Status, task_comment, task_claim, task_finish, append_description: without it, and no task_get for it.
mcp 6 1573e298: REV_CONFLICT: re-apply your change on error.details.task (keep others' edits, merge the description) with its rev. Never retry blindly.
mcp 7 3ee89210: ALREADY_CLAIMED: do not take over; do what its fix says (resume: true only for your own task from before /clear or a restart). With checks, a checker's task_finish accepts a task handed in with task_finish or passes it to the next check, never its own work.
mcp 8 49f53a24: Statuses (in order; the last one is final) and typed fields come from config; task_prime lists them. On UNKNOWN_* copy a value from allowed.
mcp 9 ab6ee06c: task_get shows comments as type commented. Files: task_attach with an absolute path. Links: add_links: [{kind, ref}] (branch, pr, commit; task_finish links HEAD).
mcp 10 44606d09: Finished tasks: task_archive. Old ones: task_list with scope all and text.
mcp 11 56896973: Ids are exact and carry the board prefix, e.g. WEB-12. Every reply names store and prefix (its 2nd content block): write only to your project's board.
mcp 12 a7dd5e3c: -
mcp 13 e7a89024: Every error has fix: do what it says or adapt it.
mcp 14 bbb708cd: -
