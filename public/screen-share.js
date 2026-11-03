// Sony signaling remains in the helper; the browser receives and decodes H.264.
export class ScreenSharePlayer {
  constructor({
    api,
    video,
    onState = () => {},
    getSpeakerId = () => '',
    peerFactory = () => new RTCPeerConnection({ iceServers: [] }),
    makeId = () => crypto.randomUUID(),
  }) {
    Object.assign(this, { api, video, onState, getSpeakerId, peerFactory, makeId });
    this.generation = 0;
    this.pc = null;
    this.watchId = null;
    this.memberKey = null;
  }
  async start(stream) {
    const stopping = this.stop();
    const generation = this.generation;
    await stopping;
    if (generation !== this.generation) return;
    const current = () => this.generation === generation;
    const watchId = (this.watchId = this.makeId());
    this.memberKey = stream.memberKey;
    const pc = (this.pc = this.peerFactory());
    this.onState('starting', { name: stream.onlineId });
    const media = new MediaStream();
    this.video.srcObject = media;
    pc.ontrack = (event) => {
      if (!current()) return;
      if (!media.getTracks().some((t) => t.id === event.track.id)) media.addTrack(event.track);
      this.video.play().catch(() => {
        if (current()) this.onState('play-required', { name: stream.onlineId });
      });
    };
    pc.onconnectionstatechange = () => {
      if (!current()) return;
      clearTimeout(this.disconnected);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed')
        void this.fail('The screen-share connection ended. Try Watch again.', generation);
      else if (pc.connectionState === 'disconnected')
        this.disconnected = setTimeout(
          () =>
            this.fail('The screen-share connection was interrupted. Try Watch again.', generation),
          10000,
        );
    };
    try {
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.addTransceiver('video', { direction: 'recvonly' });
      // The native app uses an unapplied offer to advertise receive capabilities.
      const dummy = await pc.createOffer();
      if (!current()) return;
      const offer = await this.api('/api/screen/start', {
        memberKey: stream.memberKey,
        watchId,
        sdp: dummy.sdp,
      });
      if (!current()) {
        // A stop can reach the helper before a delayed start request. Release
        // that late viewer by its own ID without touching any replacement.
        try {
          await this.api('/api/screen/stop', { watchId });
        } catch {}
        return;
      }
      await pc.setRemoteDescription({ type: offer.type, sdp: offer.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await this.gather(pc);
      if (!current()) return;
      await this.api('/api/screen/answer', { watchId, sdp: pc.localDescription.sdp });
      if (!current()) return;
      await this.outputChanged();
      this.onState('waiting', { name: stream.onlineId });
      this.startedAt = Date.now();
      this.statsTimer = setInterval(async () => {
        try {
          const stats = await pc.getStats();
          if (!current()) return;
          const video = [...stats.values()].find(
            (s) => s.type === 'inbound-rtp' && (s.kind || s.mediaType) === 'video',
          );
          if (video?.framesDecoded > 0) {
            this.lastFrames = video.framesDecoded;
            this.onState(this.video.paused ? 'play-required' : 'playing', {
              name: stream.onlineId,
              width: video.frameWidth || this.video.videoWidth,
              height: video.frameHeight || this.video.videoHeight,
              framesDecoded: video.framesDecoded,
            });
          } else if (Date.now() - this.startedAt > 25000)
            void this.fail('Connected, but no video frames arrived. Try Watch again.', generation);
        } catch {}
      }, 2000);
    } catch (error) {
      if (current()) await this.fail(error.message, generation);
    }
  }
  gather(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', changed);
        if (this.finishGather === finish) this.finishGather = null;
        resolve();
      };
      const changed = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };
      const timer = setTimeout(finish, 5000);
      this.finishGather = finish;
      pc.addEventListener('icegatheringstatechange', changed);
    });
  }
  async outputChanged() {
    if (typeof this.video.setSinkId === 'function') {
      try {
        await this.video.setSinkId(this.getSpeakerId());
      } catch {}
    }
  }
  async fail(message, generation) {
    if (generation !== this.generation) return;
    await this.stop();
    this.onState('error', { message });
  }
  async stop() {
    ++this.generation;
    clearInterval(this.statsTimer);
    clearTimeout(this.disconnected);
    this.finishGather?.();
    this.statsTimer = this.disconnected = null;
    this.lastFrames = 0;
    const watchId = this.watchId;
    this.watchId = null;
    this.memberKey = null;
    if (this.pc) {
      this.pc.ontrack = this.pc.onconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }
    this.video.pause();
    this.video.srcObject = null;
    this.onState('stopped', {});
    if (watchId) {
      try {
        await this.api('/api/screen/stop', { watchId });
      } catch {}
    }
  }
}

