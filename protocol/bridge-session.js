// Bridge control protocol used by the browser voice coordinator.
// Evidence addresses refer to libMirandaParty.so 26.10.0 ELF virtual addresses.
// See docs/ARCHITECTURE.md for integration prerequisites.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const requestId = (value) => Number.isSafeInteger(value) && value > 0;
export const isBridgePeerId = (value) =>
  typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const events = new Set([
  'peerCreated',
  'peerDeleted',
  'bridgeDeleted',
  'offerUpdated',
  'dataChannelCreated',
  'dataChannelDeleted',
  'maintenanceScheduled',
]);
const peerList = (value) =>
  Array.isArray(value) && value.length <= 100 && value.every(isBridgePeerId);

export function decodeFrame(raw) {
  let text;
  if (typeof raw === 'string') {
    if (raw.length > 131072) throw new Error('Oversized control frame');
    text = raw;
  } else {
    const bytes =
      raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : ArrayBuffer.isView(raw)
          ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
          : null;
    if (!bytes || bytes.byteLength > 131072) throw new Error('Invalid control frame');
    text = decoder.decode(bytes);
  }
  const frame = JSON.parse(text);
  if (!object(frame) || typeof frame.category !== 'string' || typeof frame.type !== 'string')
    throw new Error('Invalid control envelope');
  if (frame.category === 'response') {
    // ErrorResponse::Init 0x6c2118 reads id INSIDE error, with a string code.
    if (frame.type === 'error') {
      if (
        !object(frame.error) ||
        !requestId(frame.error.id) ||
        typeof frame.error.code !== 'string' ||
        typeof frame.error.message !== 'string'
      )
        throw new Error('Invalid error response');
    } else if (!requestId(frame.id) || !object(frame.payload)) throw new Error('Invalid response');
  } else if (!events.has(frame.type) || !object(frame.payload)) {
    // 0x6ae5b4 dispatches every non-response category through Event::ParseEvent.
    throw new Error('Unknown control event');
  }
  return frame;
}

// 0x6af818 converts DCEP channelType, including retransmit-count / lifetime modes.
export function channelOptions(channelType, reliabilityParameter) {
  if (![0, 1, 2, 128, 129, 130].includes(channelType)) throw new Error('Unknown data channel type');
  if (
    !Number.isInteger(reliabilityParameter) ||
    reliabilityParameter < 0 ||
    reliabilityParameter > 65535
  )
    throw new Error('Invalid reliability parameter');
  const options = { ordered: (channelType & 128) === 0 };
  if ((channelType & 127) === 1) options.maxRetransmits = reliabilityParameter;
  if ((channelType & 127) === 2) options.maxPacketLifeTime = reliabilityParameter;
  return options;
}

export function parsePeerChannel(label) {
  if (typeof label !== 'string') return null;
  const match = /^([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})_(0|[1-9]\d{0,9})$/i.exec(label);
  if (!match || Number(match[2]) > 0xffffffff) return null;
  return { peerId: match[1], channelNumber: Number(match[2]) };
}

