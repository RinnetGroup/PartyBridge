import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BridgeSession,
  decodeFrame,
  channelOptions,
  parsePeerChannel,
} from '../protocol/bridge-session.js';
import {
  ParticipantHandshake,
  participantRole,
  userTableMessage,
  decodeUserTable,
} from '../protocol/participant.js';

const SELF = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const THIRD = '33333333-3333-3333-3333-333333333333';
const encode = (value) =>
  new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const decode = (bytes) => JSON.parse(new TextDecoder().decode(bytes));
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
function clock() {
  let now = 0,
    next = 0;
  const timers = new Map();
  return {
    timers,
    schedule(callback, delay) {
      const id = ++next;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    advance(duration) {
      const end = now + duration;
      for (;;) {
        const first = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!first) break;
        now = first[1].at;
        timers.delete(first[0]);
        first[1].callback();
      }
      now = end;
    },
  };
}
function bridge(register) {
  const time = clock(),
    frames = [],
    diagnostics = [],
    channels = [],
    offers = [],
    states = [];
  let registrations = 0;
  const session = new BridgeSession({
    peerId: SELF,
    send: (bytes) => frames.push(decode(bytes)),
    register: async () => {
      registrations++;
      await register?.();
    },
    onDiagnostic: (value) => diagnostics.push(value),
    onPeerChannel: (value) => channels.push(value),
    onOffer: (value) => offers.push(value),
    onState: (state) => states.push(state),
    ...time,
  });
  const receive = (frame) => session.receive(encode(frame));
  const ack = (index, payload = {}) => {
    const sent = frames[index];
    receive({ category: 'response', type: sent.type, id: sent.id, payload });
  };
  const welcome = () =>
    receive({
      category: 'notification',
      type: 'dataChannelCreated',
      payload: {
        peer: {
          peerId: SELF,
          dataChannel: { sid: '0', label: 'bridge', channelType: 0, reliabilityParameter: 0 },
        },
        otherPeers: [],
      },
    });
  const ready = async () => {
    session.transportOpened();
    session.answerSubmitted();
    welcome();
    ack(1);
    ack(0);
    await flush();
  };
  const announce = (id = OTHER, label = 'bridge', otherPeers) =>
    receive({
      category: 'notification',
      type: 'dataChannelCreated',
      payload: {
        peer: {
          peerId: id,
          dataChannel: { sid: '4', label, channelType: 0, reliabilityParameter: 0 },
        },
        ...(otherPeers ? { otherPeers } : {}),
      },
    });
  return {
    session,
    frames,
    diagnostics,
    channels,
    offers,
    states,
    time,
    receive,
    ack,
    ready,
    announce,
    welcome,
    registrations: () => registrations,
  };
}

test('bridge bootstrap gates registration on answer acceptance and BOTH matching configuration responses', async () => {
  const b = bridge();
  b.session.transportOpened();
  assert.equal(b.frames.length, 0);
  b.session.answerSubmitted();
  b.session.answerSubmitted();
  assert.equal(b.frames.length, 0);
  b.welcome();
  assert.deepEqual(
    b.frames.map((f) => ({ type: f.type, payload: f.payload })),
    [
      {
        type: 'setFloorControlParameters',
        payload: { algorithm: 'sieVadAudioLevelBased01', parameters: { maxAudioStreams: 8 } },
      },
      {
        type: 'setReceivingCapability',
        payload: {
          receivingCapability: {
            audio: {
              opus: [
                { codec: 'CELT', bitrate: 24 },
                { codec: 'CELT', bitrate: 40 },
              ],
            },
          },
        },
      },
    ],
  );
  b.receive({
    category: 'response',
    type: 'setReceivingCapability',
    id: b.frames[0].id,
    payload: {},
  });
  assert.equal(b.session.pending.size, 2);
  b.ack(1);
  await flush();
  assert.equal(b.registrations(), 0);
  b.ack(0);
  await flush();
  assert.equal(b.registrations(), 1);
  b.ack(0);
  await flush();
  assert.equal(b.registrations(), 1);
  assert.deepEqual(b.states, ['configuring', 'registering', 'connecting-participants']);
  assert.equal(b.frames.length, 2);
  b.session.close();
});

