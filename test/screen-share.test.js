import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  ScreenShareViewer,
  screenShareInfo,
  screenShareList,
  screenAllocation,
  screenMemberKey,
  watchRequestPacket,
  watchingCustomData,
} from '../server/screen-share.js';
import { normalizeParty } from '../server/psn.js';
import { createApp } from '../server/index.js';
import { ScreenSharePlayer } from '../public/screen-share.js';

const SDP =
  'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000\r\n';
const ID = '11111111-1111-4111-8111-111111111111';
const WATCH1 = '22222222-2222-4222-8222-222222222222',
  WATCH2 = '33333333-3333-4333-8333-333333333333';
const allocation = {
  signalingServerAddress: 'ess1-r1-test.signaling.brd.playstation-cloud.com',
  signalingServerPort: '3443',
  sessionID: 'broadcast-session',
  sfuID: 'sfu-test',
  hash: 'PRIVATE-HASH',
};
const custom = (a = allocation) =>
  Buffer.from(
    JSON.stringify({
      Streaming: {
        PreviewId: 'preview',
        SessionId: a.sessionID,
        ConnectionInfo: JSON.stringify(a),
        IsRestricted: false,
      },
    }),
  ).toString('base64');
const makeMember = () => ({
  accountId: '9223372036854775806',
  onlineId: 'Streamer',
  platform: 'PS5',
  deviceUniqueId: 'console-device',
  customData1: custom(),
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

function fixture() {
  const member = makeMember(),
    raw = { sessionId: ID, members: [member] },
    calls = [],
    frames = [],
    sockets = [],
    events = [];
  const client = {
    active: { id: ID },
    accountId: member.accountId,
    party: async () => raw,
    accessToken: async () => 'PRIVATE-USER-TOKEN',
    request: async (url, options) => {
      calls.push({ url, options });
      return url.endsWith('sessionId')
        ? { sessionId: 'viewer-session' }
        : { sessionData: 'PRIVATE-SESSION-DATA' };
    },
    api: async (url, options) => {
      calls.push({ url, options });
      return {};
    },
    record: (step, status) => events.push({ step, status }),
  };
  class Socket extends EventEmitter {
    readyState = 0;
    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit('open');
      });
    }
    send(bytes) {
      const m = JSON.parse(bytes);
      frames.push(m);
      if (!m.request) return;
      const result =
        m.data.method === 'getProfileInfo'
          ? {
              profiles: [
                { heightPx: 360, layerId: 's0' },
                { heightPx: 720, layerId: 's2' },
              ],
            }
          : m.data.method === 'createTransport'
            ? { iceParameters: {}, iceCandidates: [], dtlsParameters: {}, id: 'transport' }
            : m.data.method === 'createRemoteSDPChrome'
              ? { remoteSDP: SDP }
              : {};
      queueMicrotask(() =>
        this.emit(
          'message',
          Buffer.from(JSON.stringify({ response: true, id: m.id, ok: true, data: result })),
        ),
      );
    }
    close() {
      this.readyState = 3;
      queueMicrotask(() => this.emit('close'));
    }
  }
  const viewer = new ScreenShareViewer(client, {
    socketFactory: (url, protocol) => {
      assert.equal(protocol, 'protoo');
      assert.match(
        url,
        /^wss:\/\/ess1-r1-test\.signaling\.brd\.playstation-cloud\.com:3443\/\?data=/,
      );
      return new Socket();
    },
    timeout: 200,
  });
  return { viewer, client, raw, member, calls, frames, sockets, events };
}

test('stream detection uses actual Streaming metadata and keeps connection credentials private', () => {
  const member = makeMember();
  member.isOnShareScreen = false;
  assert.equal(screenShareInfo(member).onlineId, 'Streamer');
  const party = normalizeParty({ sessionId: ID, members: [member] });
  assert.equal(party.members[0].screenShare.memberKey, screenMemberKey(member));
  assert.ok(!JSON.stringify(party).includes('PRIVATE-HASH'));
  assert.ok(!JSON.stringify(screenShareList({ members: [member] })).includes('broadcast-session'));
  assert.equal(screenShareInfo({ ...member, customData1: undefined, isOnShareScreen: true }), null);
  for (const data of [
    'garbage',
    Buffer.from('null').toString('base64'),
    Buffer.from('{"Streaming":[]}').toString('base64'),
  ])
    assert.equal(screenShareInfo({ ...member, customData1: data }), null);
  const phone = { ...member, platform: 'MOBILE_APP', deviceUniqueId: 'phone' };
  assert.notEqual(screenMemberKey(member), screenMemberKey(phone));
});

