import test from 'node:test';
import assert from 'node:assert/strict';
import OpusScript from 'opusscript';
import { PartyAudioMixer } from '../server/party-audio.js';

const pcm = (sample, count = 320) => {
  const out = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) out.writeInt16LE(sample, i * 2);
  return out;
};
const packet = (ssrc, sequenceNumber, value) => ({
  header: { ssrc, sequenceNumber },
  payload: pcm(value, 1),
});
function mixer() {
  let now = 0;
  const codecs = [];
  const audio = new PartyAudioMixer({
    now: () => now,
    decoderFactory: () => {
      const codec = {
        values: [],
        deleted: false,
        decode(payload) {
          this.values.push(payload.readInt16LE());
          return pcm(payload.readInt16LE());
        },
        delete() {
          this.deleted = true;
        },
      };
      codecs.push(codec);
      return codec;
    },
  });
  return {
    audio,
    codecs,
    advance(ms) {
      now += ms;
    },
  };
}

test('two sources have separate decoders and mix into one 20 ms frame instead of doubling playback time', () => {
  const { audio, codecs } = mixer();
  for (let seq = 0; seq < 2; seq++) {
    audio.push('a', packet(1, seq, 1000));
    audio.push('b', packet(2, seq, 2000));
  }
  assert.equal(codecs.length, 2);
  assert.deepEqual(audio.pull(), pcm(3000));
  assert.deepEqual(audio.pull(), pcm(3000));
  assert.deepEqual(
    codecs.map((c) => c.values),
    [
      [1000, 1000],
      [2000, 2000],
    ],
  );
  assert.deepEqual(audio.pull(), pcm(0));
  audio.close();
  assert.ok(codecs.every((c) => c.deleted));
});

test('eight simultaneous sources mix on one clock with independent decoders', () => {
  const { audio, codecs } = mixer();
  for (let source = 1; source <= 8; source++)
    for (let seq = 0; seq < 2; seq++) audio.push(String(source), packet(source, seq, 100));
  assert.equal(codecs.length, 8);
  assert.deepEqual(audio.pull(), pcm(800));
  assert.deepEqual(audio.pull(), pcm(800));
  audio.close();
  assert.ok(codecs.every((codec) => codec.deleted));
});

test('initial reordering, duplicate packets and 16-bit sequence wrap do not scramble decoder order', () => {
  const { audio, codecs } = mixer();
  audio.push('a', packet(1, 65535, 200));
  audio.push('a', packet(1, 0, 300));
  audio.push('a', packet(1, 65534, 100));
  audio.push('a', packet(1, 65535, 999));
  for (const value of [100, 200, 300]) assert.deepEqual(audio.pull(), pcm(value));
  audio.push('a', packet(1, 65535, 999));
  assert.deepEqual(audio.pull(), pcm(0));
  assert.deepEqual(codecs[0].values, [100, 200, 300]);
  audio.close();
});

test('packet loss on one stream does not block another stream and a departed source releases its decoder', () => {
  const { audio, codecs, advance } = mixer();
  audio.push('a', packet(1, 2, 100));
  audio.push('a', packet(1, 4, 100));
  for (let seq = 0; seq < 4; seq++) audio.push('b', packet(2, seq, 200));
  assert.deepEqual(audio.pull(), pcm(300));
  assert.deepEqual(audio.pull(), pcm(200));
  advance(50);
  assert.deepEqual(audio.pull(), pcm(300));
  audio.retainSsrcs(new Set([2]));
  assert.equal(codecs[0].deleted, true);
  assert.deepEqual(audio.pull(), pcm(200));
  audio.close();
});

test('mixing saturates safely and short isolated packets eventually play', () => {
  const { audio, advance } = mixer();
  audio.push('a', packet(1, 1, 25000));
  audio.push('b', packet(2, 1, 25000));
  assert.equal(audio.pull(), null);
  advance(80);
  assert.deepEqual(audio.pull(), pcm(32767));
  audio.close();
});

test('real Opus packets from two encoders decode and mix with independent decoder state', () => {
  const create = () => new OpusScript(16000, 1, OpusScript.Application.VOIP);
  const encoders = [create(), create()],
    expected = [create(), create()];
  let created = 0;
  const audio = new PartyAudioMixer({
    decoderFactory: () => {
      created++;
      return create();
    },
  });
  try {
    const reference = [];
    for (let seq = 0; seq < 2; seq++) {
      const decoded = [];
      for (let speaker = 0; speaker < 2; speaker++) {
        const wave = Buffer.alloc(640);
        for (let i = 0; i < 320; i++)
          wave.writeInt16LE(
            Math.round(
              3000 * Math.sin(((seq * 320 + i) * 2 * Math.PI * (440 + speaker * 220)) / 16000),
            ),
            i * 2,
          );
        const payload = Buffer.from(encoders[speaker].encode(wave, 320));
        audio.push(String(speaker), {
          header: { ssrc: speaker + 1, sequenceNumber: seq },
          payload,
        });
        decoded.push(expected[speaker].decode(payload));
      }
      const mixed = Buffer.alloc(640);
      for (let i = 0; i < 320; i++)
        mixed.writeInt16LE(
          Math.max(
            -32768,
            Math.min(32767, decoded[0].readInt16LE(i * 2) + decoded[1].readInt16LE(i * 2)),
          ),
          i * 2,
        );
      reference.push(mixed);
    }
    assert.equal(created, 2);
    for (const mixed of reference) assert.deepEqual(audio.pull(), mixed);
  } finally {
    audio.close();
    for (const codec of [...encoders, ...expected]) codec.delete();
  }
});
