import { AudioFrameClock } from './party-audio.js';

// Audio follows elapsed time even when capture pauses or the microphone is
// muted. Queues are deliberately short: old speech must not become call lag.
export class MicPacer {
  constructor({
    now = () => performance.now(),
    timestamp = 0,
    frameSamples = 320,
    rate = 16000,
    maxQueuedFrames = 5,
    maxAgeMs = 150,
  } = {}) {
    Object.assign(this, { now, frameSamples, maxQueuedFrames, maxAgeMs });
    this.bytes = frameSamples * 2;
    this.baseTimestamp = timestamp >>> 0;
    this.clock = new AudioFrameClock({ now, rate, frameSamples, maxCatchUpFrames: 3 });
    this.queue = [];
    this.partial = Buffer.alloc(0);
    this.received = 0;
    this.dropped = 0;
    this.lastInputAt = null;
  }
  push(pcm) {
    if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > this.bytes * 50)
      return false;
    this.lastInputAt = this.now();
    const data = this.partial.length ? Buffer.concat([this.partial, pcm]) : pcm;
    let offset = 0;
    while (offset + this.bytes <= data.length) {
      this.queue.push({
        pcm: Buffer.from(data.subarray(offset, offset + this.bytes)),
        at: this.lastInputAt,
      });
      offset += this.bytes;
      this.received++;
    }
    this.partial = Buffer.from(data.subarray(offset));
    if (this.queue.length > this.maxQueuedFrames)
      this.dropped += this.queue.splice(0, this.queue.length - this.maxQueuedFrames).length;
    return true;
  }
  take(muted = false) {
    const { frames, skipped } = this.clock.take();
    if (muted) {
      this.clear();
      return [];
    }
    if (!frames) return [];
    if (skipped && this.queue.length > frames)
      this.dropped += this.queue.splice(0, this.queue.length - frames).length;
    const now = this.now();
    while (this.queue.length && now - this.queue[0].at > this.maxAgeMs) {
      this.queue.shift();
      this.dropped++;
    }
    const result = [];
    for (let i = 0; i < frames; i++) {
      const frame = this.queue.shift();
      if (frame)
        result.push({
          pcm: frame.pcm,
          timestamp:
            (this.baseTimestamp + (this.clock.frames - frames + i) * this.frameSamples) >>> 0,
        });
    }
    return result;
  }
  clear() {
    this.queue.length = 0;
    this.partial = Buffer.alloc(0);
  }
  snapshot() {
    return {
      receivedFrames: this.received,
      droppedFrames: this.dropped,
      queuedFrames: this.queue.length,
      lastInputMsAgo: this.lastInputAt === null ? null : Math.round(this.now() - this.lastInputAt),
    };
  }
}
