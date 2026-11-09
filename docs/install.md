# Install, upgrade, uninstall

Back to the [README](https://github.com/bazarbayevabylay/laneboard/blob/main/README.md).
Every `sh` block below runs in laneboard's test suite, in order, in a fresh project, so the commands and exit codes are real.

## Requirements

Node.js 22 or newer, on macOS or Linux. The CLI is installed once per machine.
Windows is not supported: npm refuses the package there with `EBADPLATFORM`.
On an older Node.js every command prints one warning line (`warnings` with `--json`): install Node.js 22 and the CLI again.

Check with `node --version`. When nvm's default is older, install 22 and make it the default (agents start new shells with it):
`nvm install 22 && nvm alias default 22 && nvm use 22`. A global package belongs to the Node.js version active at install time:
after switching versions, install the CLI again.

## Install from npm

<!-- guide:skip installs globally -->
```sh
npm i -g laneboard
```

Check: the command prints the version (`-v` too). `laneboard` alone prints the help.

```sh
laneboard --version
```

## Install from git

Without the npm registry, install from git: clone, build, then install the folder or a tarball.

<!-- guide:skip installs globally -->
```sh
git clone https://github.com/bazarbayevabylay/laneboard.git
cd laneboard && npm ci && npm run build
npm i -g .
```

| Way | Result |
|---|---|
| `npm i -g .` | a link to the clone: `git pull && npm ci && npm run build` updates the CLI |
| `npm pack && npm i -g ./laneboard-*.tgz` | a copy from the tarball: the clone can be deleted afterwards |

## First board

Two commands in the project root. `init` creates the board `./.laneboard` and adds it to this machine's registry; `setup` connects
your agent; from then on the agent works by itself. The prefix of the task ids and the other settings: [configuration.md](https://github.com/bazarbayevabylay/laneboard/blob/main/docs/configuration.md).

```sh
laneboard init --name web --description "ACME web shop: catalog and cart"
laneboard setup claude-code
laneboard setup codex
```

Then start a new agent session in the project folder: it loads the instructions (and the MCP server) at start.
Each `setup` prints this as its `next` line. Claude Code gets hooks that print the rules and your tasks, and no MCP server unless
`setup claude-code --mcp` (then approve the project MCP server `laneboard` when asked). The server is named `laneboard`: Claude Code and Gemini CLI list it under `/mcp`, Cursor under its MCP settings,
Codex with `codex mcp list`, OpenCode with `opencode mcp list`.

## Claude Code plugin

Instead of `laneboard setup claude-code`: `/plugin marketplace add bazarbayevabylay/laneboard`, then
`/plugin install laneboard@laneboard`. Use one of them, not both: they register the same server and hooks.
The plugin does not install the CLI: install it first (`npm i -g laneboard`), then run `laneboard init` in the project root.
Without the CLI its SessionStart hook prints `laneboard CLI missing: npm i -g laneboard`.

## Upgrading from 0.3.x

- Boards of 0.3.x open as they are: store and `config.json` keep their format; the new config keys (checks, reviewers, creators) are
  optional, and `config@2` is written only when you turn one on. 0.3.x reads every board that has none of them.
- MCP: `task_delete` is gone (delete is for people, CLI-only; a call of it is an unknown-tool error whose fix names `laneboard delete`); `task_prime` is new.
- Re-run `laneboard setup <harness>` in each project: the instruction block, the hook matcher and the Claude Code pin are updated in place.

## Upgrading to 0.4.4

- `setup claude-code` no longer writes the MCP server: the hooks give the agent the rules and the CLI commands. A project set up before
  keeps its `.mcp.json` entry, and setup warns; `laneboard setup claude-code --no-mcp` takes it out, `--mcp` keeps it without the warning.
- The new `deny_names` defaults apply to boards created by 0.4.0; an older board keeps its list.

## Moving a folder or a machine

A moved project folder: run `laneboard setup <harness>` in the new folder (it re-pins), then `laneboard boards --forget <old path>/.laneboard`.
Another machine: copy the project with its `.laneboard/`, install the CLI, run `laneboard setup <harness>` there: the board path in the
project's files is this machine's.

```sh
laneboard boards
```

## Uninstall

`setup <harness> --remove` takes out only what setup wrote and restores the bytes files had before it. Codex keeps the global entry
while another project of the machine still uses it; `setup codex --remove --global` removes it anyway.

```sh
laneboard setup codex --remove
laneboard setup claude-code --remove
```

Then, if laneboard is no longer needed: delete the project's `.laneboard/` and the CLI (`npm uninstall -g laneboard`).
