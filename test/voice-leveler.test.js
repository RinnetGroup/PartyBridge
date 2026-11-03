import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartVoiceLeveler, MixLimiter } from '../server/voice-leveler.js';
import { PartyAudioMixer } from '../server/party-audio.js';

const frame = (amplitude, size = 320) =>
  Float64Array.from({ length: size }, (_, i) => amplitude * Math.sin((i * Math.PI) / 8));
const rms = (samples) => Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
const peak = (samples) => Math.max(...samples.map(Math.abs));
const pcm = (value) => {
  const b = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) b.writeInt16LE(value, i * 2);
  return b;
};

test('quiet speech rises gradually with bounded gain while loud speech converges independently', () => {
  const quiet = new SmartVoiceLeveler(),
    loud = new SmartVoiceLeveler();
  const first = rms(quiet.process(frame(1000)));
  assert.ok(first > 700 && first < 800);
  let q, l;
  for (let i = 0; i < 150; i++) {
    q = quiet.process(frame(1000));
    l = loud.process(frame(16000));
  }
  assert.ok(rms(q) > 2400 && rms(q) < 2700);
  assert.ok(Math.abs(rms(q) - rms(l)) < 150);
  assert.ok(quiet.gain <= 4 && loud.gain < 1);
});

test('silence and low background noise are never boosted, even following quiet speech', () => {
  const leveler = new SmartVoiceLeveler();
  for (let i = 0; i < 100; i++) leveler.process(frame(600));
  assert.ok(leveler.gain > 3);
  const noise = frame(100);
  const original = Float64Array.from(noise);
  leveler.process(noise);
  assert.ok(rms(noise) <= rms(original));
  assert.equal(peak(leveler.process(frame(0))), 0);
});

test('sudden full-scale peaks stay below the source ceiling without adding or losing samples', () => {
  const leveler = new SmartVoiceLeveler();
  for (let i = 0; i < 100; i++) leveler.process(frame(700));
  for (const sample of [32767, -32768]) {
    const f = new Float64Array(320);
    f[13] = sample;
    assert.equal(leveler.process(f).length, 320);
    assert.ok(peak(f) <= 26000.000001);
  }
});

test('quiet speech keeps its learned level across pauses without boosting background noise', () => {
  const leveler = new SmartVoiceLeveler();
  for (let i = 0; i < 150; i++) leveler.process(frame(600));
  const learned = leveler.gain;
  for (let i = 0; i < 20; i++) assert.ok(peak(leveler.process(frame(100))) <= 100);
  assert.equal(leveler.gain, learned);
  assert.ok(rms(leveler.process(frame(600))) > 1500);
  for (let i = 0; i < 450; i++) leveler.process(frame(0));
  assert.ok(leveler.gain < 1.05);
});

test('mix limiter bounds eight overlapping loud voices and releases smoothly', () => {
  const limiter = new MixLimiter(),
    overlap = frame(16000 * 8);
  limiter.process(overlap);
  assert.ok(peak(overlap) <= 30000.000001);
  const before = limiter.gain,
    normal = frame(3000);
  limiter.process(normal);
  assert.ok(limiter.gain > before && limiter.gain < 1);
  assert.ok(peak(normal) < 3000);
});

test('live leveling preserves decoder state, packet queues, frame duration and the exact disabled mix', () => {
  const audio = new PartyAudioMixer({ decoderFactory: () => ({ decode: (b) => b }), now: () => 0 });
  for (let seq = 0; seq < 4; seq++)
    for (const [source, value] of [
      [1, 700],
      [2, 16000],
    ])
      audio.push(String(source), {
        header: { ssrc: source, sequenceNumber: seq },
        payload: pcm(value),
      });
  assert.deepEqual(audio.pull(), pcm(16700));
  const streams = [...audio.streams.values()],
    decoders = streams.map((s) => s.decoder),
    remaining = streams.map((s) => s.packets.size);
  audio.setLeveling(true);
  assert.deepEqual(
    streams.map((s) => s.packets.size),
    remaining,
  );
  const out = audio.pull();
  assert.equal(out.length, 640);
  assert.ok(streams[0].leveler.gain > 1 && streams[1].leveler.gain < 1);
  assert.deepEqual(
    streams.map((s) => s.decoder),
    decoders,
  );
  audio.setLeveling(false);
  assert.deepEqual(audio.pull(), pcm(16700));
  audio.close();
});

test('a source returning with a new SSRC gets its own gain and does not disturb existing sources', () => {
  const audio = new PartyAudioMixer({ decoderFactory: () => ({ decode: (b) => b }), now: () => 0 });
  audio.setLeveling(true);
  for (let seq = 0; seq < 2; seq++)
    audio.push('friend', { header: { ssrc: 1, sequenceNumber: seq }, payload: pcm(700) });
  audio.pull();
  const original = audio.streams.get('friend:1').leveler;
  for (let seq = 0; seq < 2; seq++)
    audio.push('friend', { header: { ssrc: 2, sequenceNumber: seq }, payload: pcm(10000) });
  audio.pull();
  assert.notEqual(audio.streams.get('friend:2').leveler, original);
  assert.ok(original.gain > 1 && audio.streams.get('friend:2').leveler.gain < 1);
  audio.retainSsrcs(new Set([2]));
  assert.equal(audio.streams.size, 1);
  audio.close();
});
