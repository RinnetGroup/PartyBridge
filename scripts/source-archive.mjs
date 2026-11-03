import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { writeChecksums } from './release-artifacts.mjs';

// Archive exactly the reviewed Git index, never the working folder or .git data.
await import('./verify-release.mjs');
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) throw new Error('Invalid release version.');
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
const tree = execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim();
const filename = `dist/PartyBridge-${pkg.version}-source.zip`;
execFileSync('git', ['archive', '--format=zip', '--prefix=PartyBridge/', '-o', filename, tree], {
  cwd: root,
});
console.log('Created ' + filename + ' from reviewed source tree ' + tree);
await writeChecksums();
