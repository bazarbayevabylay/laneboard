// laneboard board: the board in the browser for people (read-only, live), served on 127.0.0.1 until Ctrl+C (ADR-0001 §31).
import { LaneboardError, loadConfig, storePrefix } from '../../core/index.ts';
import { notBuiltText, startBoardServer } from '../../board/server/http.ts';
import { okEnvelope, warningText } from '../format.ts';
import { str } from './args.ts';
import type { CommandDef } from './types.ts';

// --port as a port number 0..65535 (0: the system picks a free one); absent -> undefined (config board.port).
function portOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65535) {
    throw new LaneboardError('INVALID_VALUE', `--port ${value} is not a port number (0-65535)`, {
      input: { field: 'port', value, suggestion: '0' },
      edit: { drop: [{ name: 'port' }], add: [{ name: 'port', value: '0' }] },
    });
  }
  return port;
}

// Resolves when the signal is aborted (Ctrl+C); never without a signal.
function untilAborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

export const board: CommandDef = {
  name: 'board',
  usage: 'board [--port N] [--board <prefix|name|path>]',
  summary:
    'Show the board in the browser, read-only and live: prints http://127.0.0.1:<port>/ (--json: {url, port}) and serves it until Ctrl+C. ' +
    'Port: --port N, else config board.port; --port 0 lets the system pick a free one. ' +
    'Tabs: this board (or --board) first, then the other boards of this machine (laneboard boards).',
  options: { port: { type: 'string' } },
  args: { min: 0, max: 0 },
  readOnly: true,
  async run(c) {
    const port = portOption(str(c.values, 'port'));
    const ctx = c.op();
    const server = await startBoardServer({ port: port ?? loadConfig(ctx.store.dir).board.port, home: c.io.env.HOME || undefined, current: ctx.store });
    // A source checkout before `npm run build`: the server runs (API, events), the page says how to build the UI.
    const warnings = server.uiBuilt ? [] : [notBuiltText(server.uiDir)];
    // --json: one document with the address (scripts read it), then the server keeps running like without it.
    if (c.values.json === true) c.io.stdout(okEnvelope(ctx.store.dir, storePrefix(ctx.store.dir), { url: server.url, port: server.port }, warnings));
    else {
      c.io.stdout(`${server.url}\nlaneboard board: read-only, updates live; Ctrl+C stops it.\n`);
      if (warnings.length) c.io.stderr(warningText(warnings));
    }
    await untilAborted(c.io.signal);
    await server.close();
    return { data: null, warnings: [], human: '', silent: true };
  },
};
