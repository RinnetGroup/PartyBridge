import test from 'node:test';
import assert from 'node:assert/strict';
import { PsnClient } from '../server/psn.js';
import { partyCreateOptions, partyCreateBody } from '../server/party-create.js';
import { AppError } from '../server/errors.js';
import { createApp } from '../server/index.js';
process.env.NODE_ENV = 'test';
const ID = '12345678-1234-1234-1234-123456789abc';
function client() {
  const c = new PsnClient(),
    calls = [];
  c.tokens = { access: 'fixture' };
  c.accountId = '88';
  c.profile = { accountId: '88', onlineId: 'Fixture' };
  c.push.connect = async () => {};
  c.api = async (path, options) => {
    calls.push({ path, ...options });
    return path.endsWith('/invitations')
      ? {}
      : {
          v2PartySessions: [
            {
              sessionId: ID,
              members: [{ accountId: '88', platform: 'MOBILE_APP', deviceUniqueId: 'fixture' }],
            },
          ],
        };
  };
  return { c, calls };
}

test('native room contract uses one creator membership, push context and explicit open/closed access', () => {
  const options = partyCreateOptions({ name: ' Crew ' });
  const body = partyCreateBody(options, { contextId: 'local', customData4: 'initial' });
  assert.deepEqual(body, {
    v2PartySessions: [
      {
        sessionType: 'ROOM',
        sessionName: 'Crew',
        maxMembers: 16,
        joinableUserType: 'FRIENDS',
        visibilityType: 'FRIENDS_ONLY',
        members: [
          {
            accountId: 'me',
            platform: 'me',
            voiceChatActivated: false,
            customData4: 'initial',
            pushContexts: [{ contextId: 'local' }],
          },
        ],
      },
    ],
  });
  const closed = partyCreateBody(
    partyCreateOptions({ name: 'Private', type: 'closed', maxMembers: 4 }),
    { contextId: 'local', customData4: 'initial' },
  ).v2PartySessions[0];
  assert.equal(closed.joinableUserType, 'INVITE_ONLY');
  assert.equal(closed.visibilityType, 'INVITE_ONLY');
});

test('creation rejects malformed settings before connecting push or sending any upstream request', async () => {
  const { c, calls } = client();
  let pushCalls = 0;
  c.push.connect = async () => pushCalls++;
  for (const value of [
    null,
    [],
    {},
    { name: '\n' },
    { name: 'x'.repeat(33) },
    { name: 'A', type: 'public' },
    { name: 'A', maxMembers: 1 },
    { name: 'A', maxMembers: '16' },
    { name: 'A', invites: ['99', '99'] },
    { name: 'A', invites: ['18446744073709551616'] },
    { name: 'A', invites: [88] },
  ])
    await assert.rejects(c.createParty(value), { status: 400 });
  assert.equal(pushCalls, 0);
  assert.equal(calls.length, 0);
  assert.equal(c.active, null);
});

test('creation adopts its returned membership once and sends only selected invitations in native format', async () => {
  const { c, calls } = client();
  const result = await c.createParty({ name: 'Crew', invites: ['99', '88'] });
  assert.equal(c.active.id, ID);
  assert.equal(result.party.name, 'Crew');
  assert.equal(result.party.members[0].onlineId, 'Fixture');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, '/sessionManager/v2/partySessions');
  assert.deepEqual(calls[1].body, {
    invitations: [{ to: { accountId: '99' } }],
    invitationType: 'NORMAL',
  });
  assert.equal(result.inviteWarning, false);
  assert.equal(c.creatingParty, false);
  await assert.rejects(c.createParty({ name: 'Second' }), { code: 'ALREADY_JOINED' });
  assert.equal(calls.length, 2);
});

test('failed invitations retain the new party rather than repeating creation or deleting it', async () => {
  const { c, calls } = client(),
    api = c.api;
  c.api = async (path, options) => {
    if (path.endsWith('/invitations'))
      throw new AppError(502, 'SONY_PROTOCOL_ERROR', 'Fixture failure');
    return api(path, options);
  };
  const result = await c.createParty({ name: 'Crew', invites: ['99'] });
  assert.equal(result.inviteWarning, true);
  assert.equal(c.active.id, ID);
  assert.equal(calls.length, 1);
});

test('simultaneous create and join cannot start another membership while push is connecting', async () => {
  const { c, calls } = client();
  let release;
  c.push.connect = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const first = c.createParty({ name: 'Crew' });
  await assert.rejects(c.createParty({ name: 'Duplicate' }), { code: 'ALREADY_JOINED' });
  await assert.rejects(c.join(ID), { code: 'ALREADY_JOINED' });
  release();
  await first;
  assert.equal(calls.length, 1);
});

test('account changes or rejected/malformed creation never invent an active party', async () => {
  const { c } = client();
  c.push.connect = async () => {
    c.accountId = '99';
  };
  await assert.rejects(c.createParty({ name: 'Crew' }), { code: 'PARTY_CANCELLED' });
  assert.equal(c.active, null);
  for (const response of [{}, { v2PartySessions: [{ sessionId: 'bad' }] }]) {
    const { c } = client();
    c.api = async () => response;
    await assert.rejects(c.createParty({ name: 'Crew' }), { code: 'PARTY_CREATE_SCHEMA' });
    assert.equal(c.active, null);
    assert.equal(c.creatingParty, false);
  }
  const failed = client();
  let attempts = 0;
  failed.c.api = async () => {
    attempts++;
    throw new AppError(502, 'SONY_UNREACHABLE', 'Fixture timeout');
  };
  await assert.rejects(failed.c.createParty({ name: 'Crew' }), {
    code: 'PARTY_CREATE_UNCONFIRMED',
  });
  assert.equal(attempts, 1);
  assert.equal(failed.c.active, null);
});

test('HTTP controls require CSRF, validate leveling, persist its choice and apply it to a live engine', async () => {
  const { c, calls } = client(),
    state = { sessions: new Map(), clients: new Set() },
    app = createApp({ clientFactory: () => c, state });
  const url = await app.listen(0),
    boot = await fetch(url + '/api/bootstrap'),
    data = await boot.json();
  const headers = {
    Cookie: boot.headers.get('set-cookie').split(';')[0],
    'X-PartyBridge-CSRF': data.csrf,
    'Content-Type': 'application/json',
  };
  const post = (path, body, custom = headers) =>
    fetch(url + path, { method: 'POST', headers: custom, body: JSON.stringify(body) });
  try {
    assert.equal(
      (
        await post(
          '/api/party/create',
          { name: 'No CSRF' },
          { ...headers, 'X-PartyBridge-CSRF': '' },
        )
      ).status,
      403,
    );
    assert.equal(calls.length, 0);
    assert.equal((await post('/api/audio/leveling', { enabled: 'true' })).status, 400);
    assert.deepEqual(await (await post('/api/audio/leveling', { enabled: true })).json(), {
      enabled: true,
      voiceActive: false,
    });
    const session = [...state.sessions.values()][0],
      applied = [];
    session.voiceEngine = {
      stopped: false,
      setSmartLeveling: (enabled) => applied.push(enabled),
      stop: async () => {},
    };
    assert.deepEqual(await (await fetch(url + '/api/audio/leveling', { headers })).json(), {
      enabled: true,
      voiceActive: true,
    });
    assert.deepEqual(applied, [true]);
    const created = await post('/api/party/create', { name: 'Crew', type: 'closed' });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).party.id, ID);
    assert.equal((await post('/api/party/create', { name: 'Second' })).status, 409);
    assert.equal(calls.length, 1);
  } finally {
    c.active = null;
    await app.close();
  }
});
