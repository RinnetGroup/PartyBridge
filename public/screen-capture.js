// Local capture is the first stage of a sender. Sony's publisher authorization
// and SFU producer setup are not present in either mobile SDK we inspected.
// This module never opens a transport, publishes metadata, or records media.
export class LocalScreenCapture {
  constructor({
    video,
    getDisplayMedia = (constraints) => navigator.mediaDevices.getDisplayMedia(constraints),
    onState = () => {},
  }) {
    Object.assign(this, { video, getDisplayMedia, onState });
    this.generation = 0;
    this.stream = null;
  }
  async start({ audio = false } = {}) {
    this.stop(false);
    const generation = this.generation;
    this.onState('choosing');
    let stream;
    try {
      // Call directly from the button gesture, before awaiting anything else.
      stream = await this.getDisplayMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: !!audio,
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') throw new Error('SCREEN_CAPTURE_EMPTY');
      this.stream = stream;
      track.onended = () => {
        if (this.stream === stream) this.stop();
      };
      this.video.muted = true;
      this.video.autoplay = true;
      this.video.playsInline = true;
      this.video.srcObject = stream;
      await this.video.play().catch(() => {});
      if (generation !== this.generation) return;
      const { width, height, frameRate, displaySurface } = track.getSettings();
      this.onState('previewing', {
        width,
        height,
        frameRate,
        displaySurface,
        audio: stream.getAudioTracks().length > 0,
        localOnly: true,
      });
    } catch (error) {
      if (stream && this.stream !== stream) stream.getTracks().forEach((track) => track.stop());
      if (generation !== this.generation) return;
      this.stop(false);
      const cancelled = error.name === 'NotAllowedError' || error.name === 'AbortError';
      this.onState(cancelled ? 'cancelled' : 'error', {
        message: cancelled
          ? 'Screen selection was cancelled or denied.'
          : error.name === 'NotReadableError'
            ? 'That screen or window could not be captured. Try a different source.'
            : 'Screen capture could not start. Try Chrome or Edge and choose an available window.',
      });
    }
  }
  stop(notify = true) {
    this.generation++;
    const stream = this.stream;
    this.stream = null;
    for (const track of stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.video.pause();
    this.video.srcObject = null;
    if (notify) this.onState('stopped');
  }
}

export function initLocalScreenCapture() {
  const video = document.getElementById('capture-preview'),
    start = document.getElementById('capture-start');
  if (!video || !start) return;
  const stop = document.getElementById('capture-stop'),
    audio = document.getElementById('capture-audio'),
    status = document.getElementById('capture-status');
  const supported = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  const capture = new LocalScreenCapture({
    video,
    onState: (state, detail = {}) => {
      const active = state === 'previewing',
        choosing = state === 'choosing';
      video.hidden = !active;
      start.disabled = !supported || choosing;
      stop.disabled = !active && !choosing;
      audio.disabled = active || choosing;
      start.textContent = active ? 'Choose another screen' : 'Choose screen to preview';
      status.textContent = active
        ? `Local preview only · ${detail.width ?? '?'} × ${detail.height ?? '?'}${detail.audio ? ' · audio captured, playback muted' : ''}. Party members cannot see this.`
        : choosing
          ? 'Choose a screen, window, or tab in the browser dialog.'
          : (detail.message ?? 'Preview stopped. Nothing is shared with your party.');
      status.classList.toggle('error', state === 'error');
    },
  });
  start.disabled = !supported;
  if (!supported)
    status.textContent =
      'Screen capture is unavailable in this browser. Open this page in Chrome or Edge.';
  start.addEventListener('click', () => {
    void capture.start({ audio: audio.checked });
  });
  stop.addEventListener('click', () => capture.stop());
  window.addEventListener('pagehide', () => capture.stop(false));
  return capture;
}

if (typeof document !== 'undefined') initLocalScreenCapture();
