# laneboard plugin for Claude Code

laneboard is a task board and CLI for AI coding agents. This plugin gives Claude Code three things:

- the `laneboard` skill with the agent rules (how to claim, update, comment, attach and archive tasks);
- a SessionStart hook that runs `laneboard prime --hook`, so every session starts with the rules and your active tasks (in a project without a laneboard store it prints one line only);
- the laneboard MCP server (`laneboard mcp`, tools `task_*`).

The plugin does not install the CLI. Install it first: `npm i -g laneboard`, then run `laneboard init` in your project.
Set your name for writes with `export LANEBOARD_AGENT=<your-name>`.

Install: `/plugin marketplace add bazarbayevabylay/laneboard`, then `/plugin install laneboard@laneboard`.
Do not also run `laneboard setup claude-code` in the same project: both register the same MCP server and hook.