test('native nested error.id and string code fail the correlated request without exposing server text', () => {
  const b = bridge();
  b.session.answerSubmitted();
  b.session.transportOpened();
  b.welcome();
  b.receive({
    category: 'response',
    type: 'error',
    error: {
      id: b.frames[1].id,
      code: 'unsupported',
      message: 'credential-that-must-not-be-logged',
    },
  });
  assert.equal(b.session.state, 'failed');
  assert.equal(b.time.timers.size, 0);
  assert.ok(b.diagnostics.at(-1).includes('setReceivingCapability (unsupported)'));
  assert.ok(!b.diagnostics.join().includes('credential-that-must-not-be-logged'));
  b.time.advance(60000);
  assert.equal(b.frames.length, 2);
  assert.equal(b.offers.length, 0);
});

test('an unrelated response cannot cancel another request timeout or cause an offer retry', () => {
  const b = bridge();
  b.session.transportOpened();
  b.session.answerSubmitted();
  b.welcome();
  b.receive({ category: 'response', type: 'error', error: { id: 999, code: 'x', message: '' } });
  b.ack(0);
  b.time.advance(10001);
  assert.equal(b.session.state, 'failed');
  assert.equal(b.registrations(), 0);
  assert.equal(b.offers.length, 0);
  assert.equal(b.time.timers.size, 0);
});

test('a silent bridge fails initialization without sending premature configuration requests', () => {
  const b = bridge();
  b.session.answerSubmitted();
  b.session.transportOpened();
  b.time.advance(10001);
  assert.equal(b.session.state, 'failed');
  assert.equal(b.frames.length, 0);
  assert.equal(b.time.timers.size, 0);
  b.welcome();
  assert.equal(b.frames.length, 0);
});

