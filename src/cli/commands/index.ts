// Registry of CLI commands, in help order.
import { archive } from './archive.ts';
import { attach } from './attach.ts';
import { boards } from './boards.ts';
import { claim } from './claim.ts';
import { comment } from './comment.ts';
import { config } from './config.ts';
import { create } from './create.ts';
import { remove } from './delete.ts';
import { doctor } from './doctor.ts';
import { events } from './events.ts';
import { get } from './get.ts';
import { importCommand } from './import.ts';
import { init } from './init.ts';
import { list } from './list.ts';
import { mcp } from './mcp.ts';
import { migrate } from './migrate.ts';
import { prime } from './prime.ts';
import { restore } from './restore.ts';
import { setup } from './setup.ts';
import type { CommandDef } from './types.ts';
import { update } from './update.ts';
import { view } from './view.ts';

export const COMMANDS: readonly CommandDef[] = [create, get, list, update, claim, comment, attach, archive, restore, remove, events, init, config, setup, importCommand, prime, view, boards, mcp, migrate, doctor];

// Find a command by name.
export function findCommand(name: string): CommandDef | undefined {
  return COMMANDS.find((c) => c.name === name);
}
