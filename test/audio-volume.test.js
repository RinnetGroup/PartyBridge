import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAudioVolume,
  audioVolumePatch,
  DEFAULT_AUDIO_VOLUME,
} from '../server/audio-volume.js';

test('live audio volume attenuates, silences and saturates boosts without changing queued PCM', () => {
  const input = Buffer.alloc(8);
  [30000, -30000, 1000, -1000].forEach((value, i) => input.writeInt16LE(value, i * 2));
  const samples = (pcm) => Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2));
  assert.equal(applyAudioVolume(input, 100), input);
  assert.deepEqual(samples(applyAudioVolume(input, 50)), [15000, -15000, 500, -500]);
  assert.deepEqual(samples(applyAudioVolume(input, 0)), [0, 0, 0, 0]);
  assert.deepEqual(samples(applyAudioVolume(input, 200)), [32767, -32768, 2000, -2000]);
  assert.deepEqual(samples(input), [30000, -30000, 1000, -1000]);
});

test('independent volume changes preserve the other slider and reject invalid levels', () => {
  assert.deepEqual(audioVolumePatch({ microphone: 75 }), { microphone: 75, party: 100 });
  assert.deepEqual(audioVolumePatch({ party: 0 }, { microphone: 75, party: 100 }), {
    microphone: 75,
    party: 0,
  });
  assert.deepEqual(DEFAULT_AUDIO_VOLUME, { microphone: 100, party: 100 });
  for (const value of [-1, 201, '50', null, NaN, Infinity, 1.5])
    assert.throws(() => audioVolumePatch({ party: value }));
});
