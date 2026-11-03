// Mic capture worklet. The AudioContext runs at 16 kHz, so input blocks are
// already 16 kHz mono; we accumulate them into 20 ms (320-sample) frames,
// convert to Int16LE, and hand each frame to the main thread to send to the
// Node voice engine. No playback here (connecting to the destination would echo).
class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(320);
    this.n = 0;
    this.muted = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.muted !== undefined) {
        this.muted = !!e.data.muted;
        if (this.muted) this.n = 0;
      }
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || this.muted) return true;
    for (let i = 0; i < ch.length; i++) {
      let s = ch[i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      this.frame[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.frame.length) {
        const copy = this.frame.slice(0);
        this.port.postMessage({ pcm: copy.buffer, captureTime: currentTime }, [copy.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('mic-capture', MicCapture);
