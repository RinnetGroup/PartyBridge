// Node owns Sony RTC/signaling and independent Opus sources. The browser sends
// microphone PCM and receives one clocked mix at 16 kHz mono for local playout.
import os from 'node:os';
import { createRequire } from 'node:module';
import {
  RTCPeerConnection,
  MediaStreamTrack,
  RTCRtpCodecParameters,
  RtpPacket,
  RtpHeader,
} from 'werift';
import { VoiceSession } from '../protocol/voice-session.js';
import { OfferQueue } from './offer-queue.js';
import { AudioFrameClock, PartyAudioMixer } from './party-audio.js';
import { installSonyReceiveReuse } from './sony-receivers.js';
import { MicPacer } from './mic-pacer.js';
import { audioVolumePatch, applyAudioVolume, DEFAULT_AUDIO_VOLUME } from './audio-volume.js';
import {
  bridgeNetworkStats,
  peerMemberKeys,
  participantDetailsSnapshot,
} from './participant-details.js';
import { VoiceConnectWatch, voiceTransportSnapshot } from './voice-connect.js';

const require = createRequire(import.meta.url);
const OpusScript = require('opusscript');

const RATE = 16000,
  CH = 1,
  FRAME = 320; // 20 ms @ 16 kHz mono

// Pick this machine's primary LAN IPv4 for werift's ICE host candidate. Private
// ranges win over anything else; falls back to the first external IPv4.
export function lanIpv4() {
  const addrs = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
    }
  return (
    addrs.find((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)) ||
    addrs[0] ||
    '0.0.0.0'
  );
}

