import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url),
  root = fileURLToPath(new URL('../', import.meta.url));
const child = spawn(require('electron'), [root, ...process.argv.slice(2)], {
  cwd: root,
  env: { ...process.env, PARTYBRIDGE_NODE_BIN: process.execPath },
  windowsHide: false,
  stdio: 'ignore',
  detached: true,
});
child.once('error', () => {
  console.error('PartyBridge could not open. Run npm ci and try again.');
  process.exitCode = 1;
});
child.unref();
