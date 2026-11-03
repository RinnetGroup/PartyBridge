import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession } from '../protocol/voice-session.js';
import { partyMembers } from '../public/party-state.js';

const SELF = '11111111-1111-1111-1111-111111111111';
const ONE = '22222222-2222-2222-2222-222222222222';
const TWO = '33333333-3333-3333-3333-333333333333';
const p1 = { peerId: ONE, identity: 'Y-one', users: [{ account_id: '99' }] };
const p2 = { peerId: TWO, identity: 'Z-two', users: [{ account_id: '100' }] };
const hello = new TextEncoder().encode('hello');
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function clock() {
  let now = 0,
    next = 0;
  const timers = new Map();
  return {
    timers,
    schedule(fn, ms) {
      const id = ++next;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      now = end;
    },
  };
}
function channel(label, opened = false) {
  return {
    label,
    readyState: opened ? 'open' : 'connecting',
    sent: [],
    send(data) {
      this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
    },
    close() {
      this.readyState = 'closed';
      this.onclose?.();
    },
    open() {
      this.readyState = 'open';
      this.onopen?.();
    },
    receive(data) {
      this.onmessage?.({ data });
    },
  };
}
async function fixture(t, initial = [p1], options = {}) {
  const time = clock(),
    channels = [],
    failures = [],
    snapshots = [];
  let participants = initial,
    members = initial.map((p) => ({ accountId: p.users[0].account_id, onlineId: p.identity }));
  const pc = {
    createDataChannel(label) {
      const ch = channel(label);
      channels.push(ch);
      return ch;
    },
  };
  const session = new VoiceSession({
    pc,
    peerId: SELF,
    self: { identity: 'A-self', accountId: '88', platform: 100001 },
    participants,
    members,
    api: async () => ({ participants, members }),
    onOffer: () => {},
    onParticipants: (peers, roster) => snapshots.push({ peers, members: roster }),
    onFailure: (reason) => failures.push(reason),
    ...time,
    ...options,
  });
  t.after(() => session.close());
  const bridge = channels[0];
  const receive = (frame) => bridge.receive(JSON.stringify(frame));
  const event = (type, payload) => receive({ category: 'event', type, payload });
  const ack = (request) =>
    receive({
      category: 'response',
      type: request.type,
      id: request.id,
      payload: request.type === 'setMediaPubSubPeers' ? request.payload : {},
    });
  const announce = (id, label = `${SELF}_0`, sid = '2') =>
    event('dataChannelCreated', {
      peer: { peerId: id, dataChannel: { label, sid, channelType: 0, reliabilityParameter: 0 } },
    });
  bridge.open();
  session.answerSubmitted();
  event('dataChannelCreated', {
    peer: {
      peerId: SELF,
      dataChannel: { label: 'bridge', sid: '0', channelType: 0, reliabilityParameter: 0 },
    },
    otherPeers: initial.map((p) => ({ peerId: p.peerId })),
  });
  for (const request of [...bridge.sent]) ack(request);
  await settle();
  return {
    time,
    channels,
    pc,
    session,
    bridge,
    failures,
    snapshots,
    event,
    ack,
    announce,
    roster(
      next,
      nextMembers = next.map((p) => ({ accountId: p.users[0].account_id, onlineId: p.identity })),
    ) {
      participants = next;
      members = nextMembers;
      session.members = members;
      session.update(participants);
    },
    ackRoutes() {
      for (let i = 0; i < 10; i++) {
        const id = session.bridge.routingId;
        if (id === null) return;
        ack(bridge.sent.find((r) => r.id === id));
      }
      assert.fail('Routing updates did not settle');
    },
  };
}

test('late third member retains an early channel/hello and adds a route without replacing the first participant', async (t) => {
  const f = await fixture(t);
  const first = f.session.peers.get(ONE).channel;
  first.open();
  f.announce(ONE);
  first.receive(hello);
  f.ackRoutes();
  assert.equal(f.session.snapshot()[0].routeReady, true);
  const late = channel(`${TWO}_0`, true);
  f.pc.ondatachannel({ channel: late });
  late.receive(hello);
  assert.equal(late.readyState, 'open');
  f.announce(TWO, 'bridge');
  f.announce(TWO);
  f.roster([p1, p2]);
  f.ackRoutes();
  assert.equal(f.session.peers.get(ONE).channel, first);
  assert.equal(f.session.peers.get(TWO).channel, late);
  assert.ok(f.session.snapshot().every((p) => p.routeReady));
  assert.equal(f.snapshots.at(-1).members.length, 2);
  assert.deepEqual(
    f.bridge.sent.filter((r) => r.type === 'setMediaPubSubPeers').at(-1).payload
      .mediaSubscriptionPeers,
    [ONE, TWO],
  );
  assert.deepEqual(f.failures, []);
});

