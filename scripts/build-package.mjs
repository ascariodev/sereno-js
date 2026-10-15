import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const run = (...args) => execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', ...args], { stdio: 'inherit' });

rmSync('dist', { recursive: true, force: true });

run('--outDir', 'dist/esm');
run('--outDir', 'dist/cjs', '--module', 'commonjs', '--moduleResolution', 'node10', '--verbatimModuleSyntax', 'false');

mkdirSync(join('dist', 'cjs'), { recursive: true });
writeFileSync(join('dist', 'cjs', 'package.json'), '{"type":"commonjs"}\n');
