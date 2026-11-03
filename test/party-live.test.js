import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createPartyLiveUpdates } from '../public/party-live.js';
import { readPartyList, invalidatePartyList } from '../server/party-updates.js';
import { createApp } from '../server/index.js';
process.env.NODE_ENV = 'test';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function fixture(refresh = async () => true) {
  let time = 0,
    serial = 0,
    visible = true,
    online = true;
  const timers = new Map(),
    sockets = [],
    context = { connected: true, csrf: 'fixture-csrf', profile: {}, busy: false };
  const live = createPartyLiveUpdates({
    getContext: () => context,
    refresh,
    visible: () => visible,
    online: () => online,
    socketUrl: () => new URL('ws://localhost/party-updates'),
    now: () => time,
    setTimer: (fn, delay) => {
      timers.set(++serial, { fn, at: time + delay });
      return serial;
    },
    clearTimer: (id) => timers.delete(id),
    socketFactory: (url) => {
      const ws = {
        url,
        close() {
          this.closed = true;
          this.onclose?.();
        },
      };
      sockets.push(ws);
      return ws;
    },
  });
  return {
    live,
    context,
    sockets,
    timers,
    setVisible: (value) => {
      visible = value;
    },
    setOnline: (value) => {
      online = value;
    },
    async advance(ms) {
      const end = time + ms;
      while (true) {
        const next = [...timers]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      time = end;
      await flush();
    },
  };
}

test('party push refreshes immediately, coalesces bursts and keeps a periodic fallback', async () => {
  let reads = 0;
  const f = fixture(async (options) => {
    assert.equal(options.quiet, true);
    reads++;
    return true;
  });
  f.live.sync();
  await f.advance(0);
  assert.equal(reads, 1);
  assert.equal(f.sockets.length, 1);
  for (let i = 0; i < 30; i++) f.sockets[0].onmessage({ data: '{"t":"parties-changed"}' });
  await f.advance(999);
  assert.equal(reads, 1);
  await f.advance(1);
  assert.equal(reads, 2);
  await f.advance(15000);
  assert.equal(reads, 3);
  f.live.stop();
  assert.equal(f.timers.size, 0);
  assert.equal(f.sockets[0].closed, true);
});

test('push during a slow read queues one fresh read without overlapping requests', async () => {
  let reads = 0;
  const pending = deferred();
  const f = fixture(async () => {
    reads++;
    if (reads === 1) await pending.promise;
    return true;
  });
  f.live.sync();
  await f.advance(0);
  assert.equal(reads, 1);
  for (let i = 0; i < 10; i++) f.sockets[0].onmessage({ data: '{"t":"parties-changed"}' });
  await f.advance(5000);
  assert.equal(reads, 1);
  pending.resolve();
  await flush();
  await f.advance(0);
  assert.equal(reads, 2);
  f.live.stop();
});

test('party updates pause for hidden, offline and signed-out pages and resume on return', async () => {
  let reads = 0;
  const f = fixture(async () => {
    reads++;
    return true;
  });
  f.live.sync();
  await f.advance(0);
  f.setVisible(false);
  f.live.sync();
  await f.advance(60000);
  assert.equal(reads, 1);
  assert.equal(f.sockets[0].closed, true);
  f.setVisible(true);
  f.live.sync();
  await f.advance(0);
  assert.equal(reads, 2);
  f.setOnline(false);
  f.live.sync();
  await f.advance(60000);
  assert.equal(reads, 2);
  f.setOnline(true);
  f.context.busy = true;
  f.live.sync();
  await f.advance(3000);
  assert.equal(reads, 2);
  f.context.busy = false;
  await f.advance(1000);
  assert.equal(reads, 3);
  f.context.connected = false;
  f.live.sync();
  assert.equal(f.timers.size, 0);
});

test('missed push connections reconnect and failed reads back off without stopping fallback updates', async () => {
  let reads = 0;
  const f = fixture(async () => {
    reads++;
    return false;
  });
  f.live.sync();
  await f.advance(0);
  f.sockets[0].onclose();
  await f.advance(1000);
  assert.equal(f.sockets.length, 2);
  await f.advance(29000);
  assert.equal(reads, 2);
  await f.advance(60000);
  assert.equal(reads, 3);
  f.live.stop();
});

test('list reads share a flight and cache without taking the voice action lock; invalidation during a read is retained', async () => {
  let reads = 0;
  const pending = deferred();
  const session = {
    busy: true,
    client: {
      tokens: {},
      accountId: '88',
      profile: {},
      parties: async () => {
        reads++;
        return pending.promise;
      },
    },
  };
  const a = readPartyList(session),
    b = readPartyList(session);
  await flush();
  assert.equal(reads, 1);
  assert.equal(session.busy, true);
  invalidatePartyList(session);
  pending.resolve({ parties: [{ id: 'old' }] });
  await Promise.all([a, b]);
  assert.equal(session.cachedList, null);
  session.client.parties = async () => {
    reads++;
    return { parties: [{ id: 'new' }] };
  };
  assert.equal((await readPartyList(session)).parties[0].id, 'new');
  await readPartyList(session);
  assert.equal(reads, 2);
});

test('an old account read cannot repopulate the list, and rate limits delay retries', async () => {
  const pending = deferred(),
    session = {
      client: { tokens: {}, accountId: '88', profile: {}, parties: () => pending.promise },
    };
  const read = readPartyList(session);
  await flush();
  session.client.accountId = '99';
  session.client.profile = {};
  pending.resolve({ parties: [{ id: 'private-old-account' }] });
  await assert.rejects(read, { code: 'BUSY' });
  assert.equal(session.cachedList, undefined);
  session.client.parties = async () => {
    throw Object.assign(new Error('Limited'), { status: 429 });
  };
  await assert.rejects(readPartyList(session), { status: 429 });
  await assert.rejects(readPartyList(session), { code: 'PARTY_LIST_WAIT' });
});

test('authenticated party updates invalidate warm caches and preserve an existing voice engine', async () => {
  const listeners = new Set();
  let reads = 0,
    connects = 0;
  const client = {
    tokens: {},
    accountId: '88',
    profile: {},
    active: null,
    record() {},
    leave: async () => {},
    clear() {},
    parties: async () => ({ parties: [{ id: String(++reads) }] }),
    push: {
      state: 'authenticated',
      connect: async () => {
        connects++;
      },
      onPartyChanged(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    },
  };
  const state = { sessions: new Map(), clients: new Set() },
    app = createApp({ clientFactory: () => client, state });
  const url = await app.listen(0),
    bootstrap = await fetch(url + '/api/bootstrap'),
    data = await bootstrap.json();
  const headers = {
    Cookie: bootstrap.headers.get('set-cookie').split(';')[0],
    'X-PartyBridge-CSRF': data.csrf,
  };
  const session = [...state.sessions.values()][0],
    engine = { stop: async () => {} };
  session.voiceEngine = engine;
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/party-updates?csrf=' + data.csrf, {
    headers: { Cookie: headers.Cookie, Origin: url },
  });
  const ready = once(ws, 'message');
  try {
    assert.equal(JSON.parse(String((await ready)[0])).t, 'parties-changed');
    assert.equal(
      (await (await fetch(url + '/api/parties', { headers })).json()).parties[0].id,
      '1',
    );
    const notification = once(ws, 'message');
    for (const listener of listeners) listener();
    await notification;
    session.busy = true;
    assert.equal(
      (await (await fetch(url + '/api/parties', { headers })).json()).parties[0].id,
      '2',
    );
    assert.equal(session.voiceEngine, engine);
    assert.equal(session.busy, true);
    assert.equal(connects, 0);
    assert.equal(
      (await fetch(url + '/api/parties', { headers: { Cookie: headers.Cookie } })).status,
      403,
    );
  } finally {
    const closed = once(ws, 'close');
    ws.close();
    await closed;
    session.busy = false;
    await app.close();
    assert.equal(listeners.size, 0);
  }
});
