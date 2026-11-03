import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';
import { applyWeriftCompatibility } from './apply-werift-compat.mjs';

export async function prepareDesktop() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('Build the Windows x64 release on Windows x64.');
  await applyWeriftCompatibility();
  const root = new URL('../', import.meta.url),
    assets = new URL('electron/assets/', root),
    runtime = new URL('.desktop-runtime/node/', root);
  await mkdir(assets, { recursive: true });
  await mkdir(runtime, { recursive: true });
  const icon = await readFile(new URL('public/icon.svg', root), 'utf8');
  const png = new Resvg(icon, { fitTo: { mode: 'width', value: 256 } }).render().asPng();
  await writeFile(new URL('app.png', assets), png);
  await writeFile(
    new URL('tray.png', assets),
    new Resvg(icon, { fitTo: { mode: 'width', value: 32 } }).render().asPng(),
  );
  const ico = Buffer.alloc(22);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico.writeUInt16LE(1, 10);
  ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(png.length, 14);
  ico.writeUInt32LE(22, 18);
  await writeFile(new URL('app.ico', assets), Buffer.concat([ico, png]));
  await copyFile(process.execPath, new URL('node.exe', runtime));
  const response = await fetch(
    `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,
    { signal: AbortSignal.timeout(30000) },
  );
  if (!response.ok) throw new Error('Could not download the bundled Node runtime license.');
  await writeFile(new URL('LICENSE', runtime), await response.text());
  await writeFile(
    new URL('runtime.json', runtime),
    JSON.stringify(
      {
        node: process.version,
        sha256: createHash('sha256')
          .update(await readFile(process.execPath))
          .digest('hex'),
      },
      null,
      2,
    ) + '\n',
  );
}
