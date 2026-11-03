# laneboard

laneboard — доска задач и CLI, с которыми AI-агенты сами ведут свои задачи: заводят, берут, комментируют и закрывают.
Человек видит те же задачи и может вмешаться в любой момент.

Работает с Claude Code, Codex, Cursor, Gemini CLI и OpenCode. Без сервера и базы данных: хранилище — два JSON-файла в папке проекта.

| Что | Где |
|---|---|
| Гайд для агентов (на английском): установка, полный цикл задачи, ошибки, настройка, импорт | [docs/agent-guide.md](docs/agent-guide.md) |
| Архитектурное решение и спецификация | [docs/adr/0001-two-json-store-cli-first.md](docs/adr/0001-two-json-store-cli-first.md) |
| Лицензия | MIT, [LICENSE](LICENSE) |

## Установка

Нужен Node.js 22 или новее, macOS или Linux. CLI ставится один раз на машину.

<!-- guide:skip installs globally -->
```sh
npm i -g laneboard
```

Пока пакета нет в npm, его собирают из git и ставят из архива:

<!-- guide:skip installs globally -->
```sh
git clone https://github.com/bazarbayevabylay/laneboard.git
cd laneboard && npm ci && npm pack
npm i -g ./laneboard-*.tgz
```

Проверка: команда печатает версию.

```sh
laneboard --version
```

## Быстрый старт

Три шага в корне проекта. `init` создаёт хранилище `./.laneboard`, `setup` подключает харнес, дальше агент работает сам.

```sh
laneboard init --prefix WEB
laneboard setup claude-code
```

Другой харнес — то же с его именем: `codex`, `cursor`, `gemini`, `opencode`. В один проект можно подключить несколько.

```sh
laneboard setup codex
```

Что делает `setup`:

| Что | Где |
|---|---|
| MCP-сервер `laneboard` | `.mcp.json`, `.cursor/mcp.json`, `.gemini/settings.json`, `opencode.json`; для Codex — глобальный `~/.codex/config.toml` |
| Блок из трёх строк с правилами: что за инструмент, какое хранилище, «без задачи не работать» | `CLAUDE.md`, `AGENTS.md` или `GEMINI.md`, между метками `laneboard:start` / `laneboard:end` |
| Хуки Claude Code: правила в начале сессии, напоминание после правки файла без задачи | `.claude/settings.json` |
| Привязка проекта к хранилищу | `env.LANEBOARD_DIR` в `.claude/settings.json`, `mcp --dir` в записях Cursor, Gemini, OpenCode, строка `LANEBOARD_DIR=…` в блоке |

Агенту больше ничего не нужно: правила приходят из блока и из `laneboard prime`.
Так выглядит работа агента — те же команды он выполняет сам:

```sh
laneboard create "Починить редирект после входа" --status todo --assignee dev-1 --as dev-1 --json
laneboard claim WEB-1 --status in_progress --as dev-1 --json
laneboard comment WEB-1 "Причина: редирект теряет query string" --as dev-1 --json
laneboard update WEB-1 --status done --expected-rev 3 --as dev-1 --json
laneboard list --scope all --json
```

Человеку удобнее без `--json`: `laneboard list`, `laneboard get WEB-1`, `laneboard events`.

## Как устроено хранилище

Всё лежит в `.laneboard/` проекта; `init` кладёт туда `.gitignore`, чтобы хранилище не попало в git.

| Что | Где |
|---|---|
| Настройки: префикс id, статусы по порядку (последний — финальный), поля задач с типами | `config.json` — единственный файл, который правят руками |
| Активные задачи | `active.json` |
| Архив: закрытые задачи, только чтение | `archive.json` |
| Предыдущая целая версия каждого файла | `active.json.bak`, `archive.json.bak` |
| Вложения | `attachments/<id>/<имя>` |
| Блокировка на время записи | каталог `lock`, существует только пока идёт запись |

Каждая запись проходит одним путём: блокировка → свежее чтение → проверка → атомарная запись (временный файл + rename).
Поэтому десятки агентов и сессий пишут одновременно без потерь. Устаревший `--expected-rev` даёт `REV_CONFLICT`, а не тихую перезапись.

Архив: `laneboard archive <id>` переносит задачу в `archive.json`, `restore` возвращает. Поиск по архиву — `list --scope all --text <слова>`.
Вложения: `laneboard attach <id> <файл>`; файлы вроде `.env*` и ключей отклоняются по списку `attachments.deny_names`.

Проверка и ремонт: `laneboard doctor` (только читает), `doctor --fix`, `doctor --restore-backup`.

```sh
laneboard doctor
```

## Несколько проектов и агентов

У каждого проекта своё хранилище и свой префикс id: `WEB-12` и `API-12` не спутать. Ответ каждой команды называет `store` и `prefix`.

| Что | Как |
|---|---|
| Какое хранилище берёт команда | `--dir <путь>`, иначе `LANEBOARD_DIR`, иначе `.laneboard/` в текущей папке или выше |
| Проект привязан к своему хранилищу | `setup` записывает путь (`env`, `--dir`, блок инструкций), поиск вверх ему не нужен |
| Хранилище нашлось в родительской папке | каждая команда предупреждает: возможно, это чужой проект |
| Вложенная папка-агент с собственными задачами | свой `laneboard init` в этой папке, затем `setup` там же |
| Несколько агентов в одном хранилище | у каждого имя (`--as` или `LANEBOARD_AGENT`); `claim` не даёт взять чужую задачу (`ALREADY_CLAIMED`) |

```sh
mkdir -p agents/reviewer
(cd agents/reviewer && laneboard init --prefix REV && laneboard setup gemini)
laneboard list --dir agents/reviewer/.laneboard --json
```

## Перенос существующих задач

`laneboard import markdown <папка>` переносит md-файлы с YAML-frontmatter, `laneboard import json <папка|файл>` — JSON-файлы задач с историей.
Неизвестный ключ или статус останавливает импорт со списком всего найденного, `--dry-run` ничего не пишет, повторный запуск пропускает уже перенесённые файлы.
Флаги и примеры — в [docs/agent-guide.md](docs/agent-guide.md#4-migrate-import-existing-tasks).

## Удаление

`setup <харнес> --remove` убирает только то, что записал `setup`, и возвращает исходные байты файлов, которые были до него.
Каталог удаляется, только если его создал `setup` и в нём больше ничего нет.

```sh
laneboard setup codex --remove
laneboard setup claude-code --remove
```

Затем, если инструмент больше не нужен: удалить папку `.laneboard/` проекта и сам CLI (`npm uninstall -g laneboard`).

## Ограничения

| Что | Почему |
|---|---|
| Только macOS и Linux | атомарный rename и блокировка проверены только там; Windows нет в CI |
| Одна машина | блокировка — каталог в файловой системе; сетевые диски и синхронизация папок между машинами не поддерживаются |
| До ~10 000 задач в хранилище | каждая команда читает файл целиком; старые задачи стоит архивировать |
| Абсолютный путь хранилища в файлах проекта | `setup` пишет путь этой машины; на другой машине нужно запустить `setup` заново |
| Доска в браузере | ещё не готова, сейчас есть CLI и MCP |
