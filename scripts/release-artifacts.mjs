import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export const outputDirectory = new URL('../dist/', import.meta.url);
export async function writeChecksums() {
  const files = (await readdir(outputDirectory))
    .filter((name) =>
      /^PartyBridge-(?:Setup-)?\d+\.\d+\.\d+(?:-[\w.-]+)?-(?:x64|source)\.(exe|zip)$/.test(name),
    )
    .sort();
  if (!files.length) throw new Error('No release installers or ZIPs were built.');
  const lines = [];
  for (const name of files)
    lines.push(
      `${createHash('sha256')
        .update(await readFile(new URL(name, outputDirectory)))
        .digest('hex')}  ${name}`,
    );
  await writeFile(new URL('SHA256SUMS.txt', outputDirectory), lines.join('\n') + '\n');
}
