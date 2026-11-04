// Protection of the local board server (ADR-0001 §8, §31): loopback only, Host check against DNS rebinding,
// a per-run token on every /api call, strict headers on every response. No CORS headers at all.
import crypto from 'node:crypto';
import type http from 'node:http';

// The only address the server binds to (constant, not configurable).
export const LOOPBACK = '127.0.0.1';

// Header that carries the token on /api calls (EventSource, <img> and download links cannot set headers: the event stream and
// the attachment files take ?token=).
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

// Routes that take the token as ?token= (no way to set a header): the event stream and attachment files.
const QUERY_TOKEN_RE = /^\/api\/(events|tasks\/[^/]+\/attachments\/[^/]+)$/;

// The token a request presents: the header for /api calls, the query parameter for the event stream and attachment files.
export function presentedToken(req: http.IncomingMessage, url: URL): string | undefined {
  if (QUERY_TOKEN_RE.test(url.pathname)) return url.searchParams.get('token') ?? undefined;
  const header = req.headers[TOKEN_HEADER];
  return typeof header === 'string' ? header : undefined;
}

// A raw request path with a `.` or `..` segment (also %2e-escaped): URL parsing would quietly resolve it into another route, so the
// server answers 404 instead of guessing (no traversal, ever). Segments end at `/` and at `\` (the WHATWG URL parser treats a
// backslash as a slash in http URLs), and at its escape %5C too, so `x\..\..\board` cannot reach another route either.
export function hasDotSegment(rawUrl: string): boolean {
  const pathPart = rawUrl.split('?')[0] ?? '';
  return pathPart.split(/\/|\\|%5c/i).some((seg) => /^(\.|%2e){1,2}$/i.test(seg));
}
