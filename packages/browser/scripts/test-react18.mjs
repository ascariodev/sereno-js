import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'node_modules', '.react18');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const shell = process.platform === 'win32';

if (!existsSync(join(target, 'node_modules', 'react-dom'))) {
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'package.json'), '{"private":true}\n');
  execFileSync(npm, ['install', '--no-audit', '--no-fund', '--no-package-lock', 'react@18.3.1', 'react-dom@18.3.1'], {
    cwd: target,
    stdio: 'inherit',
    shell,
  });
}

writeFileSync(
  join(target, 'vitest.config.mjs'),
  `import { join } from 'node:path';
const modules = join(${JSON.stringify(target)}, 'node_modules');
export default {
  root: ${JSON.stringify(root)},
  resolve: {
    alias: [
      { find: /^react$/, replacement: join(modules, 'react') },
      { find: /^react[/](.*)$/, replacement: join(modules, 'react') + '/$1' },
      { find: /^react-dom$/, replacement: join(modules, 'react-dom') },
      { find: /^react-dom[/](.*)$/, replacement: join(modules, 'react-dom') + '/$1' },
    ],
  },
  test: { server: { deps: { inline: [/react18/] } } },
};
`,
);

const vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

execFileSync(process.execPath, [vitest, 'run', '--config', join(target, 'vitest.config.mjs'), 'test/react.test.tsx'], {
  cwd: root,
  stdio: 'inherit',
});
