import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { MicPacer } from '../server/mic-pacer.js';
import { MicFrameGate } from '../public/mic-frame.js';
import { VoiceSocketHeartbeat } from '../server/voice-socket.js';

test('a microphone burst stays bounded and is paced instead of being sent in one callback', () => {
  let now = 0;
  const pacer = new MicPacer({ now: () => now });
  pacer.push(Buffer.alloc(640 * 40, 1));
  assert.equal(pacer.take().length, 0);
  assert.equal(pacer.snapshot().queuedFrames, 5);
  assert.equal(pacer.snapshot().droppedFrames, 35);
  now = 20;
  assert.equal(pacer.take().length, 1);
  assert.equal(pacer.take().length, 0);
  now = 40;
  assert.equal(pacer.take().length, 1);
});

test('microphone timestamps follow the clock across mute, long pauses, and the 32-bit wrap', () => {
  let now = 0;
  const base = 0xffffff00,
    pacer = new MicPacer({ now: () => now, timestamp: base });
  pacer.push(Buffer.alloc(640));
  now = 20;
  assert.equal(pacer.take()[0].timestamp, base);
  pacer.push(Buffer.alloc(640));
  now = 40;
  assert.equal(pacer.take()[0].timestamp, (base + 320) >>> 0);
  pacer.push(Buffer.alloc(640));
  now = 60000;
  assert.deepEqual(pacer.take(true), []);
  now = 60020;
  pacer.push(Buffer.alloc(640));
  assert.equal(pacer.take()[0].timestamp, (base + 3000 * 320) >>> 0);
  now = 4000020;
  pacer.push(Buffer.alloc(640 * 10));
  const resumed = pacer.take();
  assert.equal(resumed.length, 3);
  assert.equal(pacer.snapshot().queuedFrames, 0);
  assert.equal(resumed.at(-1).timestamp, (base + 200000 * 320) >>> 0);
});

test('a process stall discards old captured speech rather than playing it seconds later', () => {
  let now = 0;
  const pacer = new MicPacer({ now: () => now });
  pacer.push(Buffer.alloc(640 * 3, 1));
  now = 2000;
  assert.deepEqual(pacer.take(), []);
  assert.equal(pacer.snapshot().droppedFrames, 3);
  now = 2020;
  pacer.push(Buffer.alloc(640, 2));
  assert.equal(pacer.take()[0].pcm[0], 2);
  assert.equal(pacer.push(Buffer.alloc(3)), false);
});

test('31.25 ms Windows timer wakeups still send one second of microphone audio per second', () => {
  let now = 0,
    captured = 0,
    sent = 0;
  const pacer = new MicPacer({ now: () => now });
  for (let wake = 1; wake <= 320; wake++) {
    now = wake * 31.25;
    const target = Math.floor(now / 20);
    for (; captured < target; captured++) pacer.push(Buffer.alloc(640));
    sent += pacer.take().length;
  }
  assert.equal(sent, 500);
  assert.equal(pacer.snapshot().droppedFrames, 0);
});

test('browser capture rejects old worklet messages and congested sockets, retaining legacy PCM compatibility', () => {
  const gate = new MicFrameGate(),
    pcm = new ArrayBuffer(640);
  assert.equal(gate.take({ pcm, captureTime: 1 }, 1.02, 0), pcm);
  assert.equal(gate.take({ pcm, captureTime: 1 }, 2, 0), null);
  assert.equal(gate.take({ pcm, captureTime: 2 }, 2, 9000), null);
  assert.equal(gate.take(pcm, 2), pcm);
  assert.equal(gate.take(new ArrayBuffer(4), 2), null);
  assert.deepEqual([gate.accepted, gate.stale, gate.congested], [2, 1, 1]);
});

test('the microphone worklet transfers 20 ms PCM with the capture clock attached', () => {
  const emitted = [],
    context = vm.createContext({
      sampleRate: 16000,
      currentTime: 1.5,
      AudioWorkletProcessor: class {
        port = { postMessage: (message, transfer) => emitted.push({ message, transfer }) };
      },
      registerProcessor: (_, implementation) => {
        context.Mic = implementation;
      },
    });
  vm.runInContext(
    readFileSync(new URL('../public/mic-worklet.js', import.meta.url), 'utf8'),
    context,
  );
  const mic = new context.Mic();
  mic.process([[new Float32Array(320).fill(0.5)]]);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].message.pcm.byteLength, 640);
  assert.equal(emitted[0].message.captureTime, 1.5);
  assert.equal(emitted[0].transfer[0], emitted[0].message.pcm);
});

function heartbeatFixture() {
  let now = 0,
    tick,
    cancelled = false;
  const socket = new EventEmitter();
  Object.assign(socket, {
    readyState: 1,
    pings: 0,
    terminated: false,
    ping() {
      this.pings++;
    },
    terminate() {
      this.terminated = true;
      this.emit('close');
    },
  });
  const events = [],
    session = {
      voiceSocket: socket,
      lastSeen: 0,
      client: { record: (...args) => events.push(args) },
    };
  const heartbeat = new VoiceSocketHeartbeat(socket, session, {
    now: () => now,
    schedule: (fn) => {
      tick = fn;
      return 1;
    },
    cancel: () => {
      cancelled = true;
    },
  });
  return {
    socket,
    session,
    events,
    heartbeat,
    advance: (value) => {
      now = value;
      tick();
    },
    cancelled: () => cancelled,
  };
}

test('native browser pongs keep a call alive past HTTP inactivity without page timers', () => {
  const f = heartbeatFixture();
  for (let time = 25000; time <= 600000; time += 25000) {
    f.advance(time);
    f.socket.emit('pong');
  }
  assert.equal(f.session.lastSeen, 600000);
  assert.equal(f.socket.terminated, false);
  assert.equal(f.socket.pings, 24);
  f.heartbeat.close();
  assert.equal(f.cancelled(), true);
});

test('a dead or replaced voice socket cannot extend the session lease or affect a replacement', () => {
  const f = heartbeatFixture();
  f.advance(75000);
  assert.equal(f.socket.terminated, true);
  assert.equal(f.events[0][1], 'timed out');
  assert.equal(f.socket.listenerCount('pong'), 0);
  const other = heartbeatFixture();
  other.session.voiceSocket = {};
  other.advance(25000);
  other.socket.emit('pong');
  other.socket.emit('message');
  assert.equal(other.session.lastSeen, 0);
  assert.equal(other.socket.terminated, false);
  assert.equal(other.cancelled(), true);
});
