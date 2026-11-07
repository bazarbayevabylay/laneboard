# Watching the board: terminal, browser, HTTP API

Back to the [README](https://github.com/bazarbayevabylay/laneboard/blob/main/README.md).
Every `sh` block below runs in laneboard's test suite, in order, in a fresh project, so the commands and exit codes are real.
The examples need the CLI and a board:

<!-- guide:skip installs globally -->
```sh
npm i -g laneboard
```

```sh
laneboard init --name web --description "ACME web shop: catalog and cart"
```

## In the terminal

`laneboard view` draws the board in the terminal: a column per status, cards with id, title, assignee and time in status, the newest
comment under each (`> text`; finish's result `= text`). Filters: `--assignee`, `--label`, `--text`; `view --watch` redraws after
every write. `laneboard boards` lists the boards of this machine (`~/.laneboard/boards.json`); a path without a board any more is `missing`.

```sh
laneboard view
laneboard view --assignee dev-1
```

## In the browser

The browser board is read-only by design: tasks change through agents, the CLI and MCP. `laneboard board` in the project folder
prints `http://127.0.0.1:7420/` and serves until Ctrl+C.

| What | How |
|---|---|
| Port | `--port N`, else `board.port` of `config.json` (7420); busy: `PORT_IN_USE` (exit 4), `--port 0` takes a free one |
| Boards | every board of this machine is a tab; `--board <prefix\|name\|path>` opens another one first |
| Access | this machine only (127.0.0.1), a new token per run |
| Live | a write shows within 1-2 s; the page reloads data every minute |

## HTTP API

Read the same data over HTTP (a check script, a test): take the token from `<meta name="laneboard-token" content="...">` of the page
`/`, send it as the header `X-Laneboard-Token`. Read-only `GET` routes: `/api/boards`, `/api/board` (`assignee`, `label`, `text`),
`/api/tasks` (`scope`, `status`, `assignee`, `label`, `text`, `limit`, `offset`), `/api/tasks/<id>`; `/api/events` streams changes
(token as `?token=`). Every route but `/api/boards` takes `?board=<key>` (a key from `/api/boards`); without it, the board opened first.

With the board running on port 7491 (`laneboard board --port 7491` in another terminal), all tasks of the board:

```text
TOKEN=$(curl -s http://127.0.0.1:7491/ | sed -n 's/.*name="laneboard-token" content="\([^"]*\)".*/\1/p')
curl -s -H "X-Laneboard-Token: $TOKEN" "http://127.0.0.1:7491/api/tasks?scope=all"
```