test('screen allocations cannot direct authenticated signaling to another host', () => {
  for (const host of [
    '127.0.0.1',
    'evil.test',
    'ess.signaling.brd.playstation-cloud.com.evil.test',
    'user@ess.signaling.brd.playstation-cloud.com',
  ]) {
    assert.throws(
      () =>
        screenAllocation({
          ...makeMember(),
          customData1: custom({ ...allocation, signalingServerAddress: host }),
        }),
      { code: 'SCREEN_BAD_ALLOCATION' },
    );
  }
  assert.throws(
    () =>
      screenAllocation({
        ...makeMember(),
        customData1: custom({ ...allocation, signalingServerPort: '80' }),
      }),
    { code: 'SCREEN_BAD_ALLOCATION' },
  );
});

test('native watch packet preserves 64-bit identity and encodes watch instead of request-to-broadcast', () => {
  const p = watchRequestPacket('9223372036854775806', 7);
  assert.equal(p.length, 48);
  assert.equal(p.readUInt32LE(0), 1);
  assert.equal(p.readUInt32LE(4), 7);
  assert.equal(p.readUInt32LE(8), 4);
  assert.equal(p.readBigUInt64LE(16), 9223372036854775806n);
  assert.equal(p.readUInt32LE(24), 100001);
  assert.equal(p.readUInt32LE(40), 4);
  assert.equal(p.readUInt32LE(44), 2);
  assert.throws(() => watchRequestPacket('18446744073709551616', 1));
});

test('watcher announcements preserve uint64 account IDs and unrelated member data', () => {
  const own = {
    customData1: Buffer.from('{"version":4,"otherId":9223372036854775806}').toString('base64'),
  };
  const watching = watchingCustomData(own, '9223372036854775805');
  assert.equal(
    Buffer.from(watching, 'base64').toString(),
    '{"version":4,"otherId":9223372036854775806,"Watching":[9223372036854775805]}',
  );
  const stopped = watchingCustomData({ customData1: watching }, null);
  assert.equal(
    Buffer.from(stopped, 'base64').toString(),
    '{"version":4,"otherId":9223372036854775806}',
  );
});

test('full viewer negotiates a separate receive transport and stop never touches party voice or the broadcast', async () => {
  const f = fixture();
  const offer = await f.viewer.start(screenMemberKey(f.member), SDP);
  assert.equal(offer.sdp, SDP);
  assert.equal(f.viewer.stage, 'answering');
  assert.deepEqual(
    f.frames.filter((m) => m.request).map((m) => m.data.method),
    ['getProfileInfo', 'createTransport', 'createRemoteSDPChrome'],
  );
  assert.ok(f.frames.every((m) => m.destination === allocation.sfuID));
  await f.viewer.answer(SDP);
  assert.equal(f.viewer.stage, 'receiving');
  const auth = JSON.parse(f.calls.find((c) => c.url.includes('authorize/view')).options.body);
  assert.equal(auth.partySessionId, ID);
  assert.equal(auth.userToken, 'PRIVATE-USER-TOKEN');
  assert.ok(!JSON.stringify(f.events).includes('PRIVATE'));
  const control = f.calls.find((c) => c.url.endsWith('customMessage')).options.body;
  assert.equal(control.channel, 'miranda:12');
  assert.equal(control.to[0].platform, 'PS5');
  await Promise.all([f.viewer.stop(), f.viewer.stop()]);
  assert.equal(f.frames.filter((m) => m.data.method === 'closeTransport').length, 1);
  assert.deepEqual(
    f.calls
      .filter((c) => c.options?.body?.isOnShareScreen !== undefined)
      .map((c) => c.options.body.isOnShareScreen),
    [true, false],
  );
  assert.ok(!f.calls.some((c) => /rtcBridge|\/bridges|DELETE/.test(c.url + c.options?.method)));
});

test('preview-only announcements request and wait for actual viewing details', async () => {
  const f = fixture();
  f.member.customData1 = Buffer.from('{"Streaming":{"PreviewId":"preview"}}').toString('base64');
  let waits = 0;
  f.viewer.wait = async () => {
    waits++;
    f.member.customData1 = custom();
  };
  await f.viewer.start(screenMemberKey(f.member), SDP);
  assert.equal(waits, 1);
  await f.viewer.stop();
});

