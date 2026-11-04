// HTTP client of the web board: GET only, the run's token in a header, the CLI envelope unwrapped; errors carry a text for people.
import { TEXT } from './text.ts';

const TOKEN_META = 'meta[name="laneboard-token"]';

// Why a call failed: the server did not answer (stopped, network) or it answered with an error envelope.
export class ApiError extends Error {
  readonly kind: 'network' | 'server';

  // `message` is shown to people as it is.
  constructor(kind: 'network' | 'server', message: string) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
  }
}

// The run's token, from the meta tag the server put into index.html.
export function boardToken(): string {
  return document.querySelector(TOKEN_META)?.getAttribute('content') ?? '';
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; fix: string };
}

// The `data` of a successful envelope from GET `path`; anything else throws ApiError.
export async function apiGet<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { 'X-Laneboard-Token': boardToken(), Accept: 'application/json' }, cache: 'no-store' });
  } catch {
    // fetch rejects only when no answer came (server stopped, connection refused).
    throw new ApiError('network', TEXT.serverGone);
  }
  let body: Envelope<T>;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    // Not JSON (a 403 or 404 page): the board itself is out of step with this page.
    throw new ApiError('server', TEXT.boardError);
  }
  if (body.ok && body.data !== undefined) return body.data;
  // The core's message is written for people (the same text the CLI prints).
  throw new ApiError('server', body.error?.message ?? TEXT.boardError);
}

// Text for people from anything a call threw.
export function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : TEXT.boardError;
}
