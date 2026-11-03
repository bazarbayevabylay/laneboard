// Marked text blocks owned by laneboard: Markdown `<!-- laneboard:start -->…<!-- laneboard:end -->`, TOML `# laneboard:start` … `# laneboard:end`.
import { LaneboardError } from '../core/index.ts';
import type { TextEdit } from './files.ts';

export interface Markers {
  start: string;
  end: string;
}

export const MD_MARKERS: Markers = { start: '<!-- laneboard:start -->', end: '<!-- laneboard:end -->' };

// Where our block is: [from, to) covering both markers, or undefined; a lone marker fails.
function findBlock(text: string, m: Markers, file: string, body: string): { from: number; to: number } | undefined {
  const from = text.indexOf(m.start);
  const end = text.indexOf(m.end);
  if (from < 0 && end < 0) return undefined;
  if (from < 0 || end < from || text.indexOf(m.start, from + 1) >= 0) {
    throw new LaneboardError('SETUP_UNPARSEABLE', `${file} has a broken laneboard block (markers missing, repeated or out of order); nothing was written`, {
      details: { file, snippet: `${m.start}\n${body}\n${m.end}` },
      fix: `delete the laneboard marker lines from ${file} and run setup again, or add the snippet (details.snippet) by hand`,
    });
  }
  return { from, to: end + m.end.length };
}

// What the text outside our block says about it: a clash that makes our block unsafe (SETUP_CONFLICT) or broken syntax (SETUP_UNPARSEABLE).
export type OutsideCheck = (outside: string) => { conflict: string; fix: string } | { unparseable: string } | undefined;

// What the text between our markers holds that is not ours (someone wrote into the block), or undefined.
// `firstLine` is the file line of the first line inside the block, so a report can name real line numbers.
export type InsideCheck = (inside: string, firstLine: number) => { conflict: string; fix: string } | undefined;

// Text edit for a marked block; `check` looks at the content outside the block before anything is written,
// `checkInside` at the content inside it before the block is replaced or removed (so nothing foreign is deleted with it).
export function blockEdit(file: string, m: Markers, body: string, check?: OutsideCheck, checkInside?: InsideCheck): TextEdit {
  const block = `${m.start}\n${body}\n${m.end}`;
  // Refuse to replace or remove a block that holds content that is not ours.
  const guardInside = (text: string, at: { from: number; to: number }): void => {
    const inside = text.slice(at.from + m.start.length, at.to - m.end.length);
    const firstLine = text.slice(0, at.from).split('\n').length + 1;
    const problem = checkInside?.(inside, firstLine);
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
