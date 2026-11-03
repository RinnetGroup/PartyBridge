import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PsnClient,
  parseNpsso,
  normalizeParty,
  bridgeMemberData,
  nativeParticipants,
} from '../server/psn.js';
import { SonyPush, pushAuthFrame, pushAddress, pushTlsOptions } from '../server/push.js';
import { EventEmitter } from 'node:events';
import { inspectOffer } from '../public/voice.js';
import { X509Certificate } from 'node:crypto';
import { createMobileDeviceId } from '../server/device.js';
process.env.NODE_ENV = 'test';

const ID = '12345678-1234-1234-1234-123456789abc';
const BRIDGE = '22345678-1234-1234-1234-123456789abc';
const PEER = '32345678-1234-1234-1234-123456789abc';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const authed = (fetchImpl) => {
  const client = new PsnClient({ fetchImpl, bridgeWaitMs: 0 });
  client.tokens = {
    access: 'test-access',
    refresh: 'test-refresh',
    expiresAt: Date.now() + 3600000,
  };
  client.accountId = '1234567890123456789';
  return client;
};

test('routine party polling cannot erase retained voice failures and both histories remain bounded', () => {
  const client = new PsnClient();
  client.record('voice', 'test transport failure');
  for (let i = 0; i < 100; i++) client.record('party details', 200);
  assert.equal(client.events.length, 80);
  assert.equal(client.voiceEvents[0].status, 'test transport failure');
  for (let i = 0; i < 1100; i++) client.record('voice', `voice event ${i}`);
  assert.equal(client.voiceEvents.length, 1000);
  assert.equal(client.voiceEvents.at(-1).status, 'voice event 1099');
});

test('push diagnostics retain protocol outcomes and close codes without authentication bodies or duplicate hooks', () => {
  const events = [],
    push = new SonyPush({
      contextId: 'local',
      diagnosticLog: { write: (event, detail) => events.push({ event, detail }) },
    });
  const socket = new EventEmitter();
  push.attachDiagnostics(socket);
  push.attachDiagnostics(socket);
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        method: 1003,
        returnCode: 0,
        auth: { accessToken: 'secret-authentication-body' },
      }),
    ),
  );
  socket.emit('pong');
  socket.emit('close', 1006, Buffer.from('private reason'));
  assert.equal(socket.listenerCount('message'), 1);
  assert.equal(events[0].detail.method, 1003);
  assert.equal(events.at(-1).detail.code, 1006);
  assert.ok(!JSON.stringify(events).includes('secret-authentication-body'));
  assert.ok(!JSON.stringify(events).includes('private reason'));
});

test('NPSSO accepts raw and Sony JSON but rejects header injection and wrong lengths', () => {
  const value = 'x'.repeat(64);
  assert.equal(parseNpsso(value), value);
  assert.equal(parseNpsso(JSON.stringify({ npsso: value })), value);
  for (const bad of [
    null,
    'x'.repeat(63),
    value + '\r\nCookie: stolen',
    '{',
    JSON.stringify({ npsso: 5 }),
  ])
    assert.throws(() => parseNpsso(bad), { code: 'INVALID_NPSSO' });
});

test('push JSON preserves 64-bit account ID and escapes token strings', () => {
  const id = '9223372036854775806';
  const frame = pushAuthFrame(id, 'x"y');
  assert.ok(frame.includes(`"accountId":${id},`));
  assert.equal(JSON.parse(frame).auth.accessToken, 'x"y');
  assert.throws(() => pushAuthFrame('5,"admin":true', 'x'));
});

test('push credentials cannot be redirected outside Sony communication hosts', () => {
  assert.equal(
    pushAddress('push1.np.communication.playstation.net'),
    'wss://push1.np.communication.playstation.net/np/pushNotification',
  );
  for (const host of [
    'evil.test',
    'sony.test/np.communication.playstation.net',
    'np.communication.playstation.net.evil.test',
    '127.0.0.1',
    'push1.np.communication.playstation.net:443@evil.test',
  ])
    assert.throws(() => pushAddress(host));
});

