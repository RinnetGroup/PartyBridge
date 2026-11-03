import test from 'node:test';
import assert from 'node:assert/strict';
import { AppFeatures, allowedMediaUrl, externalLink } from '../server/app-features.js';
import { AppHub, formatDuration, formatDate, sortedMessages } from '../public/hub.js';

function fixture(reply = () => ({})) {
  const calls = [];
  const client = {
    tokens: {},
    accountId: '88',
    api: async (path, options) => {
      calls.push({ path, ...options });
      return reply(path, options);
    },
  };
  return { features: new AppFeatures(client), client, calls };
}
const group = {
  groupName: { value: 'Friends' },
  mainThread: { threadId: 'thread-7' },
  members: [
    { accountId: '88', onlineId: 'Me' },
    { accountId: '99', onlineId: 'Friend' },
  ],
};

test('friend profiles retain uint64 IDs and attach independent presence without exposing upstream fields', async () => {
  const ids = ['9223372036854775806', '99'];
  const f = fixture((path) =>
    path.includes('/profiles')
      ? {
          profiles: [{ onlineId: 'First', secret: 'private' }, { onlineId: 'Second' }],
        }
      : path.includes('basicPresences')
        ? {
            basicPresences: [
              {
                accountId: ids[0],
                primaryPlatformInfo: {
                  onlineStatus: 'online',
                  platform: 'PS5',
                },
              },
            ],
          }
        : { friends: ids, totalItemCount: 2 },
  );
  const data = await f.features.read('friends');
  assert.deepEqual(
    data.items.map((p) => p.accountId),
    ids,
  );
  assert.equal(data.items[0].status, 'online');
  assert.equal(data.items[0].secret, undefined);
  assert.equal(data.nextOffset, null);
});

test('localized group reads use the recovered header and actual main thread for messages', async () => {
  const f = fixture((path) =>
    path.includes('/messages')
      ? {
          messages: [
            {
              messageUid: '1#123',
              body: 'Hello',
              sender: { accountId: '99', onlineId: 'Friend' },
              createdTimestamp: '1700000000000',
            },
          ],
        }
      : group,
  );
  const data = await f.features.read('messages', { groupId: 'group-7' });
  assert.equal(data.group.threadId, 'thread-7');
  assert.equal(data.items[0].body, 'Hello');
  assert.equal(f.calls[0].headers['Accept-Language'], 'en-US');
  assert.match(f.calls[1].path, /threads\/thread-7\/messages/);
});

test('text sends exactly one recovered POST after explicit action; reads never send messages', async () => {
  const f = fixture(() => group);
  await f.features.read('messages', { groupId: 'group-7' });
  assert.ok(f.calls.every((c) => !c.method));
  f.calls.length = 0;
  await f.features.action('message.send', {
    groupId: 'group-7',
    text: '  Hello <script>  ',
  });
  const writes = f.calls.filter((c) => c.method);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { messageType: 1, body: 'Hello <script>' });
  assert.equal(writes[0].method, 'POST');
  await f.features.action('message.hide', {
    groupId: 'group-7',
    messageId: '1#123',
  });
  assert.equal(f.calls.at(-1).method, 'DELETE');
  assert.match(
    f.calls.at(-1).path,
    /members\/me\/groups\/group-7\/threads\/thread-7\/messages\/1%23123$/,
  );
});

test('unknown operations, path traversal, oversized messages and self friendship are rejected before a mutation', async () => {
  const f = fixture(() => group);
  for (const [action, params] of [
    ['raw.fetch', { url: 'https://evil.test' }],
    ['message.send', { groupId: '../../bad', text: 'hi' }],
    ['message.send', { groupId: 'valid', text: 'x'.repeat(1001) }],
    ['friend.request', { accountId: '88' }],
    ['presence.offline', { enabled: 'false' }],
  ])
    await assert.rejects(f.features.action(action, params));
  assert.equal(f.calls.length, 0);
});

