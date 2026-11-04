// Protection of the local board server (ADR-0001 §8, §31): loopback only, Host check against DNS rebinding,
// a per-run token on every /api call, strict headers on every response. No CORS headers at all.
import crypto from 'node:crypto';
import type http from 'node:http';

// The only address the server binds to (constant, not configurable).
export const LOOPBACK = '127.0.0.1';

// Header that carries the token on /api calls (EventSource cannot set headers: /api/events takes ?token=).
export const TOKEN_HEADER = 'x-laneboard-token';

// Headers on every response: the page may load only its own files, never be framed, never send a Referer.
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// A fresh 256-bit token for one server run.
export function newToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// Host header names this server itself (127.0.0.1:<port> or localhost:<port>); anything else is a rebinding attempt.
export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `${LOOPBACK}:${port}` || host === `localhost:${port}`;
}

// Constant-time comparison of a presented token with the run's token.
export function tokenMatches(given: string | undefined, token: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The token a request presents: the header for /api calls, the query parameter for the event stream.
export function presentedToken(req: http.IncomingMessage, url: URL): string | undefined {
  if (url.pathname === '/api/events') return url.searchParams.get('token') ?? undefined;
  const header = req.headers[TOKEN_HEADER];
  return typeof header === 'string' ? header : undefined;
}