test('push TLS supplies the missing intermediate without trusting incomplete chains', () => {
  const options = pushTlsOptions();
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.allowPartialTrustChain, false);
  const intermediate = new X509Certificate(options.ca.at(-1));
  assert.equal(
    intermediate.fingerprint256,
    '02:AB:57:E4:E6:7A:0C:B4:8D:D2:FF:34:83:0E:8A:C4:0F:44:76:FB:08:CA:6B:E3:F5:CD:84:6F:64:68:40:F0',
  );
  assert.ok(
    options.ca.slice(0, -1).some((pem) => {
      const root = new X509Certificate(pem);
      return intermediate.checkIssued(root) && intermediate.verify(root.publicKey);
    }),
  );
});

test('login requires Sony custom-scheme redirect, never follows credential-bearing redirects', async () => {
  let count = 0;
  const client = new PsnClient({
    fetchImpl: async (url, options) => {
      count++;
      assert.equal(options.redirect, 'manual');
      return new Response(null, {
        status: 302,
        headers: { location: 'https://evil.test/?code=stolen' },
      });
    },
  });
  await assert.rejects(client.login('x'.repeat(64)), { code: 'SONY_LOGIN_FAILED' });
  assert.equal(count, 1);
  assert.equal(client.tokens, null);
});

test('login exchanges tokens and returns only public profile fields', async () => {
  const calls = [];
  const token =
    'header.' +
    Buffer.from('{"account_id":9223372036854775806}').toString('base64url') +
    '.signature';
  const client = new PsnClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/authorize?'))
        return new Response(null, {
          status: 302,
          headers: { location: 'com.scee.psxandroid.scecompcall://redirect/?code=v3.test' },
        });
      if (url.endsWith('/token'))
        return json({ access_token: token, refresh_token: 'private-refresh', expires_in: 3600 });
      return json({ onlineId: 'TestPlayer', email: 'private@example.test' });
    },
  });
  assert.deepEqual(await client.login('x'.repeat(64)), {
    onlineId: 'TestPlayer',
    accountId: '9223372036854775806',
  });
  const duid = new URL(calls[0].url).searchParams.get('duid');
  assert.match(duid, /^00000007000801a8[0-9a-f]{106}$/);
  assert.ok(calls[2].url.includes('/users/9223372036854775806/profiles'));
  assert.equal(client.accountId, '9223372036854775806');
  assert.ok(!JSON.stringify(client.events).includes(token));
  assert.ok(!JSON.stringify(client.events).includes(duid));
  assert.equal(
    calls[1].options.headers.Authorization,
    'Basic MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A=',
  );
  client.clear();
  assert.equal(client.tokens, null);
});

test('mobile device IDs use the APK layout and independent local identities', () => {
  const first = createMobileDeviceId(),
    second = createMobileDeviceId();
  assert.notEqual(first, second);
  assert.match(first, /^00000007000801a800000000000000[0-9a-f]{16}/);
  const labels = Buffer.from(first.slice(46), 'hex');
  assert.equal(labels.subarray(0, 22).toString(), ': PartyBrdg:  Local PC');
  assert.deepEqual(labels.subarray(22), Buffer.alloc(16));
});

test('missing access token never becomes a connected session', async () => {
  const client = new PsnClient();
  assert.throws(() => client.setTokens({ error: 'invalid_grant' }), {
    code: 'INVALID_TOKEN_RESPONSE',
  });
  assert.equal(client.tokens, null);
});

test('concurrent expiry checks share one refresh request', async () => {
  let refreshes = 0;
  const client = authed(async () => {
    refreshes++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return json({ access_token: 'new-token', expires_in: 3600 });
  });
  client.tokens.expiresAt = 0;
  assert.deepEqual(await Promise.all([client.accessToken(), client.accessToken()]), [
    'new-token',
    'new-token',
  ]);
  assert.equal(refreshes, 1);
  assert.equal(client.tokens.refresh, 'test-refresh');
});