test('friend, group and presence controls serialize only their specific request shapes', async () => {
  const f = fixture(() => ({}));
  await f.features.action('friend.accept', { accountId: '99' });
  assert.equal(f.calls.at(-1).method, 'PUT');
  await f.features.action('group.create', { accountIds: ['99', '99'] });
  assert.deepEqual(f.calls.at(-1).body, { invitees: [{ accountId: '99' }] });
  await f.features.action('group.invite', {
    groupId: 'g-1',
    accountIds: ['9223372036854775806', '99'],
  });
  assert.match(f.calls.at(-1).path, /groups\/g-1\/invitees$/);
  assert.deepEqual(f.calls.at(-1).body, {
    invitees: [{ accountId: '9223372036854775806' }, { accountId: '99' }],
  });
  await f.features.action('group.rename', { groupId: 'g-1', name: ' Squad ' });
  assert.deepEqual(f.calls.at(-1).body, { groupName: { value: 'Squad' } });
  await f.features.action('presence.offline', { enabled: true });
  assert.deepEqual(f.calls.at(-1).body, { settingValue: true });
});

test('Sony conversation IDs with tildes retain group details and support history and sends', async () => {
  const groupId = '~mpsn.1.01.fixture-conversation',
    threadId = '~mpsn.1.01.fixture-thread';
  const f = fixture((path, options) => {
    if (path.includes('/messages'))
      return {
        messages: [
          {
            messageUid: '1#123',
            body: 'Fixture message',
            sender: { accountId: '99', onlineId: 'Friend' },
          },
        ],
      };
    if (path.includes('/members/me/groups?')) return { groups: [{ groupId }], nextOffset: null };
    return { ...group, mainThread: { threadId } };
  });
  const groups = await f.features.read('groups');
  assert.equal(groups.items[0].name, 'Friends');
  assert.equal(groups.items[0].threadId, threadId);
  const messages = await f.features.read('messages', { groupId, limit: 50 });
  assert.equal(messages.items[0].body, 'Fixture message');
  await f.features.action('message.send', { groupId, text: 'Fixture reply' });
  const writes = f.calls.filter((call) => call.method);
  assert.equal(writes.length, 1);
  assert.equal(
    writes[0].path,
    `/gamingLoungeGroups/v1/groups/${groupId}/threads/${threadId}/messages`,
  );
  assert.deepEqual(writes[0].body, { messageType: 1, body: 'Fixture reply' });
  for (const invalid of ['../other', '~chat/../other', '~chat?other', '~chat\nother'])
    await assert.rejects(f.features.read('messages', { groupId: invalid }), {
      code: 'INVALID_APP_INPUT',
    });
});

test('console actions require a device returned for this account and keep its DUID out of the browser DTO', async () => {
  const f = fixture((path) =>
    path.includes('/clients')
      ? {
          clients: [
            {
              duid: 'private-device',
              platform: 'PS5',
              device: { name: 'Living room' },
            },
          ],
        }
      : {},
  );
  await assert.rejects(f.features.action('console.wake', { consoleId: 'guessed' }));
  const devices = await f.features.read('consoles');
  assert.equal(devices.items[0].duid, undefined);
  assert.equal(f.calls[0].headers['X-Psn-Can-Mobile-App-Type'], 'PSAPP');
  await f.features.action('console.launch', {
    consoleId: devices.items[0].id,
    titleId: 'PPSA00001_00',
  });
  assert.deepEqual(f.calls.at(-1).body, {
    commandDetail: {
      platform: 'PS5',
      duid: 'private-device',
      commandType: 'launchTitle',
      parameters: { titleIds: ['PPSA00001_00'] },
    },
  });
  await f.features.action('console.download', {
    consoleId: devices.items[0].id,
    entitlementId: 'product-1',
  });
  assert.equal(f.calls.at(-1).body[0].platform, 'PS5');
});

test('trophy definitions and earnings merge by trophy ID rather than response order', async () => {
  const f = fixture((path) =>
    path.includes('/users/')
      ? {
          trophies: [
            { trophyId: 2, earned: true },
            { trophyId: 1, earned: false },
          ],
        }
      : {
          trophies: [
            { trophyId: 1, trophyName: 'First', trophyHidden: true },
            { trophyId: 2, trophyName: 'Second' },
          ],
          totalItemCount: 2,
        },
  );
  const result = await f.features.read('trophy-detail', {
    titleId: 'NPWR00001_00',
    service: 'trophy2',
  });
  assert.equal(result.items[0].earned, false);
  assert.equal(result.items[1].earned, true);
  assert.ok(f.calls.every((c) => c.path.includes('npServiceName=trophy2')));
});

