# laneboard plugin for Claude Code

laneboard is a task board and CLI for AI coding agents. This plugin gives Claude Code three things:

- the `laneboard` skill with the agent rules (how to claim, comment, finish, attach and archive tasks, and resume your own task after `/clear`);
- a SessionStart hook that runs `laneboard prime --hook`, so every session starts with the rules and your active tasks (in a project without a laneboard board it prints one neutral line: no board here, and how to create one if you want it);
- a PostToolUse hook after Edit/Write that runs `laneboard prime --edit-hook`: a one-line reminder for Claude when no task is in progress (it never blocks, and prints nothing otherwise);
- the laneboard MCP server (`laneboard mcp`, tools `task_*`).

The plugin does not install the CLI. Install it first: `npm i -g laneboard`, then in your project root run
`laneboard init --name <name> --description "<whose project, what work>"`.
Without a name of your own, writes use the session's default name (`laneboard prime` shows it); pick one with `--as <name>`.

Install: `/plugin marketplace add bazarbayevabylay/laneboard`, then `/plugin install laneboard@laneboard`.
Do not also run `laneboard setup claude-code` in the same project: both register the same MCP server and hook.
