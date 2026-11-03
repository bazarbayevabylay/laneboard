laneboard agent rules (task board & CLI for AI coding agents):
1. MANDATORY for every request, even when nobody mentions tasks and the board is empty: before your first file change, claim your task or create one (`laneboard prime` prints the command); comment each meaningful step; when done, set the final status and add a result comment. No untracked work.
2. Use only `laneboard` commands (or the task_* MCP tools). Never read-modify-write .laneboard/*.json by hand.
3. Always pass `--json`. Your name: `--as <name>` or LANEBOARD_AGENT (MCP: `actor`); without them writes use the session's default name, which `laneboard prime` shows. Subagents and parallel workers of one session pass their own `--as`.
4. New task: `laneboard create "<title>" --status <status> --assignee <you> --as <you> --json`. Start work: `laneboard claim <ID> --status <status> --as <you> --json`.
5. Change anything: `laneboard update <ID> ... --expected-rev <rev>`, the rev from your last read or write (every write, comments too, returns the new rev). `--description` replaces the whole text.
6. REV_CONFLICT: the current task is in `error.details.task`; re-apply your change on it (keep the other edits, e.g. merge the description) with its rev. Never retry blindly.
7. ALREADY_CLAIMED: do not take over; comment or ask the orchestrator.
8. Statuses (in order; the last one is final) and fields with their types come from config, `laneboard prime` lists them. On UNKNOWN_* copy a value from `allowed`.
9. Notes and results: `laneboard comment <ID> "<text>"` (shown in `get` as events of type `commented`). Files: `laneboard attach <ID> <path>`. Branches, PRs, commits: `--add-link branch=<name>` / `pr=<url>` / `commit=<sha>`.
10. Done (final status) tasks: `laneboard archive <ID>`. Find old ones: `laneboard list --scope all --text <q>`.
11. Ids are exact and carry the board prefix, e.g. WEB-12. Every reply names `store` and `prefix` (CLI: the --json envelope; MCP: the second content block): write only to your project's board.
12. Not sure which board is yours (store not found, or a warning that the store belongs to another project): `laneboard boards --json`, pick yours by `description` and `path`, then `export LANEBOARD_DIR=<path>`. None for this project: in its root `laneboard init --name <name> --description "<whose project, what work>"`.
13. Every error has `fix`: run it or adapt it. Exit codes: 2 input, 3 not found, 4 conflict, 5 busy (retry once), 6 store.
14. Text starting with "-" or "--" (list items, "--- section"): options first, then `--`, then the text (`laneboard comment <ID> --as <you> -- "- item"`); option values as `--description="- item"`.
