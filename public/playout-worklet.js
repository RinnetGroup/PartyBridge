// Party audio playout worklet. Receives decoded 16 kHz mono Int16LE PCM frames
// (ArrayBuffers) from the main thread and plays them through a small jitter
// buffer: it primes ~80 ms before draining, caps backlog at ~1 s to keep
// latency low, and outputs silence (re-priming) on underrun so brief network
// gaps don't turn into permanent desync.
const PRIME = 1280; // 80 ms @ 16 kHz
const MAX = 16000; // 1 s backlog cap

class PcmPlayout extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.cur = null;
    this.pos = 0;
    this.playing = false;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this.queue = [];
        this.cur = null;
        this.pos = 0;
        this.playing = false;
        return;
      }
      const i16 = new Int16Array(e.data);
      const f = new Float32Array(i16.length);
      for (let k = 0; k < i16.length; k++) f[k] = i16[k] / 32768;
      this.queue.push(f);
      let total = this.buffered();
      while (total > MAX && this.queue.length > 1) total -= this.queue.shift().length;
    };
  }
  buffered() {
    let n = this.cur ? this.cur.length - this.pos : 0;
    for (const f of this.queue) n += f.length;
    return n;
  }
  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    if (!this.playing) {
      if (this.buffered() >= PRIME) this.playing = true;
      else {
        out.fill(0);
        return true;
      }
    }
    for (let i = 0; i < out.length; i++) {
      if (!this.cur || this.pos >= this.cur.length) {
        this.cur = this.queue.shift() || null;
        this.pos = 0;
      }
      if (!this.cur) {
        out[i] = 0;
        this.playing = false;
      } else out[i] = this.cur[this.pos++];
    }
    return true;
  }
}
registerProcessor('pcm-playout', PcmPlayout);
