import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession } from '../protocol/voice-session.js';
import { userTableMessage } from '../protocol/participant.js';

const LOCAL = '11111111-1111-1111-1111-111111111111';
const REMOTE = '22222222-2222-2222-2222-222222222222';
const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test('full coordinator waits for configuration, pairs channels, validates user table, routes audio, and cleans up', async () => {
  const channels = [],
    calls = [],
    offers = [],
    timers = new Set();
  const pc = {
    createDataChannel(label, options) {
      const channel = {
        label,
        options,
        readyState: 'connecting',
        sent: [],
        send(data) {
          this.sent.push(data);
        },
        close() {
          this.readyState = 'closed';
        },
        open() {
          this.readyState = 'open';
          this.onopen?.();
        },
      };
      channels.push(channel);
      return channel;
    },
  };
  const participant = { peerId: REMOTE, identity: 'Z-remote', users: [{ account_id: '99' }] };
  const session = new VoiceSession({
    pc,
    peerId: LOCAL,
    self: { identity: 'A-local', accountId: '88', platform: 100001 },
    participants: [participant],
    api: async (path) => {
      calls.push(path);
      return { participants: [participant] };
    },
    onOffer: (offer) => offers.push(offer),
    onFailure: (reason) => assert.fail(reason),
    schedule: (fn) => {
      const timer = { fn };
      timers.add(timer);
      return timer;
    },
    cancel: (timer) => timers.delete(timer),
  });
  const bridge = channels[0];
  bridge.open();
  session.answerSubmitted();
  assert.equal(bridge.sent.length, 0);
  bridge.onmessage({
    data: encode({
      category: 'notification',
      type: 'dataChannelCreated',
      payload: {
        peer: {
          peerId: LOCAL,
          dataChannel: { sid: '0', label: 'bridge', channelType: 0, reliabilityParameter: 0 },
        },
        otherPeers: [{ peerId: REMOTE }],
      },
    }),
  });
  assert.equal(bridge.sent.length, 2);
  assert.equal(channels.length, 1);
  assert.equal(calls.length, 0);
  for (const bytes of [...bridge.sent]) {
    const request = JSON.parse(bytes);
    bridge.onmessage({
      data: encode({ category: 'response', type: request.type, id: request.id, payload: {} }),
    });
  }
  await settle();
  assert.deepEqual(calls, ['/api/voice/register', '/api/voice/state']);
  const remote = channels[1];
  assert.equal(remote.label, `${REMOTE}_0`);
  assert.deepEqual(remote.options, { ordered: true, maxRetransmits: 0 });
  remote.open();
  assert.equal(remote.sent.length, 0);
  bridge.onmessage({
    data: encode({
      category: 'event',
      type: 'dataChannelCreated',
      payload: {
        peer: {
          peerId: REMOTE,
          dataChannel: { sid: '2', label: `${LOCAL}_0`, channelType: 0, reliabilityParameter: 0 },
        },
      },
    }),
  });
  remote.onmessage({ data: new TextEncoder().encode('hello') });
  assert.equal(new TextDecoder().decode(remote.sent[0]), 'hello');
  assert.equal(JSON.parse(new TextDecoder().decode(remote.sent[1])).peer.users[0].account_id, '88');
  assert.equal(bridge.sent.length, 3);
  remote.onmessage({
    data: encode(
      userTableMessage({
        sequence: 1,
        identity: participant.identity,
        bridgePeerId: REMOTE,
        users: [{ account_id: '99', platform: 200001 }],
      }),
    ),
  });
  const route = JSON.parse(bridge.sent.at(-1));
  assert.equal(route.type, 'setMediaPubSubPeers');
  assert.deepEqual(route.payload.mediaSubscriptionPeers, [REMOTE]);
  bridge.onmessage({
    data: encode({ category: 'response', type: route.type, id: route.id, payload: route.payload }),
  });
  bridge.onmessage({
    data: encode({
      category: 'event',
      type: 'offerUpdated',
      payload: { offer: { sdp: 'v=0\r\n' } },
    }),
  });
  assert.equal(offers.length, 1);
  session.close();
  assert.equal(timers.size, 0);
  assert.ok(channels.every((c) => c.readyState === 'closed'));
});
