// Web board UI logic that is not template (ADR-0001 §31): address state, API queries, ages, dates, names, event lines.
import { describe, expect, it } from 'vitest';
import { ageText, avatarInitial, avatarTone, dateTimeText, eventLine, eventTimeText, fieldText, sizeText, splitActor } from '../../src/board/ui/format.ts';
import { boardQuery, eventsQuery, hasFilters, parseState, stateSearch, taskQuery, tasksQuery } from '../../src/board/ui/query.ts';
import { TEXT } from '../../src/board/ui/text.ts';

describe('page state in the address', () => {
  it('parses every key and falls back to the defaults', () => {
    expect(parseState('')).toEqual({ board: null, task: null, view: 'board', assignee: null, label: null, text: '', q: '' });
    expect(parseState('?board=WEB&task=WEB-3&view=archive&assignee=dev-1&label=ui&text=log+in&q=old')).toEqual({
      board: 'WEB',
      task: 'WEB-3',
      view: 'archive',
      assignee: 'dev-1',
      label: 'ui',
      text: 'log in',
      q: 'old',
    });
    expect(parseState('?view=other&board=&assignee=').view).toBe('board');
    expect(parseState('?board=&assignee=')).toMatchObject({ board: null, assignee: null });
  });

  it('writes only what differs from the defaults and round-trips', () => {
    const base = parseState('');
    expect(stateSearch(base)).toBe('');
    const s = { ...base, board: 'LB', task: 'LB-1', assignee: 'claude-code@ab:f92f65da', text: ' a&b ' };
    expect(stateSearch(s)).toBe('?board=LB&assignee=claude-code%40ab%3Af92f65da&text=a%26b&task=LB-1');
    expect(parseState(stateSearch(s))).toEqual({ ...s, text: 'a&b' });
    // The archive words belong to the archive view only.
    expect(stateSearch({ ...base, q: 'x' })).toBe('');
    expect(stateSearch({ ...base, view: 'archive', q: 'x' })).toBe('?view=archive&q=x');
  });
});

describe('API queries', () => {
  it('board filters go to the server as they are; empty ones are left out', () => {
    expect(boardQuery(null, { assignee: null, label: null, text: '' })).toBe('');
    expect(boardQuery('WEB', { assignee: 'dev-1', label: 'ui', text: '  login ' })).toBe('?board=WEB&assignee=dev-1&label=ui&text=login');
    expect(hasFilters({ assignee: null, label: null, text: '  ' })).toBe(false);
    expect(hasFilters({ assignee: null, label: 'ui', text: '' })).toBe(true);
  });

  it('task list, one task and the event stream', () => {
    expect(tasksQuery('LB', { status: 'done', assignee: 'a', label: null, text: '', limit: 50, offset: 5 })).toBe('?board=LB&status=done&assignee=a&limit=50&offset=5');
    expect(tasksQuery(null, { scope: 'archive', text: 'old one', limit: 50, offset: 0 })).toBe('?scope=archive&text=old+one&limit=50&offset=0');
    expect(taskQuery(null)).toBe('');
    expect(taskQuery('WEB')).toBe('?board=WEB');
    expect(eventsQuery('LB', 'ab12')).toBe('?board=LB&token=ab12');
  });
});

describe('display rules', () => {
  const now = new Date(2026, 10, 4, 12, 0, 0);
  const ago = (ms: number): string => ageText(new Date(now.getTime() - ms).toISOString(), now);

  it('age like the CLI view: <1m, minutes, hours up to 48, then days; never negative', () => {
    expect([ago(59_000), ago(60_000), ago(59 * 60_000), ago(3_600_000), ago(47 * 3_600_000), ago(48 * 3_600_000), ago(-5000)]).toEqual(['<1m', '1m', '59m', '1h', '47h', '2d', '<1m']);
  });

  it('dates in local time: today, yesterday, this year, another year', () => {
    const at = (y: number, m: number, d: number, h: number, min: number): string => new Date(y, m, d, h, min).toISOString();
    expect(dateTimeText(at(2026, 10, 4, 9, 5), now)).toBe('Today 09:05');
    expect(dateTimeText(at(2026, 10, 3, 23, 59), now)).toBe('Yesterday 23:59');
    expect(dateTimeText(at(2026, 9, 1, 14, 0), now)).toBe('Oct 1 14:00');
    expect(dateTimeText(at(2025, 11, 31, 8, 30), now)).toBe('Dec 31, 2025 08:30');
    expect(eventTimeText(at(2026, 10, 4, 17, 24), now)).toBe('17:24');
    expect(eventTimeText(at(2026, 10, 2, 17, 24), now)).toBe('Nov 2');
  });

  it('names: the session part stays whole, the monogram is the person, the tone is stable', () => {
    expect(splitActor('claude-code@abylay:f92f65da')).toEqual({ base: 'claude-code@abylay', session: ':f92f65da' });
    expect(splitActor('backend-developer')).toEqual({ base: 'backend-developer', session: '' });
    expect(avatarInitial('claude-code@abylay:f92f65da')).toBe('A');
    expect(avatarInitial('backend-developer')).toBe('B');
    expect(avatarInitial('1x')).toBe('1');
    expect(avatarTone('dev-1')).toBe(avatarTone('dev-1'));
    expect(avatarTone('dev-1')).toMatch(/^h([0-9]|1[01])$/);
    const tones = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(avatarTone));
    expect(tones.size).toBeGreaterThan(3);
  });

  it('sizes and field values', () => {
    expect([sizeText(0), sizeText(1023), sizeText(12 * 1024), sizeText(3.4 * 1024 * 1024)]).toEqual(['0 B', '1023 B', '12 KB', '3.4 MB']);
    expect([fieldText('P1'), fieldText(2), fieldText(['a', 'b']), fieldText({ k: true })]).toEqual(['P1', '2', '["a","b"]', '{"k":true}']);
  });

  it('event lines come from the event data: hand-in, acceptance, resume, comment text as text', () => {
    expect(eventLine('created', { title: 'T', status: 'todo', assignee: null })).toEqual({ title: 'Created', detail: 'in todo', body: null });
    expect(eventLine('status', { from: 'todo', to: 'review', handed_in: true })).toEqual({ title: 'Handed in', detail: 'todo → review', body: null });
    expect(eventLine('status', { from: 'review', to: 'done', accepted: true }).title).toBe('Accepted');
    expect(eventLine('status', { from: 'todo', to: 'in_progress' })).toEqual({ title: 'Status', detail: 'todo → in_progress', body: null });
    expect(eventLine('assigned', { from: null, to: 'dev-1' })).toEqual({ title: 'Assigned', detail: 'nobody → dev-1', body: null });
    expect(eventLine('assigned', { from: 'a:1', to: 'a:2', resumed: true }).title).toBe('Resumed');
    expect(eventLine('commented', { text: '<b>x</b>\nline 2' })).toEqual({ title: 'Comment', detail: '', body: '<b>x</b>\nline 2' });
    expect(eventLine('updated', { title: ['a', 'b'], labels: [[], ['x']] }).detail).toBe('title, labels');
    expect(eventLine('attached', { name: 'f.txt', size: 3 }).detail).toBe('f.txt');
    expect(eventLine('archived', {}).title).toBe('Archived');
    expect(eventLine('future_type', {}).title).toBe('future_type');
  });

  it('filter summary of the empty result names every filter set', () => {
    expect(TEXT.filterSummary('researcher', 'board', 'retry')).toBe('Assignee researcher, label board, text “retry”.');
    expect(TEXT.filterSummary(null, null, 'x')).toBe('Text “x”.');
  });
});