test('a refresh finishing after logout cannot revive login or retry a write under another account', async () => {
  for (const replacement of [
    null,
    { access: 'other-access', refresh: 'other-refresh', expiresAt: Date.now() + 3600000 },
  ]) {
    let finish, started;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const reached = new Promise((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const client = authed(async () => {
      calls++;
      started();
      return pending;
    });
    client.tokens.expiresAt = 0;
    const request = client.api(
      '/fixed-test-operation',
      { method: 'POST', body: { test: true } },
      'test',
    );
    await reached;
    client.clear();
    client.tokens = replacement;
    finish(
      json({ access_token: 'stale-access', refresh_token: 'stale-refresh', expires_in: 3600 }),
    );
    await assert.rejects(request, { code: 'SONY_SESSION_CHANGED' });
    assert.equal(client.tokens, replacement);
    assert.equal(calls, 1);
  }
});

test('party list errors cannot masquerade as an empty successful list', async () => {
  const client = authed(async (url) =>
    url.includes('Invitations') ? json({ invitations: [] }) : json({ differentSchema: [] }),
  );
  await assert.rejects(client.parties(), { code: 'PARTY_SCHEMA_CHANGED' });
});

test('fresh sessionManager 401 triggers one refresh and reports authorization, not guessed expiry', async () => {
  let attempts = 0,
    refreshes = 0;
  const client = authed(async (url) => {
    if (url.endsWith('/token')) {
      refreshes++;
      return json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
    }
    attempts++;
    return json({ error: { code: 999 } }, 401);
  });
  await assert.rejects(
    client.api('/sessionManager/v2/users/me/partySessionsInvitations', {}, 'invitations'),
    (error) => error.code === 'SONY_UNAUTHORIZED' && error.details.upstreamCode === 999,
  );
  assert.equal(attempts, 2);
  assert.equal(refreshes, 1);
  assert.equal(client.tokens.access, 'new-access');
});

test('an unavailable invitation endpoint does not hide an accessible party list', async () => {
  const client = authed(async (url) => {
    if (url.endsWith('/token'))
      return json({ access_token: 'new-access', refresh_token: 'refresh', expires_in: 3600 });
    if (url.includes('Invitations')) return json({}, 401);
    return json({ parties: [{ sessionId: ID, sessionName: 'Crew' }] });
  });
  const result = await client.parties();
  assert.equal(result.parties[0].name, 'Crew');
  assert.equal(result.invitationWarning, true);
});

test('party discovery uses the current-user alias required by sessionManager', async () => {
  const paths = [];
  const client = authed(async (url) => {
    paths.push(new URL(url).pathname);
    return json(
      url.includes('Invitations')
        ? { invitations: [] }
        : url.includes('/friends/')
          ? { v2PartySessions: [] }
          : { v2UserPartySessions: [] },
    );
  });
  assert.deepEqual((await client.parties()).parties, []);
  assert.deepEqual(paths, [
    '/api/sessionManager/v2/users/me/partySessionsInvitations',
    '/api/sessionManager/v2/users/me/partySessions',
    '/api/sessionManager/v2/friends/partySessions',
    '/api/gamingLoungeGroups/v1/members/me/groups/openPartySessions',
  ]);
});

test('message-group party stays discoverable after this device leaves its voice membership', async () => {
  const client = authed(async (url) => {
    if (url.includes('Invitations')) return json({ invitations: [] });
    if (url.includes('openPartySessions')) return json({ openPartySessions: [{ sessionId: ID }] });
    if (url.includes('?view=v3'))
      return json({
        v2PartySessions: [
          { sessionId: ID, sessionName: 'Group party', members: [{ onlineId: 'Friend' }] },
        ],
      });
    return json(url.includes('/friends/') ? { v2PartySessions: [] } : { v2UserPartySessions: [] });
  });
  const result = await client.parties();
  assert.equal(result.parties.length, 1);
  assert.equal(result.parties[0].name, 'Group party');
  assert.equal(result.groupsWarning, false);
});

test('friend-party discovery merges and deduplicates Sony party responses', async () => {
  const client = authed(async (url) => {
    if (url.includes('Invitations')) return json({ invitations: [] });
    return json(
      url.includes('/friends/')
        ? {
            v2PartySessions: [
              { sessionId: ID, sessionName: 'Crew' },
              { sessionId: BRIDGE, sessionName: 'Friends' },
            ],
          }
        : { v2UserPartySessions: [{ sessionId: ID, sessionName: 'Crew' }] },
    );
  });
  const result = await client.parties();
  assert.deepEqual(
    result.parties.map((p) => p.id),
    [ID, BRIDGE],
  );
  assert.equal(result.friendsWarning, false);
});

test('current-user membership references are hydrated before showing member counts', async () => {
  const client = authed(async (url) => {
    if (url.includes('Invitations')) return json({ invitations: [] });
    if (url.includes('/friends/')) return json({ v2PartySessions: [] });
    if (url.includes('?view=v3'))
      return json({
        v2PartySessions: [
          { sessionId: ID, sessionName: 'Crew', members: [{ onlineId: 'Friend' }] },
        ],
      });
    return json({ v2UserPartySessions: [{ sessionId: ID, member: { platform: 'MOBILE_APP' } }] });
  });
  const { parties } = await client.parties();
  assert.equal(parties[0].name, 'Crew');
  assert.equal(parties[0].members.length, 1);
});

test('voice identity uses the APK slot and preserves the other member fields', () => {
  const previous = Array.from({ length: 10 }, (_, i) => `field-${i}`);
  const registered = bridgeMemberData(
    Buffer.from(JSON.stringify(previous)).toString('base64'),
    BRIDGE,
    PEER,
  );
  const slots = JSON.parse(Buffer.from(registered, 'base64').toString());
  assert.equal(slots[8], `${BRIDGE}\n${PEER}`);
  assert.equal(slots[1], 'field-1');
  assert.equal(slots[4], 'field-4');
  assert.equal(
    JSON.parse(Buffer.from(bridgeMemberData(registered, null, null), 'base64').toString())[8],
    '',
  );
  assert.equal(
    JSON.parse(Buffer.from(bridgeMemberData(null, BRIDGE, PEER), 'base64').toString()).length,
    10,
  );
  assert.throws(() => bridgeMemberData('["unexpected"]', BRIDGE, PEER), {
    code: 'MEMBER_DATA_CHANGED',
  });
});

test('live PS5 member layout uses customData4 position 8, not the metadata at position 1', () => {
  const slots = [
    'x'.repeat(88),
    '12345678',
    '1',
    '0',
    '6.2.0',
    '0',
    '0',
    '0',
    `${BRIDGE}\n${PEER}`,
    'f'.repeat(64),
  ];
  const raw = {
    members: [
      {
        accountId: '9223372036854775806',
        deviceUniqueId: 'f'.repeat(64),
        platform: 'PS5',
        voiceChatActivated: true,
        customData4: Buffer.from(JSON.stringify(slots)).toString('base64'),
      },
    ],
  };
  assert.deepEqual(nativeParticipants(raw, BRIDGE, 'own'), [
    { peerId: PEER, identity: 'f'.repeat(64), users: [{ account_id: '9223372036854775806' }] },
  ]);
  assert.deepEqual(nativeParticipants(raw, ID, 'own'), []);
});

test('voice preparation defers registration, identifies this device, offers browser Opus, and reuses its peer', async () => {
  const calls = [];
  const offer = { sdp: 'v=0\r\na=rtpmap:111 opus/48000/2\r\n' };
  const client = authed(async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    if (url.includes('?view=v3'))
      return json({
        v2PartySessions: [
          {
            sessionId: ID,
            members: [
              {
                accountId: client.accountId,
                platform: 'MOBILE_APP',
                deviceUniqueId: client.deviceId,
              },
            ],
            bridges: [{ bridgeId: BRIDGE, bridgeToken: 'private' }],
          },
        ],
      });
    if (url.includes('allow_duid')) return json({ peer: { peerId: PEER, offer } });
    if (url.includes('?fields='))
      return json({ bridge: { peers: [{ peerId: PEER }, { peerId: ID }] } });
    if (url.endsWith('/offer')) return json({ offer });
    return new Response(null, { status: 204 });
  });
  client.deviceId = createMobileDeviceId();
  client.active = { id: ID };
  const result = await client.prepareVoice();
  assert.deepEqual(result.peerIds, [ID]);
  const create = calls.find((c) => c.url.includes('allow_duid'));
  assert.deepEqual(create.body.mediaTypes.audio.opus[0].samplingRates, [48000]);
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.body?.voiceChatActivated === true));
  assert.equal(result.self.identity, client.deviceId);
  await assert.rejects(client.registerVoice(), { code: 'VOICE_NOT_PREPARED' });
  await client.answer('v=0\r\n');
  await client.registerVoice();
  assert.equal(
    JSON.parse(
      Buffer.from(calls.find((c) => c.body?.customData4).body.customData4, 'base64').toString(),
    )[8],
    `${BRIDGE}\n${PEER}`,
  );
  assert.ok(
    calls.findIndex((c) => c.body?.voiceChatActivated === true) <
      calls.findIndex((c) => c.body?.customData4),
  );
  await client.prepareVoice();
  assert.ok(calls.at(-1).url.endsWith(`/peers/${PEER}/offer`));
  assert.equal(calls.filter((c) => c.url.includes('allow_duid')).length, 1);
  await client.stopVoice();
  assert.equal(
    JSON.parse(
      Buffer.from(calls.findLast((c) => c.body?.customData4).body.customData4, 'base64').toString(),
    )[8],
    '',
  );
});

