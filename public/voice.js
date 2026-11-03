import { VoiceSession } from '../protocol/voice-session.js';

export function inspectOffer(sdp) {
  const opusRates = [...sdp.matchAll(/^a=rtpmap:\d+ opus\/(\d+)\/\d+/gim)].map((m) => Number(m[1]));
  const sonySignature = sdp.includes('rtp-payload-signature');
  if (!opusRates.includes(48000)) {
    return {
      compatible: false,
      reason: `Sony offered ${opusRates.length ? 'Opus/' + opusRates.join(', ') : 'an unknown audio codec'}. This browser requires standard Opus/48000. A native media adapter is still needed; changing the SDP text would not implement the codec or packet-signature protocol.`,
      sonySignature,
    };
  }
  return { compatible: true, sonySignature };
}

// Repair two things Sony's RTC bridge sends that modern Chrome will not accept,
// without touching codecs, clock rates, or media directions:
//  1. c= lines with the address and address-type swapped ("c=IN 172.30.14.87 IP4"
//     instead of "c=IN IP4 172.30.14.87") — Chrome rejects the whole SDP.
//  2. The legacy SCTP data-channel syntax ("m=application N DTLS/SCTP 5000" +
//     "a=sctpmap:5000 webrtc-datachannel 1024"), which Chrome dropped support for;
//     it must be RFC 8841 ("UDP/DTLS/SCTP webrtc-datachannel" + "a=sctp-port").
//     Without this the bridge control data channel never opens, so the handshake
//     never starts.
export function repairSdp(sdp) {
  if (typeof sdp !== 'string') return sdp;
  return (
    sdp
      .replace(/^c=IN (\S+) (IP4|IP6)(\r?)$/gm, 'c=IN $2 $1$3')
      .replace(
        /^(m=application \d+) DTLS\/SCTP \d+(\r?)$/gm,
        '$1 UDP/DTLS/SCTP webrtc-datachannel$2',
      )
      .replace(/^a=sctpmap:(\d+) webrtc-datachannel(?: \d+)?(\r?)$/gm, 'a=sctp-port:$1$2')
      // Sony labels the incoming audio opus/16000, which (a) collides with the
      // outgoing opus/48000 on the same payload type in one BUNDLE (Chrome rejects
      // the whole section) and (b) is non-standard — Opus RTP is always a 48000
      // clock per RFC 7587. Correct it to 48000 so Chrome accepts and plays it.
      .replace(/^(a=rtpmap:\d+ opus)\/16000(\/\d+)?(\r?)$/gm, '$1/48000$2$3')
  );
}

