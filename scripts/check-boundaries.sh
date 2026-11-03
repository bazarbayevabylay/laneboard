#!/usr/bin/env bash
# Architecture boundary checks (ADR-0001 section 11):
#   C1 file writes only in src/core/fsio.ts and src/setup/
#   C2 src/core imports no facade (cli, mcp, board, setup, import)
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

if [ "$fail" -eq 0 ]; then echo "boundaries ok (C1, C2)"; fi
exit "$fail"
