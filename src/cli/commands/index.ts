// Registry of CLI commands, in help order.
import { archive } from './archive.ts';
import { attach } from './attach.ts';
import { claim } from './claim.ts';
import { comment } from './comment.ts';
import { create } from './create.ts';
import { remove } from './delete.ts';
import { doctor } from './doctor.ts';
import { events } from './events.ts';
import { get } from './get.ts';
import { init } from './init.ts';
import { list } from './list.ts';
import { mcp } from './mcp.ts';
import { migrate } from './migrate.ts';
import { prime } from './prime.ts';
import { restore } from './restore.ts';
import { setup } from './setup.ts';
import type { CommandDef } from './types.ts';
import { update } from './update.ts';

export const COMMANDS: readonly CommandDef[] = [create, get, list, update, claim, comment, attach, archive, restore, remove, events, init, setup, prime, mcp, migrate, doctor];

// Find a command by name.
export function findCommand(name: string): CommandDef | undefined {
  return COMMANDS.find((c) => c.name === name);
}
