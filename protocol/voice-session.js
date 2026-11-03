import { BridgeSession, isBridgePeerId, parsePeerChannel } from './bridge-session.js';
import {
  ParticipantHandshake,
  participantRole,
  userTableMessage,
  decodeUserTable,
} from './participant.js';
import { PartyDataChannels } from './party-data.js';

let sequence = 0;
const encoder = new TextEncoder();

// Owns the bridge and participant control channels for one RTC peer.
export class VoiceSession {
  constructor({
    pc,
    peerId,
    self,
    participants = [],
    members = [],
    api,
    onOffer,
    onState = () => {},
    onParticipants = () => {},
    onDebug = () => {},
    onFailure = () => {},
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (timer) => clearTimeout(timer),
    pollInterval = 5000,
    participantTimeout = 90000,
    pendingChannelTimeout = 30000,
    maxRetries = 3,
  }) {
    Object.assign(this, {
      pc,
      peerId,
      self,
      members,
      api,
      onOffer,
      onState,
      onParticipants,
      onDebug,
      onFailure,
      schedule,
      cancel,
      pollInterval,
      participantTimeout,
      pendingChannelTimeout,
      maxRetries,
    });
    this.closed = false;
    this.registered = false;
    this.peers = new Map();
    this.announcements = new Map();
    this.pendingChannels = new Map();
    this.pollTimer = null;
    this.channel = pc.createDataChannel('bridge', { ordered: true });
    this.channel.binaryType = 'arraybuffer';
    this.bridge = new BridgeSession({
      peerId,
      schedule,
      cancel,
      // The bridge API carries JSON text; binary SCTP frames receive no response.
      send: (bytes) => this.channel.send(new TextDecoder().decode(bytes)),
      register: () => api('/api/voice/register', {}),
      onOffer: (offer) => {
        try {
          Promise.resolve(onOffer(offer)).catch(() => this.fail('Voice renegotiation failed'));
        } catch {
          this.fail('Voice renegotiation failed');
        }
      },
      onPeerChannel: (event) => this.peerChannel(event),
      onPeerLeft: (id) => this.remove(id),
      onState: (state) => {
        onState(state);
        if (state === 'connecting-participants') {
          this.registered = true;
          for (const peer of this.peers.values()) this.connect(peer);
          this.poll();
        }
        this.publish();
      },
      onDiagnostic: (message) => {
        onDebug(message);
        if (this.bridge.state === 'failed') this.fail(message);
      },
    });
    this.channel.onopen = () => {
      onDebug('Bridge control channel opened');
      this.bridge.transportOpened();
    };
    this.channel.onmessage = (event) => {
      if (!this.bridge.receivedFrame)
        onDebug(
          `Bridge initialization frame: ${typeof event.data === 'string' ? 'text' : 'binary'}`,
        );
      this.bridge.receive(event.data);
      this.syncPartyData();
      this.publish();
    };
    this.channel.onerror = () => this.fail('Bridge control channel error');
    this.channel.onclose = () => {
      if (!this.closed) this.fail('Bridge control channel closed');
    };
    pc.ondatachannel = (event) => this.incoming(event.channel);
    this.update(participants);
  }
  answerSubmitted() {
    if (!this.closed) this.bridge.answerSubmitted();
  }
  update(participants) {
    if (this.closed || !Array.isArray(participants)) return;
    const current = new Set();
    for (const item of participants) {
      if (!isBridgePeerId(item.peerId) || item.peerId === this.peerId) continue;
      let role;
      try {
        role = participantRole(this.self.identity, item.identity);
      } catch {
        continue;
      }
      current.add(item.peerId);
      const old = this.peers.get(item.peerId);
      if (old && old.identity === item.identity) {
        old.users = item.users;
        if (this.registered) this.connect(old);
        continue;
      }
      if (old) this.remove(item.peerId);
      const peer = {
        ...item,
        role,
        channel: null,
        handshake: null,
        tableReady: false,
        lastSequence: 0,
        state: 'connecting',
        retries: 0,
        retryTimer: null,
        setupTimer: null,
        earlyFrames: [],
      };
      this.peers.set(item.peerId, peer);
      if (this.registered) this.connect(peer);
    }
    for (const id of this.peers.keys()) if (!current.has(id)) this.remove(id);
    if (this.lastReportedCount !== this.peers.size) {
      this.lastReportedCount = this.peers.size;
      this.onDebug(`Mapped participant controls: ${this.peers.size}`);
    }
    this.syncPartyData();
    this.publish();
  }
  syncPartyData() {
    if (this.closed) return;
    // Lazy construction also initializes sessions made by an older helper
    // constructor when its methods are updated without clearing the login.
    this.partyData ??= new PartyDataChannels({
      pc: this.pc,
      peerId: this.peerId,
      self: this.self,
      schedule: this.schedule,
      cancel: this.cancel,
      maxRetries: this.maxRetries,
      onDebug: this.onDebug,
      onChange: () => this.publish(),
    });
    this.partyData.update(
      [...this.peers.values()].map((peer) => ({
        peerId: peer.peerId,
        identity: peer.identity,
        eligible:
          this.registered &&
          !!peer.handshake?.established &&
          this.bridge.bridgeReady.has(peer.peerId),
      })),
    );
  }
  snapshot() {
    return [...this.peers.values()].map((peer) => {
      const handshakeReady = !!peer.handshake?.established;
      const bridgeReady = this.bridge.bridgeReady.has(peer.peerId);
      const routeReady =
        handshakeReady && bridgeReady && this.bridge.acceptedPeers.has(peer.peerId);
      const data = this.partyData?.peers.get(peer.peerId);
      return {
        peerId: peer.peerId,
        users: peer.users,
        handshakeReady,
        bridgeReady,
        routeReady,
        dataChannelReady: this.partyData?.ready(data) ?? false,
        dataChannelState: data?.state ?? 'waiting-control',
        tableReady: peer.tableReady,
        retries: peer.retries,
        state: routeReady ? 'ready' : handshakeReady ? 'routing' : peer.state,
      };
    });
  }
  publish() {
    if (!this.closed) this.onParticipants(this.snapshot(), this.members);
  }