test('watcher metadata and flag use separate Sony PATCH requests and preserve own member data', async () => {
  const f = fixture();
  f.client.deviceId = 'own-mobile';
  f.raw.members.push({
    accountId: f.client.accountId,
    onlineId: 'Self',
    platform: 'MOBILE_APP',
    deviceUniqueId: 'own-mobile',
    customData1: Buffer.from('{"version":4}').toString('base64'),
  });
  const original = f.client.api;
  f.client.api = async (url, options) => {
    if (options.method === 'PATCH')
      assert.equal(Object.keys(options.body).length, 1, 'Sony accepts one patch field only');
    return original(url, options);
  };
  await f.viewer.start(screenMemberKey(f.member), SDP);
  await f.viewer.answer(SDP);
  await f.viewer.stop();
  const patches = f.calls.filter((c) => c.options?.method === 'PATCH').map((c) => c.options.body);
  assert.deepEqual(
    patches.map((p) => Object.keys(p)[0]),
    ['customData1', 'isOnShareScreen', 'customData1', 'isOnShareScreen'],
  );
  assert.equal(
    Buffer.from(patches[0].customData1, 'base64').toString(),
    '{"version":4,"Watching":[9223372036854775806]}',
  );
  assert.equal(Buffer.from(patches[2].customData1, 'base64').toString(), '{"version":4}');
});

test('unknown, restricted, and unsupported-codec views fail before sending a watch request', async () => {
  for (const kind of ['unknown', 'restricted', 'codec']) {
    const f = fixture();
    if (kind === 'restricted')
      f.member.customData1 = Buffer.from(
        '{"Streaming":{"PreviewId":"p","IsRestricted":true}}',
      ).toString('base64');
    await assert.rejects(
      f.viewer.start(
        kind === 'unknown' ? 'missing' : screenMemberKey(f.member),
        kind === 'codec' ? SDP.replace('H264', 'VP8') : SDP,
      ),
    );
    assert.equal(f.calls.length, 0);
    await f.viewer.stop();
  }
});

test('cancelling while authorization is pending cannot open a late socket', async () => {
  const f = fixture(),
    gate = deferred(),
    entered = deferred();
  f.client.request = async () => {
    entered.resolve();
    await gate.promise;
    return { sessionId: 'late' };
  };
  const starting = f.viewer.start(screenMemberKey(f.member), SDP);
  await entered.promise;
  await f.viewer.stop();
  gate.resolve();
  await assert.rejects(starting, { code: 'SCREEN_CANCELLED' });
  assert.equal(f.sockets.length, 0);
});

test('stopping during the watching flag update always clears the eventual flag', async () => {
  const f = fixture(),
    gate = deferred(),
    entered = deferred();
  const original = f.client.api;
  f.client.api = async (url, options) => {
    const result = await original(url, options);
    if (options.body?.isOnShareScreen === true) {
      entered.resolve();
      await gate.promise;
    }
    return result;
  };
  await f.viewer.start(screenMemberKey(f.member), SDP);
  const answer = f.viewer.answer(SDP);
  await entered.promise;
  const stopping = f.viewer.stop();
  gate.resolve();
  await assert.rejects(answer, { code: 'SCREEN_CANCELLED' });
  await stopping;
  assert.deepEqual(
    f.calls
      .filter((c) => c.options?.body?.isOnShareScreen !== undefined)
      .map((c) => c.options.body.isOnShareScreen),
    [true, false],
  );
});

test('signaling loss releases only this viewer and rejects outstanding requests', async () => {
  const f = fixture();
  await f.viewer.start(screenMemberKey(f.member), SDP);
  f.sockets[0].send = () => {};
  const pending = f.viewer.request('test-pending');
  f.sockets[0].close();
  await assert.rejects(pending, { code: 'SCREEN_CANCELLED' });
  assert.equal(f.viewer.stopped, true);
  assert.equal(f.client.active.id, ID);
});