test('stalled registration times out and a later completion cannot select audio routes', async () => {
  let complete;
  const b = bridge(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  b.session.transportOpened();
  b.session.answerSubmitted();
  b.welcome();
  b.ack(0);
  b.ack(1);
  await flush();
  b.time.advance(10001);
  assert.equal(b.session.state, 'failed');
  complete();
  await flush();
  assert.equal(b.session.state, 'failed');
  assert.equal(b.frames.length, 2);
  assert.equal(b.time.timers.size, 0);
});

test('late registration completion after close cannot revive a connection', async () => {
  let complete;
  const b = bridge(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  b.session.transportOpened();
  b.session.answerSubmitted();
  b.welcome();
  b.ack(0);
  b.ack(1);
  await flush();
  assert.equal(b.session.state, 'registering');
  b.session.close();
  complete();
  await flush();
  assert.equal(b.session.state, 'closed');
  assert.equal(b.frames.length, 2);
});

test('registration failure cancels bootstrap without selecting participants', async () => {
  const b = bridge(() => {
    throw new Error('private upstream response');
  });
  await b.ready();
  assert.equal(b.session.state, 'failed');
  assert.equal(b.frames.length, 2);
  assert.ok(!b.diagnostics.join().includes('private upstream response'));
});

test('audio routing requires bridge readiness AND the participant handshake; changes coalesce while awaiting acknowledgement', async () => {
  const b = bridge();
  await b.ready();
  b.receive({ category: 'event', type: 'peerCreated', payload: { peer: { peerId: OTHER } } });
  b.session.setParticipantReady(OTHER, true);
  assert.equal(b.frames.length, 2);
  b.announce();
  assert.deepEqual(b.frames[2].payload, {
    mediaSubscriptionPeers: [OTHER],
    mediaPublishmentPeers: [OTHER],
  });
  b.announce(THIRD);
  b.session.setParticipantReady(THIRD, true);
  b.session.setParticipantReady(OTHER, false);
  assert.equal(b.frames.length, 3);
  b.ack(2, b.frames[2].payload);
  assert.deepEqual(b.frames[3].payload.mediaSubscriptionPeers, [THIRD]);
  b.ack(3, b.frames[3].payload);
  b.receive({
    category: 'notification',
    type: 'peerDeleted',
    payload: { peer: { peerId: THIRD } },
  });
  assert.deepEqual(b.frames[4].payload.mediaSubscriptionPeers, []);
  b.session.close();
  assert.equal(b.time.timers.size, 0);
});

test('routing acknowledgement must accept both requested lists', async () => {
  const b = bridge();
  await b.ready();
  b.announce();
  b.session.setParticipantReady(OTHER, true);
  b.ack(2, { mediaSubscriptionPeers: [OTHER], mediaPublishmentPeers: [] });
  assert.equal(b.session.state, 'failed');
  assert.equal(b.time.timers.size, 0);
});

test('bridge snapshot and data-channel announcements pair the remote channel with its counterpart', async () => {
  const b = bridge();
  await b.ready();
  b.announce(SELF, 'bridge', [{ peerId: OTHER }]);
  assert.ok(b.session.bridgeReady.has(OTHER));
  assert.ok(!b.session.bridgeReady.has(SELF));
  b.announce(OTHER, `${SELF}_0`);
  assert.deepEqual(b.channels[0], {
    type: 'dataChannelCreated',
    peerId: OTHER,
    label: `${OTHER}_0`,
    channelNumber: 0,
    sid: '4',
    options: { ordered: true },
  });
  b.announce(THIRD, `${OTHER}_0`);
  assert.equal(b.channels.length, 1);
  b.session.setParticipantReady(OTHER, true);
  b.ack(2, b.frames[2].payload);
  b.receive({
    category: 'event',
    type: 'dataChannelDeleted',
    payload: { peer: { peerId: OTHER, dataChannelLabels: [`${SELF}_0`] } },
  });
  assert.equal(b.channels[1].type, 'dataChannelDeleted');
  assert.deepEqual(b.frames[3].payload.mediaSubscriptionPeers, []);
  b.session.close();
});

test('offer events support non-response native categories and local peer removal is terminal', async () => {
  const b = bridge();
  await b.ready();
  b.receive({
    category: 'notification',
    type: 'offerUpdated',
    payload: { offer: { sdp: 'v=0\r\n' } },
  });
  assert.deepEqual(b.offers, [{ type: 'offer', sdp: 'v=0\r\n' }]);
  b.receive({ category: 'notification', type: 'offerUpdated', payload: { offer: null } });
  assert.equal(b.offers.at(-1), null);
  assert.equal(b.session.state, 'connecting-participants');
  b.receive({ category: 'event', type: 'maintenanceScheduled', payload: {} });
  b.receive({ category: 'event', type: 'peerDeleted', payload: { peer: { peerId: SELF } } });
  assert.equal(b.session.state, 'failed');
});

test('control parser rejects malformed frames and handles typed-array byte offsets', () => {
  const frame = { category: 'response', type: 'setReceivingCapability', id: 1, payload: {} };
  const encoded = encode(frame),
    padded = new Uint8Array(encoded.length + 4);
  padded.set(encoded, 2);
  assert.deepEqual(decodeFrame(padded.subarray(2, -2)), frame);
  for (const raw of [
    'null',
    '[]',
    '{',
    encode({ ...frame, id: '1' }),
    new Uint8Array(131073),
    new Uint8Array([255]),
  ])
    assert.throws(() => decodeFrame(raw));
});

test('DCEP options preserve ordering and partial reliability; labels are bounded', () => {
  assert.deepEqual(channelOptions(0, 0), { ordered: true });
  assert.deepEqual(channelOptions(128, 0), { ordered: false });
  assert.deepEqual(channelOptions(129, 3), { ordered: false, maxRetransmits: 3 });
  assert.deepEqual(channelOptions(2, 100), { ordered: true, maxPacketLifeTime: 100 });
  assert.throws(() => channelOptions(3, 0));
  assert.throws(() => channelOptions(1, -1));
  assert.deepEqual(parsePeerChannel(`${OTHER}_0`), { peerId: OTHER, channelNumber: 0 });
  assert.equal(parsePeerChannel(`${OTHER}_4294967296`), null);
});

test('participant roles use stable identities in case-insensitive order', () => {
  assert.equal(participantRole('AA', 'bb'), 1);
  assert.equal(participantRole('bb', 'AA'), 2);
  assert.throws(() => participantRole('AA', 'aa'));
  assert.throws(() => participantRole('', 'b'));
});

test('paired participant handshake waits for both channels, exchanges exact hello bytes, then stops retries', () => {
  const time = clock(),
    wire = [],
    ready = [];
  const a = new ParticipantHandshake({
    role: 1,
    send: (bytes) => wire.push(['b', bytes]),
    onReady: () => ready.push('a'),
    ...time,
  });
  const b = new ParticipantHandshake({
    role: 2,
    send: (bytes) => wire.push(['a', bytes]),
    onReady: () => ready.push('b'),
    ...time,
  });
  a.transportOpened();
  b.transportOpened();
  assert.equal(wire.length, 0);
  a.remoteChannelReady();
  b.remoteChannelReady();
  assert.deepEqual([...wire[0][1]], [104, 101, 108, 108, 111]);
  while (wire.length) {
    const [dest, bytes] = wire.shift();
    (dest === 'a' ? a : b).receive(bytes);
  }
  assert.deepEqual(ready.sort(), ['a', 'b']);
  time.advance(60000);
  assert.equal(wire.length, 0);
  assert.equal(time.timers.size, 0);
  a.close();
  b.close();
});

test('hello retries stop at a bounded deadline with one failure', () => {
  const time = clock(),
    sent = [],
    failures = [];
  const peer = new ParticipantHandshake({
    role: 2,
    send: (bytes) => sent.push(bytes),
    onFailure: (reason) => failures.push(reason),
    timeout: 10000,
    ...time,
  });
  peer.remoteChannelReady();
  peer.transportOpened();
  time.advance(10001);
  assert.equal(sent.length, 4);
  assert.equal(failures.length, 1);
  assert.equal(time.timers.size, 0);
  peer.receive(encode('hello'));
  time.advance(60000);
  assert.equal(failures.length, 1);
  assert.equal(sent.length, 4);
});

test('a legitimate delayed participant hello remains acceptable after the old ten-second deadline', () => {
  const time = clock(),
    sent = [];
  const peer = new ParticipantHandshake({ role: 1, send: (bytes) => sent.push(bytes), ...time });
  peer.transportOpened();
  peer.remoteChannelReady();
  time.advance(20000);
  assert.equal(peer.closed, false);
  peer.receive(encode('hello'));
  assert.equal(peer.established, true);
  assert.equal(sent.length, 1);
  assert.equal(time.timers.size, 0);
  peer.close();
});

test('role 1 does not mistake arbitrary application data for hello; role 2 accepts and forwards it', () => {
  const time = clock(),
    data = [];
  const a = new ParticipantHandshake({
    role: 1,
    send() {},
    onData: (bytes) => data.push(bytes),
    ...time,
  });
  const b = new ParticipantHandshake({
    role: 2,
    send() {},
    onData: (bytes) => data.push(bytes),
    ...time,
  });
  for (const peer of [a, b]) {
    peer.transportOpened();
    peer.remoteChannelReady();
    peer.receive(encode('{}'));
  }
  assert.equal(a.established, false);
  assert.equal(b.established, true);
  assert.equal(data.length, 2);
  a.close();
  b.close();
  assert.equal(time.timers.size, 0);
});

test('native user-table serialization preserves 64-bit account IDs and voice_chat media records', () => {
  const user = { account_id: '18446744073709551615', platform: 100001 };
  const message = userTableMessage({
    sequence: 1,
    identity: 'local-device-identity',
    bridgePeerId: SELF,
    users: [user],
    audioUsers: [user],
  });
  assert.deepEqual(message, {
    global_seq_num: 1,
    type: 'user_table_updated',
    peer: {
      peer_id: 'local-device-identity',
      bridge_peer_id: SELF,
      miranda_signaling_version: 2,
      users: [user],
      medias: [{ user, media_records: [{ mid: '', media_identifier: 'voice_chat' }], msids: [''] }],
    },
  });
  assert.deepEqual(
    decodeUserTable(encode(message), {
      identity: 'local-device-identity',
      bridgePeerId: SELF,
      users: [user],
    }),
    message,
  );
  assert.throws(() =>
    decodeUserTable(encode(message), {
      identity: 'other-device',
      bridgePeerId: SELF,
      users: [user],
    }),
  );
  assert.throws(() =>
    userTableMessage({
      sequence: 1,
      identity: 'local-device-identity',
      bridgePeerId: SELF,
      users: [user],
      audioUsers: [{ account_id: '1', platform: 100001 }],
    }),
  );
});
