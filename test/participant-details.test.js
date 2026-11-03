import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reportedMicMuted,
  participantRoster,
  peerMemberKeys,
  bridgeNetworkStats,
  participantDetailsSnapshot,
} from '../server/participant-details.js';
import { participantDetailsView } from '../public/participant-details.js';
import { VoiceEngine } from '../server/voice-engine.js';
import { createApp } from '../server/index.js';
process.env.NODE_ENV = 'test';
const ID = '12345678-1234-1234-1234-123456789abc';
const encoded = (flag) =>
  Buffer.from(JSON.stringify(['', '', '1', '0', '6.2.0', flag, '0', '0', '', ''])).toString(
    'base64',
  );
const raw = {
  members: [
    {
      accountId: '88',
      onlineId: 'Self',
      platform: 'MOBILE_APP',
      deviceUniqueId: 'pc',
      voiceChatActivated: true,
      customData4: encoded('0'),
    },
    {
      accountId: '88',
      onlineId: 'Self',
      platform: 'PS5',
      deviceUniqueId: 'console',
      voiceChatActivated: true,
      customData4: encoded('1'),
    },
    {
      accountId: '99',
      onlineId: 'Friend',
      platform: 'PS5',
      deviceUniqueId: 'friend',
      voiceChatActivated: true,
      customData4: encoded('0'),
    },
  ],
};
const members = participantRoster(raw, 'pc'),
  profile = { accountId: '88', onlineId: 'Self' };
function stats() {
  return new Map([
    [
      'transport',
      {
        id: 'transport',
        type: 'transport',
        selectedCandidatePairId: 'selected',
        iceLocalUsernameFragment: 'private',
      },
    ],
    [
      'wrong',
      {
        id: 'wrong',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        currentRoundTripTime: 0.001,
        roundTripTimeMeasurements: 1,
      },
    ],
    [
      'selected',
      {
        id: 'selected',
        type: 'candidate-pair',
        state: 'succeeded',
        localCandidateId: 'local',
        remoteCandidateId: 'relay',
        currentRoundTripTime: 0.042,
        roundTripTimeMeasurements: 3,
      },
    ],
    [
      'local',
      { id: 'local', type: 'local-candidate', address: '2001:db8::1', usernameFragment: 'private' },
    ],
    ['relay', { id: 'relay', type: 'remote-candidate', address: '203.0.113.10', port: 50000 }],
  ]);
}

test('reported mute uses the native microphone property, preserves false, and treats missing/invalid data as unknown', () => {
  assert.equal(reportedMicMuted(encoded('1')), true);
  assert.equal(reportedMicMuted(encoded('0')), false);
  for (const value of [
    undefined,
    'garbage',
    encoded(''),
    encoded('2'),
    Buffer.from('["1"]').toString('base64'),
    encoded('true'),
  ])
    assert.equal(reportedMicMuted(value), null);
  assert.equal(members[1].micMuted, true);
  assert.equal(members[2].micMuted, false);
});

test('device keys distinguish the same account on PC and console rather than borrowing another device connection', () => {
  const peer = { users: [{ account_id: '88' }] };
  assert.deepEqual(peerMemberKeys(members, peer, 'console'), [members[1].memberKey]);
  const snapshot = participantDetailsSnapshot({
    members,
    peers: [{ accountIds: ['88'], memberKeys: [members[1].memberKey], routeReady: true }],
    profile,
    observing: true,
    voiceState: 'ready',
  });
  const self = snapshot.participants.find((p) => p.isSelf),
    console = snapshot.participants.find((p) => p.platform === 'PS5' && p.accountId === '88');
  assert.equal(self.micMuted, false);
  assert.equal(console.micMuted, true);
  assert.equal(console.connection, 'Voice ready');
  assert.equal(snapshot.participants.find((p) => p.accountId === '99').connection, 'Joining voice');
});

test('bridge details follow the selected candidate pair, convert measured RTT seconds to milliseconds, and omit credentials', () => {
  const info = bridgeNetworkStats(stats(), 'connected', 123);
  assert.equal(info.pingMs, 42);
  assert.deepEqual(info.local, { address: '2001:db8::1', family: 'IPv6' });
  assert.deepEqual(info.relay, { address: '203.0.113.10', family: 'IPv4' });
  assert.equal(JSON.stringify(info).includes('private'), false);
  assert.equal(info.sampledAt, 123);
});

