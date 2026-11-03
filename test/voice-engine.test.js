import test from 'node:test';
import assert from 'node:assert/strict';
import { OfferQueue } from '../server/offer-queue.js';
import { VoiceEngine } from '../server/voice-engine.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

test('the complete offer/REST answer transaction finishes before any later negotiation starts', async () => {
  const gate = deferred(),
    calls = [],
    counts = [];
  const queue = new OfferQueue(
    async (offer) => {
      calls.push(`offer:${offer}`);
      if (offer === 'first') await gate.promise;
      calls.push(`answer:${offer}`);
    },
    (count) => counts.push(count),
  );
  const first = queue.enqueue('first'),
    second = queue.enqueue('second'),
    third = queue.enqueue(null);
  await settle();
  assert.deepEqual(calls, ['offer:first']);
  gate.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(calls, [
    'offer:first',
    'answer:first',
    'offer:second',
    'answer:second',
    'offer:null',
    'answer:null',
  ]);
  assert.equal(counts.at(-1), 0);
});

test('a failed negotiation rejects callers and cancels queued offers rather than silently continuing', async () => {
  const calls = [];
  const queue = new OfferQueue(async (value) => {
    calls.push(value);
    throw new Error('answer rejected');
  });
  const first = assert.rejects(queue.enqueue('first'), /answer rejected/);
  const second = assert.rejects(queue.enqueue('second'), /cancelled/);
  await Promise.all([first, second]);
  await queue.idle();
  assert.deepEqual(calls, ['first']);
  assert.equal(queue.pending, 0);
});

test('closing cancels pending offers without running them', async () => {
  const gate = deferred(),
    calls = [];
  const queue = new OfferQueue(async (value) => {
    calls.push(value);
    await gate.promise;
  });
  const active = queue.enqueue('active');
  await settle();
  const skipped = assert.rejects(queue.enqueue('skip'), /cancelled/);
  queue.close();
  gate.resolve();
  await active;
  await skipped;
  await assert.rejects(queue.enqueue('late'), /cancelled/);
  assert.deepEqual(calls, ['active']);
});

test('bursts of refresh notifications share one queued fetch and retain a follow-up for changes during negotiation', async () => {
  const firstGate = deferred(),
    refreshGate = deferred(),
    calls = [];
  const queue = new OfferQueue(async (offer) => {
    calls.push(offer);
    if (offer === 'initial') await firstGate.promise;
    if (offer == null && calls.length === 2) await refreshGate.promise;
  });
  const initial = queue.enqueue('initial');
  await settle();
  const queued = queue.enqueue(null);
  for (let i = 0; i < 8; i++) assert.equal(queue.enqueue(null), queued);
  firstGate.resolve();
  await initial;
  await settle();
  const followUp = queue.enqueue(null);
  for (let i = 0; i < 8; i++) assert.equal(queue.enqueue(null), followUp);
  refreshGate.resolve();
  await Promise.all([queued, followUp]);
  assert.deepEqual(calls, ['initial', null, null]);
  assert.equal(queue.pending, 0);
});

class Signal {
  callbacks = new Set();
  subscribe(fn) {
    this.callbacks.add(fn);
    return { unSubscribe: () => this.callbacks.delete(fn) };
  }
  emit(...args) {
    for (const fn of [...this.callbacks]) fn(...args);
  }
}
class FakePc {
  connectionStateChange = new Signal();
  iceConnectionStateChange = new Signal();
  iceGatheringStateChange = new Signal();
  onDataChannel = new Signal();
  onTrack = new Signal();
  channels = [];
  iceGatheringState = 'complete';
  createDataChannel(label) {
    const ch = {
      label,
      readyState: 'connecting',
      stateChanged: new Signal(),
      onMessage: new Signal(),
      sent: [],
      send(data) {
        this.sent.push(data);
      },
      open() {
        this.readyState = 'open';
        this.stateChanged.emit('open');
      },
      close() {
        this.readyState = 'closed';
        this.stateChanged.emit('closed');
      },
    };
    this.channels.push(ch);
    return ch;
  }
  sent = [];
  addTransceiver() {
    return {
      sender: {
        sendRtp: async (packet) => {
          this.sent.push(packet);
        },
      },
    };
  }
  getReceivers() {
    return [];
  }
  async setRemoteDescription(offer) {
    this.remoteDescription = offer;
  }
  async createAnswer() {
    return { type: 'answer', sdp: this.remoteDescription.sdp };
  }
  async setLocalDescription(answer) {
    this.localDescription = answer;
    this.connectionStateChange.emit('connected');
  }
  close() {
    this.connectionStateChange.emit('closed');
  }
}
const SELF = '11111111-1111-1111-1111-111111111111',
  ONE = '22222222-2222-2222-2222-222222222222',
  TWO = '33333333-3333-3333-3333-333333333333';
