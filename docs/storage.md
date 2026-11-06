# Storage, safety and import

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

## Storage and safety

Everything lives in the project's `.laneboard/`: `config.json` (settings), `active.json`, `archive.json`, their `.bak` (the previous
version), `attachments/<id>/`, and a `lock` folder only while a write runs. Every write takes the lock, reads fresh, checks and replaces
the file atomically, so many agents write at once without losing data; a stale `--expected-rev` is `REV_CONFLICT`.

- Do not commit `.laneboard/`: `init` puts a `.gitignore` there. A board in git is not supported: a merge can give two tasks one id;
  `laneboard doctor --fix` gives the later copy a new id and names the tasks that point to the old one.
- One machine. The lock is a folder, so network drives and folders synced between machines (Dropbox, iCloud) are not supported.
- A full disk: the command fails with `INTERNAL` and "free disk space"; the board and its `.bak` stay whole. File modes follow your umask.
- `laneboard doctor` checks and exits 6 while a problem is left; `--fix` repairs what it can (attachment files without metadata go
  to `attachments/.orphaned/`, never deleted); `--restore-backup` brings back the `.bak` version. A lock with a time in the future is
  removed after 10 s without change.
- `laneboard delete <ID> --confirm <ID>` is for people: the archive keeps a trace (id, title, who and when); `get` and
  `list --scope archive` show it as `deleted <at> by <who>` (`deleted {at, by}` with `--json`). A pasted secret:
  `laneboard redact <ID> --text-file <file>` removes it from the task and from the `.bak`; redact first, then delete.
- Attachments named like keys or secrets (`.env*`, `*.pem`, `id_rsa*`, `*credentials*`, `.npmrc` and more, `attachments.deny_names`)
  are refused; `*credentials*` may refuse a harmless name too: rename the file.

```sh
laneboard doctor
```

## Import existing tasks

`laneboard import markdown <folder>` (files with YAML frontmatter), `import json <folder|file>` (task files with history) and
`import checklist TODO.md --status todo` (a Markdown TODO list: an item is a task, `[x]` the final status, an indented item a subtask).
An unknown key or status stops the import and lists every value; `--dry-run` writes nothing (it shows the status each new task gets);
a second run skips what it imported (`import checklist` still checks its `--status` and `--done-status`).
Options and examples: [agent-guide.md, section 4](https://github.com/bazarbayevabylay/laneboard/blob/main/docs/agent-guide.md#4-migrate-import-existing-tasks).

```sh
printf '# TODO\n- [x] Set up the schema\n- [ ] Dark mode toggle\n  - [ ] Keep the choice after a reload\n' > TODO.md
laneboard import checklist TODO.md --status todo --as dev-1 --json
```
