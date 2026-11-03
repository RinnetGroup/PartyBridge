import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { once } from 'node:events';
import { createApp } from '../server/index.js';

async function withApp(fn) {
  const app = createApp();
  const url = await app.listen(0);
  try {
    await fn(url);
  } finally {
    await app.close();
  }
}
async function session(url) {
  const response = await fetch(url + '/api/bootstrap');
  const data = await response.json();
  return {
    Cookie: response.headers.get('set-cookie').split(';')[0],
    'X-PartyBridge-CSRF': data.csrf,
    'Content-Type': 'application/json',
  };
}

test('helper serves UI and private in-memory session with strict cookie', async () =>
  withApp(async (url) => {
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await page.text(), /PartyBridge/);
    assert.equal((await fetch(url + '/voice-status.js')).status, 200);
    const response = await fetch(url + '/api/bootstrap');
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const body = await response.json();
    assert.equal(body.connected, false);
    assert.equal(body.csrf.length, 64);
    assert.ok(!('tokens' in body));
  }));

test('capture preview is explicitly local and its static assets do not create an account session', async () =>
  withApp(async (url) => {
    const response = await fetch(url + '/screen-capture.html');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.match(await response.text(), /Local preview only/);
    const module = await fetch(url + '/screen-capture.js');
    assert.equal(module.status, 200);
    assert.match(await module.text(), /getDisplayMedia/);
  }));

