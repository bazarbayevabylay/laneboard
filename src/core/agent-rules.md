laneboard agent rules (task board & CLI for AI coding agents):
1. MANDATORY for every request, even when nobody mentions tasks and the board is empty: before your first file change, claim your task or create one (`laneboard prime` prints the command); comment each meaningful step; when done: commit, then `laneboard finish <ID> --result "<result>" --json`. No untracked work.
2. Use only `laneboard` commands (or the task_* MCP tools). Never edit .laneboard/*.json by hand.
3. Always pass `--json`. Your name: without `--as` and LANEBOARD_AGENT writes use the session's default name (`prime` shows it). Your own: `--as <name>` on every command or LANEBOARD_AGENT (MCP: `actor`); each subagent or parallel worker needs one.
4. New task: `laneboard create "<title>" --status <status> --assignee <your name> --json` (subtask: `--parent <ID>`). Start work: `laneboard claim <ID> --status <status> --json`. `laneboard prime` prints both with your name; add `--as <name>` only for a name of your own (rule 3).
5. `--expected-rev` is optional: only for edits on top of what you read (`--description` replaces the whole text; `--field`), pass the rev from your last read or write (writes return it). Status, comment, claim, finish, `--append-description`: without it, and no `get` for it.
6. REV_CONFLICT: re-apply your change on `error.details.task` (the current task: keep others' edits, merge the description) with its rev. Never retry blindly.
7. ALREADY_CLAIMED: do not take over; run its `fix` (`--resume`: only your own task from before /clear or a restart). A reviewer accepts a task handed in with `finish` by its own `finish`.
8. Statuses (in order; the last one is final) and typed fields come from config; `laneboard prime` lists them. On UNKNOWN_* copy a value from `allowed`.
9. Notes: `laneboard comment <ID> "<text>"` (`get` shows type `commented`). Files: `laneboard attach <ID> <path>`. Links: `--add-link branch=<name>` / `pr=<url>` / `commit=<sha>` (finish links HEAD itself).
10. Finished tasks: `laneboard archive <ID>`. Old ones: `laneboard list --scope all --text <q>`.
11. Ids are exact and carry the board prefix, e.g. WEB-12. Every reply names `store` and `prefix` (CLI: the --json envelope; MCP: the 2nd content block): write only to your project's board.
12. Not sure which board is yours (store not found, or a warning that it is another project's): `laneboard boards --json`, pick yours by `description` and `path`, then pass `--dir <path>` on every command. None for this project: in its root `laneboard init --dir .laneboard --name <name> --description "<whose project, what work>"` (`--dir`: LANEBOARD_DIR may name another board), then the `next` command it prints.
13. Every error has `fix`: run it or adapt it. Exit codes: 2 input, 3 not found, 4 conflict, 5 busy (retry once), 6 store.
14. Text starting with "-" or "--" (list items, "--- section"): options first, then `--`, then the text (`laneboard comment <ID> --json -- "- item"`); option values as `--description="- item"`.

<!-- short forms: not part of the rules above. When prime runs out of room it prints these instead of the rules of the same number
(src/cli/format.ts). Line: `short <n> <first 8 hex of the sha256 of rule n>: <text>`. Changed rule n? Re-read its short form so it says
the same, then put the new hash (the test in test/cli/s3c.test.ts prints it). -->
short 1 7442ca5c: MANDATORY for every request, even with an empty board: claim or create your task before your first file change (commands below); comment each step; when done: commit, then `laneboard finish <ID> --result "<result>" --json`.
short 3 2340b5f8: Always pass `--json`. Name: without `--as`, the session default (prime shows it); own name: `--as <name>` on every command (or LANEBOARD_AGENT; MCP: `actor`), one per subagent or worker.
short 4 443714fe: New task, start: the create and claim commands below (`--status`, `--assignee`, `--json` set; subtask: `--parent <ID>`; `--as` only for your own name, rule 3).
short 5 248cdc28: `--expected-rev` only for edits on top of what you read (`--description`, `--field`): your last rev. Not for status, comment, claim, finish, `--append-description`.
short 6 9b270eed: REV_CONFLICT: re-apply your change on `error.details.task` with its rev (keep others' edits); never retry blindly.
short 7 2647a304: ALREADY_CLAIMED: do not take over; run its `fix` (`--resume`: only your own task from before /clear or a restart).
short 8 49f53a24: Statuses (in order; last is final), typed fields: the lines below the store. On UNKNOWN_* copy a value from `allowed`.
short 9 a805d684: Notes: `laneboard comment <ID> "<text>"`; files: `laneboard attach <ID> <path>`; links: `--add-link commit=<sha>` (branch=, pr=; finish links HEAD).
short 11 cdb10d5f: Ids are exact, with the board prefix (WEB-12). Every `--json` reply names `store` and `prefix`: write only to your project's board.
short 12 f0af9afb: Which board is yours? `laneboard boards --json`, pick by `description` and `path`, then `--dir <path>` on every command. None: in the project root `laneboard init --dir .laneboard --name <name> --description "<whose project, what work>"` (LANEBOARD_DIR may name another).
short 14 1985a2fe: Text starting with "-": options, then `--`, then the text (`laneboard comment <ID> --json -- "- item"`; values `--description="- item"`).
