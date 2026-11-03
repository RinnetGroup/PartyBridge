import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, relative, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { patchedHash, sha256 } from './apply-werift-compat.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const skipped = new Set(['node_modules', 'dist', '.desktop-runtime', '.git', '.local', 'logs']);
const forbidden =
  /(?:^|\/)(?:token\.txt|session\.dat|\.env(?:\..*)?|auth|logs|\.local|\.research|ipa_analysis|apk_analysis|cli)(?:\/|$)|\.(?:ipa|apk|pcap|pcapng|jsonl|dmp|dat)$/i;
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function list(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error('Release source cannot contain links: ' + relative(root, path));
    if (entry.isDirectory()) files.push(...(await list(path)));
    else files.push(relative(root, path).split(sep).join('/'));
  }
  return files;
}
let files;
if (await exists(resolve(root, '.git'))) {
  files = execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  if (!files.length)
    throw new Error('Stage the reviewed source files before verifying this repository.');
  try {
    execFileSync('git', ['diff', '--quiet', '--'], { cwd: root, stdio: 'ignore' });
  } catch {
    throw new Error(
      'Stage or restore working source changes before verifying the release snapshot.',
    );
  }
} else files = await list(root);
for (const path of files) {
  if (forbidden.test(path) || skipped.has(path.split('/')[0]))
    throw new Error('Private or generated file is staged: ' + path);
  if (!/\.(?:js|mjs|cjs|json|md|txt|ya?ml|html|css|ps1|diff)$/.test(path)) continue;
  const content = await readFile(resolve(root, path), 'utf8');
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(content) ||
    /\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/.test(content)
  )
    throw new Error('Potential private credential in ' + path);
  if (/C:[\\/]Users[\\/]User[\\/]Desktop[\\/]/i.test(content))
    throw new Error('Local working path in ' + path);
}
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (pkg.license !== 'MIT' || !pkg.private)
  throw new Error('Release metadata must retain MIT licensing and npm publishing protection.');
const dependencies = Object.keys(pkg.dependencies).sort();
if (dependencies.join(',') !== 'opusscript,werift,ws')
  throw new Error('Review production dependency changes before releasing.');
if (sha256(await readFile(resolve(root, 'node_modules/werift/lib/index.mjs'))) !== patchedHash)
  throw new Error('The reviewed Sony compatibility changes are missing.');
console.log(`Verified ${files.length} source files; no excluded private files are staged.`);

const unpacked = resolve(root, 'dist/win-unpacked');
if (await exists(unpacked)) {
  const app = resolve(unpacked, 'resources/app');
  const allowed = new Set([
    'electron',
    'server',
    'protocol',
    'public',
    'node_modules',
    'package.json',
    'LICENSE',
    'THIRD-PARTY-NOTICES.txt',
  ]);
  for (const name of await readdir(app))
    if (!allowed.has(name)) throw new Error('Unexpected bundled application entry: ' + name);
  for (const dependency of [
    'electron',
    'electron-builder',
    'prettier',
    '@discordjs/opus',
    '@roamhq/wrtc',
    'speaker',
    'naudiodon2',
    'node-datachannel',
  ])
    if (await exists(resolve(app, 'node_modules', dependency)))
      throw new Error('Unexpected bundled dependency: ' + dependency);
  if (sha256(await readFile(resolve(app, 'node_modules/werift/lib/index.mjs'))) !== patchedHash)
    throw new Error('Packaged WebRTC compatibility check failed.');
  const nodeRoot = resolve(unpacked, 'resources/node');
  const runtime = JSON.parse(await readFile(resolve(nodeRoot, 'runtime.json'), 'utf8'));
  if (sha256(await readFile(resolve(nodeRoot, 'node.exe'))) !== runtime.sha256)
    throw new Error('Bundled Node runtime hash failed.');
  for (const path of ['LICENSE', '../scripts/voice-firewall.ps1'])
    if (!(await exists(resolve(nodeRoot, path))))
      throw new Error('Missing bundled resource: ' + path);
  const checksumFile = resolve(root, 'dist/SHA256SUMS.txt');
  if (await exists(checksumFile)) {
    const checksums = (await readFile(checksumFile, 'utf8')).trim().split(/\r?\n/);
    for (const line of checksums) {
      const match = /^([a-f0-9]{64})  (PartyBridge-[\w.-]+\.(?:exe|zip))$/.exec(line);
      if (!match || basename(match[2]) !== match[2])
        throw new Error('Invalid artifact checksum record.');
      if (sha256(await readFile(resolve(root, 'dist', match[2]))) !== match[1])
        throw new Error('Artifact checksum failed: ' + match[2]);
    }
    console.log(
      `Verified packaged application, bundled runtime and ${checksums.length} artifact checksums.`,
    );
  } else console.log('Verified unpacked application and bundled runtime.');
}
