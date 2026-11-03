export const MAX_AUDIO_SOCKET_BACKLOG = 8000; // 250 ms of 16 kHz mono PCM

export class MicFrameGate {
  constructor() {
    this.accepted = 0;
    this.stale = 0;
    this.congested = 0;
  }
  take(message, audioTime, bufferedBytes = 0) {
    const pcm = message?.pcm ?? message;
    if (!(pcm instanceof ArrayBuffer) || pcm.byteLength !== 640) return null;
    if (Number.isFinite(message?.captureTime) && audioTime - message.captureTime > 0.25) {
      this.stale++;
      return null;
    }
    if (bufferedBytes > MAX_AUDIO_SOCKET_BACKLOG) {
      this.congested++;
      return null;
    }
    this.accepted++;
    return pcm;
  }
}
