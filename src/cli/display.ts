// Text for a person's terminal: task data and argv echoed in human output cannot control the terminal (clear the screen, hide text,
// set the window title, write the clipboard) or reorder what is shown (Trojan Source). JSON output keeps the data as it is.

// C0 controls except tab and newline, DEL, C1 controls (U+0080–U+009F), bidi embeddings and overrides (U+202A–U+202E) and bidi
// isolates (U+2066–U+2069); invisible characters that hide text from a person while an agent reads it (review S6c MINOR): Arabic
// letter mark (U+061C), zero width space (U+200B), LRM and RLM (U+200E, U+200F), line and paragraph separators (U+2028, U+2029),
// word joiner and invisible operators (U+2060–U+2064), a byte order mark past the first character (U+FEFF) and tag characters
// (U+E0000–U+E007F, ASCII smuggling). ZWNJ and ZWJ (U+200C, U+200D) stay: Persian and Indic words and emoji sequences need them.
const UNSAFE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;

// `text` with every unsafe character shown as `\u{XXXX}` (its code point in hex), so a person sees it instead of the terminal acting on it.
// A byte order mark as the first character is left as it is (a text read from a file may start with one).
export function safeText(text: string): string {
  return text.replace(UNSAFE, (ch, at: number) => (ch === '\uFEFF' && at === 0 ? ch : `\\u{${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}}`));
}

// A copy of `value` with every string in it (object keys too) passed through safeText: data made safe before it is laid out in columns.
export function safeData<T>(value: T): T {
  if (typeof value === 'string') return safeText(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => safeData(item)) as T;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [safeText(k), safeData(v)])) as T;
  return value;
}