test('two simultaneous handshakes coalesce route changes until both participants are acknowledged', async (t) => {
  const f = await fixture(t, [p1, p2]);
  for (const p of [p1, p2]) {
    const ch = f.session.peers.get(p.peerId).channel;
    ch.open();
    f.announce(p.peerId);
    ch.receive(hello);
  }
  assert.equal(f.bridge.sent.filter((r) => r.type === 'setMediaPubSubPeers').length, 1);
  assert.ok(f.session.snapshot().every((p) => !p.routeReady));
  f.ackRoutes();
  assert.ok(f.session.snapshot().every((p) => p.routeReady));
  f.roster([p2]);
  f.ackRoutes();
  assert.equal(f.session.peers.size, 1);
  assert.deepEqual([...f.session.bridge.acceptedPeers], [TWO]);
});

test('a closed participant channel is replaced; stale callbacks cannot damage its replacement', async (t) => {
  const f = await fixture(t);
  const peer = f.session.peers.get(ONE),
    first = peer.channel;
  first.open();
  f.announce(ONE);
  first.receive(hello);
  f.ackRoutes();
  const oldMessage = first.onmessage;
  first.close();
  f.ackRoutes();
  assert.equal(peer.channel, null);
  assert.equal(peer.state, 'reconnecting');
  f.roster([p1]);
  assert.equal(peer.channel, null);
  f.time.advance(1000);
  const next = peer.channel;
  assert.ok(next && next !== first);
  oldMessage({ data: hello });
  assert.equal(peer.handshake.established, false);
  next.open();
  next.receive(hello);
  f.ackRoutes();
  assert.equal(f.session.snapshot()[0].routeReady, true);
  assert.deepEqual(f.failures, []);
});

test('channel deletion withdraws only that participant and preserves membership for recovery', async (t) => {
  const f = await fixture(t, [p1, p2]);
  for (const p of [p1, p2]) {
    const ch = f.session.peers.get(p.peerId).channel;
    ch.open();
    f.announce(p.peerId);
    ch.receive(hello);
  }
  f.ackRoutes();
  f.event('dataChannelDeleted', { peer: { peerId: TWO, dataChannelLabels: [`${SELF}_0`] } });
  f.ackRoutes();
  assert.equal(f.session.peers.size, 2);
  assert.equal(f.session.snapshot().find((p) => p.peerId === ONE).routeReady, true);
  assert.equal(f.session.snapshot().find((p) => p.peerId === TWO).state, 'reconnecting');
});

test('one successful peer cannot cancel another peer deadline; retries stop at the configured limit', async (t) => {
  const f = await fixture(t, [p1, p2], { participantTimeout: 1000, maxRetries: 1 });
  const first = f.session.peers.get(ONE).channel;
  first.open();
  f.announce(ONE);
  first.receive(hello);
  f.ackRoutes();
  f.time.advance(1000);
  f.time.advance(1000);
  f.time.advance(1000);
  const snapshot = f.session.snapshot();
  assert.equal(snapshot.find((p) => p.peerId === ONE).routeReady, true);
  assert.equal(snapshot.find((p) => p.peerId === TWO).state, 'failed');
  assert.equal(f.session.peers.get(TWO).channel, null);
  assert.equal(f.session.closed, false);
  assert.deepEqual(f.failures, []);
  f.session.close();
  assert.equal(f.time.timers.size, 0);
});