test('party normalization projects only fields needed by UI', () => {
  const party = normalizeParty({
    sessionId: ID,
    sessionName: 'Friends',
    bridges: [{ bridgeToken: 'secret' }],
    members: [{ accountId: '99', onlineId: 'Friend', platform: 'PS5' }],
  });
  assert.equal(party.name, 'Friends');
  assert.equal(party.members.length, 1);
  assert.ok(!JSON.stringify(party).includes('secret'));
});

test('voice polling returns the full roster while a late member is still publishing voice metadata', async () => {
  const otherPeer = '42345678-1234-1234-1234-123456789abc';
  const first = {
    accountId: '99',
    onlineId: 'First',
    deviceUniqueId: 'first-device',
    platform: 'PS5',
    voiceChatActivated: true,
    customData4: bridgeMemberData(null, BRIDGE, PEER),
  };
  const late = {
    accountId: '100',
    onlineId: 'Late',
    deviceUniqueId: 'late-device',
    platform: 'PS5',
    voiceChatActivated: true,
  };
  const raw = {
    sessionId: ID,
    bridges: [{ bridgeId: BRIDGE, bridgeToken: 'private' }],
    members: [],
  };
  const client = authed(async () => json({ v2PartySessions: [raw] }));
  raw.members = [
    {
      accountId: client.accountId,
      onlineId: 'Self',
      deviceUniqueId: 'self-device',
      platform: 'MOBILE_APP',
      voiceChatActivated: true,
    },
    first,
    late,
  ];
  client.active = { id: ID, peerId: ID, identity: 'self-device', bridge: { bridgeId: BRIDGE } };
  const pending = await client.voiceState();
  assert.equal(pending.members.length, 3);
  assert.equal(pending.participants.length, 1);
  assert.equal(pending.members[0].isSelf, true);
  assert.equal(pending.members[1].isSelf, false);
  assert.ok(pending.members.every((m) => typeof m.memberKey === 'string'));
  assert.equal(pending.members[2].onlineId, 'Late');
  assert.equal(pending.members[2].voiceChatActivated, true);
  assert.ok(!JSON.stringify(pending).includes('private'));
  late.customData4 = bridgeMemberData(null, BRIDGE, otherPeer);
  const ready = await client.voiceState();
  assert.equal(ready.participants.length, 2);
  raw.members = raw.members.filter((m) => m !== first);
  const departed = await client.voiceState();
  assert.equal(departed.members.length, 2);
  assert.equal(departed.participants.length, 1);
});

