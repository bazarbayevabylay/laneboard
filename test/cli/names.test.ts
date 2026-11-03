// Default agent names (S2c): an agent that never picks a name writes under the session's default name, parallel Claude Code sessions
// get different ones (so claim tells them apart), and every event records where its name came from.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { actorPart, agentUser, defaultAgentName, resolveActor } from '../../src/core/index.ts';
import { callTool } from '../../src/mcp/tools.ts';
import { cleanupTemp, cli, newStore, readStore, tempDir } from '../helpers.ts';

afterAll(cleanupTemp);

// Environment of one Claude Code session after `setup claude-code`: the default name base and the session id.
function session(id: string): Record<string, string> {
  return { LANEBOARD_DEFAULT_AGENT: 'claude-code@Test-Person', CLAUDE_CODE_SESSION_ID: id };
}

const A = '1a2b3c4d-0000-4000-8000-000000000001';
const B = '9f8e7d6c-0000-4000-8000-000000000002';

describe('default agent name', () => {
  it('order: --as, then LANEBOARD_AGENT (both explicit), then the default; without a default nothing (ACTOR_REQUIRED on writes)', () => {
    const env = { ...session(A), LANEBOARD_AGENT: 'dev-1' };
    expect(resolveActor('me', env)).toEqual({ actor: 'me', actorSource: 'explicit' });
    expect(resolveActor(undefined, env)).toEqual({ actor: 'dev-1', actorSource: 'explicit' });
    expect(resolveActor('', session(A))).toEqual({ actor: 'claude-code@Test-Person:1a2b3c4d', actorSource: 'default' });
    expect(resolveActor(undefined, {})).toEqual({});
  });

  it('a name equal to this session\'s default name (copied from prime into --as, or set as LANEBOARD_AGENT) is still "default" (live test S2c)', async () => {
    const own = 'claude-code@Test-Person:1a2b3c4d';
    expect(resolveActor(own, session(A))).toEqual({ actor: own, actorSource: 'default' });
    expect(resolveActor(undefined, { ...session(A), LANEBOARD_AGENT: own })).toEqual({ actor: own, actorSource: 'default' });
    // Another session's default name, or the base without the session part, is a name of its own.
    expect(resolveActor(own, session(B))).toEqual({ actor: own, actorSource: 'explicit' });
    expect(resolveActor('claude-code@Test-Person', session(A))).toEqual({ actor: 'claude-code@Test-Person', actorSource: 'explicit' });
    const s = await newStore();
    expect((await cli(['create', 'copied name', '--status', 'todo', '--assignee', own, '--as', own, '--json'], { cwd: s.root, env: session(A) })).code).toBe(0);
    expect(readStore(s.dir, 'active').tasks[0]?.events).toMatchObject([{ actor: own, actor_source: 'default' }]);
    const mcp = await callTool('task_comment', { id: 'LB-1', text: 'step', actor: own }, { cwd: s.root, env: session(A) });
    expect(mcp.isError).toBeFalsy();
    expect(readStore(s.dir, 'active').tasks[0]?.events).toMatchObject([{ actor_source: 'default' }, { actor: own, actor_source: 'default', type: 'commented' }]);
  });

  it('inside Claude Code without setup (plugin only) the base is claude-code@<user>; without a session id the base alone', () => {
    expect(defaultAgentName({ CLAUDE_CODE_SESSION_ID: B, USER: 'tester' })).toBe('claude-code@tester:9f8e7d6c');
    expect(defaultAgentName({ LANEBOARD_DEFAULT_AGENT: 'codex@tester' })).toBe('codex@tester');
    expect(defaultAgentName({ USER: 'tester' })).toBeUndefined();
    // Always a valid actor name, at most 64 characters, the session part kept.
    const long = defaultAgentName({ LANEBOARD_DEFAULT_AGENT: `claude-code@${'x'.repeat(80)}`, CLAUDE_CODE_SESSION_ID: A }) ?? '';
    expect(long).toHaveLength(64);
    expect(long.endsWith(':1a2b3c4d')).toBe(true);
  });

  it('the user part: git user.name from ~/.gitconfig (later file wins over the XDG one), else USER; any name becomes actor characters', () => {
    const home = tempDir();
    fs.mkdirSync(path.join(home, '.config', 'git'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'git', 'config'), '[user]\n\tname = Xdg Name\n');
    expect(agentUser({ HOME: home, USER: 'tester' })).toBe('Xdg-Name');
    fs.writeFileSync(path.join(home, '.gitconfig'), '[core]\n\tname = not-this\n[user]\n\temail = a@b.c\n\tname = "Zoë Ünal"\n');
    expect(agentUser({ HOME: home, USER: 'tester' })).toBe('Zoe-Unal');
    expect(agentUser({ HOME: tempDir(), USER: 'tester' })).toBe('tester');
    expect(actorPart('  Иван (dev) ')).toBe('dev');
    expect(actorPart('Иван')).toBe('');
  });
});

