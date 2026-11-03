laneboard agent rules (task board & CLI for AI coding agents):
1. Use only `laneboard` commands (or the task_* MCP tools). Never read-modify-write .laneboard/*.json by hand.
2. Always pass `--json` and `--as <your-name>` (or set LANEBOARD_AGENT). MCP write tools take `actor`.
3. Start work: `laneboard claim <ID> --status <status> --as <you> --json`.
4. Change anything: `laneboard update <ID> ... --expected-rev <rev from your last read>`.
5. REV_CONFLICT: run `laneboard get <ID> --json`, re-apply your change on the new rev. Never retry blindly.
6. ALREADY_CLAIMED: do not take over; comment or ask the orchestrator.
7. Statuses and fields come from config; on UNKNOWN_* copy a value from `allowed`.
8. Notes and results: `laneboard comment <ID> "<text>"`. Files: `laneboard attach <ID> <path>`.
9. Branches, PRs, commits: `--add-link branch=<name>` / `pr=<url>` / `commit=<sha>`.
10. Done tasks: `laneboard archive <ID>`. Find old ones: `laneboard list --scope all --text <q>`.
11. Ids are exact, e.g. LB-12. Store not found: export LANEBOARD_DIR=<abs>/.laneboard.
12. Every error has `fix`: run it or adapt it. Exit codes: 2 input, 3 not found, 4 conflict, 5 busy (retry once), 6 store.
13. Text starting with "-" or "--" (list items, "--- section"): options first, then `--`, then the text (`laneboard comment <ID> --as <you> -- "- item"`); option values as `--description="- item"`.
