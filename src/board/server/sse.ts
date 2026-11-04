// Live updates of the web board: Server-Sent Events, one `change` event per store change ({"rev":N}), a ping comment every 15 s.
import type http from 'node:http';
import { watchStore } from '../../core/index.ts';
import type { StoreRef } from '../../core/index.ts';
import { SECURITY_HEADERS } from './security.ts';

// Keeps proxies and the browser from dropping a quiet stream.
export const PING_MS = 15_000;

export interface StreamOptions {
  // Store poll interval (default: the core watcher's 2 s); tests shorten it.
  pollMs?: number;
  // false = poll only (tests).
  events?: boolean;
  pingMs?: number;
}

// Stream changes of `store` to one browser connection until it closes or `stop` is aborted (server shutdown).
export function streamChanges(req: http.IncomingMessage, res: http.ServerResponse, store: StoreRef, stop: AbortSignal, opts: StreamOptions = {}): void {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  // The first bytes open the stream on the client at once.
  res.write(': connected\n\n');
  const done = new AbortController();
  const ping = setInterval(() => res.write(': ping\n\n'), opts.pingMs ?? PING_MS);
  const end = (): void => {
    if (done.signal.aborted) return;
    clearInterval(ping);
    done.abort();
    res.end();
  };
  req.on('close', end);
  // Unsubscribed when this stream ends (signal: done), so closed streams leave no listener on the server's shutdown signal.
  stop.addEventListener('abort', end, { once: true, signal: done.signal });
  void watchStore(
    store.dir,
    ({ rev }) => {
      if (!done.signal.aborted) res.write(`event: change\ndata: ${JSON.stringify({ rev })}\n\n`);
    },
    { signal: done.signal, pollMs: opts.pollMs, events: opts.events },
  );
}