test('unmatched channels expire and closing cancels pending channel buffers and retries', async (t) => {
  const f = await fixture(t, [], { pendingChannelTimeout: 1000 });
  const early = channel(`${TWO}_0`, true);
  f.pc.ondatachannel({ channel: early });
  early.receive(hello);
  f.time.advance(1000);
  assert.equal(early.readyState, 'closed');
  assert.equal(f.session.pendingChannels.size, 0);
  const pending = channel(`${ONE}_0`, true);
  f.pc.ondatachannel({ channel: pending });
  f.session.close();
  assert.equal(pending.readyState, 'closed');
  assert.equal(f.time.timers.size, 0);
});

test('roster renders late arrivals before voice metadata exists and removes departed accounts', () => {
  const first = { accountId: '99', onlineId: 'First', voiceChatActivated: true };
  const late = { accountId: '100', onlineId: 'Late', voiceChatActivated: true };
  const peers = [{ accountIds: ['99'], routeReady: true }];
  assert.deepEqual(
    partyMembers([first, late], peers, '88').map((p) => [p.onlineId, p.state]),
    [
      ['First', 'ready'],
      ['Late', 'pending'],
    ],
  );
  assert.deepEqual(
    partyMembers([late], [], '88').map((p) => p.accountId),
    ['100'],
  );
  assert.equal(
    partyMembers([{ ...late, voiceChatActivated: false }], [], '88')[0].state,
    'inactive',
  );
  assert.equal(partyMembers([{ accountId: '88', onlineId: 'Self' }], [], '88').length, 0);
});

test('the same account on this PC and a PS5 remains separate from the third PS5 participant', () => {
  const members = [
    { accountId: '88', onlineId: 'Self', platform: 'MOBILE_APP', memberKey: 'pc', isSelf: true },
    { accountId: '88', onlineId: 'Self', platform: 'PS5', memberKey: 'console', isSelf: false },
    { accountId: '99', onlineId: 'Friend', platform: 'PS5', memberKey: 'friend', isSelf: false },
  ];
  const roster = partyMembers(members, [{ accountIds: ['88'], routeReady: true }], '88');
  assert.deepEqual(
    roster.map((m) => [m.key, m.state]),
    [
      ['console', 'ready'],
      ['friend', 'pending'],
    ],
  );
});

test('a party push during a membership request schedules one fresh poll without overlapping or applying stale results last', async (t) => {
  const f = await fixture(t);
  let release,
    calls = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  f.session.api = async () => {
    calls++;
    return calls === 1
      ? pending
      : { participants: [p1, p2], members: [{ accountId: '99' }, { accountId: '100' }] };
  };
  f.session.requestPoll();
  f.session.requestPoll();
  f.session.requestPoll();
  assert.equal(calls, 1);
  release({ participants: [p1], members: [{ accountId: '99' }] });
  await settle();
  f.time.advance(0);
  await settle();
  assert.equal(calls, 2);
  assert.equal(f.session.peers.size, 2);
  assert.equal(f.snapshots.at(-1).members.length, 2);
});

test('a fresh channel announcement bypasses the old failed channel retry delay', async (t) => {
  const f = await fixture(t);
  const peer = f.session.peers.get(ONE),
    first = peer.channel;
  first.open();
  f.announce(ONE, `${SELF}_0`, '2');
  first.receive(hello);
  f.ackRoutes();
  first.close();
  f.ackRoutes();
  assert.equal(peer.state, 'reconnecting');
  assert.equal(peer.channel, null);
  f.announce(ONE, `${SELF}_0`, '4');
  assert.ok(peer.channel && peer.channel !== first);
  assert.equal(peer.retryTimer, null);
  peer.channel.open();
  peer.channel.receive(hello);
  f.ackRoutes();
  assert.equal(f.session.snapshot()[0].routeReady, true);
});

test('an incoming replacement channel bypasses backoff and still requires the participant handshake', async (t) => {
  const f = await fixture(t);
  const peer = f.session.peers.get(ONE);
  peer.channel.open();
  f.announce(ONE);
  peer.channel.receive(hello);
  f.ackRoutes();
  peer.channel.close();
  f.ackRoutes();
  const incoming = channel(`${ONE}_0`, true);
  f.pc.ondatachannel({ channel: incoming });
  assert.equal(peer.channel, incoming);
  assert.equal(peer.retryTimer, null);
  assert.equal(f.session.snapshot()[0].routeReady, false);
  incoming.receive(hello);
  f.ackRoutes();
  assert.equal(f.session.snapshot()[0].routeReady, true);
});