test('unselected/stale transports, unmeasured RTTs and hostnames never become invented IPs or zero ping', () => {
  assert.equal(bridgeNetworkStats(stats(), 'disconnected').pingMs, null);
  assert.equal(bridgeNetworkStats(stats(), 'disconnected').relay, null);
  const data = stats();
  delete data.get('transport').selectedCandidatePairId;
  assert.equal(bridgeNetworkStats(data, 'connected').relay, null);
  for (const value of [undefined, NaN, Infinity, -1, '0.05', 61]) {
    const data = stats();
    data.get('selected').currentRoundTripTime = value;
    assert.equal(bridgeNetworkStats(data, 'connected').pingMs, null);
  }
  const data2 = stats();
  data2.get('selected').roundTripTimeMeasurements = 0;
  data2.get('selected').currentRoundTripTime = 0;
  data2.get('relay').address = 'untrusted.example';
  assert.equal(bridgeNetworkStats(data2, 'connected').pingMs, null);
  assert.equal(bridgeNetworkStats(data2, 'connected').relay, null);
});

test('bridge connections hide ping and IP for remote and local participants, including healthy peer routes', () => {
  const snapshot = participantDetailsSnapshot({
    members,
    profile,
    observing: true,
    voiceState: 'ready',
    bridge: bridgeNetworkStats(stats(), 'connected'),
  });
  const view = participantDetailsView(snapshot, {
    accountId: '99',
    platform: 'PS5',
    username: 'Friend',
  });
  assert.equal(view.username, 'Friend');
  assert.equal(view.muted, 'Unmuted');
  assert.equal(view.showPing, false);
  assert.equal(view.showHost, false);
  assert.equal(view.ping, '');
  assert.equal(view.host, '');
  assert.equal(view.bridgePing, undefined);
  assert.equal(view.bridgeHost, undefined);
  const self = participantDetailsView(snapshot, { accountId: '88', isSelf: true });
  assert.equal(self.showPing, false);
  assert.equal(self.showHost, false);
  for (const p of snapshot.participants) {
    assert.equal(p.transport, 'bridge');
    assert.equal(p.pingMs, null);
    assert.equal(p.host, null);
  }
  const ready = participantDetailsSnapshot({
    members,
    profile,
    observing: true,
    voiceState: 'ready',
    bridge: bridgeNetworkStats(stats(), 'connected'),
    peers: [{ accountIds: ['99'], memberKeys: [members[2].memberKey], routeReady: true }],
  });
  assert.equal(ready.participants.find((p) => p.accountId === '99').connection, 'Voice ready');
  assert.equal(participantDetailsView(ready, { accountId: '99' }).showPing, false);
});

test('only an explicit connected P2P transport exposes its own measured ping and non-relay endpoint', () => {
  const person = {
    key: 'friend-device',
    accountId: '99',
    username: 'Friend',
    platform: 'PS5',
    isSelf: false,
    transport: 'p2p',
    transportState: 'connected',
    connection: 'Voice ready',
    pingMs: 28,
    host: { address: '2001:db8::2', family: 'IPv6', candidateType: 'srflx' },
  };
  const selection = { accountId: '99', memberKey: person.key },
    data = {
      participants: [person],
      bridge: { pingMs: 42, relay: { address: '203.0.113.10', family: 'IPv4' } },
    };
  let view = participantDetailsView(data, selection);
  assert.equal(view.showPing, true);
  assert.equal(view.ping, '28 ms');
  assert.equal(view.showHost, true);
  assert.equal(view.host, '2001:db8::2 (IPv6)');
  for (const state of ['connecting', 'disconnected', 'failed', 'closed', 'unknown', undefined]) {
    const view = participantDetailsView(
      { ...data, participants: [{ ...person, transportState: state }] },
      selection,
    );
    assert.equal(view.showPing, false);
    assert.equal(view.showHost, false);
  }
  for (const transport of ['bridge', undefined]) {
    view = participantDetailsView({ ...data, participants: [{ ...person, transport }] }, selection);
    assert.equal(view.showPing, false);
    assert.equal(view.showHost, false);
  }
  for (const candidateType of ['relay', undefined]) {
    view = participantDetailsView(
      { ...data, participants: [{ ...person, host: { ...person.host, candidateType } }] },
      selection,
    );
    assert.equal(view.showHost, false);
    assert.equal(view.showPing, true);
  }
  for (const host of [
    { address: 'relay.example', family: 'IPv4' },
    { address: '999.0.0.1', family: 'IPv4' },
    { address: 'bad::address', family: 'IPv6' },
  ]) {
    view = participantDetailsView(
      { ...data, participants: [{ ...person, host: { ...host, candidateType: 'host' } }] },
      selection,
    );
    assert.equal(view.showHost, false);
  }
  view = participantDetailsView(
    { ...data, participants: [{ ...person, transportState: 'completed', pingMs: null }] },
    selection,
  );
  assert.equal(view.showPing, false);
  assert.equal(view.showHost, true);
  view = participantDetailsView(data, { ...selection, memberKey: 'departed-device' });
  assert.equal(view.showPing, false);
  assert.equal(view.showHost, false);
});