// Keep Sony's opus/16000 as-is (werift decodes/encodes it); only fix structural SDP.
function repairSdp(sdp) {
  return sdp
    .replace(/^c=IN (\S+) (IP4|IP6)(\r?)$/gm, 'c=IN $2 $1$3')
    .replace(/^(m=application \d+) DTLS\/SCTP \d+(\r?)$/gm, '$1 UDP/DTLS/SCTP webrtc-datachannel$2')
    .replace(/^a=sctpmap:(\d+) webrtc-datachannel(?: \d+)?(\r?)$/gm, 'a=sctp-port:$1$2');
}
function mungeAnswer(sdp) {
  return sdp
    .replace(/^a=group:LS[^\r\n]*\r?\n/gm, '')
    .replace(/^a=ice-options:ice2 /gm, 'a=ice-options:')
    .replace(/^a=end-of-candidates\r?\n/gm, '')
    .replace(/^a=msid-semantic:WMS \*/gm, 'a=msid-semantic: WMS');
}
function waitIce(pc, ms = 8000) {
  return new Promise((res) => {
    if (pc.iceGatheringState === 'complete') return res();
    let subscription;
    const done = () => {
      clearTimeout(timer);
      subscription?.unSubscribe();
      res();
    };
    const timer = setTimeout(done, ms);
    subscription = pc.iceGatheringStateChange.subscribe((s) => {
      if (s === 'complete') done();
    });
  });
}
// Bridge werift's subscribe-based data channel to the browser-style on* surface voice-session.js expects.
function adaptChannel(ch) {
  const w = {
    label: ch.label,
    binaryType: 'arraybuffer',
    get readyState() {
      return ch.readyState;
    },
    send: (data) =>
      ch.send(
        ArrayBuffer.isView(data)
          ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
          : data,
      ),
    close: () => {
      try {
        ch.close();
      } catch {}
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ch.stateChanged.subscribe((st) => {
    if (st === 'open') w.onopen?.();
    else if (st === 'closed') w.onclose?.();
  });
  ch.onMessage.subscribe((data) =>
    w.onmessage?.({ data: Buffer.isBuffer(data) ? new Uint8Array(data) : data }),
  );
  if (ch.readyState === 'open') queueMicrotask(() => w.onopen?.());
  return w;
}
function adaptPc(pc) {
  const a = {
    _ondc: null,
    createDataChannel: (label, opts) => adaptChannel(pc.createDataChannel(label, opts)),
    set ondatachannel(fn) {
      a._ondc = fn;
    },
    get ondatachannel() {
      return a._ondc;
    },
  };
  pc.onDataChannel.subscribe((ch) => a._ondc?.({ channel: adaptChannel(ch) }));
  return a;
}

// Root-mean-square loudness (0..~1) of Int16LE mono PCM, for talking indicators.
function rms16(buf) {
  const n = buf.length >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}
const toBuf = (x) =>
  Buffer.isBuffer(x) ? x : Buffer.from(x.buffer ?? x, x.byteOffset ?? 0, x.byteLength ?? x.length);

// One live voice connection for one already-logged-in PsnClient.
// Events via callbacks: onState(state), onLevel({self,party}), onParticipants([...]), onLog(msg).
export class VoiceEngine {
  constructor(
    client,
    {
      onState,
      onLevel,
      onParticipants,
      onPcm,
      onLog,
      pcFactory = (config) => new RTCPeerConnection(config),
      codecFactory = () => new OpusScript(RATE, CH, OpusScript.Application.VOIP),
      audioNow = () => performance.now(),
    } = {},
  ) {
    this.client = client;
    this.onState = onState;
    this.onLevel = onLevel;
    this.onParticipants = onParticipants;
    this.onPcm = onPcm;
    this.onLog = onLog;
    this.pcFactory = pcFactory;
    this.codecFactory = codecFactory;
    this.audioNow = audioNow;
    this.pc = null;
    this.control = null;
    this.sendTrack = null;
    this.enc = null;
    this.members = [];
    this.peerSnapshot = [];
    this.receiveSubscriptions = new Map();
    this.transportState = 'new';
    this.started = false;
    this.audioReceived = false;
    this.negotiations = 0;
    this.fatal = false;
    this.audio = new PartyAudioMixer({
      decoderFactory: codecFactory,
      now: audioNow,
      onDecoded: () => {
        if (!this.audioReceived) {
          this.audioReceived = true;
          this.refreshState();
        }
      },
      onError: () => {
        if (!this.decodeWarning) {
          this.decodeWarning = true;
          this.log('An incoming audio packet could not be decoded');
        }
      },
    });
    this.seq = (Math.random() * 65535) | 0;
    this.ts = (Math.random() * 1e9) | 0;
    this.ssrc = (Math.random() * 0xffffffff) >>> 0;
    this.muted = false;
    this.sendBuf = Buffer.alloc(0);
    this.micSend = { attempted: 0, completed: 0, failed: 0, inFlight: 0 };
    this.state = 'idle';
    this.selfRms = 0;
    this.partyRms = 0;
    this.levelTimer = null;
    this.audioTimer = null;
    this.stopped = false;
  }

  log(...a) {
    const m = a.join(' ');
    this.onLog?.(m);
    console.log('[voice]', m);
  }
  setState(s) {
    if (this.state !== s) {
      this.state = s;
      this.onState?.(s, this.summary());
    }
  }
  summary() {
    const mapped = new Set(
      this.peerSnapshot.flatMap((p) => (p.users || []).map((u) => String(u.account_id))),
    );
    const missing = new Set(
      this.members
        .filter(
          (m) =>
            m.voiceChatActivated !== false &&
            !(m.isSelf ?? m.accountId === this.client.accountId) &&
            !mapped.has(m.accountId),
        )
        .map((m) => m.memberKey ?? m.accountId),
    );
    return {
      ...(this.failureReason ? { failureReason: this.failureReason } : {}),
      ready: this.peerSnapshot.filter((p) => p.routeReady).length,
      total: this.peerSnapshot.length + missing.size,
      failed: this.peerSnapshot.filter((p) => p.state === 'failed').length,
      audioReceived: this.audioReceived,
      negotiating: this.negotiations > 0,
    };
  }
  refreshState() {
    if (this.stopped || !this.started || this.fatal) return;
    const { ready, total, failed } = this.summary();
    if (this.transportState !== 'connected') this.setState('connecting');
    else if (this.negotiations) this.setState('negotiating');
    else if (!total) this.setState('waiting');
    else if (ready < total) this.setState(ready || failed ? 'partial' : 'connecting');
    else this.setState(this.audioReceived ? 'connected' : 'ready');
  }
  assertRunning() {
    if (this.stopped || this.fatal) throw new Error('Voice operation cancelled');
  }

  start(partyId) {
    this.startPromise = this.startInternal(partyId);
    return this.startPromise;
  }

  async startInternal(partyId) {
    const client = this.client;
    if (!client.active || client.active.id !== partyId) await client.join(partyId);
    this.assertRunning();
    this.setState('preparing');
    const prep = await client.prepareVoice();
    this.assertRunning();
    this.members = prep.members ?? [];
    this.log('prepared peer', prep.peerId);

    const pc = (this.pc = this.pcFactory({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
      codecs: {
        audio: [
          new RTCRtpCodecParameters({
            mimeType: 'audio/opus',
            clockRate: 16000,
            channels: 2,
            payloadType: 111,
          }),
        ],
      },
      iceUseIpv4: true,
      iceInterfaceAddresses: { udp4: process.env.PARTYBRIDGE_BIND || lanIpv4() },
    }));
    installSonyReceiveReuse(pc);
    pc.connectionStateChange.subscribe((s) => {
      this.log('conn', s);
      this.transportState = s;
      if (['connected', 'failed', 'closed'].includes(s)) this.connectWatch?.close();
      if (s === 'failed') {
        this.fatal = true;
        this.log('VOICE FAILED: WebRTC transport failed');
        this.setState('failed');
      } else if (s === 'closed' && !this.stopped) this.setState('stopped');
      else this.refreshState();
    });
    pc.iceConnectionStateChange.subscribe((s) => this.log('ice', s));

    this.sendTrack = new MediaStreamTrack({ kind: 'audio' });
    this.rtpSender = pc.addTransceiver(this.sendTrack, { direction: 'sendonly' })?.sender;
    this.enc = this.codecFactory();

    pc.onTrack.subscribe((track) => this.bindReceiveTrack(track));

    this.offers = new OfferQueue(
      (sdp) => this.acceptOfferSdp(sdp),
      (pending) => {
        this.negotiations = pending;
        this.refreshState();
        this.emitParticipants();
      },
    );

    this.control = new VoiceSession({
      pc: adaptPc(pc),
      peerId: prep.peerId,
      self: prep.self,
      participants: prep.participants,
      members: this.members,
      pollInterval: 2000,
      api: (path) =>
        path.endsWith('/state')
          ? client.voiceState()
          : path.endsWith('/register')
            ? client.registerVoice()
            : {},
      onOffer: (updated) => this.offers.enqueue(updated?.sdp),
      onState: (s) => {
        this.log('bridge', s);
        this.emitParticipants();
      },
      onParticipants: (peers, members) => {
        this.peerSnapshot = peers;
        this.members = members;
        this.refreshState();
        this.emitParticipants();
      },
      onDebug: (m) => this.log('[hs]', m),
      onFailure: (r) => {
        if (!this.stopped) {
          this.fatal = true;
          this.offers.close();
          this.log('VOICE FAILED', r);
          this.setState('failed');
        }
      },
    });
    this.unsubscribeParty = client.push?.onPartyChanged?.(() => this.control?.requestPoll());

    await this.offers.enqueue(prep.offer.sdp);
    this.assertRunning();
    this.control.answerSubmitted();
    this.started = true;
    this.refreshState();
    this.emitParticipants();
    this.watchConnection();

    this.audioClock = new AudioFrameClock({ now: this.audioNow, rate: RATE, frameSamples: FRAME });
    this.micSend ??= { attempted: 0, completed: 0, failed: 0, inFlight: 0 };
    this.micPacer = new MicPacer({ now: this.audioNow, timestamp: this.ts });
    this.audioTimer = setInterval(() => this.pumpAudio(), 10);

    this.levelTimer = setInterval(() => {
      this.onLevel?.({ self: this.muted ? 0 : this.selfRms, party: this.partyRms });
      this.partyRms *= 0.55;
      this.selfRms *= 0.55; // decay between updates
    }, 120);

    return { peerId: prep.peerId };
  }

  watchConnection() {
    this.connectWatch?.close();
    if (this.stopped || this.fatal || this.transportState === 'connected') return;
    this.connectWatch = new VoiceConnectWatch(this.pc, {
      onRetry: (snapshot) => {
        this.log('Retrying exhausted voice network checks');
        this.client.diagnosticLog?.write('voice.connect-retry', { transport: snapshot });
      },
      onTimeout: (snapshot) => {
        if (this.stopped || this.fatal || this.transportState === 'connected') return;
        this.fatal = true;
        this.offers?.close();
        this.failureReason = snapshot.some((t) => t.nominated)
          ? 'Voice encryption setup timed out. Rejoin to try again.'
          : 'Voice network checks timed out. Check that PartyBridge is allowed through your firewall, then rejoin.';
        this.client.diagnosticLog?.write('voice.connect-timeout', { transport: snapshot });
        this.log('VOICE FAILED: initial transport timed out');
        this.setState('failed');
      },
    });
  }

  emitParticipants() {
    if (this.stopped) return;
    const peers = this.participantPeers();
    this.onParticipants?.(peers, this.members, this.summary());
  }

  participantPeers() {
    return this.peerSnapshot.map((p) => ({
      peerId: p.peerId,
      accountIds: (p.users || [])
        .map((u) => String(u.account_id ?? u.accountId ?? ''))
        .filter(Boolean),
      memberKeys: peerMemberKeys(this.members, p, this.control?.peers?.get(p.peerId)?.identity),
      state: p.state,
      handshakeReady: p.handshakeReady,
      routeReady: p.routeReady,
      retries: p.retries,
      dataChannelReady: p.dataChannelReady,
      dataChannelState: p.dataChannelState,
    }));
  }

  async participantDetails() {
    const now = Date.now(),
      pc = this.pc;
    if (!this.participantNetwork || now - this.participantNetwork.sampledAt >= 1000) {
      let report;
      try {
        report = await pc?.getStats?.();
      } catch {}
      if (this.pc !== pc || this.stopped) return { participants: [], bridge: null };
      this.participantNetwork = bridgeNetworkStats(report, this.transportState, now);
    }
    const bridge =
      this.participantNetwork.state === this.transportState
        ? this.participantNetwork
        : bridgeNetworkStats(null, this.transportState, now);
    return {
      ...participantDetailsSnapshot({
        members: this.members,
        peers: this.participantPeers(),
        profile: this.client.profile,
        muted: this.muted,
        voiceState: this.state,
        observing: true,
        bridge,
      }),
      rosterReady: this.members.length > 0,
    };
  }

  async acceptOfferSdp(sdp) {
    this.assertRunning();
    const pc = this.pc,
      client = this.client;
    if (!sdp) {
      const result = await client.refreshVoiceOffer();
      sdp = result.offer.sdp;
    }
    this.assertRunning();
    const repaired = repairSdp(sdp);
    await pc.setRemoteDescription({ type: 'offer', sdp: repaired });
    this.assertRunning();
    // setRemoteDescription applies candidates to their actual media sections.
    this.syncReceiveTracks();
    const answer = await pc.createAnswer();
    this.assertRunning();
    await pc.setLocalDescription(answer);
    this.syncReceiveTracks();
    this.assertRunning();
    await waitIce(pc);
    this.assertRunning();
    await client.answer(mungeAnswer(pc.localDescription.sdp));
    this.assertRunning();
    const sources = new Set([...repaired.matchAll(/^a=ssrc:(\d+) /gm)].map((m) => Number(m[1])));
    if (sources.size) this.audio.retainSsrcs(sources);
    this.log('answer submitted');
  }

  pumpAudio() {
    if (this.stopped || this.fatal || !this.audioClock) return;
    this.micSend ??= { attempted: 0, completed: 0, failed: 0, inFlight: 0 };
    const { frames, skipped } = this.audioClock.take();
    // After a long process pause, discard old audio instead of sending seconds
    // of catch-up audio or keeping a permanent latency backlog.
    if (skipped) this.audio.close();
    for (let i = 0; i < frames; i++) {
      const pcm = this.audio.pull();
      if (pcm) {
        this.partyRms = Math.max(this.partyRms, rms16(pcm));
        this.onPcm?.(applyAudioVolume(pcm, this.audioVolume?.party ?? 100));
      }
    }
    for (const frame of this.micPacer?.take(this.muted) ?? []) {
      if (this.micSend.inFlight < 3) this.sendFrame(frame.pcm, frame.timestamp);
      else this.micPacer.dropped++;
    }
  }

  bindReceiveTrack(track) {
    if (
      !track ||
      track.kind !== 'audio' ||
      track.stopped ||
      this.stopped ||
      this.receiveSubscriptions.has(track)
    )
      return;
    const key = track.uuid ?? track.id ?? String(this.receiveSubscriptions.size);
    const subscription = track.onReceiveRtp.subscribe((rtp) => {
      if (this.stopped || this.fatal) return;
      try {
        this.audio.push(key, rtp);
      } catch {
        if (!this.decodeWarning) {
          this.decodeWarning = true;
          this.log('Incoming audio could not be buffered');
        }
      }
    });
    this.receiveSubscriptions.set(track, subscription);
  }

  syncReceiveTracks() {
    const live = new Set();
    for (const receiver of this.pc?.getReceivers?.() ?? []) {
      if (receiver.stopped) continue;
      for (const track of receiver.tracks ?? [receiver.track]) {
        if (!track || track.stopped) continue;
        live.add(track);
        this.bindReceiveTrack(track);
      }
    }
    for (const [track, subscription] of this.receiveSubscriptions) {
      if (live.has(track)) continue;
      subscription.unSubscribe();
      this.receiveSubscriptions.delete(track);
    }
  }

  async repairReceivePaths() {
    this.assertRunning();
    await this.offers.idle();
    this.assertRunning();
    installSonyReceiveReuse(this.pc);
    this.syncReceiveTracks();
    this.offers.apply = (sdp) => this.acceptOfferSdp(sdp);
    await this.offers.enqueue(null);
    this.syncReceiveTracks();
    this.log('Receive paths refreshed after participant rejoin');
  }

  // Raw 16 kHz mono Int16LE PCM from the browser mic.
  pushMic(pcm) {
    if (!this.sendTrack || this.muted || this.stopped || this.fatal) return;
    const buf = toBuf(pcm);
    if (!this.micPacer?.push(buf)) return;
    const r = rms16(buf);
    if (r > this.selfRms) this.selfRms = r;
  }
  sendFrame(pcm, timestamp = this.ts) {
    if (this.rtpSender?.canSendRtp?.() === false) {
      this.micSend.unavailable = (this.micSend.unavailable ?? 0) + 1;
      return;
    }
    let pendingSend = false;
    const failed = () => {
      this.micSend.failed++;
      if (!this.sendWarning) {
        this.sendWarning = true;
        this.log('Microphone RTP send failed; see audio diagnostics');
      }
    };
    try {
      const opus = this.enc.encode(
        applyAudioVolume(pcm, this.audioVolume?.microphone ?? 100),
        FRAME,
      );
      const rtp = new RtpPacket(
        new RtpHeader({
          version: 2,
          payloadType: 111,
          sequenceNumber: this.seq & 0xffff,
          timestamp: timestamp >>> 0,
          ssrc: this.ssrc,
          marker: false,
        }),
        Buffer.from(opus),
      );
      this.micSend.attempted++;
      this.micSend.inFlight++;
      pendingSend = true;
      // Await the sender's actual async operation. A synchronous track event
      // cannot report an SRTP/socket failure to the surrounding try/catch.
      const sending = this.rtpSender ? this.rtpSender.sendRtp(rtp) : this.sendTrack.writeRtp(rtp);
      this.seq = (this.seq + 1) & 0xffff;
      this.ts = (timestamp + FRAME) >>> 0;
      Promise.resolve(sending)
        .then(() => {
          this.micSend.completed++;
          this.lastMicSendAt = this.audioNow();
          this.sendWarning = false;
        }, failed)
        .finally(() => {
          this.micSend.inFlight--;
        });
    } catch {
      if (pendingSend) this.micSend.inFlight--;
      failed();
    }
  }
  setMuted(m) {
    this.muted = !!m;
    if (this.muted) {
      this.selfRms = 0;
      this.sendBuf = Buffer.alloc(0);
      this.micPacer?.clear();
    }
  }

  setAudioVolume(patch) {
    this.audioVolume = audioVolumePatch(patch, this.audioVolume ?? DEFAULT_AUDIO_VOLUME);
  }
  setSmartLeveling(enabled) {
    this.audio.setLeveling(enabled);
  }

  diagnostics() {
    return {
      state: this.state,
      transport: this.transportState,
      ice: voiceTransportSnapshot(this.pc),
      muted: this.muted,
      audioVolume: this.audioVolume ?? DEFAULT_AUDIO_VOLUME,
      smartLeveling: this.audio.leveling === true,
      microphone: {
        ...this.micPacer?.snapshot(),
        ...this.micSend,
        lastSendMsAgo:
          this.lastMicSendAt == null ? null : Math.round(this.audioNow() - this.lastMicSendAt),
        browser: this.browserAudioStatus ?? null,
      },
      sender: this.rtpSender
        ? {
            stopped: this.rtpSender.stopped,
            packets: this.rtpSender.packetCount,
            codec: this.rtpSender.codec?.mimeType,
          }
        : null,
      participants: this.summary(),
      peers: this.peerSnapshot,
      partyDataChannels: this.control?.partyData?.snapshot() ?? [],
      control: this.control
        ? {
            closed: this.control.closed,
            registered: this.control.registered,
            pollFailures: this.control.pollFailures,
            announcements: this.control.announcements.size,
            pendingChannels: this.control.pendingChannels.size,
          }
        : null,
      transceivers: this.pc?.getTransceivers?.().map((t) => ({
        mid: t.mid,
        direction: t.direction,
        currentDirection: t.currentDirection,
        stopped: t.stopped,
        senderStopped: t.sender.stopped,
        receiverStopped: t.receiver.stopped,
      })),
      receive: [...this.audio.streams].map(([source, stream]) => ({
        source,
        ssrc: stream.ssrc,
        highestSequence: stream.highest,
        nextSequence: stream.next,
        packetsQueued: stream.packets.size,
        samplesQueued: stream.samples,
        lastPacketMsAgo: Math.round(this.audio.now() - stream.lastSeen),
      })),
    };
  }
  reportAudioStatus(message) {
    const status = {
      context: ['running', 'suspended', 'interrupted', 'closed'].includes(message.context)
        ? message.context
        : 'unknown',
      track: ['live', 'ended'].includes(message.track) ? message.track : 'unknown',
      capture: message.capture === 'stalled' ? 'stalled' : 'flowing',
      dropped: Number.isSafeInteger(message.dropped) && message.dropped >= 0 ? message.dropped : 0,
    };
    const previous = this.browserAudioStatus;
    if (!previous || ['context', 'track', 'capture'].some((key) => previous[key] !== status[key]))
      this.log(
        `Browser audio: context ${status.context}; track ${status.track}; capture ${status.capture}`,
      );
    this.browserAudioStatus = status;
    this.client.diagnosticLog?.write('browser.audio', { client: this.client.contextId, ...status });
  }

  stop() {
    return (this.stopPromise ??= this.stopInternal());
  }

  async stopInternal() {
    this.stopped = true;
    this.connectWatch?.close();
    clearInterval(this.levelTimer);
    this.levelTimer = null;
    clearInterval(this.audioTimer);
    this.audioTimer = null;
    this.offers?.close();
    this.unsubscribeParty?.();
    this.unsubscribeParty = null;
    try {
      this.control?.close();
    } catch {}
    try {
      this.pc?.close();
    } catch {}
    for (const subscription of this.receiveSubscriptions.values()) subscription.unSubscribe();
    this.receiveSubscriptions.clear();
    this.audio.close();
    this.micPacer?.clear();
    this.enc?.delete?.();
    this.enc = null;
    // Finish/cancel queued work before deleting the peer it refers to. A late
    // preparation result is also cleaned up instead of reviving a stopped call.
    await this.startPromise?.catch(() => {});
    await this.offers?.idle();
    try {
      await this.client.stopVoice();
    } catch {}
    this.setState('stopped');
  }
}
