// C5: every error code has exit, http and a non-empty fix; exit classes match ADR-0001 section 5.
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERRORS } from '../../src/core/index.ts';
import type { ErrorCode } from '../../src/core/index.ts';

const EXPECTED_EXIT: Record<ErrorCode, number> = {
  INTERNAL: 1,
  USAGE: 2,
  UNKNOWN_OPTION: 2,
  INVALID_VALUE: 2,
  UNKNOWN_STATUS: 2,
  UNKNOWN_FIELD: 2,
  ACTOR_REQUIRED: 2,
  TASK_NOT_FOUND: 3,
  ATTACHMENT_NOT_FOUND: 3,
  REV_CONFLICT: 4,
  ALREADY_CLAIMED: 4,
  TASK_ARCHIVED: 4,
  ATTACHMENT_EXISTS: 4,
  LOCK_TIMEOUT: 5,
  LOCK_LOST: 5,
  // LB-63.5: a conflict (the port is held), not busy: the same command again finds it taken again.
  PORT_IN_USE: 4,
  STORE_NOT_FOUND: 6,
  STORE_INVALID: 6,
  STORE_TOO_NEW: 6,
  STORE_EXISTS: 6,
  STORE_READ_ONLY: 6,
  SETUP_UNPARSEABLE: 6,
  SETUP_CONFLICT: 6,
  SETUP_WRITE_FAILED: 6,
};

describe('error registry (C5)', () => {
  it.each(ERROR_CODES)('%s has exit, http and fix', (code) => {
    const spec = ERRORS[code];
    expect(spec.exit).toBe(EXPECTED_EXIT[code]);
    expect([400, 404, 409, 500, 503]).toContain(spec.http);
    expect(spec.fix.trim().length).toBeGreaterThan(10);
  });

  it('LB-63.2: every command an agent runs in a default fix carries --json (rule 3); laneboard board (a server for people) is none', () => {
    const commands = ERROR_CODES.flatMap((code) => [...ERRORS[code].fix.matchAll(/laneboard (?:prime|create|claim|comment|finish|get|list|update|attach|archive|restore|events|boards|init|config|doctor|delete|redact)\b(?:"[^"]*"|[^;,)"])*/g)].map((m) => ({ code, command: m[0] })));
    const agentCommands = commands.filter((c) => !c.command.includes('--help'));
    expect(agentCommands.length).toBeGreaterThan(8);
    for (const c of agentCommands) expect(c.command, c.code).toContain('--json');
  });

  it('lists every code exactly once', () => {
    expect([...ERROR_CODES].sort()).toEqual(Object.keys(EXPECTED_EXIT).sort());
  });
});
