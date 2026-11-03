import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { applyWeriftCompatibility } from './apply-werift-compat.mjs';

await applyWeriftCompatibility();
console.log('Sony WebRTC compatibility verified.');
const require = createRequire(import.meta.url);
let installer;
try {
  installer = require.resolve('electron/install.js');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
// Electron 45 exposes an explicit installer rather than a dependency lifecycle
// script. Production-only helper installs do not need its development binary.
if (installer) {
  const child = spawn(process.execPath, [installer], { stdio: 'inherit', windowsHide: true });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) process.exit(code ?? 1);
}
