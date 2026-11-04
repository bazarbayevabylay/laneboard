// Display rules of the web board that are not template: ages, dates, names, sizes, event lines (no DOM, unit-tested).
import { TEXT } from './text.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// How many tones the name monogram has (style.css .h0 … .h11).
export const AVATAR_TONES = 12;

// Time since `iso` like the CLI's view: <1m, 12m, 5h (up to 48 h), then days.
export function ageText(iso: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - new Date(iso).getTime());
  if (ms < MINUTE) return '<1m';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < 48 * HOUR) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

// Two digits.
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// Local time of day, HH:MM.
export function clockText(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Local time with seconds, HH:MM:SS (the "Updated" note).
export function clockSecondsText(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Calendar day of a date in local time, as a comparable number.
function dayNumber(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// "Today 17:24", "Yesterday 09:05", "Nov 3 14:00", "Nov 3, 2025 14:00" (local time).
export function dateTimeText(iso: string, now: Date): string {
  const d = new Date(iso);
  const days = Math.round((dayNumber(now) - dayNumber(d)) / DAY);
  const time = clockText(iso);
  if (days === 0) return `${TEXT.today} ${time}`;
  if (days === 1) return `${TEXT.yesterday} ${time}`;
  const year = d.getFullYear() === now.getFullYear() ? '' : `, ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()] ?? ''} ${d.getDate()}${year} ${time}`;
}

// The time column of the history: HH:MM today, else the short date.
export function eventTimeText(iso: string, now: Date): string {
  const d = new Date(iso);
  if (dayNumber(d) === dayNumber(now)) return clockText(iso);
  return `${MONTHS[d.getMonth()] ?? ''} ${d.getDate()}`;
}

// An agent name split for display: `claude-code@abylay:f92f65da` -> base `claude-code@abylay`, session `:f92f65da` (kept whole).
export function splitActor(name: string): { base: string; session: string } {
  const at = name.lastIndexOf(':');
  if (at <= 0) return { base: name, session: '' };
  return { base: name.slice(0, at), session: name.slice(at) };
}

// The monogram letter of a name: its first letter or digit after any `harness@` part, upper case.
export function avatarInitial(name: string): string {
  const base = splitActor(name).base;
  const person = base.includes('@') ? base.slice(base.indexOf('@') + 1) : base;
  const ch = /[A-Za-z0-9]/.exec(person)?.[0] ?? /[A-Za-z0-9]/.exec(name)?.[0] ?? '?';
  return ch.toUpperCase();
}

// A stable tone of a name (same name, same tone on every board and reload): class h0 … h11.
export function avatarTone(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return `h${hash % AVATAR_TONES}`;
}

// Bytes for people: 512 B, 12 KB, 3.4 MB.
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// A field value as text: strings as they are, anything else as JSON.
export function fieldText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export interface EventLine {
  // What happened (Created, Status, Handed in, Comment …).
  title: string;
  // A short detail next to it (in todo, todo → review, labels), or ''.
  detail: string;
  // A comment's text (shown as text, never as HTML), or null.
  body: string | null;
}

// One value of an event for people.
function shown(value: unknown): string {
  if (value === null || value === undefined) return TEXT.nobody;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// The history line of one event, from the event's own data (never from the task's current fields).
export function eventLine(type: string, data: Record<string, unknown>): EventLine {
  const line = (title: string, detail = '', body: string | null = null): EventLine => ({ title, detail, body });
  switch (type) {
    case 'created':
      return line(TEXT.eventCreated, typeof data.status === 'string' ? TEXT.inStatus(data.status) : '');
    case 'status': {
      const detail = TEXT.arrow(shown(data.from), shown(data.to));
      if (data.accepted === true) return line(TEXT.eventAccepted, detail);
      if (data.handed_in === true) return line(TEXT.eventHandedIn, detail);
      return line(TEXT.eventStatus, detail);
    }
    case 'assigned':
      return line(data.resumed === true ? TEXT.eventResumed : TEXT.eventAssigned, TEXT.arrow(shown(data.from), shown(data.to)));
    case 'commented':
      return line(TEXT.eventComment, '', typeof data.text === 'string' ? data.text : '');
    case 'updated':
      return line(TEXT.eventUpdated, TEXT.changed(Object.keys(data)));
    case 'attached':
      return line(TEXT.eventAttached, typeof data.name === 'string' ? data.name : '');
    case 'detached':
      return line(TEXT.eventDetached, typeof data.name === 'string' ? data.name : '');
    case 'archived':
      return line(TEXT.eventArchived);
    case 'restored':
      return line(TEXT.eventRestored);
    default:
      return line(TEXT.eventOther(type));
  }
}
