import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceConnection } from '../public/voice.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const SDP = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n';
const prepared = {
  offer: { type: 'offer', sdp: SDP },
  peerId: '11111111-1111-1111-1111-111111111111',
  self: { identity: 'test-device', accountId: '88', platform: 100001 },
  participants: [],
};

function browser(t, microphone) {
  const timers = new Set(),
    pcs = [],
    descriptors = new Map();
  class FakeStream {
    constructor(tracks = []) {
      this.tracks = tracks;
    }
    getTracks() {
      return this.tracks;
    }
    getAudioTracks() {
      return this.tracks;
    }
    addTrack(track) {
      this.tracks.push(track);
    }
  }
  class FakePC {
    constructor() {
      this.connectionState = 'new';
      this.iceGatheringState = 'complete';
      this.senders = [];
      this.channels = [];
      pcs.push(this);
    }
    createDataChannel(label) {
      const channel = {
        label,
        readyState: 'connecting',
        send() {},
        close() {
          this.readyState = 'closed';
        },
      };
      this.channels.push(channel);
      return channel;
    }
    addTrack(track) {
      this.senders.push({ track });
    }
    getSenders() {
      return this.senders;
    }
    getTransceivers() {
      return [{ currentDirection: 'sendonly' }];
    }
    async setRemoteDescription(offer) {
      this.remoteDescription = offer;
    }
    async createAnswer() {
      return { type: 'answer', sdp: SDP };
    }
    async setLocalDescription(answer) {
      this.localDescription = answer;
    }
    async getStats() {
      return new Map();
    }
    close() {
      this.connectionState = 'closed';
      this.closed = true;
    }
    addEventListener() {}
    removeEventListener() {}
  }
  const replacements = {
    window: {},
    navigator: { mediaDevices: { getUserMedia: () => microphone } },
    RTCPeerConnection: FakePC,
    RTCRtpSender: { getCapabilities: () => ({ codecs: [] }) },
    MediaStream: FakeStream,
    document: { createElement: () => ({ play: async () => {}, pause() {}, srcObject: null }) },
    setInterval: (fn) => {
      const timer = { fn };
      timers.add(timer);
      return timer;
    },
    clearInterval: (timer) => timers.delete(timer),
  };
  for (const [name, value] of Object.entries(replacements)) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return { timers, pcs };
}

test('concurrent stops coalesce remote cleanup and release every resource if control close throws', async () => {
  const remote = deferred(),
    calls = [],
    released = [];
  const voice = new VoiceConnection({
    api: (path) => {
      calls.push(path);
      return remote.promise;
    },
    onState() {},
    onStats() {},
  });
  voice.remoteMayExist = true;
  voice.control = {
    close() {
      released.push('control');
      throw new Error('wrapper failure');
    },
  };
  voice.pc = {
    close() {
      released.push('pc');
    },
  };
  voice.stream = {
    getTracks: () => [
      {
        stop() {
          released.push('microphone');
        },
      },
    ],
  };
  voice.audio = {
    pause() {
      released.push('audio');
    },
    srcObject: {},
  };
  const first = voice.stop(),
    second = voice.stop();
  assert.equal(first, second);
  assert.deepEqual(released, ['control', 'pc', 'microphone', 'audio']);
  assert.deepEqual(calls, ['/api/voice/stop']);
  assert.equal(voice.remoteMayExist, true);
  remote.resolve();
  await first;
  assert.equal(voice.remoteMayExist, false);
  assert.equal(voice.stopPromise, null);
});

test('handshake failure during an answer waits for that request, cleans up once, and preserves its reason', async (t) => {
  const track = {
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const { timers, pcs } = browser(
    t,
    Promise.resolve({ getTracks: () => [track], getAudioTracks: () => [track] }),
  );
  const answer = deferred(),
    answerStarted = deferred(),
    calls = [],
    states = [];
  const voice = new VoiceConnection({
    api: async (path) => {
      calls.push(path);
      if (path === '/api/voice/prepare') return prepared;
      if (path === '/api/voice/answer') {
        answerStarted.resolve();
        return answer.promise;
      }
      return {};
    },
    onState: (state) => states.push(state),
    onStats() {},
  });
  const starting = voice.start();
  const rejected = assert.rejects(starting, /Bridge configuration rejected/);
  await answerStarted.promise;
  voice.control.fail('Bridge configuration rejected');
  assert.equal(track.stopped, true);
  assert.equal(pcs[0].closed, true);
  assert.equal(timers.size, 0);
  assert.equal(calls.includes('/api/voice/stop'), false);
  answer.resolve({});
  await rejected;
  await tick();
  assert.equal(calls.filter((path) => path === '/api/voice/stop').length, 1);
  assert.equal(timers.size, 0);
  assert.equal(voice.pc, null);
  assert.equal(voice.preparing, false);
  assert.equal(states.at(-1), 'Voice stopped: Bridge configuration rejected.');
});

test('polls and SDP answers run in FIFO order without overlapping helper requests', async () => {
  const poll = deferred(),
    calls = [];
  let active = 0,
    maximumActive = 0;
  const voice = new VoiceConnection({
    api: async (path, body) => {
      calls.push({ path, body });
      active++;
      maximumActive = Math.max(maximumActive, active);
      try {
        return path === '/api/voice/state' ? await poll.promise : {};
      } finally {
        active--;
      }
    },
    onState() {},
    onStats() {},
  });
  const polling = voice.remoteRequest('/api/voice/state');
  const answering = voice.remoteRequest('/api/voice/answer', { sdp: SDP });
  await tick();
  assert.deepEqual(calls, [{ path: '/api/voice/state', body: undefined }]);
  poll.resolve({ participants: [] });
  await Promise.all([polling, answering]);
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/voice/state', '/api/voice/answer'],
  );
  assert.equal(calls[1].body.sdp, SDP);
  assert.equal(maximumActive, 1);
});

