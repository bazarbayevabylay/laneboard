// Write plugins/claude-code/skills/laneboard/SKILL.md from src/core/agent-rules.md; `--check` only compares (exit 1 on a difference).
import fs from 'node:fs';
import path from 'node:path';
import { skillMarkdown } from '../src/core/index.ts';

const target = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'plugins', 'claude-code', 'skills', 'laneboard', 'SKILL.md');
const want = skillMarkdown();
if (process.argv.includes('--check')) {
  const have = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (have !== want) {
    console.error(`${path.relative(process.cwd(), target)} is out of date: run npm run gen:skill`);
    process.exit(1);
  }
  console.log('SKILL.md matches src/core/agent-rules.md');
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, want);
  console.log(`wrote ${path.relative(process.cwd(), target)}`);
}
