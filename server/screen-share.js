import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { AppError } from './errors.js';

const BFE = 'https://bfe-prod.playstation-cloud.com';
const SESSION = '/sessionManager/v2/partySessions';
export const screenMemberKey = (m) =>
  `${m.accountId}:${m.platform}:${createHash('sha256')
    .update(String(m.deviceUniqueId ?? ''))
    .digest('hex')
    .slice(0, 16)}`;
const membersOf = (raw) =>
  Array.isArray(raw.members) ? raw.members : (raw.members?.players ?? []);
const text = (v, max = 256) => (typeof v === 'string' && v.length <= max ? v : '');
const failure = (code, message, status = 502) => new AppError(status, code, message);

export function memberCustomData(member) {
  if (typeof member.customData1 !== 'string' || member.customData1.length > 32768) return {};
  try {
    const data = JSON.parse(Buffer.from(member.customData1, 'base64').toString('utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export function screenShareInfo(member) {
  const s = memberCustomData(member).Streaming;
  if (!s || typeof s !== 'object' || Array.isArray(s) || !(text(s.PreviewId) || text(s.SessionId)))
    return null;
  return {
    memberKey: screenMemberKey(member),
    accountId: String(member.accountId),
    onlineId: text(member.onlineId) || 'Player',
    platform: String(member.platform),
    restricted: s.IsRestricted === true,
    startedTime: Number.isFinite(s.StartedTime) ? s.StartedTime : null,
    titleId: text(s.titleId, 64),
  };
}

export function screenShareList(raw) {
  return membersOf(raw).map(screenShareInfo).filter(Boolean);
}

export function screenAllocation(member) {
  const s = memberCustomData(member).Streaming;
  if (
    !s ||
    !text(s.SessionId) ||
    typeof s.ConnectionInfo !== 'string' ||
    s.ConnectionInfo.length > 16384
  )
    return null;
  let a;
  try {
    a = JSON.parse(s.ConnectionInfo);
  } catch {
    return null;
  }
  // These addresses come from member-controlled metadata. Never send viewer
  // authorization material to arbitrary hosts or an address supplied by the UI.
  if (
    !a ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.signaling\.brd\.playstation-cloud\.com$/i.test(
      a.signalingServerAddress ?? '',
    ) ||
    !['443', '3443'].includes(String(a.signalingServerPort)) ||
    !text(a.sessionID) ||
    !text(a.sfuID) ||
    a.sessionID !== s.SessionId
  ) {
    throw failure('SCREEN_BAD_ALLOCATION', 'The share returned unfamiliar connection details.');
  }
  return { allocation: a, broadcastId: `nativeStreamer-${s.SessionId}` };
}

// MirandaParty SendWatchRequestForBroadcaster -> BasicMessaging SessionMessagePacket.
// Basic channel=1, dataType=4, 24-byte member address, payload uint32=2 (watch).
// This is a protocol control message; it is not a visible PSN chat message.
export function watchRequestPacket(accountId, sequence) {
  if (
    !/^[1-9]\d{0,19}$/.test(String(accountId)) ||
    BigInt(accountId) > 0xffffffffffffffffn ||
    !Number.isInteger(sequence) ||
    sequence < 1 ||
    sequence > 0xffffffff
  )
    throw new Error('Invalid watch request identity');
  const packet = Buffer.alloc(48);
  packet.writeUInt32LE(1, 0);
  packet.writeUInt32LE(sequence, 4);
  packet.writeUInt32LE(4, 8);
  packet.writeBigUInt64LE(BigInt(accountId), 16);
  packet.writeUInt32LE(100001, 24);
  packet.writeUInt32LE(4, 40);
  packet.writeUInt32LE(2, 44);
  return packet;
}

export function watchingCustomData(member, accountId) {
  // Preserve unrelated member data and exact uint64 values. The native app's
  // Watching array contains numeric account IDs, not rounded JS numbers.
  let root = {};
  if (typeof member.customData1 === 'string' && member.customData1.length <= 32768) {
    try {
      root = JSON.parse(
        Buffer.from(member.customData1, 'base64').toString('utf8'),
        (_key, value, context) =>
          typeof value === 'number' &&
          !Number.isSafeInteger(value) &&
          /^-?\d+$/.test(context.source)
            ? JSON.rawJSON(context.source)
            : value,
      );
    } catch {}
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};
  if (accountId !== null) {
    if (!/^[1-9]\d{0,19}$/.test(String(accountId)) || BigInt(accountId) > 0xffffffffffffffffn)
      throw new Error('Invalid screen watcher target');
    root.Watching = [JSON.rawJSON(String(accountId))];
  } else delete root.Watching;
  return Buffer.from(JSON.stringify(root)).toString('base64');
}

export function checkScreenSdp(sdp) {
  if (
    typeof sdp !== 'string' ||
    sdp.length > 65536 ||
    !sdp.startsWith('v=0') ||
    !/^m=video /m.test(sdp)
  )
    throw failure('SCREEN_INVALID_SDP', 'A video WebRTC description is required.', 400);
  if (!/^a=rtpmap:\d+ H264\/90000/im.test(sdp))
    throw failure(
      'SCREEN_CODEC_UNAVAILABLE',
      'This browser does not offer H.264 video. Open PartyBridge in Chrome or Edge.',
      400,
    );
  return sdp;
}

export class ScreenShareViewer {
  constructor(
    client,
    {
      socketFactory = (url, protocol) =>
        new WebSocket(url, protocol, { maxPayload: 1 << 20, handshakeTimeout: 15000 }),
      onEnd = () => {},
      wait = (ms) => new Promise((r) => setTimeout(r, ms)),
      timeout = 15000,
    } = {},
  ) {
    Object.assign(this, { client, socketFactory, onEnd, wait, timeout });
    this.active = client.active;
    this.pending = new Map();
    this.sequence = 0;
    this.stopped = false;
    this.stage = 'idle';
    this.socket = null;
    this.flagSet = false;
  }
  check() {
    if (this.stopped || !this.active || this.client.active !== this.active)
      throw failure('SCREEN_CANCELLED', 'Screen viewing stopped.', 409);
  }
  async target(memberKey) {
    this.check();
    const raw = await this.client.party(this.active.id);
    this.check();
    const member = membersOf(raw).find((m) => screenMemberKey(m) === memberKey);
    if (!member || !screenShareInfo(member))
      throw failure('SCREEN_ENDED', 'This person is no longer sharing their screen.', 409);
    if (screenShareInfo(member).restricted)
      throw failure(
        'SCREEN_RESTRICTED',
        'The shared screen is currently hidden by the game or console.',
        409,
      );
    return member;
  }
  async requestWatch(member) {
    this.client.screenMessageSequence = ((this.client.screenMessageSequence ?? 0) % 0xffffffff) + 1;
    await this.client.api(
      `${SESSION}/${this.active.id}/customMessage`,
      {
        method: 'POST',
        body: {
          to: [{ accountId: String(member.accountId), platform: member.platform }],
          channel: 'miranda:12',
          payload: `ver=1.0, type=binary, body=${watchRequestPacket(this.client.accountId, this.client.screenMessageSequence).toString('base64')}`,
          withoutSequenceNumber: false,
        },
      },
      'screen-share watch request',
    );
    this.check();
  }
  async start(memberKey, localSDP) {
    checkScreenSdp(localSDP);
    this.stage = 'requesting';
    try {
      let member = await this.target(memberKey);
      this.memberKey = memberKey;
      this.targetAccountId = String(member.accountId);
      await this.requestWatch(member);
      let info = screenAllocation(member);
      for (let i = 0; !info && i < 25; i++) {
        await this.wait(1000);
        member = await this.target(memberKey);
        info = screenAllocation(member);
      }
      if (!info)
        throw failure(
          'SCREEN_NOT_READY',
          'The PS5 has not published its viewing connection yet. Try Watch again.',
        );
      Object.assign(this, info);
      this.stage = 'authorizing';
      const session = await this.client.request(
        `${BFE}/v1/broadcast/sessionId`,
        { headers: { Accept: 'application/json' } },
        'screen-share viewer session',
      );
      this.check();
      this.peerId = text(session.sessionId);
      if (!this.peerId)
        throw failure(
          'SCREEN_SESSION_SCHEMA',
          'The screen-share server returned an unfamiliar session.',
        );
      const auth = await this.client.request(
        `${BFE}/v3/broadcast/sessions/${encodeURIComponent(this.peerId)}/authorize/view`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            npEnvironment: 'np',
            userToken: await this.client.accessToken(),
            groupId: '',
            platform: 'MOBILE_APP',
            partySessionId: this.active.id,
            sessionId: this.peerId,
            broadcastInfo: this.allocation,
          }),
        },
        'screen-share viewer authorization',
      );
      this.check();
      if (!text(auth.sessionData, 16384))
        throw failure(
          'SCREEN_AUTH_SCHEMA',
          'The screen-share server did not return viewer authorization.',
        );
      await this.connect(auth.sessionData);
      this.check();
      this.stage = 'negotiating';
      const profiles = await this.request('getProfileInfo', { broadcastId: this.broadcastId });
      const choices = (profiles.profiles ?? [])
        .filter((p) => Number.isFinite(p.heightPx) && p.heightPx <= 720 && text(p.layerId, 32))
        .sort((a, b) => a.heightPx - b.heightPx);
      const preferredProfile = choices.at(-1)?.layerId ?? 's1';
      const transport = await this.request('createTransport', {
        broadcastId: this.broadcastId,
        peerId: this.peerId,
        kind: 'audio_video',
        localSDP,
        initProfile: choices[0]?.layerId ?? preferredProfile,
        preferredProfile,
      });
      this.transportCreated = true;
      const remote = await this.request('createRemoteSDPChrome', {
        peerId: this.peerId,
        localSDP,
        broadcastId: this.broadcastId,
        transportRemoteParameters: transport,
        kinds: ['video', 'audio'],
      });
      checkScreenSdp(remote.remoteSDP);
      this.check();
      this.stage = 'answering';
      return { type: 'offer', sdp: remote.remoteSDP };
    } catch (error) {
      await this.stop();
      throw error instanceof AppError
        ? error
        : failure(
            'SCREEN_START_FAILED',
            'The screen-share viewer could not start. Check Connection diagnostics.',
          );
    }
  }
  async connect(sessionData) {
    this.check();
    const url = `wss://${this.allocation.signalingServerAddress}:${this.allocation.signalingServerPort}/?data=${encodeURIComponent(sessionData)}`;
    const socket = (this.socket = this.socketFactory(url, 'protoo'));
    socket.on('message', (data) => this.receive(data));
    socket.on('error', () => {});
    socket.on('close', () => {
      if (!this.stopped) {
        this.end('The screen-share connection closed.');
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(failure('SCREEN_SIGNAL_TIMEOUT', 'The screen-share connection timed out.')),
        this.timeout,
      );
      const finish = (error) => {
        clearTimeout(timer);
        socket.off('open', opened);
        socket.off('error', failed);
        socket.off('close', closed);
        error ? reject(error) : resolve();
      };
      const opened = () => finish();
      const failed = () =>
        finish(failure('SCREEN_SIGNAL_FAILED', 'Could not connect to the screen-share server.'));
      const closed = () =>
        finish(
          failure('SCREEN_SIGNAL_CLOSED', 'The screen-share connection closed before it opened.'),
        );
      socket.once('open', opened);
      socket.once('error', failed);
      socket.once('close', closed);
    });
    this.check();
    this.client.record('screen-share signaling', 'connected');
  }
  request(method, data = {}) {
    this.check();
    if (this.socket?.readyState !== 1)
      return Promise.reject(
        failure('SCREEN_SIGNAL_CLOSED', 'The screen-share connection is closed.'),
      );
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(failure('SCREEN_REQUEST_TIMEOUT', `Screen sharing timed out during ${method}.`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.socket.send(
          JSON.stringify({
            request: true,
            id,
            method: 'mediasoup-request',
            data: { method, ...data },
            destination: this.allocation.sfuID,
          }),
        );
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(failure('SCREEN_SIGNAL_CLOSED', 'The screen-share connection is closed.'));
      }
    });
  }
  receive(bytes) {
    if (this.stopped) return;
    let message;
    try {
      message = JSON.parse(bytes.toString());
    } catch {
      return;
    }
    if (message.response === true) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      this.client.record(
        `screen-share ${pending.method}`,
        message.ok === true ? 'accepted' : text(message.name, 80) || 'rejected',
      );
      if (message.ok === true) pending.resolve(message.data ?? {});
      else
        pending.reject(
          failure(
            'SCREEN_REQUEST_REJECTED',
            message.name === 'VRoomNotExist'
              ? 'The PS5 viewing stream expired. Try Watch again.'
              : `The screen-share server rejected ${pending.method}.`,
          ),
        );
    }
    // Transport loss must never stop the independent party voice engine.
    if (
      message.notification &&
      ['transportClosed', 'broadcastClosed', 'producerClosed'].includes(message.data?.method)
    )
      this.end('The shared screen ended.');
  }
  async answer(localSDP) {
    this.check();
    checkScreenSdp(localSDP);
    if (this.stage !== 'answering')
      throw failure('SCREEN_STATE', 'Start a screen viewer before submitting its answer.', 409);
    try {
      await this.request('updateTransport', {
        peerId: this.peerId,
        broadcastId: this.broadcastId,
        localSDP,
      });
      await this.request('enableConsumer', {
        kind: 'audio_video',
        broadcastId: this.broadcastId,
        peerId: this.peerId,
      });
      this.check();
      this.flagSet = true;
      this.watchingUpdate = this.setWatching(true);
      await this.watchingUpdate;
      this.check();
      this.stage = 'receiving';
      return { state: 'receiving' };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async setWatching(enabled) {
    const raw = await this.client.party(this.active.id);
    if (this.client.active !== this.active) return;
    if (enabled) this.check();
    const mine = membersOf(raw).filter(
      (m) =>
        String(m.accountId) === this.client.accountId &&
        ['MOBILE_APP', 100001].includes(m.platform),
    );
    const created = mine.filter(
      (m) => !(this.active.previousMobileIdentities ?? []).includes(m.deviceUniqueId),
    );
    const own =
      mine.find((m) => m.deviceUniqueId === (this.active.identity || this.client.deviceId)) ??
      (created.length === 1 ? created[0] : null);
    const updateData = async () => {
      if (own)
        await this.client.api(
          `${SESSION}/${this.active.id}/members/me`,
          {
            method: 'PATCH',
            body: { customData1: watchingCustomData(own, enabled ? this.targetAccountId : null) },
          },
          'screen-share watcher announcement',
        );
    };
    const updateFlag = () =>
      this.client.api(
        `${SESSION}/${this.active.id}/members/me`,
        { method: 'PATCH', body: { isOnShareScreen: enabled } },
        enabled ? 'screen-share watching' : 'screen-share stopped watching',
      );
    // Sony rejects a PATCH with two fields (2232321 / patchFieldCount).
    // Clear the flag even if clearing custom metadata fails during cleanup.
    if (enabled) {
      await updateData();
      await updateFlag();
    } else {
      try {
        await updateData();
      } finally {
        await updateFlag();
      }
    }
  }
  end(message) {
    if (!this.stopped) {
      this.onEnd(message);
      void this.stop();
    }
  }
  stop() {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.stage = 'stopped';
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(failure('SCREEN_CANCELLED', 'Screen viewing stopped.', 409));
    }
    this.pending.clear();
    if (this.socket) {
      // Only our receive transport is closed; the broadcast and voice stay live.
      if (this.socket.readyState === 1 && this.transportCreated) {
        try {
          this.socket.send(
            JSON.stringify({
              notification: true,
              method: 'mediasoup-notification',
              destination: this.allocation.sfuID,
              data: {
                method: 'closeTransport',
                broadcastId: this.broadcastId,
                peerId: this.peerId,
              },
            }),
          );
        } catch {}
      }
      const socket = this.socket;
      this.socket = null;
      try {
        socket.close();
      } catch {}
      const timer = setTimeout(() => socket.terminate?.(), 1000);
      timer.unref?.();
      socket.once('close', () => clearTimeout(timer));
    }
    this.stopping = (async () => {
      if (this.flagSet && this.client.active === this.active) {
        this.flagSet = false;
        try {
          await this.watchingUpdate;
        } catch {}
        try {
          await this.setWatching(false);
        } catch {}
      }
    })();
    return this.stopping;
  }
}
