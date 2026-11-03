import { isBridgePeerId, parsePeerChannel } from './bridge-session.js';

// RtcGroupChat::Connection::onE2EConnection creates logical channel 1 when
// strcmp(localIdentity, remoteIdentity) < 0 (Android 0x9ba68c). Unlike channel
// 0's case-insensitive role selection, this comparison is case-sensitive.
export const partyDataInitiator = (local, remote) => local < remote;
// Native E2EDataChannelOption is reliable=false, ordered=false, both limits=-1.
// SceWebRtc maps that to unordered delivery with zero retransmissions.
const DEFAULT_OPTIONS = Object.freeze({ ordered: false, maxRetransmits: 0 });

export class PartyDataChannels {
  constructor({
    pc,
    peerId,
    self,
    onDebug = () => {},
    onChange = () => {},
    schedule = setTimeout,
    cancel = clearTimeout,
    timeout = 30000,
    maxRetries = 3,
  }) {
    Object.assign(this, {
      pc,
      peerId,
      self,
      onDebug,
      onChange,
      schedule,
      cancel,
      timeout,
      maxRetries,
    });
    this.peers = new Map();
    this.announcements = new Map();
    this.pending = new Map();
    this.closed = false;
  }
  update(participants) {
    if (this.closed) return;
    const present = new Set();
    for (const item of participants) {
      if (!isBridgePeerId(item.peerId) || item.peerId === this.peerId) continue;
      present.add(item.peerId);
      let peer = this.peers.get(item.peerId);
      if (peer && peer.identity !== item.identity) {
        this.remove(item.peerId);
        peer = null;
      }
      if (!peer) {
        peer = {
          peerId: item.peerId,
          identity: item.identity,
          initiator: partyDataInitiator(this.self.identity, item.identity),
          eligible: false,
          channel: null,
          state: 'waiting-control',
          retries: 0,
          retryTimer: null,
          setupTimer: null,
          framesReceived: 0,
          bytesReceived: 0,
        };
        this.peers.set(item.peerId, peer);
      }
      if (!item.eligible && peer.eligible) this.suspend(item.peerId);
      peer.eligible = !!item.eligible;
      if (peer.eligible) this.connect(peer);
    }
    for (const id of this.peers.keys()) if (!present.has(id)) this.remove(id);
  }
  current(peer, channel = peer.channel) {
    return !this.closed && this.peers.get(peer.peerId) === peer && peer.channel === channel;
  }
  connect(peer) {
    if (
      !this.current(peer) ||
      !peer.eligible ||
      peer.retryTimer !== null ||
      peer.state === 'failed'
    )
      return;
    const announcement = this.announcements.get(peer.peerId);
    const pending = !peer.channel ? this.takePending(peer.peerId) : null;
    if (pending) {
      peer.framesReceived += pending.framesReceived;
      peer.bytesReceived += pending.bytesReceived;
      this.bind(peer, pending.channel);
    }
    if (!peer.channel && (peer.initiator || announcement)) {
      try {
        const channel = this.pc.createDataChannel(
          `${peer.peerId}_1`,
          announcement?.options ?? DEFAULT_OPTIONS,
        );
        this.onDebug(
          `Party data channel 1 created: ${peer.initiator ? 'initiator' : 'remote pair'}`,
        );
        this.bind(peer, channel);
      } catch {
        this.retry(peer, 'Party data channel 1 could not be created');
        return;
      }
    }
    if (this.ready(peer)) {
      this.cancel(peer.setupTimer);
      peer.setupTimer = null;
      if (peer.state !== 'ready') {
        peer.state = 'ready';
        peer.retries = 0;
        this.onDebug('Party data channel 1 paired and ready');
        this.onChange();
      }
    } else {
      peer.state = peer.channel?.readyState === 'open' ? 'waiting-pair' : 'connecting';
      if (peer.setupTimer === null)
        peer.setupTimer = this.schedule(
          () => this.retry(peer, 'Party data channel 1 pairing timed out'),
          this.timeout,
        );
    }
  }
  // DataChannel::Established checks the underlying stream's paired state.
  // This channel carries party data, with no participant hello/user table.
  ready(peer) {
    return (
      !!peer?.eligible && peer.channel?.readyState === 'open' && this.announcements.has(peer.peerId)
    );
  }
  bind(peer, channel) {
    peer.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      if (!this.current(peer, channel)) return;
      this.onDebug('Party data channel 1 transport opened');
      this.connect(peer);
      this.onChange();
    };
    channel.onmessage = (event) => {
      if (!this.current(peer, channel)) return;
      const size = event.data?.byteLength ?? event.data?.length ?? 0;
      peer.framesReceived++;
      peer.bytesReceived += size;
      if (peer.framesReceived === 1)
        this.onDebug(`First party data channel 1 frame: ${size} bytes`);
    };
    channel.onclose = () => {
      if (this.current(peer, channel)) this.retry(peer, 'Party data channel 1 transport closed');
    };
    channel.onerror = () => {
      if (this.current(peer, channel)) this.retry(peer, 'Party data channel 1 transport error');
    };
    if (channel.readyState === 'open') channel.onopen();
  }
  peerChannel(event) {
    if (
      this.closed ||
      event.channelNumber !== 1 ||
      !isBridgePeerId(event.peerId) ||
      event.peerId === this.peerId
    )
      return;
    const peer = this.peers.get(event.peerId);
    if (event.type === 'dataChannelDeleted') {
      this.announcements.delete(event.peerId);
      this.dropPending(event.peerId);
      if (peer) this.retry(peer, 'Party data channel 1 remote stream removed');
      return;
    }
    const previous = this.announcements.get(event.peerId);
    if (!peer && !previous && this.announcements.size >= 64) return;
    this.announcements.set(event.peerId, event);
    this.onDebug('Party data channel 1 remote stream announced');
    if (peer) {
      if (event.sid !== previous?.sid) {
        this.cancel(peer.retryTimer);
        peer.retryTimer = null;
        if (previous) {
          this.release(peer);
          this.onDebug('Party data channel 1 stream changed; replacing old pair');
        }
        if (peer.state === 'failed') peer.state = 'connecting';
        peer.retries = 0;
      }
      this.connect(peer);
    }
    this.onChange();
  }
  incoming(channel) {
    const parsed = parsePeerChannel(channel.label);
    if (this.closed || parsed?.channelNumber !== 1 || parsed.peerId === this.peerId) {
      channel.close();
      return;
    }
    const peer = this.peers.get(parsed.peerId);
    if (peer?.channel && peer.channel.readyState !== 'closed') {
      channel.close();
      return;
    }
    if (peer?.eligible) {
      this.cancel(peer.retryTimer);
      peer.retryTimer = null;
      peer.retries = 0;
      peer.state = 'connecting';
      this.bind(peer, channel);
      this.connect(peer);
      this.onChange();
      return;
    }
    if (this.pending.has(parsed.peerId) || this.pending.size >= 64) {
      channel.close();
      return;
    }
    const pending = { channel, framesReceived: 0, bytesReceived: 0, timer: null };
    this.pending.set(parsed.peerId, pending);
    channel.binaryType = 'arraybuffer';
    // Membership can arrive after DCEP. Retain the stream, never message bodies.
    channel.onmessage = (event) => {
      pending.framesReceived++;
      pending.bytesReceived += event.data?.byteLength ?? event.data?.length ?? 0;
    };
    channel.onclose = channel.onerror = () => this.dropPending(parsed.peerId, pending);
    pending.timer = this.schedule(() => this.dropPending(parsed.peerId, pending), this.timeout);
    this.onDebug('Retained party data channel 1 awaiting participant control');
  }
  takePending(id) {
    const pending = this.pending.get(id);
    if (!pending) return null;
    this.pending.delete(id);
    this.cancel(pending.timer);
    pending.channel.onopen =
      pending.channel.onmessage =
      pending.channel.onclose =
      pending.channel.onerror =
        null;
    return pending;
  }
  dropPending(id, expected) {
    if (expected && this.pending.get(id) !== expected) return;
    this.takePending(id)?.channel.close();
  }
  release(peer) {
    this.cancel(peer.setupTimer);
    peer.setupTimer = null;
    const channel = peer.channel;
    peer.channel = null;
    if (channel) {
      channel.onopen = channel.onmessage = channel.onclose = channel.onerror = null;
      channel.close();
    }
    peer.state = peer.eligible ? 'connecting' : 'waiting-control';
  }
  retry(peer, reason) {
    if (!this.current(peer) || peer.retryTimer !== null) return;
    this.release(peer);
    this.onDebug(reason);
    if (!peer.eligible) {
      this.onChange();
      return;
    }
    if (peer.retries >= this.maxRetries) {
      peer.state = 'failed';
      this.onChange();
      return;
    }
    peer.state = 'reconnecting';
    const delay = Math.min(8000, 1000 * 2 ** peer.retries++);
    peer.retryTimer = this.schedule(() => {
      peer.retryTimer = null;
      if (!this.current(peer) || !peer.eligible) return;
      this.connect(peer);
      this.onChange();
    }, delay);
    this.onChange();
  }
  suspend(id) {
    const peer = this.peers.get(id);
    this.announcements.delete(id);
    this.dropPending(id);
    if (!peer) return;
    peer.eligible = false;
    this.cancel(peer.retryTimer);
    peer.retryTimer = null;
    this.release(peer);
    peer.retries = 0;
  }
  remove(id) {
    this.suspend(id);
    this.peers.delete(id);
  }
  snapshot() {
    return [...this.peers.values()].map((peer) => ({
      peerId: peer.peerId,
      initiator: peer.initiator,
      eligible: peer.eligible,
      state: peer.state,
      ready: this.ready(peer),
      retries: peer.retries,
      transport: peer.channel?.readyState ?? null,
      remoteReady: this.announcements.has(peer.peerId),
      framesReceived: peer.framesReceived,
      bytesReceived: peer.bytesReceived,
    }));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const id of this.peers.keys()) this.remove(id);
    for (const id of this.pending.keys()) this.dropPending(id);
    this.announcements.clear();
  }
}
