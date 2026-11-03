// Offline reconstruction of Miranda's participant control protocol, APK 26.10.0.
import { isBridgePeerId } from './bridge-session.js';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const validIdentity = (id) =>
  typeof id === 'string' && id.length > 0 && id.length <= 256 && /^[\x21-\x7e]+$/.test(id);

// Connection::Init 0x681630 compares STABLE peer identities, not bridge UUIDs.
export function participantRole(localIdentity, remoteIdentity) {
  if (
    !validIdentity(localIdentity) ||
    !validIdentity(remoteIdentity) ||
    localIdentity.toLowerCase() === remoteIdentity.toLowerCase()
  )
    throw new Error('Distinct participant identities required');
  return localIdentity.toLowerCase() < remoteIdentity.toLowerCase() ? 1 : 2;
}

export class ParticipantHandshake {
  constructor({
    role,
    send,
    onReady = () => {},
    onData = () => {},
    onFailure = () => {},
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (timer) => clearTimeout(timer),
    timeout = 60000,
  }) {
    if (![1, 2].includes(role) || typeof send !== 'function')
      throw new Error('Invalid participant handshake');
    Object.assign(this, { role, send, onReady, onData, onFailure, schedule, cancel, timeout });
    this.open = false;
    this.remoteReady = false;
    this.established = false;
    this.closed = false;
    this.retryTimer = null;
    this.deadline = null;
    this.started = false;
  }
  transportOpened() {
    this.open = true;
    this.begin();
  }
  remoteChannelReady() {
    this.remoteReady = true;
    this.begin();
  }
  begin() {
    if (this.closed || this.started || !this.open || !this.remoteReady) return;
    this.started = true;
    // Our bounded failure deadline. Native connection timeout is configurable.
    this.deadline = this.schedule(() => this.fail('Participant handshake timed out'), this.timeout);
    if (this.role === 2) this.hello();
  }
  hello() {
    if (this.closed) return;
    try {
      this.send(encoder.encode('hello'));
    } catch {
      this.fail('Participant control send failed');
      return;
    }
    // ControlDataChannel::Update 0x6cf0f0 retries every 3 seconds UNTIL a reply.
    if (this.role === 2 && !this.established)
      this.retryTimer = this.schedule(() => this.hello(), 3000);
  }
  receive(raw) {
    if (this.closed || !this.started) return;
    const bytes =
      raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : ArrayBuffer.isView(raw)
          ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
          : typeof raw === 'string'
            ? encoder.encode(raw)
            : null;
    if (!bytes || bytes.length > 131072) {
      this.fail('Invalid participant control frame');
      return;
    }
    const hello =
      bytes.length === 5 && bytes.every((byte, i) => byte === [104, 101, 108, 108, 111][i]);
    // 0x6cf1c4: role 2 accepts any first frame; role 1 requires exact "hello".
    if (this.role === 2 || hello) {
      const wasEstablished = this.established;
      this.established = true;
      this.cancel(this.retryTimer);
      this.cancel(this.deadline);
      this.retryTimer = this.deadline = null;
      if (this.role === 1 && hello) this.hello();
      if (!this.closed && !wasEstablished) this.onReady();
    }
    if (!hello && !this.closed) this.onData(bytes);
  }
  fail(reason) {
    if (!this.closed) {
      this.close();
      this.onFailure(reason);
    }
  }
  close() {
    this.closed = true;
    this.established = false;
    this.cancel(this.retryTimer);
    this.cancel(this.deadline);
    this.retryTimer = this.deadline = null;
  }
}

function checkUser(user) {
  if (
    !user ||
    typeof user.account_id !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(user.account_id) ||
    BigInt(user.account_id) > 0xffffffffffffffffn ||
    !Number.isInteger(user.platform) ||
    user.platform <= 0 ||
    user.platform > 0x7fffffff
  )
    throw new Error('Invalid signaling user');
  return { account_id: user.account_id, platform: user.platform };
}

// FormatMessage 0x69cec4; peer/users/media serializers 0x69d024/0x69d7e4/0x69d950.
// 0x692b2c sets an empty mid and media_identifier="voice_chat" for bridge audio.
export function userTableMessage({ sequence, identity, bridgePeerId, users, audioUsers = [] }) {
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    !validIdentity(identity) ||
    !isBridgePeerId(bridgePeerId) ||
    !Array.isArray(users) ||
    users.length === 0 ||
    users.length > 16 ||
    !Array.isArray(audioUsers) ||
    audioUsers.length > 16
  )
    throw new Error('Invalid user table');
  const local = users.map(checkUser);
  const medias = audioUsers.map((user) => {
    const validated = checkUser(user);
    if (
      !local.some(
        (item) => item.account_id === validated.account_id && item.platform === validated.platform,
      )
    )
      throw new Error('Audio sender must be a local user');
    return {
      user: validated,
      media_records: [{ mid: '', media_identifier: 'voice_chat' }],
      msids: [''],
    };
  });
  const peer = {
    peer_id: identity,
    bridge_peer_id: bridgePeerId,
    miranda_signaling_version: 2,
    users: local,
  };
  if (medias.length) peer.medias = medias;
  return { global_seq_num: sequence, peer, type: 'user_table_updated' };
}

export function decodeUserTable(bytes, expected) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 131072)
    throw new Error('Invalid user table frame');
  const frame = JSON.parse(decoder.decode(bytes));
  if (
    frame?.type !== 'user_table_updated' ||
    !Number.isSafeInteger(frame.global_seq_num) ||
    frame.global_seq_num < 1 ||
    frame.peer?.peer_id !== expected.identity ||
    frame.peer?.bridge_peer_id !== expected.bridgePeerId ||
    frame.peer?.miranda_signaling_version !== 2 ||
    !Array.isArray(frame.peer.users) ||
    frame.peer.users.length > 16
  )
    throw new Error('Unexpected participant user table');
  const users = frame.peer.users.map(checkUser);
  if (
    !users.length ||
    !users.every((user) =>
      expected.users.some(
        (known) =>
          known.account_id === user.account_id &&
          (known.platform === undefined || known.platform === user.platform),
      ),
    )
  )
    throw new Error('Unexpected participant identity');
  return frame;
}