test('five-party coordination routes four independent remote peers and preserves three when one rejoins', async (t) => {
  const participants = [
    p1,
    p2,
    ...[4, 5].map((n) => ({
      peerId: `${n}${'0'.repeat(7)}-0000-0000-0000-000000000000`,
      identity: `Z-remote-${n}`,
      users: [{ account_id: String(100 + n) }],
    })),
  ];
  const f = await fixture(t, participants);
  for (const p of participants) {
    const ch = f.session.peers.get(p.peerId).channel;
    ch.open();
    f.announce(p.peerId);
    ch.receive(hello);
  }
  f.ackRoutes();
  assert.equal(f.session.snapshot().filter((p) => p.routeReady).length, 4);
  const healthy = participants.slice(1).map((p) => f.session.peers.get(p.peerId).channel);
  f.session.peers.get(ONE).channel.close();
  f.ackRoutes();
  f.announce(ONE, `${SELF}_0`, 'fresh');
  const replacement = f.session.peers.get(ONE).channel;
  replacement.open();
  replacement.receive(hello);
  f.ackRoutes();
  assert.equal(f.session.snapshot().filter((p) => p.routeReady).length, 4);
  assert.deepEqual(
    participants.slice(1).map((p) => f.session.peers.get(p.peerId).channel),
    healthy,
  );
});

test('a changed stream ID replaces an established control channel without disturbing another member', async (t) => {
  const f = await fixture(t, [p1, p2]);
  for (const id of [ONE, TWO]) {
    const ch = f.session.peers.get(id).channel;
    ch.open();
    f.announce(id);
    ch.receive(hello);
  }
  f.ackRoutes();
  const peer = f.session.peers.get(ONE),
    old = peer.channel,
    healthy = f.session.peers.get(TWO).channel;
  f.announce(ONE, `${SELF}_0`, '6');
  assert.equal(old.readyState, 'closed');
  assert.notEqual(peer.channel, old);
  f.ackRoutes();
  assert.equal(f.session.snapshot().find((p) => p.peerId === ONE).routeReady, false);
  assert.equal(f.session.snapshot().find((p) => p.peerId === TWO).routeReady, true);
  const replacement = peer.channel;
  replacement.open();
  replacement.receive(hello);
  f.ackRoutes();
  assert.equal(
    f.session.snapshot().every((p) => p.routeReady),
    true,
  );
  f.announce(ONE, `${SELF}_0`, '6');
  assert.equal(peer.channel, replacement);
  assert.equal(f.session.peers.get(TWO).channel, healthy);
});

test('full voice coordination pairs channel 1 for every remote peer and isolates its recovery from voice control', async (t) => {
  const f = await fixture(t, [p1, p2]);
  const pair = (id) => {
    const control = f.session.peers.get(id).channel;
    control.open();
    f.announce(id);
    control.receive(hello);
    f.ackRoutes();
    const data = f.session.partyData.peers.get(id).channel;
    data.open();
    f.announce(id, `${SELF}_1`, '6');
    return { control, data };
  };
  const first = pair(ONE),
    second = pair(TWO);
  assert.equal(
    f.session.snapshot().every((p) => p.routeReady && p.dataChannelReady),
    true,
  );
  f.event('dataChannelDeleted', { peer: { peerId: ONE, dataChannelLabels: [`${SELF}_1`] } });
  assert.equal(f.session.peers.get(ONE).channel, first.control);
  assert.equal(first.control.readyState, 'open');
  assert.equal(f.session.snapshot().find((p) => p.peerId === ONE).routeReady, true);
  assert.equal(f.session.partyData.peers.get(TWO).channel, second.data);
  f.time.advance(1000);
  const replacement = f.session.partyData.peers.get(ONE).channel;
  replacement.open();
  f.announce(ONE, `${SELF}_1`, '8');
  assert.equal(
    f.session.snapshot().every((p) => p.dataChannelReady),
    true,
  );
  f.roster([p2]);
  f.ackRoutes();
  assert.equal(replacement.readyState, 'closed');
  assert.equal(second.data.readyState, 'open');
  f.session.close();
  assert.equal(f.time.timers.size, 0);
  assert.deepEqual(f.failures, []);
});