test('join only sets active state after acknowledged membership; current APK request schema', async () => {
  const calls = [];
  const client = authed(async (url, options) => {
    if (url.includes('?view=v3'))
      return json({ v2PartySessions: [{ sessionId: ID, members: [] }] });
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(null, { status: 204 });
  });
  client.push.connect = async () => {};
  await client.join(ID);
  assert.equal(client.active.id, ID);
  assert.equal(calls[0].body.members[0].platform, 'me');
  assert.equal(calls[0].body.members[0].voiceChatActivated, false);
  await assert.rejects(client.join(ID), { code: 'ALREADY_JOINED' });
  const denied = authed(async () => json({ error: { message: 'secret-token' } }, 403));
  denied.push.connect = async () => {};
  await assert.rejects(
    denied.join(ID),
    (error) => error.code === 'SONY_DENIED' && !error.message.includes('secret-token'),
  );
  assert.equal(denied.active, null);
});

test('leave removes only own peer and membership, never shared bridge', async () => {
  const paths = [];
  const client = authed(async (url) => {
    paths.push(url);
    return new Response(null, { status: 204 });
  });
  client.active = {
    id: ID,
    bridge: { bridgeId: BRIDGE, bridgeToken: 'bridge-private' },
    peerId: PEER,
    ownsBridge: false,
  };
  await client.leave();
  assert.equal(paths.length, 2);
  assert.ok(paths[0].endsWith(`/peers/${PEER}`));
  assert.ok(paths[1].endsWith('/members/me'));
  assert.equal(client.active, null);
});