test('media registration accepts only HTTPS Sony hosts, not arbitrary URLs or credentials', () => {
  for (const url of [
    'http://image.api.playstation.com/x',
    'https://playstation.com.evil.test/x',
    'https://127.0.0.1/x',
    'https://secret@image.api.playstation.com/x',
    'https://image.api.playstation.com:444/x',
    'javascript:alert(1)',
  ])
    assert.equal(allowedMediaUrl(url), null);
  const f = fixture(),
    uri = f.features.image('https://image.api.playstation.com/game.png?private=signature');
  assert.match(uri, /^\/api\/app\/media\//);
  assert.ok(!uri.includes('signature'));
  assert.equal(f.features.image('https://evil.test/x'), null);
  assert.equal(externalLink('javascript:alert(1)'), null);
});

test('clearing an account prevents an in-flight response from leaking into a replacement account', async () => {
  let resolve;
  const pending = new Promise((r) => (resolve = r));
  const f = fixture(() => pending);
  const response = f.features.read('trophy-summary');
  f.features.clear();
  resolve({ trophyLevel: 42 });
  await assert.rejects(response, /Connect your account again/);
  assert.equal(f.features.media.size, 0);
});

test('cached reads deduplicate upstream requests, while an explicit refresh gets fresh data', async () => {
  const f = fixture(() => ({ trophyLevel: 5 }));
  await Promise.all([f.features.read('trophy-summary'), f.features.read('trophy-summary')]);
  assert.equal(f.calls.length, 1);
  await f.features.read('trophy-summary', { refresh: '1' });
  assert.equal(f.calls.length, 2);
});

test('frontend duration/date formatting and message ordering cope with empty and repeated server data', () => {
  assert.equal(formatDuration('PT78H20M32S'), '78h 20m');
  assert.equal(formatDuration('P1DT1H'), '25h 0m');
  assert.equal(formatDuration('unknown'), '');
  assert.equal(formatDate('invalid'), '');
  const messages = [
    { id: 'new', createdAt: '1700000001000' },
    { id: 'old', createdAt: '1700000000000' },
    { id: 'new', createdAt: '1700000001000' },
  ];
  assert.deepEqual(
    sortedMessages(messages).map((m) => m.id),
    ['old', 'new'],
  );
});

test('navigation state never shadows a page renderer', () => {
  const originalDocument = globalThis.document,
    originalInterval = globalThis.setInterval;
  const element = () => ({
    children: [],
    dataset: {},
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = children;
    },
    setAttribute() {},
  });
  const roots = {};
  globalThis.document = {
    createElement: element,
    getElementById: (id) => (roots[id] ??= element()),
  };
  globalThis.setInterval = () => 0;
  try {
    const hub = new AppHub({
      api: async () => ({}),
      getContext: () => ({ connected: false }),
      toast() {},
    });
    for (const item of hub.nav.children)
      if (item.dataset.tab !== 'party') assert.equal(typeof hub[item.dataset.tab], 'function');
  } finally {
    globalThis.document = originalDocument;
    globalThis.setInterval = originalInterval;
  }
});

test('the native owned-library request includes readable game metadata and filters game packages', async () => {
  const f = fixture(() => ({
    entitlements: [
      {
        id: 'license-1',
        activeFlag: true,
        isGame: true,
        titleMeta: {
          name: 'Readable game',
          iconUrl: 'https://image.api.playstation.com/game.png',
        },
        gameMeta: { packageType: 'PS4GD' },
      },
    ],
    totalResults: 1,
  }));
  const result = await f.features.read('owned');
  assert.equal(result.items[0].name, 'Readable game');
  assert.equal(result.items[0].platform, 'PS4');
  const url = new URL('https://example.test' + f.calls[0].path);
  assert.ok(url.searchParams.get('fields').includes('titleMeta'));
  assert.equal(url.searchParams.get('gameMetaPackageType'), 'PSGD,PS4GD');
});

