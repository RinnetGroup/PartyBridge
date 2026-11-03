import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import http from 'node:http';

async function fixture(run) {
  const calls = [],
    state = { sessions: new Map(), clients: new Set() };
  const client = {
    accountId: '88',
    tokens: {},
    profile: { accountId: '88', onlineId: 'Fixture' },
    events: [],
    active: null,
    api: async (path, options) => {
      calls.push({ path, ...options });
      return path.includes('/profiles')
        ? {
            onlineId: 'Fixture',
            avatars: [
              {
                size: 'm',
                url: 'https://image.api.playstation.com/fixture.png',
              },
            ],
          }
        : { trophyLevel: 10, earnedTrophies: { gold: 2 } };
    },
    fetch: async () =>
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'Content-Type': 'image/png' },
      }),
    leave: async () => {},
    clear() {
      this.tokens = null;
    },
  };
  const app = createApp({ clientFactory: () => client, state });
  const url = await app.listen(0);
  const response = await fetch(url + '/api/bootstrap'),
    bootstrap = await response.json();
  const headers = {
    Cookie: response.headers.get('set-cookie').split(';')[0],
    'X-PartyBridge-CSRF': bootstrap.csrf,
    'Content-Type': 'application/json',
  };
  try {
    await run({ url, headers, client, calls, state });
  } finally {
    await app.close();
  }
}

test("browser message-history requests accept Sony's tilde conversation IDs", async () =>
  fixture(async ({ url, headers, client, calls }) => {
    const groupId = '~mpsn.1.01.fixture-conversation';
    client.api = async (path, options) => {
      calls.push({ path, ...options });
      return path.includes('/messages')
        ? {
            messages: [
              {
                messageUid: '1#1',
                body: 'Fixture history',
                sender: { accountId: '99', onlineId: 'Friend' },
              },
            ],
          }
        : {
            groupName: { value: 'Fixture conversation' },
            mainThread: { threadId: groupId },
            members: [],
          };
    };
    const response = await fetch(
      url + '/api/app/messages?' + new URLSearchParams({ groupId, limit: '50' }),
      { headers },
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.items[0].body, 'Fixture history');
    assert.equal(data.group.id, groupId);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => !call.method));
  }));

test('photos require CSRF and image bytes before the upload-and-message sequence', async () =>
  fixture(async ({ url, headers, client, calls }) => {
    const uploads = [];
    client.accessToken = async () => 'fixture';
    client.request = async (url, options) => {
      uploads.push({ url, ...options });
      return { resourceId: 'photo-1' };
    };
    client.api = async (path, options) => {
      calls.push({ path, ...options });
      return { mainThread: { threadId: 'thread-1' }, members: [] };
    };
    const photoHeaders = { ...headers, 'Content-Type': 'image/png' },
      body = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(
      (
        await fetch(url + '/api/app/photo?groupId=group-1', {
          method: 'POST',
          headers: { Cookie: headers.Cookie, 'Content-Type': 'image/png' },
          body,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url + '/api/app/photo?groupId=group-1', {
          method: 'POST',
          headers: photoHeaders,
          body: 'not an image',
        })
      ).status,
      400,
    );
    assert.equal(uploads.length, 0);
    assert.equal(
      (
        await fetch(url + '/api/app/photo?groupId=group-1', {
          method: 'POST',
          headers: photoHeaders,
          body,
        })
      ).status,
      200,
    );
    assert.equal(uploads.length, 1);
    assert.deepEqual(calls.at(-1).body, {
      messageType: 3,
      messageDetail: { imageMessageDetail: { resourceId: 'photo-1' } },
    });
  }));

test('authenticated message media sends its bearer only to the Sony API origin', async () =>
  fixture(async ({ url, headers, client, state }) => {
    await fetch(url + '/api/app/trophy-summary', { headers });
    const features = [...state.sessions.values()][0].appFeatures;
    const media = features.resource('group-1', 'resource-1'),
      requests = [];
    client.accessToken = async () => 'fixture';
    client.fetch = async (target, options) => {
      requests.push({ target, headers: new Headers(options.headers) });
      return requests.length === 1
        ? new Response(null, {
            status: 302,
            headers: {
              Location: 'https://image.api.playstation.com/fixture.png',
            },
          })
        : new Response(new Uint8Array([137, 80, 78, 71]), {
            headers: { 'Content-Type': 'image/png' },
          });
    };
    const response = await fetch(url + media, { headers });
    await response.arrayBuffer();
    assert.equal(response.status, 200);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers.get('Authorization'), 'Bearer fixture');
    assert.equal(requests[1].headers.get('Authorization'), null);
  }));

