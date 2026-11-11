// Registry of CLI commands, in help order.
import { archive } from './archive.ts';
import { attach } from './attach.ts';
import { board } from './board.ts';
import { boards } from './boards.ts';
import { claim } from './claim.ts';
import { comment } from './comment.ts';
import { config } from './config.ts';
import { create } from './create.ts';
import { remove } from './delete.ts';
import { doctor } from './doctor.ts';
import { events } from './events.ts';
import { finish } from './finish.ts';
import { get } from './get.ts';
import { importCommand } from './import.ts';
import { init } from './init.ts';
import { list } from './list.ts';
import { mcp } from './mcp.ts';
import { migrate } from './migrate.ts';
import { prime } from './prime.ts';
import { redact } from './redact.ts';
import { restore } from './restore.ts';
import { setup } from './setup.ts';
import type { CommandDef } from './types.ts';
import { update } from './update.ts';
import { view } from './view.ts';

export const COMMANDS: readonly CommandDef[] = [create, get, list, update, claim, comment, finish, attach, archive, restore, remove, redact, events, init, config, setup, importCommand, prime, view, board, boards, mcp, migrate, doctor];

// Names agents type for a command (lb-tokens experiment: `laneboard show`, `laneboard edit`): they run as that command; the help does
// not list them, so agents keep learning one name.
const COMMAND_ALIASES: Readonly<Record<string, string>> = { show: 'get', edit: 'update' };

// Other words for a command: an unknown one of these is no command, but its error suggests the command, so the fix runs as printed.
const COMMAND_SYNONYMS: Readonly<Record<string, string>> = {
  info: 'get',
  cat: 'get',
  read: 'get',
  describe: 'get',
  set: 'update',
  modify: 'update',
  change: 'update',
  note: 'comment',
  done: 'finish',
  close: 'finish',
  complete: 'finish',
  take: 'claim',
  start: 'claim',
  pick: 'claim',
  new: 'create',
  add: 'create',
  ls: 'list',
  search: 'list',
  find: 'list',
};

// The command an alias stands for, else the name as given.
export function commandName(name: string): string {
  return Object.hasOwn(COMMAND_ALIASES, name) ? (COMMAND_ALIASES[name] ?? name) : name;
}

// The command a synonym names (for an unknown-command suggestion), else undefined.
export function commandSynonym(name: string): string | undefined {
  const key = name.toLowerCase();
  return Object.hasOwn(COMMAND_SYNONYMS, key) ? COMMAND_SYNONYMS[key] : undefined;
}

// Find a command by name or alias.
export function findCommand(name: string): CommandDef | undefined {
  const real = commandName(name);
  return COMMANDS.find((c) => c.name === real);
}
