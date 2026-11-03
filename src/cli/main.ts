#!/usr/bin/env node
// laneboard CLI entry point (bin): wires the real process into runCli.
import fs from 'node:fs';
import { runCli } from './run.ts';

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  readStdin: () => fs.readFileSync(0, 'utf8'),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