test('capture browsing uses the app category/type route and deleted notification records stay hidden', async () => {
  const f = fixture((path) =>
    path.includes('gameMediaService')
      ? {
          ugcDocument: [{ ugcId: 'capture-1', title: 'Screenshot', ugcType: 'screenshot' }],
        }
      : {
          notifications: [
            { notificationId: 'gone', state: 'Deleted' },
            { notificationId: 'new', state: 'Unread', title: 'Friend request' },
          ],
        },
  );
  const captures = await f.features.read('captures', { type: 'screenshot' });
  assert.match(f.calls[0].path, /cloudMediaGallery\/ugcType\/screenshot/);
  assert.equal(captures.items[0].id, 'capture-1');
  const notifications = await f.features.read('notifications');
  assert.deepEqual(
    notifications.items.map((n) => n.id),
    ['new'],
  );
  await f.features.read('captures', { type: 'video', cursor: 'next-page' });
  assert.equal(
    new URL('https://example.test' + f.calls.at(-1).path).searchParams.get('nextCursorMark'),
    'next-page',
  );
});

test('search maps the live result wrapper, HTTPS avatars, game media and store product IDs', async () => {
  const other = '9223372036854775806';
  const f = fixture((path) => {
    const users =
      JSON.parse(new URL('https://example.test' + path).searchParams.get('variables'))
        .searchContext === 'MobileUniversalSearchSocial';
    return {
      data: {
        universalContextSearch: {
          results: [
            {
              searchResults: [
                {
                  id: 'outer-id',
                  result: users
                    ? {
                        accountId: other,
                        onlineId: 'Friend',
                        avatarUrl: 'http://static-resource.np.community.playstation.net/avatar.png',
                        relationshipState: 'friend',
                      }
                    : {
                        id: '10001',
                        name: 'Astro',
                        media: [
                          {
                            type: 'IMAGE',
                            role: 'MASTER',
                            url: 'https://image.api.playstation.com/game.png',
                          },
                        ],
                        platforms: ['PS5'],
                        defaultProduct: {
                          id: 'UP0001-ABCD00001_00-GAME000000000001',
                        },
                      },
                },
              ],
            },
          ],
        },
      },
    };
  });
  const users = await f.features.read('search', { q: 'Friend' });
  assert.equal(users.items[0].accountId, other);
  assert.equal(users.items[0].name, 'Friend');
  assert.ok(users.items[0].image);
  assert.equal(
    [...f.features.media.values()][0].url,
    'https://static-resource.np.community.playstation.net/avatar.png',
  );
  const games = await f.features.read('search', { q: 'Astro', type: 'games' });
  assert.equal(games.items[0].name, 'Astro');
  assert.equal(games.items[0].conceptId, '10001');
  assert.match(games.items[0].productId, /^UP0001/);
  assert.ok(games.items[0].image);
  await assert.rejects(
    fixture(() => ({
      errors: [{ message: 'Query unavailable' }],
    })).features.read('search', { q: 'test' }),
    { code: 'APP_SEARCH_UNAVAILABLE' },
  );
});

test('photo sending uploads one bounded image, then posts the recovered image message type', async () => {
  const f = fixture(() => group),
    uploads = [];
  f.client.accessToken = async () => 'fixture';
  f.client.request = async (url, options) => {
    uploads.push({ url, ...options });
    return { resourceId: 'resource-1' };
  };
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await f.features.sendPhoto('group-7', png, 'image/png');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].body, png);
  assert.deepEqual(f.calls.at(-1).body, {
    messageType: 3,
    messageDetail: { imageMessageDetail: { resourceId: 'resource-1' } },
  });
  await assert.rejects(f.features.sendPhoto('group-7', Buffer.from('not a picture'), 'image/png'));
  await assert.rejects(f.features.sendPhoto('group-7', Buffer.alloc(1048577), 'image/png'));
  assert.equal(uploads.length, 1);
});
