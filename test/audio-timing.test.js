import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { AudioFrameClock, PartyAudioMixer } from '../server/party-audio.js';

const sample = 1200;
const frame = (count) => {
  const pcm = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) pcm.writeInt16LE(sample, i * 2);
  return pcm;
};

test('clock catches up delayed callbacks without losing fractional time or duplicating frames', () => {
  let time = 0;
  const clock = new AudioFrameClock({ now: () => time });
  let frames = 0;
  for (let i = 1; i <= 80; i++) {
    time = i * 31.25;
    frames += clock.take().frames;
  }
  assert.equal(frames, 125);
  assert.deepEqual(clock.take(), { frames: 0, skipped: 0 });
  time = 2519;
  assert.equal(clock.take().frames, 0);
  time = 2520;
  assert.equal(clock.take().frames, 1);
});

test('long process stalls cannot create an unbounded audio burst or a permanent clock deficit', () => {
  let time = 0;
  const clock = new AudioFrameClock({ now: () => time });
  time = 10000;
  assert.deepEqual(clock.take(), { frames: 10, skipped: 490 });
  time = 10020;
  assert.deepEqual(clock.take(), { frames: 1, skipped: 0 });
});

async function workletClass() {
  let Processor;
  const context = vm.createContext({
    AudioWorkletProcessor: class {
      port = {};
    },
    registerProcessor: (_name, type) => {
      Processor = type;
    },
  });
  vm.runInContext(
    await readFile(new URL('../public/playout-worklet.js', import.meta.url), 'utf8'),
    context,
  );
  return Processor;
}

function simulate(Processor, clocked) {
  let now = 0,
    nextWake = 31.25,
    nextPacket = 0,
    nextRender = 0,
    sequence = 0;
  let silence = 0,
    rendered = 0;
  const playout = new Processor();
  const audio = new PartyAudioMixer({
    now: () => now,
    decoderFactory: () => ({ decode: () => frame(640) }),
  });
  const clock = new AudioFrameClock({ now: () => now });
  // Two continuous 40 ms Opus sources and the actual browser playout worklet.
  // Node callbacks arrive every 31.25 ms, while browser rendering follows its
  // independent hardware clock: 128 samples every 8 ms at 16 kHz.
  while (now < 15000) {
    now = Math.min(nextWake, nextPacket, nextRender);
    if (now === nextPacket) {
      for (const ssrc of [1, 2])
        audio.push(String(ssrc), {
          header: { ssrc, sequenceNumber: sequence },
          payload: Buffer.from([1]),
        });
      sequence++;
      nextPacket += 40;
    }
    if (now === nextWake) {
      const count = clocked ? clock.take().frames : 1;
      for (let i = 0; i < count; i++) {
        const pcm = audio.pull();
        if (pcm)
          playout.port.onmessage({
            data: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
          });
      }
      nextWake += 31.25;
    }
    if (now === nextRender) {
      const output = new Float32Array(128);
      playout.process([], [[output]]);
      if (now >= 1000)
        for (const value of output) {
          rendered++;
          if (value === 0) silence++;
        }
      nextRender += 8;
    }
  }
  audio.close();
  return { silence, rendered };
}

test('elapsed-time mixing keeps actual browser playout continuous under the reproduced Windows timer cadence', async () => {
  const Processor = await workletClass();
  const previous = simulate(Processor, false),
    fixed = simulate(Processor, true);
  assert.ok(
    previous.silence > previous.rendered / 4,
    'The old timer must reproduce substantial cutouts',
  );
  assert.equal(fixed.silence, 0, 'Continuous incoming audio must remain continuous after warmup');
});