export function initScreenSharing({ api, getContext }) {
  const $ = (id) => document.getElementById(id);
  const panel = $('screens-panel'),
    video = $('screen-video'),
    viewer = $('screen-viewer'),
    status = $('screen-status');
  let streams = [],
    polling = false,
    destroyed = false;
  const player = new ScreenSharePlayer({
    api,
    video,
    getSpeakerId: () => getContext().speakerId || '',
    onState: (state, detail) => {
      viewer.hidden = state === 'stopped' || state === 'error';
      $('screen-stop').disabled = state === 'stopped' || state === 'error';
      status.textContent =
        state === 'starting'
          ? `Opening ${detail.name}'s screen…`
          : state === 'waiting'
            ? 'Waiting for video…'
            : state === 'playing'
              ? `${detail.name} · ${detail.width || '?'} × ${detail.height || '?'}`
              : state === 'play-required'
                ? 'Press Play on the video to start playback.'
                : state === 'error'
                  ? detail.message
                  : '';
      status.classList.toggle('error', state === 'error');
      render();
    },
  });
  function render() {
    const list = $('screen-streams');
    list.replaceChildren();
    panel.hidden = !getContext().active && !player.watchId;
    $('screen-empty').hidden = streams.length > 0;
    for (const stream of streams) {
      const row = document.createElement('div');
      row.className = 'screen-stream';
      const label = document.createElement('span');
      label.textContent = `${stream.onlineId} · ${stream.platform} · ${stream.restricted ? 'Screen hidden' : 'Sharing screen'}`;
      const button = document.createElement('button');
      button.className = 'quiet small';
      button.textContent = player.memberKey === stream.memberKey ? 'Watching' : 'Watch';
      button.disabled = stream.restricted || player.memberKey === stream.memberKey;
      button.onclick = () => {
        void player.start(stream);
      };
      row.append(label, button);
      list.append(row);
    }
  }
  async function refresh() {
    if (polling || destroyed) return;
    if (!getContext().active) {
      streams = [];
      if (player.watchId) await player.stop();
      render();
      return;
    }
    polling = true;
    try {
      const data = await api('/api/screens');
      if (destroyed) return;
      streams = data.streams;
      if (
        player.watchId &&
        (!streams.some((s) => s.memberKey === player.memberKey && !s.restricted) ||
          (data.viewer && data.viewer.watchId !== player.watchId) ||
          data.viewer?.state === 'stopped')
      )
        await player.stop();
      render();
    } catch (error) {
      status.textContent = error.message;
      status.classList.add('error');
    } finally {
      polling = false;
    }
  }
  $('screen-stop').onclick = () => {
    void player.stop();
  };
  $('screen-fullscreen').onclick = () => {
    video.requestFullscreen?.().catch(() => {});
  };
  const timer = setInterval(refresh, 5000);
  window.addEventListener('pagehide', () => {
    destroyed = true;
    clearInterval(timer);
    const watchId = player.watchId;
    // Keepalive releases the viewing transport while ordinary pagehide cleanup
    // can close media synchronously. It never disconnects party voice.
    if (watchId)
      fetch('/api/screen/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-PartyBridge-CSRF': getContext().csrf },
        body: JSON.stringify({ watchId }),
        keepalive: true,
      }).catch(() => {});
    void player.stop();
  });
  void refresh();
  return { refresh, outputChanged: () => player.outputChanged() };
}