test('a departed device is not silently replaced by another device on the same account', () => {
  const snapshot = participantDetailsSnapshot({
    members,
    profile,
    observing: true,
    voiceState: 'ready',
    bridge: { state: 'disconnected' },
  });
  assert.match(
    snapshot.participants.find((p) => p.accountId === '99').connection,
    /your voice connection/,
  );
  const view = participantDetailsView(snapshot, {
    memberKey: 'departed-device',
    accountId: '88',
    platform: 'PS5',
    username: 'Self',
  });
  assert.equal(view.connection, 'Left party or no longer visible');
  assert.equal(view.muted, 'Not reported');
});

test('live details read existing stats with a short cache and reflect mute changes without restarting the engine', async () => {
  const engine = new VoiceEngine({ profile, accountId: '88' }, { codecFactory: () => ({}) });
  let reads = 0;
  engine.pc = {
    getStats: async () => {
      reads++;
      return stats();
    },
  };
  engine.transportState = 'connected';
  engine.state = 'ready';
  engine.members = members;
  engine.peerSnapshot = [];
  const pc = engine.pc;
  const one = await engine.participantDetails();
  engine.setMuted(true);
  const two = await engine.participantDetails();
  assert.equal(one.participants[0].micMuted, false);
  assert.equal(two.participants[0].micMuted, true);
  assert.equal(reads, 1);
  assert.equal(engine.pc, pc);
  engine.members = [];
  const loading = await engine.participantDetails();
  assert.equal(loading.rosterReady, false);
  assert.equal(
    participantDetailsView(loading, { accountId: '99', username: 'Friend' }).connection,
    'Waiting for participant details',
  );
});

test('details endpoint uses the live engine for the active party and protects reads with the local session and CSRF', async () => {
  let detailsReads = 0,
    partyReads = 0;
  const c = {
    accountId: '88',
    deviceId: 'pc',
    profile,
    tokens: {},
    active: { id: ID },
    events: [],
    party: async () => {
      partyReads++;
      return raw;
    },
    record() {},
    leave: async () => {},
    clear() {},
  };
  const state = { sessions: new Map(), clients: new Set() },
    app = createApp({ clientFactory: () => c, state });
  const url = await app.listen(0),
    boot = await fetch(url + '/api/bootstrap'),
    b = await boot.json();
  const headers = {
    Cookie: boot.headers.get('set-cookie').split(';')[0],
    'X-PartyBridge-CSRF': b.csrf,
  };
  const session = [...state.sessions.values()][0];
  session.voiceEngine = {
    stopped: false,
    participantDetails: async () => {
      detailsReads++;
      return { participants: [{ username: 'Fixture' }], bridge: null };
    },
    stop: async () => {},
  };
  try {
    const path = '/api/party/participant-details?id=' + ID;
    assert.equal((await fetch(url + path, { headers: { Cookie: headers.Cookie } })).status, 403);
    const response = await fetch(url + path, { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).participants[0].username, 'Fixture');
    assert.equal(detailsReads, 1);
    assert.equal(partyReads, 0);
    session.voiceEngine.stopped = true;
    const outside = await (await fetch(url + path, { headers })).json();
    assert.equal(partyReads, 1);
    assert.equal(outside.bridge, null);
    assert.equal(
      outside.participants.find((p) => p.accountId === '99').connection,
      'Join voice to check',
    );
    assert.equal(outside.participants.find((p) => p.accountId === '99').micMuted, false);
    assert.equal(
      (await fetch(url + '/api/party/participant-details?id=bad', { headers })).status,
      400,
    );
    assert.equal(
      (await fetch(url + path, { headers: { ...headers, Origin: 'https://untrusted.example' } }))
        .status,
      403,
    );
  } finally {
    await app.close();
  }
});
