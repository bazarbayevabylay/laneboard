# laneboard — technical spec v0.1 (ADR-0001: two-JSON store behind one transact(), CLI-first, MCP + board as thin facades)
Status: accepted 2026-11-03, S1 implemented (deltas in §14) · Links: none · Source: owner brief, install/storage research digests
Tagline: "Task board & CLI for AI coding agents". Scope: create, update, delete, archive, attach, comment, board. No workflow: statuses are a plain list.

## 0. Context
- Repo is empty (`git log` → "does not have any commits yet"); no structure to continue. Stack is fixed by owner: TypeScript/Node, Vue 3 board in the same package, no server/DB/Docker, no git dependency.
- Threshold: new data format, public contracts (CLI, MCP, HTTP, files), new deps → architectural.
- Pilot load: one machine, several long sessions + dozens of subagents writing at once. Each session spawns its own MCP stdio process, so N processes write the same files.
- Taken into account (late owner input): agent ergonomics first — one obvious way per action, strict validation, every error says how to fix, predictable `--json`, no magic defaults; "Agent rules" section (§7); slice order CLI → MCP/setup → agent usability test → board; code/comments/README in English plus README.ru.md.

## 1. Decisions (variants)
| Decision | A | B | Chosen, main reason |
|---|---|---|---|
| Concurrency | every process writes under a file lock | one daemon owns files, CLI/MCP are clients | A: no daemon lifecycle; B needs autostart + fallback anyway. Two-way (internal). |
| Lock | `proper-lockfile` (mkdir lock + mtime heartbeat, stale takeover) | own O_EXCL/mkdir + pid liveness (~80 LOC) | A: proven by prototype (§4), used by two neighbour trackers; B kept as fallback if dep is dropped. Two-way. |
| Event log | `events[]` inside each task | separate append-only `events.jsonl` | A: owner fixed two JSON files; log moves with the task in the same write; no cross-file divergence. Cost: global feed = scan (fine ≤10k tasks). Two-way via `migrate`. |
| MCP stack | official `@modelcontextprotocol/sdk` | hand-written JSON-RPC stdio | A: protocol negotiation is not ours to maintain. Cost: heavy dep tree (risk R5). |
Checks per decision are rules W1–W11 (§4) and C1–C8 (§11).

## 2. Data model (JSON Schema draft 2020-12; zod is the single source, `schema/*.json` generated)
Task (`schema/task.json`):
```json
{"type":"object","additionalProperties":true,
 "required":["id","rev","title","description","status","assignee","labels","links","fields","attachments","events","events_dropped","created_at","created_by","updated_at","updated_by"],
 "properties":{
  "id":{"type":"string","pattern":"^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*$"},
  "rev":{"type":"integer","minimum":1},
  "title":{"type":"string","minLength":1,"maxLength":200},
  "description":{"type":"string","maxLength":100000},
  "status":{"type":"string","minLength":1},
  "assignee":{"oneOf":[{"$ref":"#/$defs/actor"},{"type":"null"}]},
  "labels":{"type":"array","uniqueItems":true,"items":{"type":"string","pattern":"^[a-z0-9][a-z0-9._-]{0,39}$"}},
  "links":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["kind","ref"],
    "properties":{"kind":{"enum":["task","branch","pr","commit","url","file"]},"ref":{"type":"string","minLength":1,"maxLength":2000}}}},
  "fields":{"type":"object"},
  "attachments":{"type":"array","items":{"type":"object","additionalProperties":false,
    "required":["name","size","sha256","mime","added_by","added_at"],
    "properties":{"name":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$"},"size":{"type":"integer"},
      "sha256":{"type":"string","pattern":"^[a-f0-9]{64}$"},"mime":{"type":"string"},"added_by":{"$ref":"#/$defs/actor"},"added_at":{"$ref":"#/$defs/ts"}}}},
  "events":{"type":"array","items":{"type":"object","additionalProperties":true,"required":["at","actor","type","data"],
    "properties":{"at":{"$ref":"#/$defs/ts"},"actor":{"$ref":"#/$defs/actor"},
      "type":{"enum":["created","updated","status","assigned","commented","attached","detached","archived","restored"]},"data":{"type":"object"}}}},
  "events_dropped":{"type":"integer","minimum":0},
  "created_at":{"$ref":"#/$defs/ts"},"created_by":{"$ref":"#/$defs/actor"},
  "updated_at":{"$ref":"#/$defs/ts"},"updated_by":{"$ref":"#/$defs/actor"},
  "archived_at":{"$ref":"#/$defs/ts"}},
 "$defs":{"actor":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$"},"ts":{"type":"string","format":"date-time"}}}
```
- `status` must be in `config.statuses` on every write that sets it; a status later removed from config stays readable (board shows an "unknown status" column).
- `fields` keys must be declared in `config.fields`; values validated by declared type. This is the only extension point for team data (priority, estimate, runs…).
- `link kind=task` must reference an existing id (active or archive). Comments are events (`commented`, `data.text` ≤10 000 chars).
- Events: appended by core on every change, never by callers. `updated` stores `{field:[from,to]}`; for `description` only `{"description":{"chars":[old,new]}}`. Over `limits.events_per_task` the oldest are dropped and `events_dropped` grows.
- Unknown properties (file, task, event level) written by a newer laneboard are preserved on rewrite. Unknown input from callers is rejected (§5).
- Times: UTC ISO 8601 with ms, set by core only.

