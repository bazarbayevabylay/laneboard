// Who writes: an explicit name (--as, the MCP `actor`, LANEBOARD_AGENT) or the session's default name.
// The default keeps agents that never pick a name apart: the harness and the user (set by setup in LANEBOARD_DEFAULT_AGENT),
// plus the Claude Code session id (CLAUDE_CODE_SESSION_ID, set in Bash, hook and stdio MCP subprocesses: code.claude.com/docs/en/env-vars).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Where the name of a write came from; recorded on every event (`actor_source`).
export type ActorSource = 'explicit' | 'default';

export interface ResolvedActor {
  actor?: string;
  actorSource?: ActorSource;
  // The default name without its `:<session>` part; set only when the actor is the session default name of a known session
  // (`claim --resume` takes over tasks of earlier sessions with the same base, e.g. after /clear).
  sessionBase?: string;
}

// Characters of the session id kept in a default name (enough to tell parallel sessions apart).
const SESSION_CHARS = 8;
const MAX_ACTOR = 64;
// The harness whose session id the CLI can read without setup (the Claude Code plugin).
const SESSION_HARNESS = 'claude-code';

// `user.name` from one git config file (only the [user] section; includes are not followed), or undefined.
function gitUserName(file: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // No such config file: the next source is tried.
    return undefined;
  }
  let inUser = false;
  let name: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const section = /^\[\s*([A-Za-z0-9.-]+)\s*\]/.exec(line);
    if (section) {
      inUser = section[1]?.toLowerCase() === 'user';
      continue;
    }
    const m = /^name\s*=\s*(.*)$/i.exec(line);
    if (inUser && m) name = (m[1] ?? '').replace(/^"(.*)"$/, '$1').trim() || name;
  }
  return name;
}

// A free-form name as actor characters: accents dropped, other characters become `-`, at most 40 characters.
export function actorPart(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._@-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    .slice(0, 40);
}

// The person behind the agent: git user.name (global config, read without running git), else the OS user.
export function agentUser(env: Record<string, string | undefined>): string {
  const home = env.HOME;
  const files = home ? [path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'git', 'config'), path.join(home, '.gitconfig')] : [];
  // Git reads the XDG file first and ~/.gitconfig after it, so the latter wins.
  let name: string | undefined;
  for (const file of files) name = gitUserName(file) ?? name;
  if (!name) name = env.USER || env.LOGNAME;
  if (!name) {
    try {
      name = os.userInfo().username;
    } catch {
      // No user database entry (some containers): a generic name still works.
      name = undefined;
    }
  }
  return actorPart(name ?? '') || 'user';
}

// Default name base for a harness, as setup writes it: `<harness>@<user>`.
export function defaultAgentBase(harness: string, env: Record<string, string | undefined>): string {
  return `${harness}@${agentUser(env)}`;
}

// The session's default name split in its base (LANEBOARD_DEFAULT_AGENT, else `claude-code@<user>` inside Claude Code) and the
// first 8 alphanumerics of the Claude Code session id (empty when unknown); undefined outside any harness that setup configured.
function defaultNameParts(env: Record<string, string | undefined>): { base: string; session: string } | undefined {
  const session = (env.CLAUDE_CODE_SESSION_ID ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, SESSION_CHARS);
  const base = env.LANEBOARD_DEFAULT_AGENT?.trim() || (session ? defaultAgentBase(SESSION_HARNESS, env) : '');
  if (!base) return undefined;
  return session ? { base: base.slice(0, MAX_ACTOR - SESSION_CHARS - 1), session } : { base: base.slice(0, MAX_ACTOR), session };
}

// The session's default name: the base plus `:<session>` when the Claude Code session id is known.
export function defaultAgentName(env: Record<string, string | undefined>): string | undefined {
  const parts = defaultNameParts(env);
  if (!parts) return undefined;
  return parts.session ? `${parts.base}:${parts.session}` : parts.base;
}

// Is `holder` the default name of another session with the same base (the same user and harness, e.g. before /clear)?
export function isEarlierSessionName(holder: string, sessionBase: string | undefined, actor: string): boolean {
  if (sessionBase === undefined || holder === actor || !holder.startsWith(`${sessionBase}:`)) return false;
  return new RegExp(`^[A-Za-z0-9]{1,${SESSION_CHARS}}$`).test(holder.slice(sessionBase.length + 1));
}

// Name for a write: explicit (--as / MCP actor, then LANEBOARD_AGENT), else the default name, else none (ACTOR_REQUIRED on write).
// A given name equal to this session's default name is still the default (agents copy it from `prime` into --as).
export function resolveActor(explicit: string | undefined, env: Record<string, string | undefined>): ResolvedActor {
  const given = explicit !== undefined && explicit !== '' ? explicit : env.LANEBOARD_AGENT || undefined;
  const parts = defaultNameParts(env);
  const fallback = defaultAgentName(env);
  // Only a default name with a session part has earlier sessions to resume from.
  const session = parts?.session ? { sessionBase: parts.base } : {};
  if (given !== undefined) return given === fallback ? { actor: given, actorSource: 'default', ...session } : { actor: given, actorSource: 'explicit' };
  return fallback === undefined ? {} : { actor: fallback, actorSource: 'default', ...session };
}