function engineFixture(options = {}) {
  const pc = new FakePc(),
    codecs = [],
    states = [],
    rosters = [],
    pcm = [];
  const participants = [ONE, TWO].map((peerId, index) => ({
    peerId,
    identity: `Z-${index}`,
    users: [{ account_id: String(99 + index) }],
  }));
  const members = participants.map((p, i) => ({
    accountId: p.users[0].account_id,
    onlineId: `Person ${i}`,
    voiceChatActivated: true,
  }));
  const prep = {
    peerId: SELF,
    offer: { sdp: 'v=0\r\ns=initial\r\n' },
    self: { identity: 'A-self', accountId: '88', platform: 100001 },
    participants,
    members,
  };
  const client = {
    accountId: '88',
    active: { id: SELF },
    prepareVoice: async () => prep,
    answer: async () => {},
    registerVoice: async () => ({}),
    voiceState: async () => ({ participants, members }),
    stopVoice: async () => {},
    refreshVoiceOffer: async () => ({ offer: { sdp: 'v=0\r\ns=refresh\r\n' } }),
  };
  const engine = new VoiceEngine(client, {
    pcFactory: () => pc,
    codecFactory: () => {
      const codec = {
        deleted: false,
        encode: () => Buffer.from([1]),
        decode: () => Buffer.alloc(640, 1),
        delete() {
          this.deleted = true;
        },
      };
      codecs.push(codec);
      return codec;
    },
    onState: (state) => states.push(state),
    onParticipants: (peers, roster, summary) => rosters.push({ peers, members: roster, summary }),
    onPcm: (data) => pcm.push(data),
    ...options,
  });
  return { engine, client, pc, participants, members, states, rosters, pcm, codecs };
}

test('the Node microphone sender paces packets, wraps sequence numbers, and reports async transport failures', async (t) => {
  let now = 0;
  const logs = [],
    f = engineFixture({ audioNow: () => now, onLog: (message) => logs.push(message) });
  t.after(() => f.engine.stop());
  f.engine.seq = 65535;
  await f.engine.start(SELF);
  clearInterval(f.engine.audioTimer);
  f.engine.pushMic(Buffer.alloc(640 * 5));
  assert.equal(f.pc.sent.length, 0);
  now = 20;
  f.engine.pumpAudio();
  await settle();
  now = 40;
  f.engine.pumpAudio();
  await settle();
  assert.deepEqual(
    f.pc.sent.map((p) => p.header.sequenceNumber),
    [65535, 0],
  );
  assert.equal(f.pc.sent[1].header.timestamp - f.pc.sent[0].header.timestamp, 320);
  const blocked = deferred();
  f.engine.rtpSender.sendRtp = () => blocked.promise;
  for (now = 60; now <= 400; now += 20) {
    f.engine.pushMic(Buffer.alloc(640));
    f.engine.pumpAudio();
  }
  assert.equal(f.engine.micSend.inFlight, 3);
  assert.ok(f.engine.micPacer.dropped >= 15);
  blocked.reject(new Error('test socket failure'));
  await settle();
  assert.equal(f.engine.micSend.failed, 3);
  assert.equal(f.engine.micSend.inFlight, 0);
  assert.equal(f.engine.fatal, false);
  assert.ok(logs.some((message) => message.includes('Microphone RTP send failed')));
});

