---
title: Warm the cache after deploy
stage: blocked
owner: lead
project: api
branch: feat/20260103-cache-warmup
created: 2026-01-03
updated: 2026-01-04
depends_on: "waiting for the deploy hook"
agents:
  - role: code-analyst
    status: done
    result_ref: notes/cache-map.md
  - role: backend-developer
    status: spawned
---
Blocked until the deploy hook exists.
