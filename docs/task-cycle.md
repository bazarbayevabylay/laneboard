# The task cycle: create, claim, comment, finish

Back to the [README](https://github.com/bazarbayevabylay/laneboard/blob/main/README.md). The full guide for agents:
[agent-guide.md](https://github.com/bazarbayevabylay/laneboard/blob/main/docs/agent-guide.md), section 2.
Every `sh` block below runs in laneboard's test suite, in order, in a fresh project, so the commands and exit codes are real.
The examples need the CLI and a board:

<!-- guide:skip installs globally -->
```sh
npm i -g laneboard
```

```sh
laneboard init --name web --description "ACME web shop: catalog and cart"
```

## Create and claim

This is the agent's work; it runs the same commands itself (`dev-1` is its name, see [agent-names.md](https://github.com/bazarbayevabylay/laneboard/blob/main/docs/agent-names.md)):

```sh
laneboard create "Fix the redirect after login" --status todo --assignee dev-1 --as dev-1 --json
laneboard claim WEB-1 --status in_progress --as dev-1 --json
laneboard comment WEB-1 "Cause: the redirect drops the query string" --as dev-1 --json
laneboard update WEB-1 --append-description "Repro: log in from /cart" --as dev-1 --json
laneboard create --title "No title argument" --status todo --as dev-1 --json  # exit 2
```

- `create` needs `--status` (no default): without it the error's `fix` is the same command with the first configured status.
- The title is an argument, not an option: `create --title X` fails with the right command as its fix.
- An option given twice is `USAGE` (`--status is given 2 times`), except `--json` and `--as` with the same value: a fix you add
  `--as <name> --json` to still runs.
- `claim`, and `create` with you as assignee, also reply `next`, the comment of your plan for the task: comment the plan at once, then
  each step, a plan item or a commit (a `finish` with no comment of yours since you took the task warns). Text with quotes, tabs or newlines goes through stdin: `laneboard comment WEB-1 - --json <<'EOF'`.
- `show` runs as `get` and `edit` as `update`; `finish --add-link kind=ref` adds links in the same write, as `update` does.
- Every write replies short: `id`, the new `rev`, `status`, `assignee` (`attach` adds `attachment`, `finish` adds `commit`, `claim` and `create` for yourself add `next`);
  the whole task is `laneboard get WEB-1` or `--full` on the write. People read better without `--json`: `list`, `get`, `events`, `view`.

## Finishing work

`finish` is one write: the result comment (`result: true` in its event), a link to the current git commit (`commit=<HEAD>`;
`--no-commit` skips it; outside git or before the first commit there is none: `"commit": null`, `no commit linked`), then the status. Commit first: uncommitted changes or a HEAD older than the claim
give a warning; git is asked with a 2-second limit, and without git the task is still finished.

```sh
laneboard finish WEB-1 --result "Fixed, redirect test added" --as dev-1 --json
laneboard get WEB-1
laneboard list --scope all --json
```

- `--status` takes any status but the first. The assignee's `finish` into a status that is not final hands the task in (`handed_in: true`);
  on a board with checks only into a check ([orchestrators.md](https://github.com/bazarbayevabylay/laneboard/blob/main/docs/orchestrators.md)).
  Somebody else's task `finish` only accepts, into the final status, and only after its assignee handed it in (`accepted: true`).
- Handed in again into the same status with a new result: the result is recorded; the same result again changes nothing.
- Git worktree: the board of the main checkout is found by itself, and `finish` there links the worktree's HEAD.
  `finish` in the main checkout while other worktrees have newer commits warns with the fix; `--commit <sha>` names the commit
  (MCP: `cwd` = your worktree's absolute path, or `commit`). With several worktrees the fix is one command: the finish with your
  worktree's commit, then `&&` the removal of the wrong link.
- A commit already linked to a task of another name gives the warning `commit <sha> is already linked to <ID>` with the command that
  links the commit of your work instead.
- Subtasks: `create ... --parent WEB-1` (a task of the same board); `get` lists `children`, `list --parent WEB-1` the direct ones.
- `update --append-description` adds a paragraph without `--expected-rev`; `--description` replaces the text and keeps the old one in its event.
- `--expected-rev` is needed only for edits on top of what you read (description, fields); never for status, comment, claim or finish.

```sh
laneboard create "Write the redirect test" --status todo --parent WEB-1 --as dev-1 --json
laneboard list --parent WEB-1 --json
```
