import { SmartVoiceLeveler, MixLimiter } from './voice-leveler.js';

// Timers can wake much later than their requested interval on Windows. Count
// samples against a monotonic clock, rather than emitting one frame per wakeup.
export class AudioFrameClock {
  constructor({
    now = () => performance.now(),
    rate = 16000,
    frameSamples = 320,
    maxCatchUpFrames = 10,
  } = {}) {
    Object.assign(this, { now, maxCatchUpFrames });
    this.frameMs = (frameSamples * 1000) / rate;
    this.origin = now();
    this.frames = 0;
  }
  take() {
    const target = Math.max(this.frames, Math.floor((this.now() - this.origin) / this.frameMs));
    const due = target - this.frames;
    this.frames = target;
    return {
      frames: Math.min(due, this.maxCatchUpFrames),
      skipped: Math.max(0, due - this.maxCatchUpFrames),
    };
  }
}

// Each RTP source owns its decoder and packet/PCM buffers. pull() consumes the
// same amount of time from EVERY source and mixes it into one browser PCM frame.
export class PartyAudioMixer {
  constructor({
    decoderFactory,
    rate = 16000,
    frameSamples = 320,
    now = () => Date.now(),
    onDecoded = () => {},
    onError = () => {},
  }) {
    Object.assign(this, { decoderFactory, rate, frameSamples, now, onDecoded, onError });
    this.streams = new Map();
    this.hasAudio = false;
  }

  push(trackId, packet) {
    const { ssrc, sequenceNumber } = packet.header;
    if (!Number.isInteger(ssrc) || !Number.isInteger(sequenceNumber) || !packet.payload?.length)
      return;
    const key = `${trackId}:${ssrc}`;
    let stream = this.streams.get(key);
    if (!stream) {
      if (this.streams.size >= 64) return;
      stream = {
        decoder: this.decoderFactory(),
        ssrc,
        packets: new Map(),
        highest: sequenceNumber,
        next: sequenceNumber,
        started: false,
        decoded: false,
        chunks: [],
        offset: 0,
        samples: 0,
        lastSeen: this.now(),
        gapAt: null,
      };
      this.streams.set(key, stream);
    }
    const delta = ((sequenceNumber - (stream.highest & 0xffff) + 0x8000) & 0xffff) - 0x8000;
    const sequence = stream.highest + delta;
    stream.highest = Math.max(stream.highest, sequence);
    if (stream.decoded && sequence < stream.next) return;
    if (!stream.decoded) stream.next = Math.min(stream.next, sequence);
    stream.lastSeen = this.now();
    if (!stream.packets.has(sequence)) stream.packets.set(sequence, Buffer.from(packet.payload));
    // Drop old backlog on a stalled source without holding up other speakers.
    if (stream.packets.size > 100) {
      const oldest = Math.min(...stream.packets.keys());
      stream.packets.delete(oldest);
      stream.next = Math.max(stream.next, oldest + 1);
    }
  }

  fill(key, stream) {
    if (!stream.started) {
      // Brief priming permits a reordered first pair; do not wait forever for a
      // second packet when a participant sends only a short sound.
      if (stream.packets.size < 2 && this.now() - stream.lastSeen < 60) return;
      stream.started = true;
    }
    while (stream.samples < this.frameSamples && stream.packets.size) {
      let payload = stream.packets.get(stream.next);
      if (!payload) {
        stream.gapAt ??= this.now();
        if (this.now() - stream.gapAt < 40) break;
        stream.next = Math.min(...stream.packets.keys());
        payload = stream.packets.get(stream.next);
      }
      stream.packets.delete(stream.next++);
      stream.decoded = true;
      stream.gapAt = null;
      try {
        const pcm = Buffer.from(stream.decoder.decode(payload));
        if (!pcm.length || pcm.length % 2) continue;
        stream.chunks.push(pcm);
        stream.samples += pcm.length / 2;
        this.hasAudio = true;
        this.onDecoded(key, pcm);
      } catch {
        this.onError(key);
      }
    }
  }

  pull() {
    const sum = new Float64Array(this.frameSamples);
    for (const [key, stream] of this.streams) {
      if (this.now() - stream.lastSeen > 30000) {
        this.remove(key);
        continue;
      }
      this.fill(key, stream);
      const frame = this.leveling ? new Float64Array(this.frameSamples) : sum;
      for (let i = 0; i < this.frameSamples && stream.samples; i++) {
        const chunk = stream.chunks[0];
        frame[i] += chunk.readInt16LE(stream.offset * 2);
        stream.offset++;
        stream.samples--;
        if (stream.offset * 2 === chunk.length) {
          stream.chunks.shift();
          stream.offset = 0;
        }
      }
      if (this.leveling) {
        (stream.leveler ??= new SmartVoiceLeveler(this.rate)).process(frame);
        for (let i = 0; i < frame.length; i++) sum[i] += frame[i];
      }
    }
    if (!this.hasAudio) return null;
    if (this.leveling) (this.limiter ??= new MixLimiter(this.rate)).process(sum);
    const pcm = Buffer.alloc(this.frameSamples * 2);
    for (let i = 0; i < sum.length; i++)
      pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum[i]))), i * 2);
    return pcm;
  }

  setLeveling(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Leveling must be on or off');
    if (this.leveling === enabled) return;
    this.leveling = enabled;
    this.limiter = null;
    for (const stream of this.streams.values()) delete stream.leveler;
  }

  retainSsrcs(ssrcs) {
    for (const [key, stream] of this.streams) if (!ssrcs.has(stream.ssrc)) this.remove(key);
  }
  remove(key) {
    const stream = this.streams.get(key);
    if (!stream) return;
    this.streams.delete(key);
    stream.decoder.delete?.();
  }
  close() {
    for (const key of this.streams.keys()) this.remove(key);
    this.hasAudio = false;
  }
}
