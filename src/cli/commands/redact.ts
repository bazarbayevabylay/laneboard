// laneboard redact
import { REDACTED, redactTask } from '../../core/index.ts';
import { readTextFile, str } from './args.ts';
import type { CommandDef } from './types.ts';

export const redact: CommandDef = {
  name: 'redact',
  usage: 'redact <id> --text-file P|-',
  summary: 'Remove a text (a secret pasted by mistake) from a task and from the store backups.',
  options: { 'text-file': { type: 'string' } },
  args: { min: 1, max: 1 },
  flags: { text: '--text-file' },
  async run(c) {
    // The text comes from a file or stdin, never from argv: a secret on the command line stays in the shell history.
    const file = str(c.values, 'text-file');
    // A file usually ends with a newline that is not part of the text (`echo secret > f`).
    const text = file === undefined ? undefined : readTextFile(c.io, file, 'text-file').replace(/\r?\n$/, '');
    const r = await redactTask(c.op(), { id: c.positionals[0] ?? '', text: text as string });
    const times = r.data.redacted === 1 ? '1 occurrence' : `${r.data.redacted} occurrences`;
    const backups = r.data.backups > 0 ? `, ${r.data.backups} removed from the store backups` : '';
    return { ...r, human: `${r.data.id} redacted: ${times} replaced with ${REDACTED}${backups} (rev ${r.data.rev})` };
  },
};
