#!/usr/bin/env bash
# Architecture boundary checks (ADR-0001 section 11):
#   C1 file writes only in src/core/fsio.ts and src/setup/
#   C2 src/core imports no facade (cli, mcp, board, setup, import)
#   C4 nothing in src/mcp writes stdout (it belongs to the MCP protocol)
#   C9 src/board is read-only: no write op or lock of the core, and imports from core only through src/core/index.ts (ADR §31, K6)
# Usage: scripts/check-boundaries.sh [repo-root]   (exit 1 on a violation)
set -u
cd "${1:-.}" || exit 2
if [ ! -d src ]; then
  echo "check-boundaries: no src/ in $(pwd)" >&2
  exit 2
fi
fail=0

c1=$(grep -rnE '\b(writeFile|writeFileSync|rename|renameSync|appendFile|appendFileSync|copyFile|copyFileSync|unlink|unlinkSync|rmSync|createWriteStream)\b' src --include='*.ts' | grep -vE '^src/(core/fsio\.ts|setup/)')
if [ -n "$c1" ]; then
  echo "C1 violation: file writes outside src/core/fsio.ts and src/setup/:"
  echo "$c1"
  fail=1
fi

if [ -d src/core ]; then
  c2=$(grep -rnE "from ['\"][^'\"]*(\.\./)+(cli|mcp|board|setup|import)/" src/core)
  if [ -n "$c2" ]; then
    echo "C2 violation: src/core imports a facade:"
    echo "$c2"
    fail=1
  fi
fi

if [ -d src/mcp ]; then
  c4=$(grep -rnE 'console\.log|process\.stdout\.write' src/mcp)
  if [ -n "$c4" ]; then
    echo "C4 violation: src/mcp writes stdout (reserved for the MCP protocol):"
    echo "$c4"
    fail=1
  fi
fi

if [ -d src/board ]; then
  c9w=$(grep -rnE '\b(transact|withLock|writeFileAtomic|createTask|updateTask|claimTask|commentTask|finishTask|attachFile|archiveTasks|restoreTask|deleteTask|importTasks|initStore|configureStore|migrateStore|doctor)\b' src/board)
  if [ -n "$c9w" ]; then
    echo "C9 violation: src/board names a core write op or the store lock (the web board is read-only):"
    echo "$c9w"
    fail=1
  fi
  c9i=$(grep -rnE "from ['\"](\.\./)+core/[a-z]" src/board | grep -v 'core/index\.ts')
  if [ -n "$c9i" ]; then
    echo "C9 violation: src/board imports core modules other than src/core/index.ts:"
    echo "$c9i"
    fail=1
  fi
fi

if [ "$fail" -eq 0 ]; then echo "boundaries ok (C1, C2, C4, C9)"; fi
exit "$fail"