test('active Node engine reports partial readiness until every peer is routed and mixes decoded audio before reporting receipt', async (t) => {
  const f = engineFixture();
  t.after(() => f.engine.stop());
  await f.engine.start(SELF);
  const bridge = f.pc.channels[0];
  const receive = (frame) => bridge.onMessage.emit(JSON.stringify(frame));
  const event = (type, payload) => receive({ category: 'event', type, payload });
  const requests = () =>
    bridge.sent.filter((data) => typeof data === 'string').map((data) => JSON.parse(data));
  const ack = (r) =>
    receive({
      category: 'response',
      type: r.type,
      id: r.id,
      payload: r.type === 'setMediaPubSubPeers' ? r.payload : {},
    });
  const ackRoutes = () => {
    for (let i = 0; i < 10 && f.engine.control.bridge.routingId !== null; i++)
      ack(requests().find((r) => r.id === f.engine.control.bridge.routingId));
  };
  bridge.open();
  event('dataChannelCreated', {
    peer: {
      peerId: SELF,
      dataChannel: { label: 'bridge', sid: '0', channelType: 0, reliabilityParameter: 0 },
    },
    otherPeers: [{ peerId: ONE }, { peerId: TWO }],
  });
  for (const request of requests()) ack(request);
  await settle();
  const connect = (id) => {
    const ch = f.pc.channels.find((c) => c.label === `${id}_0`);
    ch.open();
    event('dataChannelCreated', {
      peer: {
        peerId: id,
        dataChannel: { label: `${SELF}_0`, sid: id, channelType: 0, reliabilityParameter: 0 },
      },
    });
    ch.onMessage.emit(Buffer.from('hello'));
    ackRoutes();
    return ch;
  };
  connect(ONE);
  assert.equal(f.engine.state, 'partial');
  assert.deepEqual(f.rosters.at(-1).summary, {
    ready: 1,
    total: 2,
    failed: 0,
    audioReceived: false,
    negotiating: false,
  });
  const track = { kind: 'audio', uuid: 'track-1', onReceiveRtp: new Signal() };
  f.pc.onTrack.emit(track);
  for (let seq = 0; seq < 2; seq++)
    track.onReceiveRtp.emit({
      header: { ssrc: 5, sequenceNumber: seq },
      payload: Buffer.from([1]),
    });
  // Invoke the same mixer clock used by the interval without depending on wall time.
  const mixed = f.engine.audio.pull();
  assert.equal(mixed.length, 640);
  assert.equal(f.engine.state, 'partial');
  const second = connect(TWO);
  assert.equal(f.engine.state, 'connected');
  assert.equal(f.rosters.at(-1).summary.ready, 2);
  for (const id of [ONE, TWO]) {
    const data = f.pc.channels.find((c) => c.label === `${id}_1`);
    assert.ok(data);
    data.open();
    event('dataChannelCreated', {
      peer: {
        peerId: id,
        dataChannel: {
          label: `${SELF}_1`,
          sid: `data-${id}`,
          channelType: 129,
          reliabilityParameter: 0,
        },
      },
    });
  }
  assert.ok(f.rosters.at(-1).peers.every((peer) => peer.dataChannelReady));
  assert.ok(f.engine.diagnostics().partyDataChannels.every((channel) => channel.ready));
  second.close();
  assert.equal(f.engine.state, 'partial');
  await f.engine.stop();
  assert.ok(f.codecs.every((c) => c.deleted));
  assert.equal(track.onReceiveRtp.callbacks.size, 0);
});

test('Node renegotiation failures reach the session failure callback', async (t) => {
  const f = engineFixture();
  t.after(() => f.engine.stop());
  await f.engine.start(SELF);
  f.client.answer = async () => {
    throw new Error('rejected');
  };
  f.engine.control.bridge.onOffer({ sdp: 'v=0\r\ns=updated\r\n' });
  await settle();
  await f.engine.offers.idle();
  await settle();
  assert.equal(f.engine.state, 'failed');
  assert.equal(f.engine.control.closed, true);
});

test('Node offer callbacks cannot overwrite an SDP answer while its REST submission is in flight', async (t) => {
  const f = engineFixture();
  t.after(() => f.engine.stop());
  await f.engine.start(SELF);
  const gate = deferred(),
    answers = [];
  f.client.answer = async (sdp) => {
    answers.push(sdp);
    if (answers.length === 1) await gate.promise;
  };
  f.engine.control.bridge.onOffer({ sdp: 'v=0\r\ns=first-update\r\n' });
  f.engine.control.bridge.onOffer({ sdp: 'v=0\r\ns=second-update\r\n' });
  await settle();
  assert.deepEqual(answers, ['v=0\r\ns=first-update\r\n']);
  assert.match(f.pc.remoteDescription.sdp, /first-update/);
  gate.resolve();
  await f.engine.offers.idle();
  assert.deepEqual(answers, ['v=0\r\ns=first-update\r\n', 'v=0\r\ns=second-update\r\n']);
});

test('leaving during peer preparation cancels late setup and concurrent stops share one cleanup', async () => {
  const f = engineFixture(),
    gate = deferred();
  const prep = await f.client.prepareVoice();
  let cleanups = 0;
  f.client.prepareVoice = () => gate.promise;
  f.client.stopVoice = async () => {
    cleanups++;
  };
  const starting = assert.rejects(f.engine.start(SELF), /cancelled/);
  const first = f.engine.stop(),
    second = f.engine.stop();
  assert.equal(first, second);
  assert.equal(cleanups, 0);
  gate.resolve(prep);
  await starting;
  await first;
  assert.equal(cleanups, 1);
  assert.equal(f.engine.pc, null);
  assert.equal(f.engine.state, 'stopped');
});

test('Node audio pump produces wall-clock audio duration when Windows delays timer callbacks to 31.25 ms', async (t) => {
  let time = 0;
  const f = engineFixture({ audioNow: () => time });
  t.after(() => f.engine.stop());
  await f.engine.start(SELF);
  // A ready decoded stream avoids testing the network or codec in this clock test.
  f.engine.audio.hasAudio = true;
  for (let tick = 1; tick <= 80; tick++) {
    time = tick * 31.25;
    f.engine.pumpAudio();
  }
  assert.equal(f.pcm.length, 125); // 2.5 seconds, not 80 frames / 1.6 seconds.
  assert.equal(
    f.pcm.reduce((bytes, pcm) => bytes + pcm.length, 0),
    16000 * 2 * 2.5,
  );
});