test('a cancelled browser setup cannot publish a late offer or leave a live connection', async () => {
  const gate = deferred(),
    entered = deferred(),
    calls = [];
  const pc = {
    addTransceiver() {},
    async createOffer() {
      entered.resolve();
      await gate.promise;
      return { sdp: SDP };
    },
    close() {
      this.closed = true;
    },
  };
  const previous = globalThis.MediaStream;
  globalThis.MediaStream = class {};
  try {
    const p = new ScreenSharePlayer({
      api: async (url, body) => calls.push({ url, body }),
      video: { pause() {} },
      peerFactory: () => pc,
      makeId: () => WATCH1,
    });
    const starting = p.start({ memberKey: 'member', onlineId: 'Streamer' });
    await entered.promise;
    await p.stop();
    gate.resolve();
    await starting;
    assert.equal(pc.closed, true);
    assert.ok(calls.every((c) => c.url === '/api/screen/stop'));
  } finally {
    globalThis.MediaStream = previous;
  }
});

test('helper screens endpoints enforce CSRF and stale watch IDs cannot stop or answer a replacement', async () => {
  const f = fixture(),
    viewers = [];
  Object.assign(f.client, { tokens: {}, events: [], leave: async () => {}, clear() {} });
  const app = createApp({
    clientFactory: () => f.client,
    screenViewerFactory: () => {
      const v = {
        stage: 'answering',
        async start(key) {
          this.memberKey = key;
          return { type: 'offer', sdp: SDP };
        },
        async answer() {
          return { state: 'receiving' };
        },
        async stop() {
          this.stopped = true;
        },
      };
      viewers.push(v);
      return v;
    },
  });
  const url = await app.listen(0);
  try {
    const boot = await fetch(url + '/api/bootstrap');
    const csrf = (await boot.json()).csrf;
    const headers = {
      Cookie: boot.headers.get('set-cookie').split(';')[0],
      'X-PartyBridge-CSRF': csrf,
      'Content-Type': 'application/json',
    };
    const post = (path, body, h = headers) =>
      fetch(url + path, { method: 'POST', headers: h, body: JSON.stringify(body) });
    assert.equal(
      (
        await post(
          '/api/screen/start',
          {},
          { Cookie: headers.Cookie, 'Content-Type': 'application/json' },
        )
      ).status,
      403,
    );
    const list = await fetch(url + '/api/screens', { headers }).then((r) => r.json());
    assert.equal(list.streams.length, 1);
    assert.ok(!JSON.stringify(list).includes('PRIVATE'));
    assert.equal(
      (await post('/api/screen/start', { memberKey: 'streamer', sdp: SDP, watchId: WATCH1 }))
        .status,
      200,
    );
    assert.equal(
      (await post('/api/screen/start', { memberKey: 'streamer', sdp: SDP, watchId: WATCH2 }))
        .status,
      200,
    );
    assert.equal(viewers[0].stopped, true);
    await post('/api/screen/stop', { watchId: WATCH1 });
    assert.equal(viewers[1].stopped, undefined);
    assert.equal((await post('/api/screen/answer', { sdp: SDP, watchId: WATCH1 })).status, 409);
    assert.equal((await post('/api/screen/answer', { sdp: SDP, watchId: WATCH2 })).status, 200);
    await post('/api/screen/stop', { watchId: WATCH2 });
    assert.equal(viewers[1].stopped, true);
  } finally {
    await app.close();
  }
});

test('a late browser start response receives correlated cleanup after cancellation', async () => {
  const gate = deferred(),
    entered = deferred(),
    calls = [];
  const pc = {
    addTransceiver() {},
    createOffer: async () => ({ sdp: SDP }),
    close() {
      this.closed = true;
    },
    setRemoteDescription() {
      throw new Error('Cancelled offer must never be applied');
    },
  };
  const previous = globalThis.MediaStream;
  globalThis.MediaStream = class {};
  try {
    const p = new ScreenSharePlayer({
      video: { pause() {} },
      makeId: () => WATCH1,
      peerFactory: () => pc,
      api: async (url, body) => {
        calls.push({ url, body });
        if (url.endsWith('/start')) {
          entered.resolve();
          await gate.promise;
          return { type: 'offer', sdp: SDP };
        }
        return {};
      },
    });
    const starting = p.start({ memberKey: 'streamer', onlineId: 'Streamer' });
    await entered.promise;
    await p.stop();
    gate.resolve();
    await starting;
    assert.equal(pc.closed, true);
    assert.equal(
      calls.filter((c) => c.url.endsWith('/stop') && c.body.watchId === WATCH1).length,
      2,
    );
  } finally {
    globalThis.MediaStream = previous;
  }
});