test('rejects hostile Origin and Host before credential handling', async () =>
  withApp(async (url) => {
    assert.equal(
      (await fetch(url + '/api/bootstrap', { headers: { Origin: 'https://evil.test' } })).status,
      403,
    );
    const hostileHostStatus = await new Promise((resolve, reject) => {
      const request = http.get(
        url + '/api/bootstrap',
        { headers: { Host: 'evil.test' } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
    });
    assert.equal(hostileHostStatus, 403);
  }));

test('mutations require CSRF and JSON, and invalid NPSSO is rejected locally', async () =>
  withApp(async (url) => {
    const headers = await session(url);
    assert.equal(
      (
        await fetch(url + '/api/connect', {
          method: 'POST',
          headers: { Cookie: headers.Cookie, 'Content-Type': 'application/json' },
          body: '{"npsso":"invalid"}',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url + '/api/connect', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'text/plain' },
          body: '{}',
        })
      ).status,
      415,
    );
    const response = await fetch(url + '/api/connect', {
      method: 'POST',
      headers,
      body: '{"npsso":"invalid"}',
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_NPSSO');
  }));

test('unauthenticated party and diagnostics access is bounded', async () =>
  withApp(async (url) => {
    assert.equal((await fetch(url + '/api/parties')).status, 401);
    const headers = await session(url);
    const response = await fetch(url + '/api/parties', { headers });
    assert.equal(response.status, 401);
    const diagnostics = await fetch(url + '/api/diagnostics', { headers });
    assert.equal(diagnostics.status, 200);
    assert.deepEqual((await diagnostics.json()).events, []);
    assert.equal((await fetch(url + '/server/psn.js')).status, 401);
  }));

test('route reload preserves the session and exposes only the protocol module allowlist', async () => {
  let registrations = 0;
  const client = {
    tokens: {},
    profile: null,
    active: null,
    events: [],
    registerVoice: async () => {
      registrations++;
      return { registered: true };
    },
    voiceState: async () => ({ participants: [] }),
    leave: async () => {},
    clear() {},
  };
  const app = createApp({ clientFactory: () => client });
  const url = await app.listen(0);
  try {
    const headers = await session(url);
    createApp({ state: app.server[Symbol.for('partybridge.runtime')], httpServer: app.server });
    assert.equal(
      (await fetch(url + '/api/bootstrap', { headers })).headers.get('set-cookie'),
      null,
    );
    assert.deepEqual(
      await (
        await fetch(url + '/api/voice/register', { method: 'POST', headers, body: '{}' })
      ).json(),
      { registered: true },
    );
    assert.equal(registrations, 1);
    assert.deepEqual(await (await fetch(url + '/api/voice/state', { headers })).json(), {
      participants: [],
    });
    assert.equal((await fetch(url + '/protocol/voice-session.js')).status, 200);
    assert.equal((await fetch(url + '/protocol/party-data.js')).status, 200);
    assert.equal((await fetch(url + '/protocol/other.js', { headers })).status, 404);
  } finally {
    await app.close();
  }
});

test('an old browser socket cannot stop its replacement and duplicate start messages cannot create two engines', async () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((yes) => {
      resolve = yes;
    });
    return { promise, resolve };
  };
  const firstStarted = deferred(),
    firstGate = deferred(),
    muted = deferred(),
    secondStarted = deferred();
  const engines = [];
  const client = {
    tokens: {},
    profile: null,
    active: { id: 'party' },
    events: [],
    record(step, status) {
      this.events.push({ step, status });
    },
    leave: async () => {},
    clear() {},
  };
  const app = createApp({
    clientFactory: () => client,
    voiceEngineFactory: () => {
      const index = engines.length;
      const engine = {
        stops: 0,
        async start() {
          if (index === 0) {
            firstStarted.resolve();
            await firstGate.promise;
          } else secondStarted.resolve();
        },
        async stop() {
          this.stops++;
        },
        setMuted() {
          muted.resolve();
        },
        pushMic() {},
      };
      engines.push(engine);
      return engine;
    },
  });
  const url = await app.listen(0),
    headers = await session(url);
  const bootstrap = await fetch(url + '/api/bootstrap', { headers }).then((r) => r.json());
  const address = url.replace('http:', 'ws:') + '/ws?csrf=' + bootstrap.csrf;
  let first, second;
  try {
    first = new WebSocket(address, { headers: { Cookie: headers.Cookie } });
    await once(first, 'open');
    first.send(JSON.stringify({ t: 'start', partyId: 'party' }));
    first.send(JSON.stringify({ t: 'start', partyId: 'party' }));
    await firstStarted.promise;
    first.send(JSON.stringify({ t: 'mute', on: true }));
    await muted.promise;
    assert.equal(engines.length, 1);
    firstGate.resolve();
    const oldClosed = once(first, 'close');
    second = new WebSocket(address, { headers: { Cookie: headers.Cookie } });
    await once(second, 'open');
    await oldClosed;
    second.send(JSON.stringify({ t: 'start', partyId: 'party' }));
    await secondStarted.promise;
    assert.equal(engines.length, 2);
    assert.equal(engines[0].stops, 1);
    assert.equal(engines[1].stops, 0);
  } finally {
    firstGate.resolve();
    const pending = [first, second]
      .filter((ws) => ws && ws.readyState !== WebSocket.CLOSED)
      .map((ws) => {
        const closed = once(ws, 'close');
        ws.close();
        return closed;
      });
    await Promise.all(pending);
    await app.close();
  }
});

test('audio controls apply saved leveling at startup and update a live call without replacing its socket', async () => {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const client = {
    tokens: {},
    profile: null,
    active: { id: 'party' },
    events: [],
    record() {},
    leave: async () => {},
    clear() {},
  };
  const engine = {
    starts: 0,
    stops: 0,
    async start() {
      this.starts++;
      started();
    },
    async stop() {
      this.stops++;
    },
    setAudioVolume(value) {
      this.volume = value;
    },
    setSmartLeveling(value) {
      this.leveling = value;
    },
  };
  const app = createApp({ clientFactory: () => client, voiceEngineFactory: () => engine });
  const url = await app.listen(0),
    headers = await session(url),
    bootstrap = await fetch(url + '/api/bootstrap', { headers }).then((r) => r.json());
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws?csrf=' + bootstrap.csrf, {
    headers: { Cookie: headers.Cookie },
  });
  try {
    await once(ws, 'open');
    const saved = await fetch(url + '/api/audio/leveling', {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabled: true }),
    }).then((r) => r.json());
    assert.deepEqual(saved, { enabled: true, voiceActive: false });
    ws.send(JSON.stringify({ t: 'start', partyId: 'party' }));
    await ready;
    assert.equal(engine.leveling, true);
    const update = await fetch(url + '/api/audio/volume', {
      method: 'POST',
      headers,
      body: JSON.stringify({ microphone: 75 }),
    }).then((r) => r.json());
    assert.deepEqual(update, { microphone: 75, party: 100, voiceActive: true });
    assert.deepEqual(engine.volume, { microphone: 75, party: 100 });
    assert.equal(engine.starts, 1);
    assert.equal(engine.stops, 0);
    assert.equal(ws.readyState, WebSocket.OPEN);
    const smart = await fetch(url + '/api/audio/leveling', {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabled: false }),
    }).then((r) => r.json());
    assert.deepEqual(smart, { enabled: false, voiceActive: true });
    assert.equal(engine.leveling, false);
    assert.equal(engine.starts, 1);
    assert.equal(engine.stops, 0);
    assert.equal(ws.readyState, WebSocket.OPEN);
    assert.equal(
      (await fetch(url + '/api/audio/volume', { method: 'POST', headers, body: '{"party":201}' }))
        .status,
      400,
    );
    assert.deepEqual(
      await fetch(url + '/api/audio/volume', { headers }).then((r) => r.json()),
      update,
    );
    assert.equal((await fetch(url + '/volume.html')).status, 200);
    assert.equal((await fetch(url + '/volume-controls.js')).status, 200);
  } finally {
    const closed = once(ws, 'close');
    ws.close();
    await closed;
    await app.close();
  }
});
