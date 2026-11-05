// Marked text blocks owned by laneboard: Markdown `<!-- laneboard:start -->…<!-- laneboard:end -->`, TOML `# laneboard:start` … `# laneboard:end`.
import { LaneboardError } from '../core/index.ts';
import type { TextEdit } from './files.ts';
import { instructionLines } from './harnesses/common.ts';
import type { StorePin } from './harnesses/common.ts';

export interface Markers {
  start: string;
  end: string;
}

export const MD_MARKERS: Markers = { start: '<!-- laneboard:start -->', end: '<!-- laneboard:end -->' };

// Lines that are exactly `marker` (trailing spaces or a \r allowed), as [from, to) offsets: a marker quoted inside other text
// (`<!-- laneboard:end -->` in a sentence, an indented example) is not one.
function markerLines(text: string, marker: string): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  let from = 0;
  for (const line of text.split('\n')) {
    if (line.trimEnd() === marker) out.push({ from, to: from + line.length });
    from += line.length + 1;
  }
  return out;
}

// Where our block is: [from, to) covering both marker lines and `endFrom` (start of the end marker line), or undefined; a lone,
// repeated or misplaced marker line fails.
function findBlock(text: string, m: Markers, file: string, body: string): { from: number; to: number; endFrom: number } | undefined {
  const starts = markerLines(text, m.start);
  const end = markerLines(text, m.end)[0];
  const start = starts[0];
  if (start === undefined && end === undefined) return undefined;
  if (start === undefined || end === undefined || end.from < start.from || starts.length > 1) {
    throw new LaneboardError('SETUP_UNPARSEABLE', `${file} has a broken laneboard block (markers missing, repeated or out of order); nothing was written`, {
      details: { file, snippet: `${m.start}\n${body}\n${m.end}` },
      fix: `delete the laneboard marker lines from ${file} (a marker quoted as an example stops counting when it is indented or has other text on its line) and run setup again, or add the snippet (details.snippet) by hand`,
    });
  }
  return { from: start.from, to: end.to, endFrom: end.from };
}

// What the text outside our block says about it: a clash that makes our block unsafe (SETUP_CONFLICT) or broken syntax (SETUP_UNPARSEABLE).
export type OutsideCheck = (outside: string) => { conflict: string; fix: string } | { unparseable: string } | undefined;

// What the text between our markers holds that is not ours (someone wrote into the block), or undefined.
// `firstLine` is the file line of the first line inside the block, so a report can name real line numbers.
export type InsideCheck = (inside: string, firstLine: number) => { conflict: string; fix: string } | undefined;

// Placeholder for the store path in the instruction line templates (plain characters, so shellQuote leaves it as it is).
const STORE_SLOT = 'LANEBOARDSTOREPATHSLOT';
// Every way the instruction block names the store (Record: a new pin cannot be left out).
const PINS = Object.keys({ 'settings-local-env': true, 'settings-root-local-env': true, 'settings-env': true, inline: true } satisfies Record<StorePin, true>) as StorePin[];
// Lines earlier versions wrote that instructionLines no longer gives (the 0.1.0 builds, commits 6f81877..4e19d07, before 0.2.0; the
// inline store line up to 0.4.0 before S6v): a block holding them is still laneboard's and is updated (test/setup/fixtures/blocks/).
const EARLIER_LINES = [
  'This project tracks tasks with laneboard (task board & CLI for AI coding agents; the store is .laneboard/).',
  'Before you work on tasks, run `laneboard prime` and follow the rules it prints.',
  'Writes need your name: `export LANEBOARD_AGENT=<your-name>` or pass `--as <your-name>`.',
  'MANDATORY for every request, even when nobody mentions tasks and the board is empty: before your first file change, run `laneboard prime` and claim your task or create one (prime prints the command); comment each meaningful step; when done, set the final status and add a result comment. No untracked work.',
  // The inline store line of 0.1.0 to 0.4.0 before S6v: its "export ... once" sent other projects' writes to this board (UX run 3 C-U3).
  `This project tracks work with laneboard (task board & CLI for AI coding agents). Its store is ${STORE_SLOT}: run every laneboard command with it, \`LANEBOARD_DIR=${STORE_SLOT} laneboard <command>\` (or export LANEBOARD_DIR=${STORE_SLOT} once).`,
];
// Instruction lines laneboard writes, with any store path: an earlier setup pinned another store or another file, plus the lines
// of earlier versions (EARLIER_LINES).
const INSTRUCTION_LINES = [...PINS.flatMap((pin) => instructionLines(STORE_SLOT, pin).split('\n')), ...EARLIER_LINES].map(templateRegExp);

