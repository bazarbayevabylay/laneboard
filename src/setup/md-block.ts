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

// Text edit for a marked block; `conflict` reports content outside the block that the block would clash with.
export function blockEdit(file: string, m: Markers, body: string, conflict?: (outside: string) => string | undefined): TextEdit {
  const block = `${m.start}\n${body}\n${m.end}`;
  return {
    add(text) {
      if (text === null || text.trim() === '') return `${block}\n`;
      const at = findBlock(text, m, file, body);
      const outside = at ? text.slice(0, at.from) + text.slice(at.to) : text;
      const clash = conflict?.(outside);
      if (clash) {
        throw new LaneboardError('SETUP_UNPARSEABLE', `${file} ${clash}, so laneboard cannot edit it safely; nothing was written`, {
          details: { file, snippet: block },
          fix: `remove that part from ${file} and run setup again, or keep it and skip setup for this file`,
        });
      }
      if (at) return text.slice(0, at.from) + block + text.slice(at.to);
      return `${text}${text.endsWith('\n') ? '' : '\n'}\n${block}\n`;
    },
    strip(text) {
      const at = findBlock(text, m, file, body);
      if (!at) return text;
      const before = text.slice(0, at.from);
      const after = text.slice(at.to).replace(/^\n/, '');
      // The block was appended after a blank line: drop that separator too.
      return after === '' ? before.replace(/\n\n$/, '\n') : before + after;
    },
    same(a, b) {
      return a.trimEnd() === b.trimEnd();
    },
    isEmpty(text) {
      return text.trim() === '';
    },
  };
}
