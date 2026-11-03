// laneboard archive
import { archiveTasks } from '../../core/index.ts';
import { flag, int, str } from './args.ts';
import type { CommandDef } from './types.ts';

export const archive: CommandDef = {
  name: 'archive',
  usage: 'archive <id>... [--expected-rev N]  |  archive --status S --updated-before <Nd> [--dry-run]',
  summary: 'Move tasks to archive.json (read-only there; restore brings them back).',
  options: { 'expected-rev': { type: 'string' }, status: { type: 'string' }, 'updated-before': { type: 'string' }, 'dry-run': { type: 'boolean' } },
  args: { min: 0, max: Infinity },
  async run(c) {
    const r = await archiveTasks(c.op(), {
      ids: c.positionals.length ? c.positionals : undefined,
      expected_rev: int(c.values, 'expected-rev'),
      status: str(c.values, 'status'),
      updated_before: str(c.values, 'updated-before'),
      dry_run: flag(c.values, 'dry-run') || undefined,
    });
    const { archived, dry_run } = r.data;
    const lines = archived.map((t) => (dry_run ? `would archive ${t.id} (rev ${t.rev})` : `${t.id} archived (rev ${t.rev})`));
    if (!archived.length) lines.push('no tasks matched');
    else if (dry_run) lines.push(`${archived.length} task(s) would be archived (dry run, nothing written)`);
    return { ...r, human: lines.join('\n') };
  },
};
