import test from 'node:test';
import assert from 'node:assert/strict';
import {
  screenPublisherAnnouncement,
  removeScreenPublisherAnnouncement,
  decodeScreenWatchRequest,
} from '../server/screen-publisher-contract.js';
import { screenAllocation, watchRequestPacket } from '../server/screen-share.js';

const decode = (data) => Buffer.from(data, 'base64').toString('utf8');
const member = {
  customData1: Buffer.from('{"Watching":[9223372036854775806],"other":7}').toString('base64'),
};
const details = {
  previewId: 'preview-owned',
  startedTick: '63900000000000001',
  titleId: 'PPSA00001',
};
const allocation = {
  sessionID: 'owned-room',
  signalingServerAddress: 'ess1-test.signaling.brd.playstation-cloud.com',
  signalingServerPort: '3443',
  sfuID: 'owned-sfu',
  hash: 'test-private',
};

test('a preview-only announcement preserves exact uint64 ticks and Watching without inventing a media room', () => {
  const encoded = screenPublisherAnnouncement(member, details),
    text = decode(encoded),
    json = JSON.parse(text);
  assert.match(text, /"StartedTime":63900000000000001/);
  assert.match(text, /"Watching":\[9223372036854775806\]/);
  assert.equal(json.Streaming.PreviewId, details.previewId);
  assert.equal(json.Streaming.ConnectionInfo, undefined);
  assert.equal(json.Streaming.lastThumbnailUploadedTime, 0);
  assert.equal(json.other, 7);
  assert.equal(screenAllocation({ customData1: encoded }), null);
  for (const customData1 of [undefined, null, ''])
    assert.equal(
      JSON.parse(decode(screenPublisherAnnouncement({ customData1 }, details))).Streaming.PreviewId,
      details.previewId,
    );
});

test('an allocated announcement uses nested JSON text and round-trips through the existing Sony viewer parser', () => {
  const encoded = screenPublisherAnnouncement(member, { ...details, allocation }),
    json = JSON.parse(decode(encoded));
  assert.equal(typeof json.Streaming.ConnectionInfo, 'string');
  assert.deepEqual(JSON.parse(json.Streaming.ConnectionInfo), allocation);
  assert.deepEqual(screenAllocation({ customData1: encoded }), {
    allocation,
    broadcastId: 'nativeStreamer-owned-room',
  });
  const noPreview = screenPublisherAnnouncement(member, {
    ...details,
    previewId: '',
    lastThumbnailUploadedTick: '63900000000000002',
    allocation,
  });
  assert.equal(JSON.parse(decode(noPreview)).Streaming.PreviewId, '');
  assert.match(decode(noPreview), /"lastThumbnailUploadedTime":63900000000000002/);
  assert.throws(() =>
    screenPublisherAnnouncement(member, {
      ...details,
      allocation: { ...allocation, signalingServerAddress: 'evil.test' },
    }),
  );
});

test('old publisher cleanup preserves a newer room and clears only Streaming for its own room', () => {
  const encoded = screenPublisherAnnouncement(member, { ...details, allocation }),
    current = { customData1: encoded };
  assert.equal(removeScreenPublisherAnnouncement(current, { sessionId: 'old-room' }), encoded);
  assert.equal(
    removeScreenPublisherAnnouncement(current, { previewId: details.previewId }),
    encoded,
  );
  assert.equal(
    decode(removeScreenPublisherAnnouncement(current, { sessionId: allocation.sessionID })),
    decode(member.customData1),
  );
  const preview = { customData1: screenPublisherAnnouncement(member, details) };
  assert.equal(
    decode(removeScreenPublisherAnnouncement(preview, { previewId: details.previewId })),
    decode(member.customData1),
  );
});

test('invalid current metadata and rounded clocks are rejected rather than silently losing member data', () => {
  for (const customData1 of [
    'garbage',
    Buffer.from('null').toString('base64'),
    Buffer.from('[]').toString('base64'),
  ])
    assert.throws(() => screenPublisherAnnouncement({ customData1 }, details));
  for (const startedTick of [Number(details.startedTick), '18446744073709551616', -1, 0])
    assert.throws(() => screenPublisherAnnouncement(member, { ...details, startedTick }));
});

test('native watch requests retain the exact sender ID and malformed or unrelated packets are ignored', () => {
  const packet = watchRequestPacket('9223372036854775806', 12);
  assert.deepEqual(decodeScreenWatchRequest(packet), {
    operation: 'watch',
    sequence: 12,
    accountId: '9223372036854775806',
    platform: 100001,
  });
  for (const offset of [0, 8, 16, 40, 44]) {
    const invalid = Buffer.from(packet);
    if (offset === 16) invalid.writeBigUInt64LE(0n, offset);
    else invalid.writeUInt32LE(0, offset);
    assert.equal(decodeScreenWatchRequest(invalid), null);
  }
  const initialSequence = Buffer.from(packet);
  initialSequence.writeUInt32LE(0, 4);
  assert.equal(decodeScreenWatchRequest(initialSequence).sequence, 0);
  assert.equal(decodeScreenWatchRequest(packet.subarray(1)), null);
});
