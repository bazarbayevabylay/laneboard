// laneboard boards
import { forgetBoard, LaneboardError, listBoards } from '../../core/index.ts';
import { boardsText } from '../board-view.ts';
import { str } from './args.ts';
import type { CommandDef } from './types.ts';

export const boards: CommandDef = {
  name: 'boards',
  usage: 'boards [--forget <prefix|name|path>]',
  summary:
    'List the boards on this machine (~/.laneboard/boards.json, filled by init and setup): prefix, name, active tasks per status, last change, path and description. ' +
    'A path without a store any more is shown as missing; --forget drops such an entry (an entry whose path holds a store is kept). ' +
    'Open one read-only: laneboard view --board <prefix>.',
  options: { forget: { type: 'string' } },
  args: { min: 0, max: 0 },
  async run(c) {
    const home = c.io.env.HOME;
    if (!home) throw new LaneboardError('USAGE', 'HOME is not set, so the board registry (~/.laneboard/boards.json) cannot be found', {
        fix: 'export HOME=<your home directory> and run laneboard boards again',
        edit: { env: 'HOME=<your home directory>' },
      });
    const forget = str(c.values, 'forget');
    if (forget !== undefined) {
      const f = await forgetBoard(home, forget, c.io.cwd, { lockWaitMs: c.io.lockWaitMs });
      return { ...f, human: f.data.forgotten.map((b) => `forgot ${b.path} (${b.prefix}${b.name ? ` ${b.name}` : ''}): no store there`).join('\n') };
    }
    const r = await listBoards(home);
    return { ...r, human: boardsText(r.data) };
  },
};