test('app routes require the existing session and CSRF, and expose no arbitrary upstream proxy', async () =>
  fixture(async ({ url, headers, calls }) => {
    assert.equal((await fetch(url + '/api/app/trophy-summary')).status, 401);
    assert.equal(
      (
        await fetch(url + '/api/app/trophy-summary', {
          headers: { Cookie: headers.Cookie },
        })
      ).status,
      403,
    );
    const response = await fetch(url + '/api/app/trophy-summary', { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).level, 10);
    assert.equal((await fetch(url + '/api/app/https://evil.test', { headers })).status, 404);
    assert.equal(calls.length, 1);
  }));

test('opening the public frontend from a link works without allowing cross-site API access', async () =>
  fixture(async ({ url, headers }) => {
    const navigation = {
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
    };
    const status = await new Promise((resolve, reject) => {
      http
        .get(url, { headers: navigation }, (response) => {
          response.resume();
          resolve(response.statusCode);
        })
        .on('error', reject);
    });
    assert.equal(status, 200);
    assert.equal(
      (
        await fetch(url + '/api/app/trophy-summary', {
          headers: { ...headers, ...navigation },
        })
      ).status,
      403,
    );
    assert.equal((await fetch(url + '/api/bootstrap', { headers: navigation })).status, 403);
  }));

test('new feature requests do not take the voice transaction lock', async () =>
  fixture(async ({ url, headers, state }) => {
    [...state.sessions.values()][0].busy = true;
    assert.equal((await fetch(url + '/api/app/trophy-summary', { headers })).status, 200);
    [...state.sessions.values()][0].accountChanging = true;
    assert.equal((await fetch(url + '/api/app/trophy-summary', { headers })).status, 409);
  }));

test('app mutations require JSON and CSRF and only execute an explicit supported action', async () =>
  fixture(async ({ url, headers, calls }) => {
    const request = {
      method: 'POST',
      body: JSON.stringify({ action: 'friend.accept', accountId: '99' }),
    };
    assert.equal(
      (
        await fetch(url + '/api/app/action', {
          ...request,
          headers: {
            Cookie: headers.Cookie,
            'Content-Type': 'application/json',
          },
        })
      ).status,
      403,
    );
    assert.equal(calls.length, 0);
    assert.equal((await fetch(url + '/api/app/action', { ...request, headers })).status, 200);
    assert.equal(calls.at(-1).method, 'PUT');
    assert.equal(
      (
        await fetch(url + '/api/app/action', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            action: 'raw.fetch',
            url: 'https://evil.test',
          }),
        })
      ).status,
      404,
    );
    assert.equal(calls.length, 1);
  }));

test('media URLs are registered by Sony responses and served only to the account session', async () =>
  fixture(async ({ url, headers }) => {
    const profile = await fetch(url + '/api/app/profile', { headers }).then((r) => r.json());
    assert.match(profile.avatar, /^\/api\/app\/media\//);
    assert.equal((await fetch(url + profile.avatar)).status, 401);
    const media = await fetch(url + profile.avatar, {
      headers: { Cookie: headers.Cookie },
    });
    assert.equal(media.status, 200);
    assert.equal(media.headers.get('content-type'), 'image/png');
    assert.equal((await media.arrayBuffer()).byteLength, 4);
    assert.equal(
      (
        await fetch(url + profile.avatar, {
          headers: { Cookie: headers.Cookie, Range: 'bytes=0-5,10-20' },
        })
      ).status,
      416,
    );
  }));