test('a rejected helper request does not poison subsequent queued work', async () => {
  const calls = [];
  const voice = new VoiceConnection({
    api: async (path) => {
      calls.push(path);
      if (path === '/failed') throw new Error('request rejected');
      return {};
    },
    onState() {},
    onStats() {},
  });
  const first = assert.rejects(voice.remoteRequest('/failed'), /request rejected/);
  const second = voice.remoteRequest('/next');
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['/failed', '/next']);
});

test('stop waits for the active request, skips queued requests, and refuses later cancelled work', async () => {
  const older = deferred(),
    calls = [];
  const voice = new VoiceConnection({
    api: async (path) => {
      calls.push(path);
      return path === '/older' ? older.promise : {};
    },
    onState() {},
    onStats() {},
  });
  voice.remoteMayExist = true;
  const pending = voice.remoteRequest('/older');
  const skipped = assert.rejects(voice.remoteRequest('/queued'), /cancelled/);
  await tick();
  const stopped = voice.stop();
  await tick();
  assert.deepEqual(calls, ['/older']);
  older.resolve({});
  await Promise.all([pending, skipped, stopped]);
  await assert.rejects(voice.remoteRequest('/after-stop'), /cancelled/);
  assert.deepEqual(calls, ['/older', '/api/voice/stop']);
  assert.equal(voice.pendingRemotes.size, 0);
});

test('cancelled microphone acquisition stops a late stream without creating a peer connection', async (t) => {
  const microphone = deferred(),
    started = deferred(),
    calls = [];
  const { pcs, timers } = browser(t, microphone.promise);
  const track = {
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const voice = new VoiceConnection({
    api: async (path) => {
      calls.push(path);
      return path === '/api/voice/prepare' ? prepared : {};
    },
    onState: (state) => {
      if (state.includes('microphone')) started.resolve();
    },
    onStats() {},
  });
  const starting = voice.start(),
    rejected = assert.rejects(starting, /cancelled/);
  await started.promise;
  await voice.stop();
  microphone.resolve({ getTracks: () => [track], getAudioTracks: () => [track] });
  await rejected;
  assert.equal(track.stopped, true);
  assert.equal(pcs.length, 0);
  assert.equal(timers.size, 0);
  assert.equal(calls.filter((path) => path === '/api/voice/stop').length, 1);
});

test('late RTC statistics cannot overwrite stopped state and failed transport releases the microphone', async (t) => {
  const track = {
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const { pcs, timers } = browser(
    t,
    Promise.resolve({ getTracks: () => [track], getAudioTracks: () => [track] }),
  );
  const states = [],
    reports = [],
    calls = [];
  const voice = new VoiceConnection({
    api: async (path) => {
      calls.push(path);
      return path === '/api/voice/prepare' ? prepared : {};
    },
    onState: (state) => states.push(state),
    onStats: (report) => reports.push(report),
  });
  await voice.start();
  const pendingStats = deferred();
  pcs[0].getStats = () => pendingStats.promise;
  const readStats = [...timers][0].fn();
  pcs[0].connectionState = 'failed';
  pcs[0].onconnectionstatechange();
  await tick();
  pendingStats.resolve(
    new Map([['rx', { type: 'inbound-rtp', kind: 'audio', bytesReceived: 5000 }]]),
  );
  await readStats;
  assert.equal(track.stopped, true);
  assert.equal(timers.size, 0);
  assert.equal(states.at(-1), 'Voice stopped: Voice transport failed.');
  assert.deepEqual(reports, [{ received: 0, sent: 0, connection: 'closed' }]);
  assert.equal(calls.filter((path) => path === '/api/voice/stop').length, 1);
});
