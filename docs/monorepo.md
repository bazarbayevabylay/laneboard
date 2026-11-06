# Monorepo and several boards

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

## One board per repository

One board per git repository is the default: a package with its own `AGENTS.md` or `CLAUDE.md` uses the board at the repository root,
with no warning. Inside git only a `.git` (a nested repository, a submodule) or a board of its own marks another project.

- `setup` in a package pins it to the root's board. Claude Code: the board path goes to the root's `.claude/settings.local.json`
  (git does not see it); the package commits only the hooks. An older pin in `.claude/settings.json` is moved with a warning: commit that change.
  The exception: a package with a board of its own, or any folder of a repository whose root holds other boards, keeps its pin in
  the committed `.claude/settings.json` (the root's local file would pin every board in the repository). Do not commit that file's
  `env` (a machine path), or keep one board per repository. setup says so in one warning whenever the pin goes to that file.
- A package with a board of its own: `laneboard init --dir packages/<name>/.laneboard`; a plain `init` in a package of a repository
  whose board lies above is refused with the fix.
- Which board a command uses: `--dir <path>`, else `LANEBOARD_DIR`, else `.laneboard/` in the current folder or above (a linked git
  worktree: its main checkout's). Every reply names `store` and `prefix`. Not sure which board is yours: `laneboard boards --json`.
- `--board <prefix|name|path>` opens another board read-only (`view`, `list`, `get`, `events`, `board`); a write through it is `STORE_READ_ONLY`.
- A task of another board is linked with `--link task=BILL-1` (`update --add-link`); `get` shows its status.

```sh
mkdir -p packages/billing
laneboard init --dir packages/billing/.laneboard --name billing --description "Billing package: invoices and payments"
laneboard create "Invoice rounding" --status todo --dir packages/billing/.laneboard --as dev-1 --json
laneboard boards --json
laneboard list --board BILL --json
```