Store file (`schema/store.json`): `{"schema":"laneboard/store@1","kind":"active"|"archive","rev":int≥0,"next_id":int≥1 (active only),"updated_at":ts,"content_sha256":hex,"tasks":[Task]}`, `additionalProperties: true`. `content_sha256` = sha256 of serialized `tasks`; mismatch on read means a hand edit → warning (stderr / `warnings[]`), reported by `doctor`.

Config (`schema/config.json`, `additionalProperties: false` at every level — a typo must fail loudly):
```json
{"schema":"laneboard/config@1","prefix":"LB","statuses":["todo","in_progress","review","done"],
 "fields":{"priority":{"type":"number","description":"0 = highest"}},
 "limits":{"events_per_task":500,"attachment_bytes":26214400,"list_limit_max":200},
 "attachments":{"deny_names":[".env*","*.pem","*.key","id_rsa*","id_ed25519*"]},
 "board":{"port":7420}}
```
Field types: `string|number|boolean|string[]|json`. `init` writes every key explicitly (no hidden defaults; what runs is what the file says). Config is human-editable; validated on every command.

## 3. Store layout and discovery
```
.laneboard/
  config.json            human-editable, validated
  active.json            tool-only, mode 0444
  archive.json           tool-only, mode 0444
  active.json.bak, archive.json.bak   previous good version (same atomic write)
  attachments/<id>/<name>
  lock                   lock directory (proper-lockfile), exists only while held
  board.json             {pid, port, started_at} while a board runs
  .gitignore             "*" (written by init; no git calls; `--no-gitignore` to skip)
```
Discovery, first match wins, resolved path is printed in every `--json` envelope (`store`): 1) `--dir <path-to-.laneboard>`; 2) `LANEBOARD_DIR`; 3) walk up from cwd to `/` looking for `.laneboard/`. None → `STORE_NOT_FOUND` with fix `laneboard init` or `export LANEBOARD_DIR=/abs/path/.laneboard`. Git worktrees outside the project tree need `LANEBOARD_DIR` (documented in Agent rules).

