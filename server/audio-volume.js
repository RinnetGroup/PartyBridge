export const DEFAULT_AUDIO_VOLUME = Object.freeze({ microphone: 100, party: 100 });

export function audioVolumePatch(patch, current = DEFAULT_AUDIO_VOLUME) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new Error('Invalid audio volume');
  const next = { ...current };
  for (const key of ['microphone', 'party']) {
    if (patch[key] === undefined) continue;
    if (!Number.isInteger(patch[key]) || patch[key] < 0 || patch[key] > 200)
      throw new Error('Volume must be between 0 and 200 percent');
    next[key] = patch[key];
  }
  return next;
}

// Never alter the jitter buffer or microphone queue's original PCM.
export function applyAudioVolume(pcm, percent = 100) {
  if (percent === 100) return pcm;
  const result = Buffer.alloc(pcm.length);
  if (!percent) return result;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const sample = Math.round((pcm.readInt16LE(i) * percent) / 100);
    result.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i);
  }
  return result;
}
