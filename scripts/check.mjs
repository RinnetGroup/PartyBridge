import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
let count = 0;
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) await check(path);
    else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', fileURLToPath(path)], {
        stdio: 'inherit',
      });
      if (result.status !== 0) process.exit(result.status ?? 1);
      count++;
    }
  }
}
for (const directory of ['server', 'protocol', 'public', 'electron'])
  await check(new URL('../' + directory + '/', import.meta.url));
console.log(`Checked ${count} JavaScript modules.`);