test('a bridge created by this PC is preserved after linking when other party members can be using it', async () => {
  const paths = [];
  const client = authed(async (url, options) => {
    paths.push({ url, method: options.method });
    return new Response(null, { status: 204 });
  });
  client.active = {
    id: ID,
    bridge: { bridgeId: BRIDGE, bridgeToken: 'private' },
    peerId: PEER,
    ownsBridge: true,
    bridgeLinked: true,
    voiceActivated: true,
  };
  await client.leave();
  assert.equal(
    paths.filter((p) => p.url.endsWith(`/bridges/${BRIDGE}`) && p.method === 'DELETE').length,
    0,
  );
  assert.equal(
    paths.filter((p) => p.url.endsWith(`/peers/${PEER}`) && p.method === 'DELETE').length,
    1,
  );
  assert.equal(client.active, null);
});

test('simultaneous socket stop and HTTP leave share cleanup instead of deleting the peer and metadata twice', async () => {
  let release;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    calls = [];
  const client = authed(async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    if (url.endsWith(`/peers/${PEER}`)) await gate;
    return new Response(null, { status: 204 });
  });
  client.active = {
    id: ID,
    bridge: { bridgeId: BRIDGE, bridgeToken: 'private' },
    peerId: PEER,
    ownsBridge: true,
    bridgeLinked: true,
    voiceActivated: true,
    peerRegistered: true,
  };
  const stop = client.stopVoice(),
    secondStop = client.stopVoice(),
    leave = client.leave(),
    secondLeave = client.leave();
  assert.equal(stop, secondStop);
  assert.equal(leave, secondLeave);
  release();
  await Promise.all([stop, leave]);
  assert.equal(calls.filter((c) => c.url.endsWith(`/peers/${PEER}`)).length, 1);
  assert.equal(calls.filter((c) => c.body?.customData4).length, 1);
  assert.equal(calls.filter((c) => c.body?.voiceChatActivated === false).length, 1);
  assert.equal(
    calls.filter((c) => c.url.endsWith('/members/me') && c.method === 'DELETE').length,
    1,
  );
  assert.equal(calls.filter((c) => c.url.endsWith(`/bridges/${BRIDGE}`)).length, 0);
});

test('cleanup failure retains state so it can be retried', async () => {
  const client = authed(async () => json({}, 503));
  client.active = {
    id: ID,
    bridge: { bridgeId: BRIDGE, bridgeToken: 'bridge-private' },
    peerId: PEER,
  };
  await assert.rejects(client.leave());
  assert.equal(client.active.peerId, PEER);
  assert.equal(client.active.id, ID);
});

test('explicit nonmember response during cleanup clears stale local membership', async () => {
  const client = authed(async (url, options) =>
    options.method === 'PATCH'
      ? json({ error: { code: 2233351 } }, 403)
      : new Response(null, { status: 202 }),
  );
  client.active = {
    id: ID,
    bridge: { bridgeId: BRIDGE, bridgeToken: 'private' },
    peerId: PEER,
    voiceActivated: true,
  };
  await client.leave();
  assert.equal(client.active, null);
});