describe('agents without a name', () => {
  it('a write without --as and LANEBOARD_AGENT uses the default name; the event says "default"; get shows it', async () => {
    const s = await newStore();
    const r = JSON.parse((await cli(['create', 'Haiku work', '--status', 'todo', '--json'], { cwd: s.root, env: session(A) })).stdout);
    expect(r).toMatchObject({ ok: true, data: { created_by: 'claude-code@Test-Person:1a2b3c4d' } });
    expect(r.data.events[0]).toMatchObject({ actor: 'claude-code@Test-Person:1a2b3c4d', actor_source: 'default', type: 'created' });
    expect(readStore(s.dir, 'active').tasks[0]?.events).toMatchObject([{ actor_source: 'default' }]);
    const named = JSON.parse((await cli(['comment', 'LB-1', 'step', '--as', 'dev-1', '--json'], { cwd: s.root, env: session(A) })).stdout);
    expect(named.data.events.at(-1)).toMatchObject({ actor: 'dev-1', actor_source: 'explicit' });
    const human = await cli(['get', 'LB-1'], { cwd: s.root });
    expect(human.stdout).toContain('claude-code@Test-Person:1a2b3c4d (default name)  created');
    expect(human.stdout).toContain('dev-1  commented');
  });

  it('two sessions without names get different names: the second claim is ALREADY_CLAIMED', async () => {
    const s = await newStore();
    expect((await cli(['create', 'Shared task', '--status', 'todo', '--as', 'lead'], { cwd: s.root })).code).toBe(0);
    const first = JSON.parse((await cli(['claim', 'LB-1', '--status', 'in_progress', '--json'], { cwd: s.root, env: session(A) })).stdout);
    expect(first).toMatchObject({ ok: true, data: { assignee: 'claude-code@Test-Person:1a2b3c4d' } });
    const second = await cli(['claim', 'LB-1', '--json'], { cwd: s.root, env: session(B) });
    expect(second.code).toBe(4);
    expect(JSON.parse(second.stdout).error).toMatchObject({ code: 'ALREADY_CLAIMED', details: { assignee: 'claude-code@Test-Person:1a2b3c4d' } });
    // The same session claims again: a no-op, not a conflict.
    expect((await cli(['claim', 'LB-1'], { cwd: s.root, env: session(A) })).code).toBe(0);
  });

  it('outside any configured harness a write still needs a name (ACTOR_REQUIRED)', async () => {
    const s = await newStore();
    const r = await cli(['create', 'x', '--status', 'todo', '--json'], { cwd: s.root, env: { USER: 'tester' } });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error.code).toBe('ACTOR_REQUIRED');
  });

  it('prime names the default and prints the create command without --as (so the events stay "default")', async () => {
    const s = await newStore();
    const r = await cli(['prime'], { cwd: s.root, env: session(A) });
    expect(r.stdout).toContain('Your name is the session default claude-code@Test-Person:1a2b3c4d');
    expect(r.stdout).toContain('  laneboard create "<short title of your work>" --status todo --assignee claude-code@Test-Person:1a2b3c4d --json\n');
    const json = JSON.parse((await cli(['prime', '--json'], { cwd: s.root, env: session(A) })).stdout);
    expect(json.data).toMatchObject({ agent: 'claude-code@Test-Person:1a2b3c4d', agent_source: 'default' });
  });

  it('the edit hook with only a default name: quiet while anybody has a task in progress (an agent may have used its own --as)', async () => {
    const s = await newStore();
    const hook = (id: string) => cli(['prime', '--edit-hook'], { cwd: s.root, env: session(id) });
    expect((await hook(A)).stdout).toContain('laneboard: no task is in progress in store');
    await cli(['create', 'mine', '--status', 'todo', '--assignee', 'my-own-name', '--as', 'my-own-name'], { cwd: s.root, env: session(A) });
    expect(await hook(A)).toEqual({ code: 0, stdout: '', stderr: '' });
    // LANEBOARD_AGENT is explicit: the hook looks at that name's tasks only.
    expect((await cli(['prime', '--edit-hook'], { cwd: s.root, env: { ...session(B), LANEBOARD_AGENT: 'dev-9' } })).stdout).toContain('no task is in progress for dev-9');
  });

  it('MCP: a write tool without actor uses LANEBOARD_AGENT, else the default name of the session that started the server', async () => {
    const s = await newStore();
    const created = await callTool('task_create', { title: 'via MCP', status: 'todo' }, { cwd: s.root, env: session(B) });
    expect(created.isError).toBeUndefined();
    expect(created.structuredContent).toMatchObject({ created_by: 'claude-code@Test-Person:9f8e7d6c', events: [{ actor_source: 'default' }] });
    const viaEnv = await callTool('task_comment', { id: 'LB-1', text: 'x' }, { cwd: s.root, env: { ...session(B), LANEBOARD_AGENT: 'dev-7' } });
    expect(viaEnv.structuredContent).toMatchObject({ updated_by: 'dev-7' });
    const none = await callTool('task_comment', { id: 'LB-1', text: 'x' }, { cwd: s.root, env: {} });
    expect(none.structuredContent).toMatchObject({ code: 'ACTOR_REQUIRED' });
  });
});