export class VoiceConnection {
  constructor({ api, onState, onStats, onDebug = () => {} }) {
    Object.assign(this, { api, onState, onStats, onDebug });
    this.pc = null;
    this.stream = null;
    this.timer = null;
    this.audio = null;
    this.control = null;
    this.negotiation = Promise.resolve();
    this.preparing = false;
    this.cancelled = false;
    this.remoteMayExist = false;
    this.stopPromise = null;
    this.pendingRemotes = new Set();
    this.remoteTail = Promise.resolve();
    this.cancelIce = null;
    this.failure = null;
    this.attempt = 0;
  }
  async remoteRequest(path, body) {
    const attempt = this.attempt;
    // The helper permits one active action per session. Serialize polling,
    // registration and SDP answers even when their browser events overlap.
    const operation = this.remoteTail.then(() => {
      if (this.cancelled || attempt !== this.attempt)
        throw this.failure ?? new Error('Voice attempt cancelled.');
      return this.api(path, body);
    });
    // Each caller receives its own error; later actions can still run.
    this.remoteTail = operation.then(
      () => {},
      () => {},
    );
    this.pendingRemotes.add(operation);
    try {
      return await operation;
    } finally {
      this.pendingRemotes.delete(operation);
    }
  }
  requireActive(pc = this.pc) {
    if (this.cancelled || this.pc !== pc)
      throw this.failure ?? new Error('Voice attempt cancelled.');
  }
  fail(reason, pc) {
    if (this.pc !== pc || this.cancelled || this.failure) return;
    const attempt = this.attempt;
    this.failure = new Error(reason);
    this.stop().then(
      () => {
        if (this.attempt !== attempt) return;
        this.onStats({ received: 0, sent: 0, connection: 'closed' });
        this.onState(`Voice stopped: ${reason}.`);
      },
      () => {
        if (this.attempt === attempt)
          this.onState(`Voice stopped: ${reason}. Remote cleanup is pending; use Leave party.`);
      },
    );
  }
  async start(deviceId = '') {
    if (this.pc || this.preparing || this.remoteMayExist || this.stopPromise)
      throw new Error('Stop the previous voice attempt first.');
    ++this.attempt;
    this.failure = null;
    this.preparing = true;
    this.cancelled = false;
    this.dataStatsReported = false;
    try {
      this.onState('Requesting Sony’s voice offer…');
      this.remoteMayExist = true;
      const { offer, peerId, self, participants } = await this.remoteRequest(
        '/api/voice/prepare',
        {},
      );
      this.requireActive();
      const check = inspectOffer(offer.sdp);
      if (!check.compatible) throw new Error(check.reason);
      // Listen-only (?listen): never capture or send audio, so other clients can't
      // be crashed by our outgoing frames — used to test hearing in isolation.
      const listenOnly =
        typeof location !== 'undefined' && /(?:^|[?&])listen(?:[=&]|$)/.test(location.search);
      this.listenOnly = listenOnly;
      if (!listenOnly) {
        this.onState('Requesting your microphone…');
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            echoCancellation: true,
            noiseSuppression: true,
          },
          video: false,
        });
        this.requireActive();
        this.onDebug(`Microphone audio tracks: ${this.stream.getAudioTracks().length}`);
        if (!this.stream.getAudioTracks().length)
          throw new Error(
            'The browser returned no microphone audio track. Open PartyBridge in Chrome or Edge and allow microphone access.',
          );
      } else {
        this.onDebug('Listen-only mode: no microphone, no outgoing audio.');
      }
      // Sony's RTC bridge advertises only its own (public) host candidates and no
      // STUN/TURN, so the browser must discover its own public address via STUN or
      // the transport never connects (stuck "connecting"). Use public STUN servers.
      const pc = (this.pc = new RTCPeerConnection({
        iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
      }));
      this.onDebug(
        `Browser audio codecs: ${(RTCRtpSender.getCapabilities('audio')?.codecs ?? []).map((c) => `${c.mimeType}/${c.clockRate}/${c.channels ?? 1}`).join(', ')}`,
      );
      // Re-clock Sony's 16 kHz incoming RTP onto Chrome's 48 kHz Opus grid so
      // playout isn't ~3x fast. Done at the encoded-frame level (see retime-worker.js)
      // because the browser has no 16 kHz Opus clock to negotiate in SDP.
      // Sony's incoming Opus is clocked at 16 kHz; Chrome assumes 48 kHz and plays
      // it ~3x fast, and we can't re-clock in place (timestamps are read-only). So
      // tap the raw Opus packets via an encoded-transform worker, decode them in the
      // page with WebCodecs, and play at real time through Web Audio (see onPcm).
      this.retimeWorker = null;
      this.localDecode = null;
      const canBypass =
        'RTCRtpScriptTransform' in window &&
        'AudioDecoder' in window &&
        'EncodedAudioChunk' in window;
      if (canBypass) {
        try {
          this.initLocalDecode();
          this.retimeWorker = new Worker('/retime-worker.js?v=decode2');
          this.retimeWorker.onmessage = (e) => {
            if (e.data && e.data.payload) this.pushOpus(e.data.payload);
          };
          this.onDebug(
            'Clean-audio path: tapping Opus + decoding with WebCodecs at 48 kHz real time.',
          );
        } catch (e) {
          this.onDebug(`Clean-audio path unavailable: ${e.message}`);
          this.localDecode = null;
          this.retimeWorker = null;
        }
      } else {
        this.onDebug(
          `Clean-audio path unsupported here (ScriptTransform=${'RTCRtpScriptTransform' in window}, AudioDecoder=${'AudioDecoder' in window}); falling back to Chrome playout.`,
        );
      }
      this.negotiation = Promise.resolve();
      this.control = new VoiceSession({
        pc,
        peerId,
        self,
        participants,
        api: (path, body) => this.remoteRequest(path, body),
        onDebug: this.onDebug,
        onOffer: (updated) => this.acceptOffer(updated, pc),
        onState: (state) => {
          if (this.pc === pc && !this.cancelled && !['closed', 'failed'].includes(state))
            this.onState(`Voice handshake: ${state.replaceAll('-', ' ')}`);
        },
        onFailure: (reason) => this.fail(reason, pc),
      });
      this.sendProbeWorker = null;
      if (!listenOnly && this.stream) {
        for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);
        this.onDebug(`Microphone attached: ${pc.getSenders().length} senders`);
        // Probe the OUTGOING audio: report whether the browser lets us rewrite the
        // RTP timestamp / payload before send (needed to match Sony's 16 kHz format).
        if ('RTCRtpScriptTransform' in window) {
          const audioSender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
          if (audioSender && 'transform' in audioSender) {
            try {
              this.sendProbeWorker = new Worker('/retime-worker.js?v=send1');
              this.sendProbeWorker.onmessage = (e) => {
                if (e.data && e.data.kind === 'send-probe')
                  this.onDebug(`Outgoing packet probe: ${JSON.stringify(e.data)}`);
              };
              audioSender.transform = new RTCRtpScriptTransform(this.sendProbeWorker, {
                mode: 'send-probe',
              });
              this.onDebug('Attached outgoing-packet probe to mic sender.');
            } catch (e) {
              this.onDebug(`Outgoing probe unavailable: ${e.message}`);
            }
          }
        }
      } else {
        pc.addTransceiver('audio', { direction: 'recvonly' });
        this.onDebug('Listen-only: receive-only audio transceiver, sending nothing.');
      }
      this.audio = document.createElement('audio');
      this.audio.autoplay = true;
      this.audio.srcObject = new MediaStream();
      pc.ontrack = (event) => {
        if (this.pc !== pc || this.cancelled || !this.audio) return;
        const audio = this.audio;
        let bypassing = false;
        if (
          this.retimeWorker &&
          this.localDecode &&
          event.track.kind === 'audio' &&
          event.receiver &&
          'transform' in event.receiver
        ) {
          try {
            event.receiver.transform = new RTCRtpScriptTransform(this.retimeWorker, {});
            bypassing = true;
            this.onDebug('Tapping Opus packets for clean-audio decode.');
          } catch (e) {
            this.onDebug(`Opus tap failed, using Chrome playout: ${e.message}`);
          }
        }
        audio.srcObject.addTrack(event.track);
        // When we decode + play the audio ourselves, mute Chrome's own (fast/broken)
        // playout of the same track so we don't hear both.
        try {
          audio.muted = bypassing;
        } catch {}
        try {
          this.localDecode?.ctx?.resume?.();
        } catch {}
        this.onDebug(
          `Incoming audio tracks: ${audio.srcObject.getAudioTracks().length}${bypassing ? ' (Chrome playout muted; using clean decode)' : ''}`,
        );
        audio.play().catch(() => {
          if (this.pc === pc && !this.cancelled && !bypassing)
            this.onState('Audio playback needs permission. Check your browser’s sound setting.');
        });
      };
      pc.onconnectionstatechange = () => {
        if (this.pc !== pc || this.cancelled) return;
        if (['failed', 'closed'].includes(pc.connectionState))
          this.fail(`Voice transport ${pc.connectionState}`, pc);
        else if (pc.connectionState === 'disconnected')
          this.onState('Voice transport disconnected · waiting for recovery');
        else
          this.onState(
            pc.connectionState === 'connected'
              ? 'Transport connected · waiting for received audio packets'
              : `Voice transport: ${pc.connectionState}`,
          );
      };
      await this.acceptOffer(offer, pc);
      this.requireActive(pc);
      this.control.answerSubmitted();
      this.requireActive(pc);
      const startedAt = Date.now();
      let statsPending = false;
      this.timer = setInterval(async () => {
        if (this.pc !== pc || this.cancelled || statsPending) return;
        statsPending = true;
        let stats;
        try {
          stats = await pc.getStats();
        } catch {
          return;
        } finally {
          statsPending = false;
        }
        if (this.pc !== pc || this.cancelled) return;
        let received = 0,
          sent = 0;
        for (const report of stats.values()) {
          if (
            report.type === 'inbound-rtp' &&
            (report.kind === 'audio' || report.mediaType === 'audio')
          )
            received += report.bytesReceived ?? 0;
          if (
            report.type === 'outbound-rtp' &&
            (report.kind === 'audio' || report.mediaType === 'audio')
          )
            sent += report.bytesSent ?? 0;
        }
        this.onStats({ received, sent, connection: pc.connectionState });
        if (!this.dataStatsReported && Date.now() - startedAt > 12000) {
          this.dataStatsReported = true;
          for (const report of stats.values())
            if (report.type === 'data-channel')
              this.onDebug(
                `Control transport: ${report.state}; sent ${report.messagesSent ?? 0} messages / ${report.bytesSent ?? 0} bytes; received ${report.messagesReceived ?? 0} messages / ${report.bytesReceived ?? 0} bytes`,
              );
        }
        // Inbound-audio timing stats: heavy removedSamplesForAcceleration vs
        // totalSamplesReceived means Chrome is racing playout (the 16 kHz clock
        // mismatch). After the re-clock transform this ratio should fall sharply.
        if (
          received > 0 &&
          Date.now() - startedAt > 9000 &&
          (!this._accelStatsAt || Date.now() - this._accelStatsAt > 8000)
        ) {
          this._accelStatsAt = Date.now();
          for (const report of stats.values())
            if (
              report.type === 'inbound-rtp' &&
              (report.kind === 'audio' || report.mediaType === 'audio')
            ) {
              this.onDebug(
                `Inbound audio timing: samples=${report.totalSamplesReceived ?? '?'} accel=${report.removedSamplesForAcceleration ?? '?'} decel=${report.insertedSamplesForDeceleration ?? '?'} conceal=${report.concealedSamples ?? '?'} jbufDelay=${(report.jitterBufferDelay ?? 0).toFixed?.(2) ?? report.jitterBufferDelay} clock=${report.clockRate ?? '?'}`,
              );
            }
        }
        if (received > 0)
          this.onState('Receiving audio packets · confirm that you can hear your party');
        else if (Date.now() - startedAt > 30000)
          this.onState('Waiting for party audio · see Voice diagnostics for handshake progress');
      }, 1000);
      return check;
    } catch (error) {
      const original = this.failure ?? error;
      try {
        await this.stop();
      } catch {
        original.message += ' Remote voice cleanup is pending; use Leave party to retry.';
      }
      throw original;
    } finally {
      this.preparing = false;
    }
  }
  acceptOffer(offer, pc) {
    this.negotiation = this.negotiation.then(async () => {
      if (this.pc !== pc || this.cancelled) return;
      if (!offer) ({ offer } = await this.remoteRequest('/api/voice/prepare', {}));
      if (this.pc !== pc || this.cancelled) return;
      offer = { type: offer.type ?? 'offer', sdp: repairSdp(offer.sdp) };
      if (!this.listenOnly) offer = { type: offer.type, sdp: this.mungeSendFormat(offer.sdp) };
      const check = inspectOffer(offer.sdp);
      if (!check.compatible) throw new Error(check.reason);
      await pc.setRemoteDescription(offer);
      if (this.pc !== pc || this.cancelled) return;
      this.onDebug(
        `Offer media: ${offer.sdp
          .split(/\r?\n/)
          .filter((line) => /^m=/.test(line))
          .map((line) => line.split(' ').slice(0, 3).join(' '))
          .join('; ')}`,
      );
      this.onDebug(
        `Offer codecs: ${offer.sdp
          .split(/\r?\n/)
          .filter((line) => /^a=(rtpmap|fmtp):/.test(line))
          .join('; ')}`,
      );
      this.onDebug(
        `Offer transports: ${offer.sdp.includes('a=group:BUNDLE') ? 'bundled' : 'separate'}; ICE contexts ${new Set([...offer.sdp.matchAll(/^a=ice-ufrag:(.+)$/gm)].map((m) => m[1])).size}; DTLS roles ${[...offer.sdp.matchAll(/^a=setup:([a-z]+)$/gm)].map((m) => m[1]).join(', ')}`,
      );
      await pc.setLocalDescription(await pc.createAnswer());
      if (this.pc !== pc || this.cancelled) return;
      const audioSections = pc.localDescription.sdp
        .split(/(?=^m=)/m)
        .filter((section) => section.startsWith('m=audio '));
      if (!audioSections.some((section) => !/^m=audio 0 /.test(section)))
        throw new Error(
          'The browser rejected Sony’s audio format. Voice is not connected; see Voice diagnostics.',
        );
      await new Promise((resolve, reject) => {
        if (pc.iceGatheringState === 'complete') return resolve();
        const finish = (error) => {
          clearTimeout(timeout);
          pc.removeEventListener('icegatheringstatechange', handler);
          if (this.cancelIce === cancel) this.cancelIce = null;
          if (error) reject(error);
          else resolve();
        };
        const timeout = setTimeout(() => finish(new Error('ICE gathering timed out.')), 10000);
        const handler = () => {
          if (pc.iceGatheringState === 'complete') finish();
        };
        const cancel = (this.cancelIce = () =>
          finish(this.failure ?? new Error('Voice attempt cancelled.')));
        pc.addEventListener('icegatheringstatechange', handler);
      });
      if (this.pc !== pc || this.cancelled) return;
      await this.remoteRequest('/api/voice/answer', { sdp: pc.localDescription.sdp });
      if (this.pc !== pc || this.cancelled) return;
      this.onDebug(
        `Answer media: ${pc.localDescription.sdp
          .split(/\r?\n/)
          .filter((line) => /^m=/.test(line))
          .map((line) => line.split(' ').slice(0, 3).join(' '))
          .join('; ')}`,
      );
      this.onDebug(
        `Audio negotiation accepted: ${
          pc
            .getTransceivers()
            .map((t) => t.currentDirection ?? 'pending')
            .join(', ') || 'no transceivers'
        }; senders: ${pc.getSenders().length}`,
      );
    });
    return this.negotiation;
  }
  mute(value) {
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !value;
    });
  }
  // Set up the in-page Opus decoder + Web Audio sink that replaces Chrome's broken
  // 48 kHz playout of Sony's 16 kHz-clocked stream.
  initLocalDecode() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx({ sampleRate: 48000, latencyHint: 'interactive' });
    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(ctx.destination);
    const d = {
      ctx,
      gain,
      playhead: 0,
      lead: 0.12,
      chunkTs: 0,
      configured: false,
      logged: false,
      lastErr: 0,
    };
    d.decoder = new AudioDecoder({
      output: (data) => this.onPcm(data),
      error: (e) => {
        if (Date.now() - d.lastErr > 2000) {
          d.lastErr = Date.now();
          this.onDebug(`Opus decode error: ${e.message}`);
        }
      },
    });
    this.localDecode = d;
    this.onDebug('In-page Opus decoder ready (WebCodecs, 48 kHz).');
  }
  // Feed one tapped Opus packet to the decoder. Each party-voice packet is 40 ms;
  // we hand the decoder a monotonic timestamp so output stays in order.
  pushOpus(payload) {
    const d = this.localDecode;
    if (!d || this.cancelled || d.decoder.state === 'closed') return;
    try {
      if (!d.configured) {
        d.decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
        d.configured = true;
      }
      d.chunkTs += 40000; // microseconds
      d.decoder.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: d.chunkTs,
          duration: 40000,
          data: payload,
        }),
      );
    } catch (e) {
      if (Date.now() - d.lastErr > 2000) {
        d.lastErr = Date.now();
        this.onDebug(`Opus decode push failed: ${e.message}`);
      }
    }
  }
  // Play one decoded PCM buffer at real time. We own the schedule (playhead), so the
  // 16 kHz RTP clock is irrelevant: each 40 ms buffer is placed 40 ms after the last.
  onPcm(data) {
    const d = this.localDecode;
    if (!d || this.cancelled) {
      try {
        data.close();
      } catch {}
      return;
    }
    try {
      const frames = data.numberOfFrames,
        channels = data.numberOfChannels,
        rate = data.sampleRate;
      if (!d.logged) {
        d.logged = true;
        this.onDebug(
          `Decoded PCM: ${rate} Hz, ${channels} ch, ${frames} samples/frame, format ${data.format}`,
        );
      }
      const buf = d.ctx.createBuffer(channels, frames, rate);
      for (let c = 0; c < channels; c++) {
        const tmp = new Float32Array(frames);
        data.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
        buf.copyToChannel(tmp, c);
      }
      const now = d.ctx.currentTime;
      if (d.playhead < now + 0.02) d.playhead = now + d.lead; // prime / recover from underrun
      const src = d.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(d.gain);
      src.start(d.playhead);
      d.playhead += buf.duration;
    } catch (e) {
      if (Date.now() - d.lastErr > 2000) {
        d.lastErr = Date.now();
        this.onDebug(`PCM play failed: ${e.message}`);
      }
    } finally {
      try {
        data.close();
      } catch {}
    }
  }
  // Ask Chrome's Opus encoder to produce narrowband audio (16 kHz content) to match
  // Sony's party-voice format. maxplaybackrate/sprop-maxcapturerate are standard Opus
  // fmtp params; we add them to the remote (Sony) offer so Chrome encodes to suit.
  // This matches content bandwidth — the RTP clock stays 48 kHz (the send probe tells
  // us whether that can be changed too).
  mungeSendFormat(sdp) {
    const extra = 'maxplaybackrate=16000;sprop-maxcapturerate=16000';
    const opusPts = [...sdp.matchAll(/^a=rtpmap:(\d+) opus\//gim)].map((m) => m[1]);
    let out = sdp;
    for (const pt of opusPts) {
      const fmtpRe = new RegExp(`^(a=fmtp:${pt} )([^\\r\\n]*)$`, 'gm');
      if (fmtpRe.test(out)) {
        out = out.replace(new RegExp(`^(a=fmtp:${pt} )([^\\r\\n]*)$`, 'gm'), (m, p, params) =>
          params.includes('maxplaybackrate') ? m : `${p}${params};${extra}`,
        );
      } else {
        out = out.replace(
          new RegExp(`^(a=rtpmap:${pt} opus[^\\r\\n]*)$`, 'gmi'),
          (m) => `${m}\r\na=fmtp:${pt} ${extra}`,
        );
      }
    }
    return out;
  }
  releaseLocal() {
    this.cancelled = true;
    clearInterval(this.timer);
    this.timer = null;
    this.cancelIce?.();
    this.cancelIce = null;
    const control = this.control,
      pc = this.pc,
      stream = this.stream,
      audio = this.audio,
      worker = this.retimeWorker,
      decode = this.localDecode,
      sendWorker = this.sendProbeWorker;
    this.control =
      this.pc =
      this.stream =
      this.audio =
      this.retimeWorker =
      this.localDecode =
      this.sendProbeWorker =
        null;
    // Each resource must be released even if another wrapper's close fails.
    const release = (fn) => {
      try {
        fn();
      } catch {
        this.onDebug('A local voice resource reported an error while closing');
      }
    };
    if (control) release(() => control.close());
    if (pc) {
      pc.onconnectionstatechange = pc.ontrack = pc.ondatachannel = null;
      release(() => pc.close());
    }
    for (const track of stream?.getTracks() ?? []) release(() => track.stop());
    if (audio) {
      release(() => audio.pause());
      release(() => {
        audio.srcObject = null;
      });
    }
    if (worker) release(() => worker.terminate());
    if (sendWorker) release(() => sendWorker.terminate());
    if (decode) {
      release(() => {
        if (decode.decoder.state !== 'closed') decode.decoder.close();
      });
      release(() => decode.ctx.close());
    }
  }
  stop() {
    this.releaseLocal();
    if (this.stopPromise) return this.stopPromise;
    const pending = [...this.pendingRemotes];
    const operation = (async () => {
      // In-flight work finishes; the cancellation guard discards queued work.
      // Then cleanup cannot collide with this connection's earlier actions.
      if (pending.length) await Promise.allSettled(pending);
      if (this.remoteMayExist) {
        await this.api('/api/voice/stop', {});
        this.remoteMayExist = false;
      }
    })();
    this.stopPromise = operation.finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }
}
