#!/usr/bin/env node
// laneboard CLI entry point (bin): wires the real process into runCli.
import fs from 'node:fs';
import { runCli } from './run.ts';

// Ctrl+C ends `view --watch` cleanly (exit 0); the handler is installed only when a command asks for the signal,
// so Ctrl+C still stops every other command the usual way.
let interrupt: AbortController | undefined;

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  readStdin: () => fs.readFileSync(0, 'utf8'),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  columns: process.stdout.isTTY ? process.stdout.columns : undefined,
  isTTY: process.stdout.isTTY === true,
  get signal() {
    if (!interrupt) {
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      interrupt = controller;
    }
    return interrupt.signal;
  },
});
