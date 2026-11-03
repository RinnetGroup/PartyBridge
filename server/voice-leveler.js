// Receive-only processing. Each RTP source owns an independent gain envelope.
// Work on the mixer's existing 20 ms frame: no extra buffering or RTP changes.
const TARGET = 2600,
  NOISE_FLOOR = 180,
  CEILING = 26000;
export class SmartVoiceLeveler {
  constructor(rate = 16000) {
    this.rate = rate;
    this.gain = 1;
  }
  process(samples) {
    let power = 0,
      peak = 0;
    for (const value of samples) {
      power += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    const rms = Math.sqrt(power / (samples.length || 1));
    // Never boost silence or low background noise. Turn down quickly; raise
    // quiet speech gradually to avoid pumping between words.
    const quiet = rms < NOISE_FLOOR;
    if (quiet) {
      this.quietSamples = (this.quietSamples ?? 0) + samples.length;
      // Keep the learned speech gain between words and through short packet
      // gaps. Noise itself never receives a boost. Long idle periods gradually
      // return the estimate to unity for the next conversation.
      if (this.quietSamples > this.rate)
        this.gain += (1 - this.gain) * (1 - Math.exp(-samples.length / this.rate / 1.5));
      const noiseGain = Math.min(1, this.gain);
      for (let i = 0; i < samples.length; i++) samples[i] *= noiseGain;
      return samples;
    }
    this.quietSamples = 0;
    const desired = Math.max(0.125, Math.min(4, TARGET / rms));
    const tau = desired < this.gain ? 0.025 : 0.7;
    const next =
      this.gain + (desired - this.gain) * (1 - Math.exp(-samples.length / this.rate / tau));
    const cap = peak ? CEILING / peak : Infinity;
    const start = Math.min(this.gain, cap),
      end = Math.min(next, cap);
    for (let i = 0; i < samples.length; i++)
      samples[i] *= start + ((end - start) * (i + 1)) / samples.length;
    this.gain = end;
    return samples;
  }
}

// Overlapping voices still need headroom after their individual adjustments.
// Immediate attenuation prevents clipping; slow release avoids a volume surge
// when one person stops talking. The user's Party volume is applied afterward.
export class MixLimiter {
  constructor(rate = 16000) {
    this.rate = rate;
    this.gain = 1;
  }
  process(samples) {
    let peak = 0;
    for (const value of samples) peak = Math.max(peak, Math.abs(value));
    const cap = peak ? 30000 / peak : 1;
    const start = Math.min(this.gain, cap);
    const end = Math.min(
      cap,
      start + (1 - start) * (1 - Math.exp(-samples.length / this.rate / 0.25)),
      1,
    );
    for (let i = 0; i < samples.length; i++)
      samples[i] *= start + ((end - start) * (i + 1)) / samples.length;
    this.gain = end;
    return samples;
  }
}
