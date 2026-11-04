// The web board's HTTP server (`laneboard board`, ADR-0001 §31): node:http on 127.0.0.1, GET only, serves the built Vue UI
// (dist/board) and the read-only API; nothing here writes a file or a store.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LaneboardError } from '../../core/index.ts';
import type { StoreRef } from '../../core/index.ts';
import { apiRoute, errorReply, eventStore } from './api.ts';
import type { ApiReply } from './api.ts';
import { streamChanges } from './sse.ts';
import type { StreamOptions } from './sse.ts';
import { hostAllowed, LOOPBACK, newToken, presentedToken, SECURITY_HEADERS, tokenMatches } from './security.ts';

export interface BoardServerOptions {
  // 0 = the OS picks a free port.
  port: number;
  // Home directory of the board registry (tabs of the other boards); absent = the current board only.
  home?: string;
  // The board the command was started for (its own board, or --board).
  current: StoreRef;
  // Folder of the built UI (index.html + assets/); default: dist/board of this package.
  uiDir?: string;
  stream?: StreamOptions;
}

export interface BoardServer {
  url: string;
  port: number;
  // The run's token (tests send it; the page reads it from its meta tag).
  token: string;
  server: http.Server;
  close(): Promise<void>;
}

interface Asset {
  type: string;
  body: Buffer;
}

// Names of files the server hands out from assets/ (Vite's hashed bundle names).
const ASSET_NAME_RE = /^[A-Za-z0-9._-]+$/;
const ASSET_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// The built UI: dist/board next to the compiled server (dist/board/server), or the repository's dist/board when run from src.
function defaultUiDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '..'), path.resolve(here, '../../../dist/board')];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ?? candidates[0] ?? here;
}

// index.html with the run's token in a meta tag, and every asset file read once at start (only listed files are ever served).
function loadUi(dir: string, token: string): { index: string; assets: Map<string, Asset> } {
  const indexFile = path.join(dir, 'index.html');
  if (!fs.existsSync(indexFile)) {
    throw new LaneboardError('INTERNAL', `the web board is not built: no ${indexFile}`, { fix: 'build it in the laneboard source folder: npm ci && npm run build' });
  }
  const html = fs.readFileSync(indexFile, 'utf8');
  const index = html.replace('</head>', `<meta name="laneboard-token" content="${token}">\n</head>`);
  const assets = new Map<string, Asset>();
  const assetDir = path.join(dir, 'assets');
  const names = fs.existsSync(assetDir) ? fs.readdirSync(assetDir) : [];
  for (const name of names) {
    const type = ASSET_TYPES[path.extname(name)];
    if (type && ASSET_NAME_RE.test(name)) assets.set(name, { type, body: fs.readFileSync(path.join(assetDir, name)) });
  }
  return { index, assets };
}

// Send a plain-text answer (403, 404, 405) with the security headers.
function sendText(res: http.ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(`${text}\n`);
}

// Send an API envelope.
function sendJson(res: http.ServerResponse, reply: ApiReply): void {
  res.writeHead(reply.status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(reply.body));
}

// Listen on the loopback address; a taken port is PORT_IN_USE whose fix lets the OS pick one.
function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === 'EADDRINUSE') {
        reject(new LaneboardError('PORT_IN_USE', `port ${port} on ${LOOPBACK} is already in use (another laneboard board or program)`, {
          edit: { drop: [{ name: 'port' }], add: [{ name: 'port', value: '0' }] },
        }));
      } else reject(err);
    };
    server.once('error', onError);
    server.listen(port, LOOPBACK, () => {
      server.off('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}

// Start the board server; resolves once it listens.
export async function startBoardServer(opts: BoardServerOptions): Promise<BoardServer> {
  const token = newToken();
  const ui = loadUi(opts.uiDir ?? defaultUiDir(), token);
  const ctx = { home: opts.home, current: { ...opts.current, readOnly: true } };
  // Aborted on close: ends every open event stream, so close() does not wait for browsers.
  const shutdown = new AbortController();
  let port = opts.port;

  // One request: Host, method and token checks first, then the route.
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!hostAllowed(req.headers.host, port)) return sendText(res, 403, 'Forbidden: this server answers only to 127.0.0.1 and localhost');
    if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed: the board is read-only', { Allow: 'GET' });
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}:${port}`);
    if (url.pathname === '/') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(ui.index);
      return;
    }
    if (url.pathname.startsWith('/assets/')) {
      const asset = ui.assets.get(url.pathname.slice('/assets/'.length));
      if (!asset) return sendText(res, 404, 'Not found');
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': asset.type, 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.end(asset.body);
      return;
    }
    if (!url.pathname.startsWith('/api/')) return sendText(res, 404, 'Not found');
    if (!tokenMatches(presentedToken(req, url), token)) return sendText(res, 403, 'Forbidden: missing or wrong board token (reload the page)');
    if (url.pathname === '/api/events') {
      let store: StoreRef;
      try {
        store = await eventStore(ctx, url);
      } catch (err) {
        // An unknown board answers like the other routes: an error envelope instead of a stream.
        return sendJson(res, errorReply(err));
      }
      return streamChanges(req, res, store, shutdown.signal, opts.stream);
    }
    const reply = await apiRoute(ctx, url);
    if (!reply) return sendText(res, 404, 'Not found');
    sendJson(res, reply);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      // A bug in a route must still answer (and never print a stack to the page).
      if (!res.headersSent) sendJson(res, errorReply(err));
      else res.end();
    });
  });
  port = await listen(server, opts.port);
  return {
    url: `http://${LOOPBACK}:${port}/`,
    port,
    token,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        shutdown.abort();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
