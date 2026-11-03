// Generate schema/*.json from the zod schemas; with --check, fail when the committed files differ (C8).
import fs from 'node:fs';
import path from 'node:path';
import { jsonSchemas } from '../src/core/schema.ts';

const args = process.argv.slice(2);
const check = args.includes('--check');
const dirArg = args.indexOf('--dir');
// --dir <path> checks another directory (used by the C8 red test).
const dir = dirArg >= 0 && args[dirArg + 1] ? path.resolve(args[dirArg + 1] ?? '') : path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'schema');
let stale = 0;
for (const [name, schema] of Object.entries(jsonSchemas())) {
  const file = path.join(dir, name);
  const want = `${JSON.stringify(schema, null, 2)}\n`;
  const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  if (have === want) continue;
  if (check) {
    console.error(`schema/${name} is ${have === undefined ? 'missing' : 'out of date'}; run npm run gen:schema and commit it`);
    stale++;
  } else {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, want);
    console.log(`wrote schema/${name}`);
  }
}
if (check && stale === 0) console.log('schema/ matches the zod schemas');
process.exitCode = stale ? 1 : 0;
