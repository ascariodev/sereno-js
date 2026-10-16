#!/usr/bin/env node
import { runCli } from './connection.js';

const write = (stream: NodeJS.WriteStream) => (text: string) => void stream.write(text);

runCli(process.argv.slice(2), { env: process.env, out: write(process.stdout), err: write(process.stderr) }).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`Failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