## 4. Write path (src/core/transact.ts)
`transact<T>(store, {files: ("active"|"archive")[]}, fn: (s: State) => T, opts?: {faults?}): Promise<T>` — the only mutation path for CLI, MCP, board, import.
Prototype (outside repo, Node 22.23 and 24.21, macOS) backs W2, W4, W6–W8 with measured numbers.
| # | Rule | Test (vitest, `test/core/`) |
|---|---|---|
| W1 | No file write outside `src/core/fsio.ts` (store) and `src/setup/` (harness files). | C1 grep + planted violation |
| W2 | Lock `.laneboard/lock` held for read → validate → mutate → write of all touched files. stale 10 s, heartbeat 5 s, wait budget 15 s (> stale, so a dead holder is always outwaited) → `LOCK_TIMEOUT`. Write deadline 5 s after the acquire (half the stale window): a holder past it writes nothing → `LOCK_LOST`; a holder past the stale window does not remove the lock directory on release (it may be another process's now). | 8 procs × 25 creates → 200 tasks, ids LB-1..LB-200. Prototype: 200/200 with lock; 25–26/200 kept without. Writer paused 10+ s while another process takes over and writes → `LOCK_LOST`, the other's task kept, `next_id` monotonic, a third holder's lock intact. |
| W3 | Every call reads files fresh; no in-memory state across calls in MCP/board processes. | long-lived MCP process sees a CLI write on next `task_get` |
| W4 | Write = tmp `<file>.<pid>.<rand>.tmp` in same dir → write → fsync → chmod 0444 → rename → fsync dir; `.bak` written the same way first. Orphan `*.tmp` removed at transact start, only under lock (prototype: cleanup without lock deleted live peers' tmp → ENOENT crashes). | fault after tmp write → original intact; next transact removes tmp |
| W5 | File `rev` +1 per write; task `rev` +1 per change. `expected_rev` (optional on update, claim, archive, delete; always sent by board) mismatch → `REV_CONFLICT` with current task in `details`. | two parallel updates with same expected_rev → exactly one ok, one REV_CONFLICT |
| W6 | Archive writes archive.json then active.json; restore writes active.json then archive.json. Each bumps task rev. Duplicate id across files → copy with higher task rev wins (tie: active); repaired by the next both-file transact and by `doctor`. | fault between renames → both files hold id; reader view shows it once in archive; next transact cleans active (prototype: as stated) |
| W7 | Reads touching both files (get with archive fallback, `--scope all|archive`, events) run under the lock; single-file reads are lock-free. | flipper process archive/restore × 200 vs reader: 0 wrong. Prototype: lock-free two-file reads wrong in 20–23 % of reads in either order; locked 0/1421–1758. |
| W8 | Crash recovery: dead holder → takeover after stale (prototype: 8.9–9.0 s after SIGKILL). Unparseable/schema-invalid file → `STORE_INVALID` for reads and writes; `doctor --restore-backup` swaps in `.bak` after printing task counts of both. | SIGKILL holder test; corrupt file test |
| W9 | `next_id` never decreases (archive/delete do not touch it); `doctor` asserts `next_id > max id in both files` and fixes. | delete highest id, create → larger id |
| W10 | File `schema` newer than supported → `STORE_TOO_NEW` on write (fix: upgrade laneboard); reads allowed. `migrate` upgrades older files under lock. | fixture with `store@2` |
| W11 | Unknown properties preserved on rewrite. | round-trip with `x_future` on file, task, event |
Attachments: the source is read before the lock (symlinks resolved, at most `limits.attachment_bytes` through one descriptor), then under the lock written to `attachments/<id>/<name>` via tmp+rename, then metadata in the same transact; crash between → orphan file (never metadata without file); `doctor` lists/removes orphans. Archive leaves files in place; delete removes record, then directory.

## 5. CLI (`laneboard <verb>`; parser `node:util.parseArgs` with `strict: true`)
Global: `--json`, `--dir <path>`, `--as <actor>`. Actor for writes = `--as`, else `LANEBOARD_AGENT`, else `ACTOR_REQUIRED` (no OS-user fallback). Ids are exact (`LB-12`); `12`/`lb-12` → `INVALID_VALUE` with the exact id in `fix`.
| Command | MCP tool |
|---|---|
| `create <title> --status S [--description T | --description-file P|-] [--assignee A] [--label L]… [--link kind=ref]… [--field k=v]…` | task_create |
| `get <id> [--events N]` (searches archive too; result has `"archived": bool`) | task_get |
| `list [--status S]… [--assignee A | --unassigned] [--label L]… [--text Q] [--scope active|archive|all] [--limit N] [--offset N]` | task_list |
| `update <id> [--title] [--description|--description-file] [--status S] [--assignee A | --unassign] [--add-label L] [--remove-label L] [--add-link k=ref] [--remove-link k=ref] [--field k=v] [--unset-field k] [--expected-rev N]` (≥1 change) | task_update |
| `claim <id> [--status S] [--expected-rev N]` — assignee := actor; held by another → `ALREADY_CLAIMED` (fix: `comment`; `update --assignee` only in the message, for an intentional and agreed reassignment) | task_claim |
| `comment <id> (<text> | --file P|-)` | task_comment |
| `attach <id> <path> [--name N]` / `attach <id> --remove <name>` | task_attach |
| `archive <id>… [--expected-rev N]` / `archive --status S --updated-before <Nd> [--dry-run]` | task_archive |
| `restore <id>` | task_restore |
| `delete <id> --confirm <id> [--expected-rev N]` | task_delete |
| `events [--task id] [--since ts] [--limit N] [--scope …]` | task_events |
CLI-only: `init [--prefix P] [--statuses a,b,c]`, `setup <harness> [--remove] [--dry-run]`, `migrate`, `doctor [--fix] [--restore-backup]`, `board [--port N]`, `mcp`, `prime [--hook]`, `import markdown …` (S5), `--help`, `--version`.
- Archived tasks are read-only: update/claim/comment/attach on them → `TASK_ARCHIVED` (fix: `laneboard restore <id>`).
- `list`: `--limit` default 20 (max `list_limit_max`), sorted `updated_at` desc; the envelope always states `scope/limit/offset/total`.
- Output, human: one line per result (`LB-12 created (rev 1)`), aligned table for lists plus footer `20 of 57 shown (scope active); next: --offset 20`.
- Output, `--json` (stdout only, one document, also on error; stderr empty): `{"ok":true,"store":"/abs/.laneboard","data":…,"warnings":[]}`; task = full Task + `archived`; list items = `{id,title,status,assignee,labels,updated_at,rev}`. Error: `{"ok":false,"store":…,"error":{"code","message","fix","allowed"?,"details"?}}`.
- Error registry `Record<ErrorCode,{exit,http,fix}>` in `src/core/errors.ts`: 0 ok · 1 `INTERNAL` · 2 `USAGE`, `UNKNOWN_OPTION` (with closest option), `INVALID_VALUE`, `UNKNOWN_STATUS` (allowed list), `UNKNOWN_FIELD` (declared list), `ACTOR_REQUIRED` · 3 `TASK_NOT_FOUND` (fix: `list --scope all --text`), `ATTACHMENT_NOT_FOUND` · 4 `REV_CONFLICT`, `ALREADY_CLAIMED`, `TASK_ARCHIVED`, `ATTACHMENT_EXISTS` · 5 `LOCK_TIMEOUT`, `LOCK_LOST` (write deadline passed, nothing written; fix: retry) · 6 `STORE_NOT_FOUND`, `STORE_INVALID`, `STORE_TOO_NEW`, `STORE_EXISTS` (init into an existing or non-empty directory; §14).
```
$ laneboard update LB-12 --status doing --as dev-1
error UNKNOWN_STATUS: "doing" is not a configured status
  allowed: todo, in_progress, review, done
  fix: laneboard update LB-12 --status <status from allowed> --as dev-1
```
A concrete value is suggested only for an obvious typo (`in-progress` → `in_progress`); see §14.
- Options that are not repeatable in the table above (everything except `--label`, `--link`, `--field`, `--add-*`, `--remove-*`, `--unset-field`, list `--status`) may appear once: a repeat → `USAGE` (`--status is given 2 times`), never "last one wins".
- Text that starts with `-` (a Markdown list item, `-1 …`): positionals go after `--` (`laneboard comment LB-1 --as me -- "- item"`), option values use `--opt=value` (`--description="- a"`). Otherwise `UNKNOWN_OPTION`/`USAGE` with that exact command as `fix`.

## 6. MCP (`laneboard mcp`, stdio, SDK `McpServer.registerTool` + `StdioServerTransport`, verified in sdk@1.30.0 `dist/esm/server/mcp.d.ts`)
- 11 tools, same names/params as §5 (snake_case: `expected_rev`, `description`, `add_labels`…): task_create, task_get, task_list, task_update, task_claim, task_comment, task_attach (`path` | `remove`), task_archive (`ids` | `status`+`updated_before`, `dry_run`), task_restore, task_delete (`confirm_id`), task_events. Status changes only via task_update.
- Every write tool requires `actor` (one MCP process serves a session and all its subagents, so env cannot identify the caller).
- Result: `structuredContent` = CLI `data`; `content[0].text` = same JSON. Error: `isError: true`, same error object as CLI. Inputs are zod `.strict()`: unknown keys rejected.
- Server `instructions` = Agent rules (§7), ≤4 096 chars (Claude Code start-up limit [mcp]). stdout belongs to the protocol: nothing else writes it (C4). Responses capped by `limit`; Claude Code warns >10k tokens [mcp].

## 7. Agent rules (skill body, `prime` output, MCP instructions; one source `src/core/agent-rules.md`)
```
1. Use only `laneboard` commands (or task_* tools). Never read-modify-write .laneboard/*.json by hand.
2. Always pass `--json` and `--as <your-name>` (or set LANEBOARD_AGENT).
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
13. Text starting with "-": options first, then `--`, then the text (`laneboard comment <ID> --as <you> -- "- item"`); option values as `--description="- item"`.
```

## 8. Board (`laneboard board`, Vue 3 SPA built by Vite into `dist/board/`, served by `node:http`)
- Binds 127.0.0.1 only (constant). Port: `--port N`, else `config.board.port`; busy → error with fix `--port 0` (OS-assigned). No silent increments. Prints URL. If `board.json` names a live pid → prints that URL, exit 0.
- Actor: same rule as CLI (`--as` / `LANEBOARD_AGENT`), shown in header.
- API (all call core ops; JSON envelopes as CLI): `GET /api/config`, `GET /api/tasks?scope&status&assignee&label&text&limit&offset`, `GET /api/tasks/:id`, `POST /api/tasks`, `PATCH /api/tasks/:id` (body = update params incl. `expected_rev`), `POST /api/tasks/:id/claim|comments|archive|restore`, `DELETE /api/tasks/:id?confirm_id&expected_rev`, `PUT /api/tasks/:id/attachments/:name` (raw body), `DELETE …/attachments/:name`, `GET …/attachments/:name`, `GET /api/events` (SSE). HTTP status from error registry (400/404/409/503/500).
- Live update: `fs.watch(storeDir)` debounced 100 ms + 2 s `stat` poll fallback → read header `rev` → SSE `change {file, rev}`; heartbeat every 15 s; client refetches.
- Protection: Host header ∈ {`127.0.0.1:<port>`, `localhost:<port>`} else 403 (DNS rebinding); per-run 256-bit token embedded in index.html, required as `X-Laneboard-Token` (SSE: `?token=`) on every `/api` call, else 403; mutating requests also require `Origin` = served origin; no CORS headers; JSON body ≤1 MB; upload ≤ `attachment_bytes` (413). Attachments: `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`; inline only png/jpeg/gif/webp. SPA CSP `default-src 'self'`.
- UI: columns = `config.statuses` (+ unknown-status column); drag card → PATCH with `expected_rev`, 409 → toast + refetch; card panel: edit title/description/assignee/labels/links/fields, comment, upload/download/remove attachment, archive; archive view with search and restore; delete asks to type the id.

## 9. setup and Claude Code plugin
`laneboard setup <claude|codex|cursor|gemini|opencode> [--remove] [--dry-run]`, run in project root. Writes only our key or a marked block (`<!-- laneboard:start -->…<!-- laneboard:end -->`, TOML `# laneboard:start/end`). Instruction block = 3 lines: what laneboard is, "run `laneboard prime` for rules", `LANEBOARD_AGENT`.
| Harness | MCP entry | Instructions | Hook | Source |
|---|---|---|---|---|
| claude | `.mcp.json` → `mcpServers.laneboard {command:"laneboard",args:["mcp"]}` | `CLAUDE.md` block | `.claude/settings.json` SessionStart `laneboard prime --hook` | [mcp][hooks][memory] |
| codex | `~/.codex/config.toml` `[mcp_servers.laneboard]` command/args (project file only for trusted projects; output says "global file") | `AGENTS.md` block | none in v1 | [codex-mcp][agents-md] |
| cursor | `.cursor/mcp.json` → `mcpServers.laneboard` | `AGENTS.md` block | none in v1 | [cursor-mcp][cursor-rules] |
| gemini | `.gemini/settings.json` → `mcpServers.laneboard` | `GEMINI.md` block | none in v1 | [gemini-mcp][gemini-md] |
| opencode | `opencode.json` → `mcp.laneboard {type:"local",command:["laneboard","mcp"]}` (`enabled` key: VERIFY) | `AGENTS.md` block | none in v1 | [opencode-mcp][opencode-rules] |
- Idempotent: second run reports `unchanged` per file, bytes identical. Existing different value → replaced, printed as a diff. First modification of a pre-existing file writes `<file>.laneboard.bak` once.
- Rollback: `--remove` deletes our key/block; deletes a file only if we created it and it is now empty (`{}` / blank). Unparseable JSON (JSONC comments) → `SETUP_UNPARSEABLE` (exit 6), no write, prints the snippet to add by hand.
- Claude Code: plugin and `setup claude` both register MCP → use one; `setup claude` warns if the plugin cache has laneboard (VERIFY path).
Plugin (same repo; marketplace = repo) [plugins][marketplace][components]:
```
.claude-plugin/marketplace.json   {"name":"laneboard","owner":{"name":"laneboard maintainers"},
                                   "plugins":[{"name":"laneboard","source":"./plugins/claude-code","description":"…"}]}   (fields: VERIFY)
plugins/claude-code/.claude-plugin/plugin.json   {"name":"laneboard","version":"<= package.json>","description":"…","license":"MIT"}
plugins/claude-code/.mcp.json     {"mcpServers":{"laneboard":{"command":"laneboard","args":["mcp"]}}}
plugins/claude-code/hooks/hooks.json  {"hooks":{"SessionStart":[{"matcher":"startup|resume|clear|compact",
  "hooks":[{"type":"command","command":"command -v laneboard >/dev/null 2>&1 && laneboard prime --hook || echo 'laneboard CLI missing: npm i -g laneboard'"}]}]}}
plugins/claude-code/skills/laneboard/SKILL.md   frontmatter name/description (VERIFY) + Agent rules
```
- Install: `/plugin marketplace add bazarbayevabylay/laneboard` → `/plugin install laneboard@laneboard`. Plugin cannot install the binary (npm source skips install scripts [marketplace]) → `npm i -g laneboard` is a documented prerequisite (Q2).
- `prime --hook`: Agent rules + tasks assigned to `LANEBOARD_AGENT` (non-archived, `updated_at` desc); unset → rules + counts per status + "set LANEBOARD_AGENT". ≤4 000 chars, truncated with `… N more: laneboard list --assignee <a>`. SessionStart stdout becomes context [hooks]; MCP is not ready at SessionStart, so the hook is a command, not a tool call [hooks].
- Test: `plugin.json.version === package.json.version`; release script bumps both.

## 10. Repo and package
```
src/core/   schema.ts errors.ts agent-rules.md config.ts store.ts fsio.ts lock.ts transact.ts ops/*.ts index.ts
src/cli/    main.ts commands/*.ts format.ts
src/mcp/    server.ts tools.ts
src/board/  server/{http,api,sse,watch,security}.ts  ui/{index.html,main.ts,App.vue,components/}
src/setup/  index.ts harnesses/{claude,codex,cursor,gemini,opencode}.ts json-key.ts md-block.ts toml-block.ts
src/import/ markdown.ts
schema/  plugins/claude-code/  .claude-plugin/marketplace.json  scripts/check-boundaries.sh  test/{core,cli,mcp,setup,board,import,usability}
.github/workflows/ci.yml  README.md  README.ru.md  CHANGELOG.md  LICENSE  .nvmrc
```
- Direction: cli/mcp/board/setup/import → `src/core/index.ts`; core imports none of them (C2).
- package.json: `"type":"module"`, `bin: {"laneboard":"dist/cli/main.js"}`, `files: ["dist","schema","README.md","README.ru.md","LICENSE"]`, `engines.node: ">=22"` (Node 20 EOL 2026-04-30, nodejs.org/en/about/previous-releases).
- Runtime deps: `@modelcontextprotocol/sdk` ^1.30 (MCP protocol); `zod` (SDK peer `^3.25 || ^4`, reused for all validation and JSON Schema generation — `z.toJSONSchema` needs v4: VERIFY); `proper-lockfile` ^4.1.2 (Node has no flock; deps graceful-fs, retry, signal-exit); `yaml` (S5 import only, lazy-loaded). Not used: express/commander/chokidar/busboy → `node:http`, `parseArgs`, `fs.watch`, raw-body upload.
- Dev deps: typescript, @types/node, @types/proper-lockfile, vitest, vite, @vitejs/plugin-vue, vue, @playwright/test (S4 e2e only).
- Tests: vitest for everything (TS + Vue without extra tooling). CI (GitHub Actions): ubuntu-latest + macos-latest × Node 22, 24: `npm ci`, `npm run typecheck`, `npm run check:boundaries`, `npm run check:schema`, `npm test`, `npm run build`, `npm pack --dry-run`. Windows not in CI (Q4).
- Code, comments, README in English; README.ru.md mirrors README sections (test compares heading count). License: MIT (Q3).

## 11. Constraints (rule — check — result now)
Repo is empty, so each check is created in S1/S2; red-control run on a planted tree in the prototype: C1, C2, C4 exit 1 on violation, 0 on clean.
- C1 Writes only in fsio/setup — `! grep -rnE '\b(writeFile|writeFileSync|rename|renameSync|appendFile|appendFileSync|copyFile|copyFileSync|unlink|unlinkSync|rmSync|createWriteStream)\b' src --include='*.ts' | grep -vE '^src/(core/fsio\.ts|setup/)'` — planted: 1/0.
- C2 Core does not import facades — `! grep -rnE "from ['\"][^'\"]*(\.\./)+(cli|mcp|board|setup|import)/" src/core` — planted: 1/0.
- C3 Exactly 11 MCP tools, every core op exposed or listed CLI-only — `Record<OpName, McpTool | "cli-only">` (typecheck) + `listTools().length === 11` e2e.
- C4 Nothing writes stdout in MCP code — `! grep -rnE 'console\.log|process\.stdout\.write' src/mcp` — planted: 1/0.
- C5 Every error code has exit, http, fix — `Record<ErrorCode,…>` typecheck + test iterating the registry asserting non-empty `fix`.
- C6 Board bound to loopback — test asserts `server.address().address === "127.0.0.1"`; requests without token / foreign Origin / foreign Host → 403.
- C7 No env-triggered fault hooks in the package — `! grep -rnE 'CRASH|FAULT' dist --include='*.js' | grep -i 'process\.env'`; faults reach core only via the `opts.faults` argument from test fixtures.
- C8 Generated JSON Schema matches zod — `npm run check:schema` (`scripts/gen-schema.ts --check`: regenerates in memory and compares with `schema/` on disk, so a missing or untracked file also fails).

## 12. Slices (sequential; package.json and CI owned by the running slice)
S1 core + CLI (~70 turns). Files: package.json, tsconfig, .nvmrc, src/core, src/cli, schema, scripts, test/core, test/cli, ci.yml, LICENSE.
DoD: `npm ci && npm run typecheck && npm run check:boundaries && npm run check:schema && npm test && npm run build; echo $?` → 0, covering W1–W11, C1, C2, C5, C8, CLI golden outputs (human + json) for every command and every error code; smoke `T=$(mktemp -d) && cd "$T" && laneboard init && laneboard create "x" --status todo --as a --json` → `"id":"LB-1"`, then `laneboard update LB-1 --status doing --as a; echo $?` → 2 with `allowed`.
S2 MCP + setup + plugin (~70). Files: src/mcp, src/setup, plugins/, .claude-plugin/, test/mcp, test/setup.
DoD: `npm test -- test/mcp test/setup; echo $?` → 0: SDK client over stdio lists exactly 11 tools and calls each; CLI/MCP parity (same `data` for same op on cloned stores); per harness in temp HOME+cwd: run twice → `unchanged` + identical bytes, `--remove` → original (deep-equal JSON, identical md); `prime --hook` ≤4 000 chars; `claude plugin validate plugins/claude-code` (VERIFY command) exit 0; record `npm i --omit=dev` footprint in the PR (R5).
S3 agent usability test (~60). Before any board work.
Setup: temp store, `PATH` wrapper logging argv/exit/error code to JSONL (no product change); 3 fresh subagents get only SKILL.md and `laneboard prime`, no repo access.
Scenarios: create; claim; change status; attach file; archive; find in archive; REV_CONFLICT from a parallel edit (harness edits between read and write); wrong inputs (bad status, bad id, unknown flag, unknown field, missing actor).
Metrics per run: unintended non-zero exits, retries per scenario, `--help` lookups, wrong interpretations, hand edits of store files (mtime/sha check).
Pass: 3/3 runs finish all scenarios; ≤4 unintended errors per run; ≥90 % of errors fixed on the next call; 0 hand edits.
Fixes (messages, flags, rules) land in this slice; max 2 rounds, then escalate. Report: `docs/usability/round-N.md`.
S4 board (~80). Files: src/board, test/board, vite config.
DoD: `npm run build && npm test -- test/board; echo $?` → 0: C6; SSE `change` within 2 s after a CLI write from another process; stale PATCH → 409; upload over limit → 413; `.html` attachment served with attachment + nosniff headers; `npx playwright test` drags a card todo → done and `laneboard get <id> --json` shows `done`; screenshot attached.
S5 README, import, publish (~60). Files: README.md, README.ru.md, CHANGELOG.md, src/import, test/import.
Import: `laneboard import markdown <dir> --status-key K --status-map a=b… [--title-key title] [--ignore-key k]… [--dry-run]`. Mapping: frontmatter → title/status; body → description; declared keys → `fields`. Undeclared key or unmapped status → error listing all found values. Idempotency key = link `file=<relative path>`.
DoD: fixture of 5 files → import creates 5, re-import creates 0 and skips 5; `npm pack --dry-run` lists only `files`; `npm publish --dry-run; echo $?` → 0. Real `npm publish` and plugin tag only after the owner's explicit OK.

## 13. Risks and open questions (owner)
| # | Question / risk | Until answered |
|---|---|---|
| Q1 (answered: hard delete, `confirm_id`, active and archive) | Delete: hard delete (record + attachments, nothing left) or tombstone in archive.json for audit? May agents delete active tasks via MCP? | hard delete, `confirm_id` required, active and archive |
| Q2 (answered: global install) | Plugin needs `npm i -g laneboard` (plugin cannot install binaries). Alternative: `npx -y laneboard@<ver>` in `.mcp.json`/hook pins versions but needs network and adds start-up latency (npx in plugin `.mcp.json`: VERIFY). | global install, hook prints install hint |
| Q3 (answered: MIT) | License MIT (as Backlog.md, beads) or Apache-2.0 (patent grant)? | MIT |
| Q4 (answered: macOS + Linux only; `os` in package.json, CI matrix) | Windows in v1? rename over a file open in another process can fail there; no CI coverage planned. | macOS + Linux only, documented |
| R6 | The mtime lock cannot stop a holder that pauses inside the write itself (after its last deadline check, a window of milliseconds); proper-lockfile has no fencing token. | accepted for v1; the deadline check runs before every file write |
| R5 | SDK 1.30 pulls express, hono, jose, ajv… for a stdio-only server; proper-lockfile's 10 s stale window stalls writers after a crash. | measure in S2; if footprint is unacceptable, bundle with esbuild or switch to own JSON-RPC (new ADR) |

Sources (accessed 2026-11-03): [plugins] code.claude.com/docs/en/plugins · [components] …/plugins/components.md · [marketplace] …/plugins/marketplace-reference.md · [hooks] …/hooks.md · [mcp] …/mcp.md · [memory] …/memory.md · [codex-mcp] developers.openai.com/codex/mcp (→ learn.chatgpt.com/docs/extend/mcp) · [agents-md] learn.chatgpt.com/docs/agent-configuration/agents-md · [cursor-mcp] cursor.com/docs/context/mcp · [cursor-rules] cursor.com/docs/context/rules · [gemini-mcp] geminicli.com/docs/tools/mcp-server · [gemini-md] geminicli.com/docs/cli/gemini-md · [opencode-mcp] opencode.ai/docs/mcp-servers · [opencode-rules] opencode.ai/docs/rules · MCP SDK: npm @modelcontextprotocol/sdk 1.30.0 type definitions · proper-lockfile 4.1.2 `lib/lockfile.js`.

## 14. S1 implementation deltas (what the code does where this spec was silent or different)
- Schema: `schema/*.json` is generated by `z.toJSONSchema` and is the reference; it differs in form from the §2 sketch (no `$defs`, nullable as a type list, no `uniqueItems` on labels — core de-duplicates labels and links instead).
- Config value formats: `prefix` `^[A-Z][A-Z0-9]{0,9}$`; each status `^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$`, non-empty and unique; field keys `^[a-z][a-z0-9_]{0,39}$`; `fields.<k>.description` optional.
- New error code `STORE_EXISTS` (exit 6, http 409). `init` writes under the lock in the target dir, config.json last; target = `--dir`, else `LANEBOARD_DIR`, else `<cwd>/.laneboard` (no walk-up).
- Fixes never guess a distant value: an agent may run a fix blindly, so `doing` does not become `done`. Suggestion only when equal ignoring case and `-_`, or one edit/transposition away; otherwise a placeholder `<field from allowed>` or a format placeholder (`--field priority=<number>`, `--since <YYYY-MM-DDTHH:MM:SS.sssZ>`). The CLI rebuilds the user's own argv with the corrected token; a fix never points to `--help` (usage errors print the command's usage line). For the same reason the `ALREADY_CLAIMED` fix is a `comment` command and never a takeover.
- Attachments: `deny_names` is checked against the stored name, the source name and the symlink target name, before the name format check (so no fix suggests renaming a secret).
- Op inputs (shared by CLI and MCP): snake_case; `assignee: null` unassigns (no separate `unassign`); `labels` (list filter); `fields` (typed) plus `field_args` (CLI `key=value`, parsed with declared types — MCP should expose only `fields`). Paths for attach must be absolute (CLI resolves against cwd).
- List items also carry `archived` (needed with `--scope all`). `--text` matches id, title, description and labels, case-insensitive.
- `events`: newest first; `--since` is exclusive; default limit 20 (max `list_limit_max`); `--task` searches both files and ignores `--scope`.
- Semantics: a comment is a change (task rev +1); `update`/`claim` with values equal to the current ones is a no-op (rev unchanged, warning `no changes`); archive of an archived task → `TASK_ARCHIVED`; restore of an active task → `INVALID_VALUE`; delete needs an actor and records no event (the task is gone).
- Write path: fault points are `after_tmp_write` and `between_files`; transact writes the file that gains tasks first (archive → archive.json first, restore → active.json first), which implements W6 generically. Bodies under the lock are synchronous, so proper-lockfile's heartbeat (and its compromised callback) never runs inside them; instead `HeldLock.assertHeld()` before every file write (store files, attachment file, doctor repairs) fails with `LOCK_LOST` (exit 5) once 5 s have passed since the acquire. On release after ≥ 10 s the lock directory is left in place (stale, so the next writer takes it at once) instead of removing what may be another process's lock. Attachment tmp files live in the store root, so orphan cleanup never scans attachment names.
- `doctor` exits 0 and reports `data.healthy`; `--restore-backup` swaps only files that fail to read, keeps the broken one as `<file>.invalid-<ts>`. `migrate` only verifies store@1 (no older format exists).
- CLI: `src/cli/run.ts` holds the in-process runner (`runCli(io)`), `main.ts` is the bin wrapper; tests drive the runner in-process and the real process via `node src/cli/main.ts`.
- Tooling: tests and scripts run TypeScript directly through Node type stripping (development needs Node ≥22.18; the published package is compiled and needs ≥22). Runtime deps in S1: `zod`, `proper-lockfile` only (MCP SDK arrives in S2, `yaml` in S5). `npm install` with npm 10.9 (Node 22) crashes on the vitest 5 peer tree (arborist `edgesOut`); the lockfile was produced with npm 11; `npm ci` works with both.
- Not in S1: `src/core/agent-rules.md`, `prime`, `setup`, `mcp`, `board`, `import` (S2–S5).