// A whole-line pattern for a template line: its text literally, any non-empty text in place of each STORE_SLOT.
function templateRegExp(line: string): RegExp {
  const literal = (part: string): string => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${line.split(STORE_SLOT).map(literal).join('.+')}$`);
}

// Default inside check of a block without its own: each non-blank line inside is one laneboard writes (this run's body or an
// instruction line with any store), else SETUP_CONFLICT with the line numbers, so a user's text between the markers is never deleted.
function onlyOurLines(file: string, m: Markers, body: string): InsideCheck {
  const bodyLines = new Set(body.split('\n'));
  const ours = (line: string): boolean => bodyLines.has(line) || INSTRUCTION_LINES.some((re) => re.test(line));
  return (inside, firstLine) => {
    // inside starts with the rest of the start marker line (index 0 is that line), so index i is file line firstLine + i - 1.
    const foreign = inside
      .split('\n')
      .map((line, i) => ({ line: line.trimEnd(), at: firstLine + i - 1 }))
      .filter((l, i) => i > 0 && l.line !== '' && !ours(l.line))
      .map((l) => l.at);
    if (foreign.length === 0) return undefined;
    const lines = `line${foreign.length > 1 ? 's' : ''} ${foreign.slice(0, 10).join(', ')}${foreign.length > 10 ? ` and ${foreign.length - 10} more` : ''}`;
    return {
      conflict: `has text laneboard did not write inside its block (${lines})`,
      fix: `move ${lines} of ${file} out of the block between "${m.start}" and "${m.end}" (or delete the marker lines if that text is yours), then run setup again`,
    };
  };
}

// Text edit for a marked block; `check` looks at the content outside the block before anything is written,
// `checkInside` at the content inside it before the block is replaced or removed (so nothing foreign is deleted with it;
// default: only lines laneboard writes may be there).
export function blockEdit(file: string, m: Markers, body: string, check?: OutsideCheck, checkInside?: InsideCheck): TextEdit {
  const block = `${m.start}\n${body}\n${m.end}`;
  const inspectInside = checkInside ?? onlyOurLines(file, m, body);
  // Refuse to replace or remove a block that holds content that is not ours.
  const guardInside = (text: string, at: { from: number; endFrom: number }): void => {
    const inside = text.slice(at.from + m.start.length, at.endFrom);
    const firstLine = text.slice(0, at.from).split('\n').length + 1;
    const problem = inspectInside(inside, firstLine);
    if (problem) {
      throw new LaneboardError('SETUP_CONFLICT', `${file} ${problem.conflict}; nothing was written`, {
        details: { file, snippet: block },
        fix: problem.fix,
      });
    }
  };
  return {
    add(text) {
      if (text === null || text.trim() === '') return `${block}\n`;
      const at = findBlock(text, m, file, body);
      // Our block becomes blank lines, so line numbers in a problem report match the file.
      const outside = at ? text.slice(0, at.from) + '\n'.repeat(text.slice(at.from, at.to).split('\n').length - 1) + text.slice(at.to) : text;
      const problem = check?.(outside);
      if (problem && 'conflict' in problem) {
        throw new LaneboardError('SETUP_CONFLICT', `${file} ${problem.conflict}, so the laneboard block would clash with it; nothing was written`, {
          details: { file, snippet: block },
          fix: problem.fix,
        });
      }
      if (problem) {
        throw new LaneboardError('SETUP_UNPARSEABLE', `${file} ${problem.unparseable}; nothing was written`, {
          details: { file, snippet: block },
          fix: `fix ${file} and run setup again, or add the snippet (details.snippet) by hand`,
        });
      }
      if (at) {
        guardInside(text, at);
        return text.slice(0, at.from) + block + text.slice(at.to);
      }
      return `${text}${text.endsWith('\n') ? '' : '\n'}\n${block}\n`;
    },
    strip(text) {
      const at = findBlock(text, m, file, body);
      if (!at) return text;
      guardInside(text, at);
      const before = text.slice(0, at.from);
      const after = text.slice(at.to).replace(/^\n/, '');
      // The block was appended after a blank line: drop that separator too (also when text was added after the block later).
      if (after === '') return before.replace(/\n\n$/, '\n');
      return (before === '' || before.endsWith('\n\n')) && after.startsWith('\n') ? before + after.slice(1) : before + after;
    },
    owns(text) {
      return findBlock(text, m, file, body) !== undefined;
    },
    same(a, b) {
      return a.trimEnd() === b.trimEnd();
    },
    isEmpty(text) {
      return text.trim() === '';
    },
  };
}