export class BridgeSession {
  constructor({
    peerId,
    send,
    register,
    onOffer = () => {},
    onPeerChannel = () => {},
    onPeerLeft = () => {},
    onState = () => {},
    onDiagnostic = () => {},
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (timer) => clearTimeout(timer),
    requestTimeout = 10000,
  }) {
    if (!isBridgePeerId(peerId)) throw new Error('Invalid local bridge peer');
    if (typeof send !== 'function' || typeof register !== 'function')
      throw new Error('Bridge callbacks required');
    Object.assign(this, {
      peerId,
      send,
      register,
      onOffer,
      onPeerChannel,
      onPeerLeft,
      onState,
      onDiagnostic,
      schedule,
      cancel,
      requestTimeout,
    });
    this.state = 'waiting';
    this.open = false;
    this.answerAccepted = false;
    this.receivedFrame = false;
    this.phaseTimer = null;
    this.nextId = 0;
    this.pending = new Map();
    this.configured = new Set();
    this.known = new Set();
    this.bridgeReady = new Set();
    this.participantReady = new Set();
    this.lastSelection = null;
    this.routingId = null;
    this.acceptedPeers = new Set();
  }
  transition(state) {
    this.state = state;
    this.onState(state);
  }
  terminal() {
    return this.state === 'failed' || this.state === 'closed';
  }
  transportOpened() {
    if (!this.terminal()) {
      this.open = true;
      this.begin();
    }
  }
  answerSubmitted() {
    if (!this.terminal()) {
      this.answerAccepted = true;
      this.begin();
    }
  }
  begin() {
    if (this.state !== 'waiting' || !this.open || !this.answerAccepted) return;
    // 0x6aa1c0 requires the first inbound bridge frame (flag set at 0x6ae5b4),
    // in addition to the connected transport, before OnJoinedToBridge fires.
    if (!this.receivedFrame) {
      if (this.phaseTimer === null)
        this.phaseTimer = this.schedule(
          () => this.fail('Timed out waiting for bridge initialization'),
          this.requestTimeout,
        );
      return;
    }
    this.cancel(this.phaseTimer);
    this.phaseTimer = null;
    this.transition('configuring');
    // OnJoinedToBridge 0x6856e0; serializers 0x6c488c and 0x6c5e1c.
    this.request('setFloorControlParameters', {
      algorithm: 'sieVadAudioLevelBased01',
      parameters: { maxAudioStreams: 8 },
    });
    if (!this.terminal())
      this.request('setReceivingCapability', {
        receivingCapability: {
          audio: {
            opus: [
              { codec: 'CELT', bitrate: 24 },
              { codec: 'CELT', bitrate: 40 },
            ],
          },
        },
      });
  }
  request(type, payload, selection) {
    if (this.terminal()) return null;
    const id = ++this.nextId;
    const timer = this.schedule(
      () => this.fail(`Timed out waiting for ${type}`),
      this.requestTimeout,
    );
    this.pending.set(id, { type, timer, selection });
    try {
      this.send(encoder.encode(JSON.stringify({ category: 'request', type, id, payload })));
    } catch {
      this.fail('Control channel send failed');
    }
    return id;
  }
  receive(raw) {
    if (this.terminal()) return;
    let frame;
    try {
      frame = decodeFrame(raw);
    } catch {
      this.onDiagnostic('Invalid or unsupported bridge control frame');
      return;
    }
    this.receivedFrame = true;
    if (
      frame.type !== 'bridgeDeleted' &&
      !(frame.type === 'peerDeleted' && frame.payload?.peer?.peerId === this.peerId)
    )
      this.begin();
    if (frame.category === 'response') {
      this.response(frame);
      return;
    }
    const { type, payload } = frame;
    // All event kinds are surfaced without leaking IDs, SDP, or server text.
    this.onDiagnostic(`Bridge event: ${type}`);
    if (type === 'bridgeDeleted') {
      this.fail('Voice bridge was removed');
      return;
    }
    if (type === 'maintenanceScheduled') return;
    if (type === 'offerUpdated') {
      // Native OfferUpdatedEvent::HasOffer permits offer:null. The handler
      // then requests an offer through REST (0x6ca138, 0x6af644).
      if (payload.offer == null) {
        this.onDiagnostic('Bridge requested a fresh audio offer');
        this.onOffer(null);
        return;
      }
      const sdp = payload.offer?.sdp;
      if (typeof sdp !== 'string' || !sdp.startsWith('v=0') || sdp.length > 65536) {
        this.fail('Invalid updated voice offer');
        return;
      }
      this.onOffer({ type: 'offer', sdp });
      return;
    }
    const id = payload.peer?.peerId;
    if (!isBridgePeerId(id)) {
      this.onDiagnostic('Invalid bridge peer event');
      return;
    }
    if (type === 'peerDeleted') {
      this.removePeer(id);
      return;
    }
    if (type === 'peerCreated') {
      if (id !== this.peerId) this.known.add(id);
      return;
    }
    if (type === 'dataChannelDeleted') {
      const labels = payload.peer.dataChannelLabels;
      if (
        !Array.isArray(labels) ||
        labels.length > 100 ||
        !labels.every((label) => typeof label === 'string' && label.length <= 128)
      ) {
        this.onDiagnostic('Invalid channel deletion event');
        return;
      }
      if (labels.includes('bridge')) this.removePeer(id);
      for (const label of labels) {
        const parsed = parsePeerChannel(label);
        if (parsed?.peerId === this.peerId && id !== this.peerId) {
          if (parsed.channelNumber === 0) this.setParticipantReady(id, false);
          this.onPeerChannel({
            type,
            peerId: id,
            label: `${id}_${parsed.channelNumber}`,
            channelNumber: parsed.channelNumber,
          });
        }
      }
      return;
    }
    const channel = payload.peer.dataChannel;
    if (!object(channel) || typeof channel.sid !== 'string' || typeof channel.label !== 'string') {
      this.onDiagnostic('Invalid bridge channel event');
      return;
    }
    let options;
    try {
      options = channelOptions(channel.channelType, channel.reliabilityParameter);
    } catch {
      this.onDiagnostic('Unsupported bridge channel options');
      return;
    }
    const addressed = parsePeerChannel(channel.label);
    this.onDiagnostic(
      `Channel announcement: source ${id === this.peerId ? 'self' : 'remote'}; destination ${channel.label === 'bridge' ? 'bridge' : addressed?.peerId === this.peerId ? 'self' : 'other'}; type ${channel.channelType}`,
    );
    if (payload.otherPeers !== undefined) {
      if (
        !Array.isArray(payload.otherPeers) ||
        payload.otherPeers.length > 100 ||
        !payload.otherPeers.every((p) => isBridgePeerId(p?.peerId))
      ) {
        this.onDiagnostic('Invalid bridge readiness snapshot');
        return;
      }
      // OtherPeers is the bridge-channel readiness snapshot, not only REST existence.
      for (const peer of payload.otherPeers)
        if (peer.peerId !== this.peerId) {
          this.known.add(peer.peerId);
          this.bridgeReady.add(peer.peerId);
        }
    }
    if (channel.label === 'bridge') {
      if (id !== this.peerId) {
        this.known.add(id);
        this.bridgeReady.add(id);
      }
    } else {
      const label = parsePeerChannel(channel.label);
      // A remote channel addressed to us is paired with a local remote-id_N label.
      if (id !== this.peerId && label?.peerId === this.peerId) {
        this.known.add(id);
        this.onPeerChannel({
          type,
          peerId: id,
          label: `${id}_${label.channelNumber}`,
          channelNumber: label.channelNumber,
          sid: channel.sid,
          options,
        });
      }
    }
    this.selectPeers();
  }
  response(frame) {
    const error = frame.type === 'error';
    const id = error ? frame.error.id : frame.id;
    const pending = this.pending.get(id);
    if (!pending || (!error && frame.type !== pending.type)) {
      this.onDiagnostic('Unmatched bridge response');
      return;
    }
    if (error) {
      // Never put arbitrary server messages or codes in diagnostics.
      const code = /^[A-Za-z0-9_.-]{1,40}$/.test(frame.error.code) ? ` (${frame.error.code})` : '';
      this.fail(`Bridge rejected ${pending.type}${code}`);
      return;
    }
    if (pending.type === 'setMediaPubSubPeers') {
      const p = frame.payload;
      if (!peerList(p.mediaSubscriptionPeers) || !peerList(p.mediaPublishmentPeers)) {
        this.fail('Invalid audio routing acknowledgement');
        return;
      }
      const canonical = (values) => JSON.stringify([...new Set(values)].sort());
      if (
        canonical(p.mediaSubscriptionPeers) !== pending.selection ||
        canonical(p.mediaPublishmentPeers) !== pending.selection
      ) {
        this.fail('Bridge did not accept the requested audio routes');
        return;
      }
    }
    this.cancel(pending.timer);
    this.pending.delete(id);
    this.onDiagnostic(`Bridge acknowledged ${pending.type}`);
    if (pending.type === 'setMediaPubSubPeers') {
      this.acceptedPeers = new Set(JSON.parse(pending.selection));
      this.routingId = null;
      this.lastSelection = pending.selection;
      this.selectPeers();
      return;
    }
    this.configured.add(pending.type);
    if (
      this.state === 'configuring' &&
      this.configured.has('setFloorControlParameters') &&
      this.configured.has('setReceivingCapability')
    ) {
      this.transition('registering');
      this.phaseTimer = this.schedule(
        () => this.fail('Party peer registration timed out'),
        this.requestTimeout,
      );
      // 0x685d54/0x685e80 gate 0x685908: register only after BOTH acknowledgements.
      Promise.resolve()
        .then(() => (this.terminal() ? undefined : this.register()))
        .then(
          () => {
            if (this.terminal()) return;
            this.cancel(this.phaseTimer);
            this.phaseTimer = null;
            this.transition('connecting-participants');
            this.selectPeers();
          },
          () => this.fail('Party peer registration failed'),
        );
    }
  }
  setParticipantReady(id, ready) {
    if (this.terminal() || !isBridgePeerId(id) || id === this.peerId) return;
    if (ready) this.participantReady.add(id);
    else this.participantReady.delete(id);
    this.selectPeers();
  }
  selectPeers() {
    if (this.state !== 'connecting-participants' || this.routingId !== null) return;
    const peers = [...this.participantReady]
      .filter((id) => this.known.has(id) && this.bridgeReady.has(id))
      .sort();
    const selection = JSON.stringify(peers);
    if (selection === this.lastSelection || (peers.length === 0 && this.lastSelection === null))
      return;
    this.routingId = this.request(
      'setMediaPubSubPeers',
      { mediaSubscriptionPeers: peers, mediaPublishmentPeers: peers },
      selection,
    );
  }
  removePeer(id) {
    if (id === this.peerId) {
      this.fail('Local voice peer was removed');
      return;
    }
    this.known.delete(id);
    this.bridgeReady.delete(id);
    this.participantReady.delete(id);
    this.acceptedPeers.delete(id);
    this.onPeerLeft(id);
    this.selectPeers();
  }
  clearPending() {
    this.cancel(this.phaseTimer);
    this.phaseTimer = null;
    for (const request of this.pending.values()) this.cancel(request.timer);
    this.pending.clear();
    this.routingId = null;
    this.acceptedPeers.clear();
  }
  fail(reason) {
    if (this.terminal()) return;
    this.clearPending();
    this.transition('failed');
    this.onDiagnostic(reason);
  }
  close() {
    this.clearPending();
    this.transition('closed');
  }
}