  incoming(channel) {
    if (this.closed) {
      channel.close();
      return;
    }
    const parsed = parsePeerChannel(channel.label);
    if (parsed?.channelNumber === 1) {
      this.syncPartyData();
      this.partyData?.incoming(channel);
      return;
    }
    if (this.closed || !parsed || parsed.channelNumber !== 0 || parsed.peerId === this.peerId) {
      channel.close();
      return;
    }
    const peer = this.peers.get(parsed.peerId);
    if (peer?.channel && !peer.handshake?.closed && peer.channel.readyState !== 'closed') {
      channel.close();
      return;
    }
    if (peer && this.registered) {
      // An actual replacement channel is ready now; a timer for the failed old
      // channel must not delay it. Stable identity and user-table checks remain.
      this.cancel(peer.retryTimer);
      peer.retryTimer = null;
      if (peer.state === 'failed') peer.retries = 0;
      this.bind(peer, channel);
      this.connect(peer);
      return;
    }
    // DCEP can beat the REST membership poll. Keep both the channel and its
    // early frames until we can validate its stable participant identity.
    if (this.pendingChannels.has(parsed.peerId) || this.pendingChannels.size >= 64) {
      channel.close();
      return;
    }
    const pending = { channel, frames: [], bytes: 0, timer: null };
    this.pendingChannels.set(parsed.peerId, pending);
    channel.binaryType = 'arraybuffer';
    channel.onmessage = (event) => {
      const size = event.data?.byteLength ?? event.data?.length ?? 0;
      if (pending.frames.length >= 32 || pending.bytes + size > 262144) {
        this.dropPending(parsed.peerId);
        return;
      }
      pending.bytes += size;
      pending.frames.push(event.data);
    };
    channel.onclose = channel.onerror = () => this.dropPending(parsed.peerId);
    pending.timer = this.schedule(
      () => this.dropPending(parsed.peerId),
      this.pendingChannelTimeout,
    );
    this.onDebug('Retained participant channel awaiting membership');
  }
  takePending(id) {
    const pending = this.pendingChannels.get(id);
    if (!pending) return null;
    this.pendingChannels.delete(id);
    this.cancel(pending.timer);
    const channel = pending.channel;
    channel.onopen = channel.onmessage = channel.onclose = channel.onerror = null;
    return pending;
  }
  dropPending(id) {
    const pending = this.takePending(id);
    if (pending) pending.channel.close();
  }
  peerChannel(event) {
    if (this.closed) return;
    if (event.channelNumber === 1) {
      this.syncPartyData();
      this.partyData?.peerChannel(event);
      if (!this.peers.has(event.peerId)) this.requestPoll();
      return;
    }
    if (this.closed || event.channelNumber !== 0) return;
    if (event.type === 'dataChannelDeleted') {
      this.announcements.delete(event.peerId);
      this.dropPending(event.peerId);
      const peer = this.peers.get(event.peerId);
      if (peer) {
        const accounts = new Set((peer.users ?? []).map((u) => String(u.account_id)));
        const platforms = [
          ...new Set(
            this.members
              .filter((m) => !m.isSelf && accounts.has(String(m.accountId)))
              .map((m) => m.platform)
              .filter(Boolean),
          ),
        ];
        this.retry(
          peer,
          `Participant control channel was removed${platforms.length ? ` (${platforms.join('/')})` : ''}`,
        );
      }
      return;
    }
    const previous = this.announcements.get(event.peerId);
    this.announcements.set(event.peerId, event);
    const peer = this.peers.get(event.peerId);
    if (
      peer &&
      previous?.sid !== undefined &&
      event.sid !== undefined &&
      event.sid !== previous.sid
    ) {
      // A replacement can be announced before the old channel closes. Reusing
      // the old established handshake strands media on the stale control path.
      this.cancel(peer.retryTimer);
      peer.retryTimer = null;
      this.releasePeer(peer);
      peer.state = 'connecting';
      peer.retries = 0;
      this.onDebug('Participant control stream changed; replacing stale channel');
    }
    if (peer && event.sid !== undefined && event.sid !== previous?.sid && peer.state === 'failed') {
      peer.retries = 0;
      peer.state = 'connecting';
    }
    if (
      peer &&
      event.sid !== undefined &&
      event.sid !== previous?.sid &&
      peer.retryTimer !== null
    ) {
      this.cancel(peer.retryTimer);
      peer.retryTimer = null;
      peer.state = 'connecting';
    }
    if (peer && this.registered) this.connect(peer);
    else if (!peer) this.requestPoll();
    this.publish();
  }
  connect(peer) {
    if (
      this.closed ||
      !this.registered ||
      this.peers.get(peer.peerId) !== peer ||
      peer.retryTimer !== null ||
      peer.state === 'failed'
    )
      return;
    if (!peer.handshake?.established && peer.setupTimer === null) {
      peer.setupTimer = this.schedule(
        () => this.retry(peer, 'Participant connection timed out'),
        this.participantTimeout,
      );
    }
    const announcement = this.announcements.get(peer.peerId);
    const pending = !peer.channel ? this.takePending(peer.peerId) : null;
    if (pending) this.bind(peer, pending.channel, pending.frames);
    if (!peer.channel && (peer.role === 1 || announcement)) {
      // Native reliable=false with both limits=-1 maps to zero retransmits
      // in libSceWebRtc 0x1a6c80, not the browser's reliable default.
      try {
        this.bind(
          peer,
          this.pc.createDataChannel(
            `${peer.peerId}_0`,
            announcement?.options ?? { ordered: true, maxRetransmits: 0 },
          ),
        );
      } catch {
        this.retry(peer, 'Participant control channel could not be created');
      }
    }
    if (announcement) peer.handshake?.remoteChannelReady();
    this.flushFrames(peer);
  }
  bind(peer, channel, frames = []) {
    this.cancel(peer.retryTimer);
    peer.retryTimer = null;
    peer.channel = channel;
    channel.binaryType = 'arraybuffer';
    peer.earlyFrames = frames;
    peer.state = 'connecting';
    const current = () =>
      !this.closed && this.peers.get(peer.peerId) === peer && peer.channel === channel;
    this.onDebug(`Participant control created: role ${peer.role}`);
    peer.handshake = new ParticipantHandshake({
      role: peer.role,
      schedule: this.schedule,
      cancel: this.cancel,
      send: (bytes) => channel.send(bytes),
      onReady: () => {
        if (!current()) return;
        this.cancel(peer.setupTimer);
        peer.setupTimer = null;
        this.onDebug('Participant hello exchange complete');
        const users = [{ account_id: this.self.accountId, platform: this.self.platform }];
        try {
          channel.send(
            encoder.encode(
              JSON.stringify(
                userTableMessage({
                  sequence: ++sequence,
                  identity: this.self.identity,
                  bridgePeerId: this.peerId,
                  users,
                  audioUsers: users,
                }),
              ),
            ),
          );
        } catch {
          this.retry(peer, 'Participant user table could not be sent');
          return;
        }
        peer.retries = 0;
        this.onDebug('Sent participant user table');
        // Native updateConnectingState 0x690d08 enables routing once hello and
        // bridge readiness are established; user-table arrival is independent.
        this.bridge.setParticipantReady(peer.peerId, true);
        this.syncPartyData();
        this.publish();
      },
      onData: (bytes) => {
        if (!current()) return;
        let table;
        try {
          table = decodeUserTable(bytes, {
            identity: peer.identity,
            bridgePeerId: peer.peerId,
            users: peer.users,
          });
        } catch {
          this.onDebug(`Unrecognized participant message (${bytes.length} bytes)`);
          return;
        }
        if (table.global_seq_num <= peer.lastSequence) return;
        peer.lastSequence = table.global_seq_num;
        peer.tableReady = true;
        this.onDebug('Participant identity and user table accepted');
        this.bridge.setParticipantReady(peer.peerId, true);
        this.publish();
      },
      onFailure: (reason) => {
        if (current()) this.retry(peer, reason);
      },
    });
    channel.onopen = () => {
      if (!current()) return;
      this.onDebug('Participant control transport opened');
      peer.handshake.transportOpened();
      this.flushFrames(peer);
    };
    channel.onmessage = (event) => {
      if (!current()) return;
      if (!peer.receivedFrame) {
        peer.receivedFrame = true;
        this.onDebug(
          `First participant frame: ${typeof event.data === 'string' ? 'text' : 'binary'}; ${event.data.byteLength ?? event.data.length ?? 0} bytes; handshake ${peer.handshake.started ? 'started' : 'waiting for pair'}`,
        );
      }
      if (!peer.handshake.started) {
        const size = event.data?.byteLength ?? event.data?.length ?? 0;
        const buffered = peer.earlyFrames.reduce(
          (n, data) => n + (data.byteLength ?? data.length ?? 0),
          0,
        );
        if (peer.earlyFrames.length >= 32 || buffered + size > 262144) {
          this.retry(peer, 'Too many early participant frames');
          return;
        }
        peer.earlyFrames.push(event.data);
      } else peer.handshake.receive(event.data);
    };
    channel.onclose = () => {
      if (current()) this.retry(peer, 'Participant control transport closed');
    };
    channel.onerror = () => {
      if (current()) this.retry(peer, 'Participant control transport error');
    };
    if (channel.readyState === 'open') channel.onopen();
    if (this.announcements.has(peer.peerId)) peer.handshake.remoteChannelReady();
    this.flushFrames(peer);
    this.publish();
  }
  flushFrames(peer) {
    while (peer.handshake?.started && !peer.handshake.closed && peer.earlyFrames.length)
      peer.handshake.receive(peer.earlyFrames.shift());
  }
  releasePeer(peer) {
    this.partyData?.suspend(peer.peerId);
    this.cancel(peer.setupTimer);
    peer.setupTimer = null;
    peer.handshake?.close();
    peer.handshake = null;
    const channel = peer.channel;
    peer.channel = null;
    if (channel) {
      channel.onopen = channel.onmessage = channel.onclose = channel.onerror = null;
      channel.close();
    }
    peer.tableReady = false;
    peer.lastSequence = 0;
    peer.receivedFrame = false;
    peer.earlyFrames = [];
    this.bridge.setParticipantReady(peer.peerId, false);
  }
  retry(peer, reason) {
    if (this.closed || this.peers.get(peer.peerId) !== peer || peer.retryTimer !== null) return;
    this.releasePeer(peer);
    this.onDebug(reason);
    if (peer.retries >= this.maxRetries) {
      peer.state = 'failed';
      this.publish();
      return;
    }
    peer.state = 'reconnecting';
    const delay = Math.min(8000, 1000 * 2 ** peer.retries++);
    peer.retryTimer = this.schedule(() => {
      peer.retryTimer = null;
      if (this.closed || this.peers.get(peer.peerId) !== peer) return;
      peer.state = 'connecting';
      this.connect(peer);
      this.publish();
    }, delay);
    this.publish();
  }
  requestPoll() {
    if (this.closed || !this.registered) return;
    if (this.polling) {
      this.pollRequested = true;
      return;
    }
    this.cancel(this.pollTimer);
    this.pollTimer = null;
    void this.poll();
  }
  async poll() {
    if (this.closed) return;
    if (this.polling) {
      this.pollRequested = true;
      return;
    }
    this.polling = true;
    this.cancel(this.pollTimer);
    this.pollTimer = null;
    try {
      const data = await this.api('/api/voice/state');
      this.pollFailures = 0;
      if (!this.closed) {
        if (Array.isArray(data.members)) this.members = data.members;
        this.update(data.participants);
      }
    } catch (error) {
      // A single failed refresh (a transient fetch error, or a brief party-state
      // blip) must not end a working call. Only give up after several in a row.
      if (error?.code !== 'BUSY' && !this.closed) {
        this.pollFailures = (this.pollFailures || 0) + 1;
        if (this.pollFailures >= 4) {
          this.fail('Party membership could not be refreshed');
          return;
        }
      }
    } finally {
      this.polling = false;
      const delay = this.pollRequested ? 0 : this.pollInterval;
      this.pollRequested = false;
      if (!this.closed) this.pollTimer = this.schedule(() => this.poll(), delay);
    }
  }
  remove(id) {
    this.partyData?.remove(id);
    this.announcements.delete(id);
    this.dropPending(id);
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    this.cancel(peer.retryTimer);
    peer.retryTimer = null;
    this.releasePeer(peer);
    this.publish();
  }
  fail(reason) {
    if (!this.closed) {
      this.close();
      this.onFailure(reason);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.cancel(this.pollTimer);
    this.pollTimer = null;
    this.partyData?.close();
    this.bridge.close();
    for (const id of this.peers.keys()) this.remove(id);
    for (const id of this.pendingChannels.keys()) this.dropPending(id);
    this.announcements.clear();
    this.pc.ondatachannel = null;
    this.channel.onopen =
      this.channel.onmessage =
      this.channel.onclose =
      this.channel.onerror =
        null;
    this.channel.close();
  }
}
