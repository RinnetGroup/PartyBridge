import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { RTCPeerConnection } from 'werift';
import { applyWeriftCompatibility, patchedHash, sha256 } from '../scripts/apply-werift-compat.mjs';
const require = createRequire(import.meta.url);
const { parseMessage } = require('../node_modules/werift/lib/ice-server/src/stun/message.js');

test('a fresh dependency install contains the reviewed compatibility bundle and setup is idempotent', async () => {
  await applyWeriftCompatibility();
  await applyWeriftCompatibility();
  assert.equal(
    sha256(await readFile(new URL('../node_modules/werift/lib/index.mjs', import.meta.url))),
    patchedHash,
  );
});

test('Sony ICE attribute is serialized before integrity and fingerprint, with a valid authenticated STUN packet', async () => {
  const pc = new RTCPeerConnection({ iceServers: [] });
  try {
    pc.addTransceiver('audio');
    const connection = pc.iceTransports[0].connection;
    const request = connection.buildRequest({
      nominate: false,
      remoteUsername: 'remote-fixture',
      localUsername: 'local-fixture',
      iceControlling: false,
    });
    request.addMessageIntegrity(Buffer.from('fixture-password'));
    request.addFingerprint();
    const bytes = request.bytes,
      attributes = [];
    for (let offset = 20; offset < bytes.length;) {
      attributes.push(bytes.readUInt16BE(offset));
      offset += 4 + Math.ceil(bytes.readUInt16BE(offset + 2) / 4) * 4;
    }
    assert.ok(attributes.indexOf(0xc057) >= 0);
    assert.ok(attributes.indexOf(0xc057) < attributes.indexOf(0x0008));
    assert.ok(attributes.indexOf(0x0008) < attributes.indexOf(0x8028));
    assert.ok(parseMessage(bytes, Buffer.from('fixture-password')));
  } finally {
    await pc.close();
  }
});

test('SCTP client/server follows DTLS role even when ICE roles disagree', async () => {
  const pc = new RTCPeerConnection({ iceServers: [] });
  try {
    pc.createDataChannel('fixture');
    const transport = pc.sctpTransport;
    transport.dtlsTransport.iceTransport.connection.iceControlling = false;
    transport.dtlsTransport.role = 'client';
    assert.equal(transport.isServer, false);
    transport.dtlsTransport.iceTransport.connection.iceControlling = true;
    transport.dtlsTransport.role = 'server';
    assert.equal(transport.isServer, true);
  } finally {
    await pc.close();
  }
});
