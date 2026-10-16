import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const build = fileURLToPath(new URL('../../../scripts/build-package.mjs', import.meta.url));

export default function setup(): void {
  for (const directory of ['../../core', '..']) {
    execFileSync(process.execPath, [build], { cwd: fileURLToPath(new URL(directory, import.meta.url)), stdio: 'inherit' });
  }
}
