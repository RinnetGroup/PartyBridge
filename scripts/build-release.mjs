import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { lstat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { prepareDesktop } from './prepare-desktop.mjs';
import { writeChecksums } from './release-artifacts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const realRoot = await realpath(root);
for (const name of ['dist', 'dist/win-unpacked']) {
  const target = resolve(root, name),
    remainder = relative(realRoot, target);
  if (remainder.startsWith('..') || isAbsolute(remainder))
    throw new Error('Build output is outside this release project.');
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error('Build output cannot be a link.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
await prepareDesktop();
const directoryOnly = process.argv.includes('--dir');
const args = [
  require.resolve('electron-builder/cli.js'),
  '--config',
  'electron-builder.yml',
  '--win',
  '--x64',
  '--publish',
  'never',
];
if (directoryOnly) args.push('--dir');
const child = spawn(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', resolve);
});
if (code !== 0) process.exit(code ?? 1);
if (!directoryOnly) await writeChecksums();
