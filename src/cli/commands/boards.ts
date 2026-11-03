// laneboard boards
import { LaneboardError, listBoards } from '../../core/index.ts';
import { boardsText } from '../board-view.ts';
import type { CommandDef } from './types.ts';

export const boards: CommandDef = {
  name: 'boards',
  usage: 'boards',
  summary:
    'List the boards on this machine (~/.laneboard/boards.json, filled by init and setup): prefix, name, active tasks per status, last change, path and description. ' +
    'A path without a store any more is shown as missing. Open one read-only: laneboard view --board <prefix>.',
  options: {},
  args: { min: 0, max: 0 },
  async run(c) {
    const home = c.io.env.HOME;
    if (!home) throw new LaneboardError('USAGE', 'HOME is not set, so the board registry (~/.laneboard/boards.json) cannot be found', { fix: 'export HOME=<your home directory> and run laneboard boards again' });
    const r = await listBoards(home);
    return { ...r, human: boardsText(r.data) };
  },
};
