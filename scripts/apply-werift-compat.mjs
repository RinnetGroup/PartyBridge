// These three changes were required by the working Sony transport. Keep them
// reproducible after npm ci instead of relying on an edited node_modules folder.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const originalHash = '0848cdde8e5507cf9fe0de6e66e5bd1c4f7e5b0e8c0dae582fcdc29b9dcec62e';
export const patchedHash = '66c747a1c98c8a50e9f63b4e29654c512b8c7451a41d910cf3f28057db086801';
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const file = new URL('../node_modules/werift/lib/index.mjs', import.meta.url);
const packageFile = new URL('../node_modules/werift/package.json', import.meta.url);

export async function applyWeriftCompatibility() {
  const pkg = JSON.parse(await readFile(packageFile, 'utf8'));
  if (pkg.version !== '0.25.2')
    throw new Error('Review the Sony compatibility patch before changing werift versions.');
  let source = await readFile(file, 'utf8');
  const digest = sha256(source);
  if (digest === patchedHash) return;
  if (digest !== originalHash)
    throw new Error('Unexpected werift bundle; compatibility patch was not applied.');
  const changes = [
    [
      '  [8, "MESSAGE-INTEGRITY", packBytes, unpackBytes],',
      '  [8, "MESSAGE-INTEGRITY", packBytes, unpackBytes],\n  [49239, "GOOG-NETWORK-INFO", packBytes, unpackBytes],',
    ],
    [
      'request.setAttribute("USERNAME", txUsername).setAttribute(',
      'request.setAttribute("USERNAME", txUsername).setAttribute("GOOG-NETWORK-INFO", Buffer.from([0, 1, 0, 0])).setAttribute(',
    ],
    [
      '    return this.dtlsTransport.iceTransport.role !== "controlling";',
      "    // RFC 8841: the DTLS CLIENT sends the SCTP INIT (is the SCTP client). werift's\n" +
        '    // original logic keyed this off the ICE controlling role, which deadlocks when\n' +
        "    // we're ICE-controlled but DTLS-client (answerer to a=setup:actpass). Use the\n" +
        '    // DTLS role instead, matching libwebrtc.\n' +
        '    return this.dtlsTransport.role === "server";',
    ],
  ];
  for (const [before, after] of changes) {
    if (source.split(before).length !== 2)
      throw new Error('Werift compatibility target is not unique.');
    source = source.replace(before, after);
  }
  if (sha256(source) !== patchedHash)
    throw new Error('Werift compatibility result did not match the reviewed bundle.');
  await writeFile(file, source);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await applyWeriftCompatibility();
  console.log('Sony WebRTC compatibility verified.');
}