test('leave clears stale membership even when voice never activated', async () => {
  const client = authed(async () => json({ error: { code: 2233351 } }, 403));
  client.active = { id: ID };
  await client.leave();
  assert.equal(client.active, null);
});

test('permission errors identify the failing stage without guessing invitation status', async () => {
  const client = authed(async () => json({ error: { code: 2233351 } }, 403));
  await assert.rejects(
    client.api('/test', {}, 'register voice peer in party'),
    (error) =>
      /register voice peer/.test(error.message) &&
      /no longer recognizes/.test(error.message) &&
      !/invitation/.test(error.message),
  );
});

test('voice activation requires explicit registration after answer acceptance and is deactivated on stop', async () => {
  const calls = [];
  const client = authed(async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    return new Response(null, { status: 204 });
  });
  client.active = {
    id: ID,
    bridge: { bridgeId: BRIDGE, bridgeToken: 'bridge-private' },
    peerId: PEER,
    ownsBridge: false,
    bridgeLinked: true,
    voiceActivated: false,
  };
  await client.answer('v=0\r\n');
  assert.equal(calls[0].url.endsWith('/answer'), true);
  assert.equal(calls.length, 1);
  await client.registerVoice();
  assert.deepEqual(calls[1].body, { voiceChatActivated: true });
  await client.answer('v=0\r\n');
  await client.registerVoice();
  assert.equal(calls.filter((c) => c.body?.voiceChatActivated === true).length, 1);
  await client.stopVoice();
  assert.deepEqual(calls.at(-1).body, { voiceChatActivated: false });
  assert.equal(client.active.voiceActivated, false);
});

test('a party with no joinable bridge is refused rather than having one created', async () => {
  const calls = [];
  const client = authed(async (url, options) => {
    calls.push({ url, method: options.method });
    if (options.method === 'GET')
      return json({ v2PartySessions: [{ sessionId: ID, bridges: [] }] });
    return new Response(null, { status: 202 });
  });
  client.active = { id: ID, bridge: null, peerId: null, ownsBridge: false, bridgeLinked: false };
  await assert.rejects(client.prepareVoice(), { code: 'NO_JOINABLE_BRIDGE' });
  // The party must not be mutated: no bridge created, none linked.
  assert.equal(
    calls.some((c) => c.url.endsWith('/rtcBridge/v1/bridges') && c.method === 'POST'),
    false,
  );
  assert.equal(
    calls.some((c) => c.url.endsWith(`/partySessions/${ID}/bridges`)),
    false,
  );
  assert.equal(client.active.bridge, null);
});

test('failed link cleans up a newly created unshared bridge when creation is explicitly enabled', async () => {
  const calls = [];
  const client = authed(async (url, options) => {
    calls.push({ url, method: options.method });
    if (options.method === 'GET')
      return json({ v2PartySessions: [{ sessionId: ID, bridges: [] }] });
    if (url.endsWith('/rtcBridge/v1/bridges'))
      return json({ bridge: { bridgeId: BRIDGE, bridgeToken: 'private' } });
    if (url.endsWith(`/partySessions/${ID}/bridges`)) return json({}, 400);
    return new Response(null, { status: 202 });
  });
  client.allowBridgeCreation = true;
  client.active = { id: ID, bridge: null, peerId: null, ownsBridge: false, bridgeLinked: false };
  await assert.rejects(client.prepareVoice());
  assert.equal(calls.at(-1).method, 'DELETE');
  assert.ok(calls.at(-1).url.endsWith(`/bridges/${BRIDGE}`));
  assert.equal(client.active.bridge, null);
});

test('browser rejects nonstandard Opus clock rather than pretending SDP rewriting works', () => {
  const result = inspectOffer(
    'v=0\r\na=rtpmap:111 opus/16000/2\r\na=extmap:2 urn:sony:rtp-payload-signature\r\n',
  );
  assert.equal(result.compatible, false);
  assert.equal(result.sonySignature, true);
  assert.match(result.reason, /native media adapter/);
  assert.equal(inspectOffer('v=0\r\na=rtpmap:111 opus/48000/2\r\n').compatible, true);
});
