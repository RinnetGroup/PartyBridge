import { createHash, randomUUID } from 'node:crypto';
import { AppError, requireId } from './errors.js';
import { partyCreateOptions, partyCreateBody } from './party-create.js';
import { reportedMicMuted } from './participant-details.js';
import { screenShareInfo } from './screen-share.js';
import { SonyPush } from './push.js';
import { createMobileDeviceId } from './device.js';

// These are identifiers of the public Android client, documented by psn-api.
// They are not user credentials. No Sony password is collected by this app.
const AUTH = 'https://ca.account.sony.com/api/authz/v3/oauth';
const API = 'https://m.np.playstation.com/api';
const CLIENT_ID = '09515159-7237-4370-9b40-3806e67c0891';
const CLIENT_AUTH = 'Basic ' + Buffer.from(`${CLIENT_ID}:ucPjka5tntB2KqsP`).toString('base64');
const REDIRECT = 'com.scee.psxandroid.scecompcall://redirect';
const SCOPE = 'psn:mobile.v2.core psn:clientapp';
const SESSION = '/sessionManager/v2/partySessions';
const RTC = '/rtcBridge/v1/bridges';
const mediaTypesFor = (rates) => ({
  application: { isRequired: true },
  audio: {
    isRequired: true,
    opus: [{ bitrate: 40, channels: 1, codec: 'CELT', ptime: 40, samplingRates: rates }],
  },
});

// APK 26.10.0: BridgeInfoAccessor::SetBridgePeerId (0x99859c),
// ChannelMemberBridgeInfoPropertyValue::Format (0x99ae74), and the
// SetBridgePeerId request (0x99a9d0/0x99a9d8): customData4, array index 8.
// EncodeSessionMemberCustomData (0x90bcfc) base64-encodes that JSON for REST.
export function bridgeMemberData(previous, bridgeId, peerId) {
  // Initial native join builder 0x97e5e8 sets the first capability flag true.
  // Encode 0x953708 stores boolean strings, with slot 3 inverted on decode.
  let slots = ['', '', '1', '0', '6.2.0', '0', '0', '0', '', ''];
  if (previous) {
    try {
      if (
        typeof previous !== 'string' ||
        previous.length > 2048 ||
        !/^[A-Za-z\d+/]*={0,2}$/.test(previous)
      )
        throw new Error();
      const parsed = JSON.parse(Buffer.from(previous, 'base64').toString('utf8'));
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 10 ||
        parsed.some((v) => typeof v !== 'string')
      )
        throw new Error();
      slots = parsed;
    } catch {
      throw new AppError(
        502,
        'MEMBER_DATA_CHANGED',
        'Sony returned unfamiliar member data. Voice registration stopped to preserve it.',
      );
    }
  }
  slots[8] = peerId ? `${requireId(bridgeId)}\n${requireId(peerId)}` : '';
  return Buffer.from(JSON.stringify(slots), 'utf8').toString('base64');
}

const stableIdentity = (value) => typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value);
const membersOf = (raw) =>
  Array.isArray(raw.members) ? raw.members : (raw.members?.players ?? []);
const mobileMember = (member) => member.platform === 'MOBILE_APP' || member.platform === 100001;
const voiceMembers = (raw, ownIdentity) =>
  normalizeParty(raw).members.map((member, index) => ({
    ...member,
    voiceChatActivated: membersOf(raw)[index]?.voiceChatActivated !== false,
    micMuted: reportedMicMuted(membersOf(raw)[index]?.customData4),
    isSelf: membersOf(raw)[index]?.deviceUniqueId === ownIdentity,
    memberKey: `${member.accountId}:${member.platform}:${createHash('sha256')
      .update(String(membersOf(raw)[index]?.deviceUniqueId ?? ''))
      .digest('hex')
      .slice(0, 16)}`,
  }));
export function nativeParticipants(raw, bridgeId, ownIdentity) {
  const result = new Map();
  for (const member of membersOf(raw)) {
    if (
      !stableIdentity(member.deviceUniqueId) ||
      member.deviceUniqueId === ownIdentity ||
      member.voiceChatActivated === false
    )
      continue;
    const accountId = String(member.accountId);
    if (!/^[1-9]\d{0,19}$/.test(accountId)) continue;
    let slots;
    try {
      slots = JSON.parse(Buffer.from(member.customData4 ?? '', 'base64').toString('utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(slots) || typeof slots[8] !== 'string') continue;
    const [bridge, peer, extra] = slots[8].split('\n');
    if (
      extra !== undefined ||
      bridge !== bridgeId ||
      !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(peer ?? '')
    )
      continue;
    const existing = result.get(peer);
    if (existing && existing.identity !== member.deviceUniqueId)
      throw new AppError(
        502,
        'PEER_IDENTITY_CONFLICT',
        'Party members disagree about a voice peer identity.',
      );
    const participant = existing ?? { peerId: peer, identity: member.deviceUniqueId, users: [] };
    if (!participant.users.some((u) => u.account_id === accountId))
      participant.users.push({ account_id: accountId });
    result.set(peer, participant);
  }
  return [...result.values()];
}

// Schema-only diagnostics: no response values, account IDs, or session IDs.
function shape(value, depth = 0) {
  if (value === null) return 'null';
  if (depth >= 4) return Array.isArray(value) ? 'array' : typeof value;
  if (Array.isArray(value))
    return { count: value.length, ...(value.length ? { item: shape(value[0], depth + 1) } : {}) };
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .filter((k) => /^[A-Za-z][A-Za-z\d_]{0,39}$/.test(k))
        .slice(0, 20)
        .map((k) => [k, shape(value[k], depth + 1)]),
    );
  return typeof value;
}

export function parseNpsso(input) {
  let value = typeof input === 'string' ? input.trim() : '';
  if (value.startsWith('{')) {
    try {
      value = JSON.parse(value).npsso;
    } catch {
      value = '';
    }
  }
  if (typeof value !== 'string' || !/^[A-Za-z\d_-]{64}$/.test(value)) {
    throw new AppError(
      400,
      'INVALID_NPSSO',
      'Paste the 64-character NPSSO value, or the JSON from Sony’s connection page.',
    );
  }
  return value;
}

export function normalizeParty(raw) {
  const id = raw.sessionId ?? raw.partySessionId;
  requireId(id);
  // Friends'-party summaries list members under `friends`, not `members`.
  const members = Array.isArray(raw.members)
    ? raw.members
    : (raw.members?.players ?? raw.friends ?? []);
  return {
    id,
    name:
      typeof raw.sessionName === 'string' && raw.sessionName
        ? raw.sessionName
        : 'PlayStation party',
    owner: raw.owner?.onlineId ?? '',
    members: members.map((m) => ({
      accountId: String(m.accountId ?? ''),
      onlineId: String(m.onlineId ?? 'Player'),
      platform: String(m.platform ?? 'PlayStation'),
      ...(screenShareInfo(m) ? { screenShare: screenShareInfo(m) } : {}),
    })),
    maxMembers: Number(raw.maxMembers) || 16,
    joinable: raw.partyJoinable !== false,
    visibility: raw.visibilityType === 'INVITE_ONLY' ? 'Invite only' : 'Friends',
  };
}

export class PsnClient {
  constructor({
    fetchImpl = fetch,
    allowBridgeCreation,
    bridgeWaitMs = 60000,
    sendSamplingRates,
    onSessionChanged,
    onSessionExpired,
  } = {}) {
    this.fetch = fetchImpl;
    this.onSessionChanged = onSessionChanged;
    this.onSessionExpired = onSessionExpired;
    // Opus sample rate we advertise for our OUTGOING audio. The browser/libwebrtc
    // require 48000; a native client that can packetize 16 kHz (werift) sets [16000]
    // so the bridge offers our send as opus/16000 — the format the party expects.
    this.sendSamplingRates = sendSamplingRates ?? [48000];
    this.tokens = null;
    this.profile = null;
    this.active = null;
    this.contextId = randomUUID();
    this.events = [];
    this.refreshing = null;
    this.accountId = null;
    this.push = new SonyPush(this);
    this.lastForcedRefresh = 0;
    // Creating and linking a new rtcBridge into a party restarts its voice for
    // every PS5 member and leaves the party pointing at a bridge this PC owns.
    // Off by default: PartyBridge joins only a bridge the party already has.
    this.allowBridgeCreation =
      allowBridgeCreation ?? process.env.PARTYBRIDGE_ALLOW_CREATE_BRIDGE === '1';
    // Join path: how long to wait for a remote member's voice bridge to appear.
    this.bridgeWaitMs = bridgeWaitMs;
  }

  record(step, status, extra = {}) {
    // Deliberately no request/response bodies, URLs, SDP, account IDs or tokens.
    const event = { time: new Date().toISOString(), step, status, ...extra };
    this.diagnosticLog?.write('psn.event', { client: this.contextId, ...event });
    this.events.push(event);
    this.events = this.events.slice(-80);
    // Two-second roster polling must not erase a call's failure history.
    if (
      step === 'voice' ||
      step.startsWith('voice socket') ||
      ['remove voice peer', 'deactivate party voice', 'leave party', 'idle party cleanup'].includes(
        step,
      )
    ) {
      this.voiceEvents ??= [];
      this.voiceEvents.push(event);
      this.voiceEvents = this.voiceEvents.slice(-1000);
    }
    if (process.env.NODE_ENV !== 'test' && step !== 'voice')
      console.log(`[PSN] ${step}: ${status}`);
  }

  async request(url, options, step) {
    let response;
    try {
      response = await this.fetch(url, {
        ...options,
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      this.record(step, 'network-error');
      throw new AppError(
        502,
        'SONY_UNREACHABLE',
        'Could not reach PlayStation. Check your connection and try again.',
        { step },
      );
    }
    this.record(step, response.status);
    if (!response.ok) {
      let data;
      try {
        data = await response.json();
      } catch {}
      const upstreamCode = data?.error?.code;
      const details = {
        step,
        upstreamStatus: response.status,
        ...(typeof upstreamCode === 'number' ? { upstreamCode } : {}),
      };
      if (typeof upstreamCode === 'number') this.record(`${step} error code`, upstreamCode);
      if (typeof data?.error?.message === 'string') {
        let reason = data.error.message.slice(0, 200);
        for (const secret of [this.tokens?.access, this.tokens?.refresh, this.accountId].filter(
          Boolean,
        ))
          reason = reason.split(secret).join('[redacted]');
        reason = reason.replace(/[A-Za-z\d_.+\/=\-]{32,}|\b\d{7,}\b|\S+@\S+/g, '[redacted]');
        this.record(`${step} reason`, reason);
      }
      if (response.status === 401) {
        if (step === 'session refresh')
          throw new AppError(
            401,
            'SONY_SESSION_EXPIRED',
            'Sony rejected the session refresh. Reconnect your account.',
            details,
          );
        throw new AppError(
          401,
          'SONY_UNAUTHORIZED',
          `Sony rejected authorization for ${step}. This does not necessarily mean your account session expired.`,
          details,
        );
      }
      if (response.status === 403 && upstreamCode === 2233351)
        throw new AppError(
          403,
          'SONY_DENIED',
          `Sony no longer recognizes this device as a party member (${step}). Leave the party here, then join it again.`,
          details,
        );
      if (response.status === 403)
        throw new AppError(
          403,
          'SONY_DENIED',
          `PlayStation denied ${step}. The cause has not been established; see Connection diagnostics.`,
          details,
        );
      if (response.status === 429)
        throw new AppError(
          429,
          'SONY_RATE_LIMIT',
          'PlayStation asked us to slow down. Wait a minute before trying again.',
          details,
        );
      throw new AppError(
        502,
        'SONY_PROTOCOL_ERROR',
        `PlayStation rejected the ${step} request (HTTP ${response.status}). This unofficial protocol needs live verification.`,
        details,
      );
    }
    if (response.status === 204 || response.status === 202) return {};
    const content = await response.text();
    if (!content) return {};
    try {
      return JSON.parse(content, (key, value, context) =>
        key === 'accountId' && typeof value === 'number' ? context.source : value,
      );
    } catch {
      throw new AppError(
        502,
        'INVALID_SONY_RESPONSE',
        'PlayStation returned an unexpected response.',
        { step },
      );
    }
  }

  setTokens(raw) {
    if (
      typeof raw.access_token !== 'string' ||
      !Number.isFinite(raw.expires_in) ||
      raw.expires_in <= 0
    ) {
      throw new AppError(
        502,
        'INVALID_TOKEN_RESPONSE',
        'Sony did not return a valid session. Reconnect your account.',
      );
    }
    this.tokens = {
      access: raw.access_token,
      refresh: raw.refresh_token ?? this.tokens?.refresh,
      expiresAt: Date.now() + raw.expires_in * 1000,
    };
    this.record('token format', raw.access_token.split('.').length === 3 ? 'JWT' : 'opaque');
    this.record(
      'mobile scope',
      typeof raw.scope === 'string' && raw.scope.split(' ').includes('psn:mobile.v2.core')
        ? 'present'
        : 'not-reported',
    );
    try {
      const payload = JSON.parse(
        Buffer.from(raw.access_token.split('.')[1], 'base64url').toString(),
        (key, value, context) =>
          key === 'account_id' && typeof value === 'number' ? context.source : value,
      );
      if (/^[1-9]\d{0,19}$/.test(String(payload.account_id)))
        this.accountId = String(payload.account_id);
      this.record('token device context', payload.device_type ? 'present' : 'missing');
      this.record(
        'token device identifier',
        payload.duid || payload.device_id ? 'present' : 'missing',
      );
    } catch {}
  }

  async exchange(fields, step) {
    return this.request(
      `${AUTH}/token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: CLIENT_AUTH,
        },
        body: new URLSearchParams({ ...fields, token_format: 'jwt' }).toString(),
      },
      step,
    );
  }

  async login(input) {
    const npsso = parseNpsso(input);
    // The APK includes duid when obtaining the authorization code (Lb/f.java).
    // Refreshing a token issued without it does not add device context.
    this.deviceId ??= createMobileDeviceId();
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      duid: this.deviceId,
    });
    let response;
    try {
      response = await this.fetch(`${AUTH}/authorize?${params}`, {
        headers: { Cookie: `npsso=${npsso}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new AppError(
        502,
        'SONY_UNREACHABLE',
        'Could not reach Sony sign-in. Please try again.',
      );
    }
    this.record('authorize', response.status);
    const location = response.headers.get('location');
    let code;
    try {
      const target = new URL(location);
      if (target.protocol === 'com.scee.psxandroid.scecompcall:' && target.hostname === 'redirect')
        code = target.searchParams.get('code');
    } catch {}
    if (!code || ![301, 302, 303, 307, 308].includes(response.status)) {
      throw new AppError(
        401,
        'SONY_LOGIN_FAILED',
        'Sony did not accept this connection code. Sign in again and get a fresh NPSSO.',
      );
    }
    this.setTokens(
      await this.exchange(
        { code, redirect_uri: REDIRECT, grant_type: 'authorization_code' },
        'token exchange',
      ),
    );
    try {
      if (!this.accountId)
        throw new AppError(502, 'ACCOUNT_ID_MISSING', 'Sony did not provide an account ID.');
      const data = await this.api(
        `/userProfile/v1/internal/users/${this.accountId}/profiles`,
        {},
        'profile',
      );
      const p = data.profile ?? data.profiles?.[0] ?? data;
      if (typeof p.accountId === 'string' && /^[1-9]\d{0,19}$/.test(p.accountId))
        this.accountId = p.accountId;
      this.profile = {
        onlineId: typeof p.onlineId === 'string' ? p.onlineId : 'PlayStation player',
        accountId: this.accountId,
      };
      // Reuse this profile for our own avatar instead of fetching it again.
      (this._profileCache ??= new Map()).set(this.accountId, { p, ts: Date.now() });
    } catch (error) {
      if (error.status === 401) {
        this.clear();
        throw error;
      }
      this.profile = { onlineId: 'PlayStation player', accountId: this.accountId };
    }
    await this.saveLogin();
    return this.profile;
  }

  async saveLogin() {
    if (!this.onSessionChanged) return;
    try {
      this.loginSaved = (await this.onSessionChanged(this)) === true;
    } catch {
      this.loginSaved = false;
    }
  }

  // Resolve an account's best avatar image URL: a custom profile photo first,
  // then a non-default PSN avatar. Returns null so the UI can show initials.
  async avatarUrl(accountId) {
    const cached = (this._profileCache ??= new Map()).get(accountId);
    let p = cached && Date.now() - cached.ts < 3600000 ? cached.p : null;
    if (!p) {
      const data = await this.api(
        `/userProfile/v1/internal/users/${accountId}/profiles`,
        {},
        'avatar profile',
      );
      p = data.profile ?? data.profiles?.[0] ?? data;
      this._profileCache.set(accountId, { p, ts: Date.now() });
    }
    const pick = (arr) =>
      Array.isArray(arr) &&
      (arr.find((a) => a.size === 'm') ?? arr.find((a) => a.size === 'l') ?? arr[0]);
    const custom = pick(p.personalDetail?.profilePictures);
    const avatar = pick(p.avatars);
    // Prefer a custom profile photo, else the PSN avatar (including the default).
    const url = custom?.url || avatar?.url || null;
    if (!url) return null;
    try {
      if (!/\.playstation\.(net|com)$/.test(new URL(url).hostname)) return null;
    } catch {
      return null;
    }
    return url;
  }

  // Fetch and cache an account's avatar image bytes (for same-origin proxying).
  async avatar(accountId) {
    if (!this.tokens || !/^[1-9]\d{0,19}$/.test(accountId)) return null;
    const cached = (this._avatarCache ??= new Map()).get(accountId);
    if (cached && Date.now() - cached.ts < 3600000) return cached.img;
    let img = null;
    try {
      const url = await this.avatarUrl(accountId);
      if (url) {
        const res = await this.fetch(url, { signal: AbortSignal.timeout(10000) });
        const type = res.headers.get('content-type') || 'image/png';
        if (res.ok && /^image\//.test(type)) {
          const ab = await res.arrayBuffer();
          if (ab.byteLength <= 2_000_000) img = { buf: Buffer.from(ab), type };
        }
      }
    } catch {}
    this._avatarCache.set(accountId, { img, ts: Date.now() });
    return img;
  }

  async accessToken() {
    if (!this.tokens)
      throw new AppError(401, 'NOT_CONNECTED', 'Connect your PlayStation account first.');
    const originalTokens = this.tokens;
    if (this.tokens.expiresAt > Date.now() + 60000) return this.tokens.access;
    if (!this.tokens.refresh)
      throw new AppError(401, 'SONY_SESSION_EXPIRED', 'Reconnect your PlayStation account.');
    if (!this.refreshing) {
      this.refreshing = this.exchange(
        { grant_type: 'refresh_token', refresh_token: this.tokens.refresh, scope: SCOPE },
        'session refresh',
      )
        .then(async (raw) => {
          if (this.tokens !== originalTokens)
            throw new AppError(
              409,
              'SONY_SESSION_CHANGED',
              'Your account changed. Try the action again.',
            );
          this.setTokens(raw);
          await this.saveLogin();
        })
        .catch(async (error) => {
          if (
            this.tokens === originalTokens &&
            [400, 401].includes(error.details?.upstreamStatus)
          ) {
            this.clear();
            this.loginSaved = false;
            try {
              await this.onSessionExpired?.();
            } catch {}
            throw new AppError(
              401,
              'SONY_SESSION_EXPIRED',
              'Your login expired. Sign in again.',
              error.details,
            );
          }
          throw error;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    await this.refreshing;
    if (!this.tokens)
      throw new AppError(
        409,
        'SONY_SESSION_CHANGED',
        'Your account changed. Try the action again.',
      );
    return this.tokens.access;
  }

  async api(path, { method = 'GET', body, headers = {} } = {}, step) {
    const serviceHeaders = {};
    if (path.startsWith('/sessionManager/')) {
      const id = path.match(/\/partySessions\/([a-f\d-]{36})(?:\/|$)/i)?.[1];
      if (id) serviceHeaders['X-PSN-SESSION-MANAGER-SESSION-IDS'] = id;
    }
    const send = async () =>
      this.request(
        `${API}${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${await this.accessToken()}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'okhttp/4.12.0',
            'X-PSN-REQUEST-ID': randomUUID(),
            'X-PSN-APP-VER': 'PlayStationApp-Android/26.10.0',
            ...serviceHeaders,
            ...headers,
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
        step,
      );
    try {
      return await send();
    } catch (error) {
      // A rejected request has not mutated the party. Refresh at most once,
      // then report endpoint authorization accurately instead of guessing expiry.
      if (
        error.code !== 'SONY_UNAUTHORIZED' ||
        !this.tokens?.refresh ||
        Date.now() - this.lastForcedRefresh < 30000
      )
        throw error;
      this.lastForcedRefresh = Date.now();
      this.tokens.expiresAt = 0;
      await this.accessToken();
      return send();
    }
  }

  async parties() {
    if (!this.tokens)
      throw new AppError(401, 'NOT_CONNECTED', 'Connect your PlayStation account first.');
    if (!this.accountId)
      throw new AppError(
        502,
        'ACCOUNT_ID_MISSING',
        'The Sony token does not contain an account ID. Reconnect your account.',
      );
    let invitations = [];
    let invitationWarning = false;
    try {
      const raw = await this.api(
        '/sessionManager/v2/users/me/partySessionsInvitations',
        {},
        'invitations',
      );
      this.record('invitations schema', JSON.stringify(shape(raw)));
      invitations =
        raw.partySessionsInvitations ?? raw.invitations ?? raw.invitedPartySessions ?? [];
    } catch (error) {
      if (error.code === 'SONY_SESSION_EXPIRED' || error.status === 429) throw error;
      invitationWarning = true;
    }
    const ids = invitations
      .map((x) => x.partySessionId ?? x.sessionId)
      .filter((x) => {
        try {
          requireId(x);
          return true;
        } catch {
          return false;
        }
      });
    // This service requires the current-user alias. A numeric account ID works
    // for userProfile, but sessionManager rejects it with 2232321/accountId.
    const data = await this.api('/sessionManager/v2/users/me/partySessions', {}, 'party list');
    this.record('party list schema', JSON.stringify(shape(data)));
    const list =
      data.v2UserPartySessions ?? data.v2PartySessions ?? data.partySessions ?? data.parties;
    if (!Array.isArray(list)) {
      this.record(
        'party response fields',
        Object.keys(data)
          .filter((k) => /^[a-zA-Z\d_]{1,40}$/.test(k))
          .join(', '),
      );
      throw new AppError(
        502,
        'PARTY_SCHEMA_CHANGED',
        'Sony returned an unfamiliar party list format. Check diagnostics.',
      );
    }
    const parties = [];
    for (const p of list.slice(0, 20)) {
      const record = typeof p === 'string' ? { sessionId: p } : p;
      // v2UserPartySessions contains membership references, not party details.
      const full =
        !record.sessionName && !record.members
          ? await this.party(record.sessionId ?? record.partySessionId)
          : record;
      parties.push(normalizeParty(full));
    }
    let friendsWarning = false;
    try {
      const friends = await this.api(
        '/sessionManager/v2/friends/partySessions',
        {},
        'friends parties',
      );
      this.record('friends parties schema', JSON.stringify(shape(friends)));
      const friendList =
        friends.v2PartySessions ?? friends.v2FriendsPartySessions ?? friends.partySessions;
      if (!Array.isArray(friendList)) friendsWarning = true;
      else
        for (const p of friendList) {
          const party =
            typeof p === 'string' ? normalizeParty({ sessionId: p }) : normalizeParty(p);
          if (!parties.some((existing) => existing.id === party.id)) parties.push(party);
        }
    } catch (error) {
      if (error.code === 'SONY_SESSION_EXPIRED' || error.status === 429) throw error;
      friendsWarning = true;
    }
    // The app lists message-group parties separately. They remain available
    // after this device leaves voice, unlike current membership references.
    let groupsWarning = false;
    try {
      const groups = await this.api(
        '/gamingLoungeGroups/v1/members/me/groups/openPartySessions',
        {},
        'group parties',
      );
      this.record('group parties schema', JSON.stringify(shape(groups)));
      if (!Array.isArray(groups.openPartySessions)) groupsWarning = true;
      else
        for (const item of groups.openPartySessions.slice(0, 20)) {
          try {
            const id = requireId(item.sessionId);
            if (!ids.includes(id)) ids.push(id);
          } catch {}
        }
    } catch (error) {
      if (error.code === 'SONY_SESSION_EXPIRED' || error.status === 429) throw error;
      groupsWarning = true;
    }
    // Invitations and message-group references require full party details.
    for (const id of ids.slice(0, 20)) {
      if (parties.some((p) => p.id === id)) continue;
      try {
        parties.push(normalizeParty(await this.party(id)));
      } catch {
        invitationWarning = true;
      }
    }
    return { parties, invitationWarning, friendsWarning, groupsWarning, limit: null };
  }

  async party(id) {
    requireId(id);
    const data = await this.api(
      `${SESSION}?view=v3`,
      { headers: { 'X-PSN-SESSION-MANAGER-SESSION-IDS': id } },
      'party details',
    );
    const schema = JSON.stringify(shape(data));
    if (schema !== this.lastPartySchema) {
      this.lastPartySchema = schema;
      this.record('party details schema', schema);
    }
    const raw = (data.v2PartySessions ?? data.partySessions ?? []).find(
      (p) => (p.sessionId ?? p.partySessionId) === id,
    );
    if (!raw)
      throw new AppError(
        404,
        'PARTY_NOT_FOUND',
        'This party is no longer available, or your account cannot see it.',
      );
    return raw;
  }

  async createParty(input) {
    if (!this.tokens)
      throw new AppError(401, 'NOT_CONNECTED', 'Connect your PlayStation account first.');
    if (this.active || this.creatingParty)
      throw new AppError(
        409,
        'ALREADY_JOINED',
        'Leave your current party before starting another.',
      );
    const options = partyCreateOptions(input),
      ownerAccount = this.accountId;
    this.creatingParty = true;
    try {
      await this.push.connect();
      if (!this.tokens || this.accountId !== ownerAccount || this.active)
        throw new AppError(409, 'PARTY_CANCELLED', 'Your account or party changed. Try again.');
      const body = partyCreateBody(options, {
        contextId: this.contextId,
        customData4: bridgeMemberData(null, null, null),
      });
      let response;
      try {
        response = await this.api(SESSION, { method: 'POST', body }, 'create party');
      } catch (error) {
        if (
          ['SONY_UNREACHABLE', 'INVALID_SONY_RESPONSE'].includes(error.code) ||
          error.details?.upstreamStatus >= 500
        ) {
          throw new AppError(
            502,
            'PARTY_CREATE_UNCONFIRMED',
            'The new party could not be confirmed. Refresh your parties before trying again.',
            error.details,
          );
        }
        throw error;
      }
      const created = response?.v2PartySessions?.[0];
      let id;
      try {
        id = requireId(created?.sessionId);
      } catch {
        throw new AppError(
          502,
          'PARTY_CREATE_SCHEMA',
          'Sony accepted the request but did not return a party ID. Refresh your parties before trying again.',
        );
      }
      if (!this.tokens || this.accountId !== ownerAccount)
        throw new AppError(
          409,
          'PARTY_CANCELLED',
          'Your account changed while starting the party. Refresh your parties.',
        );
      this.active = {
        id,
        bridge: null,
        peerId: null,
        ownsBridge: false,
        bridgeLinked: false,
        voiceActivated: false,
        previousMobileIdentities: [],
      };
      let inviteWarning = false;
      const invites = options.invites.filter((accountId) => accountId !== this.accountId);
      if (invites.length) {
        try {
          await this.api(
            `${SESSION}/${id}/invitations`,
            {
              method: 'POST',
              body: {
                invitations: invites.map((accountId) => ({ to: { accountId } })),
                invitationType: 'NORMAL',
              },
            },
            'invite to new party',
          );
        } catch {
          inviteWarning = true;
        }
      }
      const party = normalizeParty({
        ...body.v2PartySessions[0],
        ...created,
        sessionId: id,
        members: (Array.isArray(created.members) && created.members.length
          ? created.members
          : [
              {
                accountId: this.accountId,
                onlineId: this.profile?.onlineId,
                platform: 'MOBILE_APP',
              },
            ]
        ).map((m) => ({
          ...m,
          ...(String(m.accountId) === this.accountId
            ? { onlineId: this.profile?.onlineId ?? m.onlineId }
            : {}),
        })),
      });
      return { party, inviteWarning };
    } finally {
      this.creatingParty = false;
    }
  }

  async join(id) {
    requireId(id);
    if (this.active || this.creatingParty)
      throw new AppError(409, 'ALREADY_JOINED', 'Leave your current party before joining another.');
    let previousMobileIdentities = [];
    try {
      previousMobileIdentities = membersOf(await this.party(id))
        .filter((m) => String(m.accountId) === this.accountId && mobileMember(m))
        .map((m) => m.deviceUniqueId);
    } catch (error) {
      if (![403, 404].includes(error.status)) throw error;
    }
    await this.push.connect();
    const initialData = bridgeMemberData(null, null, null);
    await this.api(
      `${SESSION}/${id}/members`,
      {
        method: 'POST',
        body: {
          members: [
            {
              accountId: 'me',
              platform: 'me',
              voiceChatActivated: false,
              customData4: initialData,
              pushContexts: [{ contextId: this.contextId }],
            },
          ],
        },
      },
      'join party',
    );
    this.active = {
      id,
      bridge: null,
      peerId: null,
      ownsBridge: false,
      bridgeLinked: false,
      voiceActivated: false,
      previousMobileIdentities,
    };
    return { id, state: 'joined', voice: 'not-connected' };
  }

  async prepareVoice() {
    const active = this.active;
    if (!active) throw new AppError(409, 'NO_PARTY', 'Join a party first.');
    if (active.peerId) return this.refreshVoiceOffer();
    let raw = await this.party(active.id);
    let existing = raw.bridges?.find(
      (b) => typeof b.bridgeId === 'string' && typeof b.bridgeToken === 'string',
    );
    // A remote member's voice bridge can take a moment to appear, and it drops if
    // their app backgrounds. When we are joining (not creating), wait briefly for
    // one rather than failing instantly, so the other device can (re)enter voice.
    if (!existing && !this.allowBridgeCreation && !raw.bridges?.length && this.bridgeWaitMs > 0) {
      const deadline = Date.now() + this.bridgeWaitMs;
      while (!existing && Date.now() < deadline && this.active === active) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        raw = await this.party(active.id);
        existing = raw.bridges?.find(
          (b) => typeof b.bridgeId === 'string' && typeof b.bridgeToken === 'string',
        );
      }
    }
    this.record('party bridge schema', JSON.stringify(shape(raw.bridges)));
    if (raw.bridges?.length && !existing)
      throw new AppError(
        502,
        'BRIDGE_SCHEMA_CHANGED',
        'Sony returned an unfamiliar existing voice bridge. Check diagnostics.',
      );
    try {
      // Join an existing party bridge when one is LIVE — the native app skips
      // create/link and goes straight to add-peer. We stay a participant
      // (ownsBridge false), so leaving only removes our peer and never tears down
      // a bridge the rest of the party is using. A party's bridge ref can dangle
      // after a member leaves voice. Failed joins preserve the shared bridge.
      // APK RE shows add-peer is rejected until we are an ACTIVATED voice member
      // (404 / upstream 2277389), so activate voice BEFORE adding our peer.
      // Join the party's existing bridge as a participant (ownsBridge stays false,
      // so leaving only removes our own peer and never tears down a bridge others
      // use). We NEVER unlink or replace a linked bridge: a previous version did
      // and corrupted real parties (the party ended up pointing at our dead bridge
      // while members sat on a different live one). If the linked bridge is dead,
      // add-peer below fails and we surface a clear error instead of hijacking.
      // The native app activates voice before add-peer (else 404/2277389).
      if (existing) {
        active.bridge = { bridgeId: existing.bridgeId, bridgeToken: existing.bridgeToken };
        active.bridgeLinked = true;
        if (!active.voiceActivated) {
          await this.api(
            `${SESSION}/${active.id}/members/me`,
            { method: 'PATCH', body: { voiceChatActivated: true } },
            'activate party voice',
          );
          active.voiceActivated = true;
        }
      } else if (this.allowBridgeCreation) {
        const created = await this.api(
          RTC,
          { method: 'POST', body: {}, headers: { 'X-PSN-RTC-TITLE-ID': 'METROPOL_AND' } },
          'create voice bridge',
        );
        if (!created.bridge?.bridgeId || !created.bridge?.bridgeToken)
          throw new AppError(
            502,
            'BRIDGE_SCHEMA_CHANGED',
            'Sony did not return a usable voice bridge.',
          );
        active.bridge = {
          bridgeId: requireId(created.bridge.bridgeId),
          bridgeToken: created.bridge.bridgeToken,
        };
        active.ownsBridge = true;
        await this.api(
          `${SESSION}/${active.id}/bridges`,
          { method: 'POST', body: { bridges: [active.bridge] } },
          'link voice bridge',
        );
        active.bridgeLinked = true;
      } else {
        this.record('voice bridge', 'none-joinable; creation disabled');
        throw new AppError(
          409,
          'NO_JOINABLE_BRIDGE',
          'This party has no voice bridge to join yet. Have a member start party voice first, then connect from PartyBridge.',
        );
      }
      requireId(active.bridge.bridgeId);
      // Activating voice (PATCH above) commits to the party-session service, but the
      // rtcBridge server is a separate service that learns about voice membership on a
      // short sync delay. A peer POST that races that sync is rejected with
      // 404 / upstream 2277389 ("resource not found") even though the bridge is live —
      // the recurring "create voice peer" failure. Retry briefly to let the sync land.
      // Only retry this race (404+2277389); a genuinely stale/absent bridge keeps 404ing
      // and surfaces as the normal error after the attempts are spent.
      let data;
      for (let attempt = 1; ; attempt++) {
        try {
          data = await this.api(
            `${RTC}/${active.bridge.bridgeId}/peers?allow_duid_duplication=false&g=2`,
            {
              // The live bridge accepts 48 kHz. Only advertise the browser's clock;
              // including Sony's nonstandard 16 kHz mode can prevent negotiation.
              method: 'POST',
              headers: this.rtcHeaders(),
              body: { mediaTypes: mediaTypesFor(this.sendSamplingRates) },
            },
            'create voice peer',
          );
          break;
        } catch (error) {
          const racing =
            error?.details?.upstreamStatus === 404 && error?.details?.upstreamCode === 2277389;
          // Joining someone else's bridge can take longer to sync than creating
          // our own, so allow more attempts when we did not create the bridge.
          const maxAttempts = active.ownsBridge ? 5 : 8;
          if (racing && attempt < maxAttempts && this.active === active) {
            this.record('create voice peer retry', attempt);
            await new Promise((resolve) => setTimeout(resolve, 1200));
            continue;
          }
          // Exhausted on a bridge we are joining (not one we created): the linked
          // bridge is dead/stale (often a party left pointing at an old bridge).
          // Surface a clear message rather than hijacking by creating a new one.
          if (racing && !active.ownsBridge) {
            throw new AppError(
              409,
              'BRIDGE_UNAVAILABLE',
              "This party's voice bridge is not accepting new connections. Ask the host to turn party voice off and back on, then try again.",
            );
          }
          throw error;
        }
      }
      this.record('voice peer schema', JSON.stringify(shape(data)));
      if (!data.peer?.peerId || !data.peer?.offer?.sdp)
        throw new AppError(
          502,
          'PEER_SCHEMA_CHANGED',
          'Sony did not return a usable WebRTC offer.',
        );
      active.peerId = requireId(data.peer.peerId);
      const mine = membersOf(raw).filter(
        (member) => String(member.accountId) === this.accountId && mobileMember(member),
      );
      const created = mine.filter(
        (member) => !(active.previousMobileIdentities ?? []).includes(member.deviceUniqueId),
      );
      const ownMember =
        mine.find((member) => member.deviceUniqueId === this.deviceId) ??
        (created.length === 1 ? created[0] : null);
      if (!ownMember || !stableIdentity(ownMember.deviceUniqueId))
        throw new AppError(
          502,
          'SELF_IDENTITY_MISSING',
          'Could not identify this device in the party. Voice stopped before participant signaling.',
        );
      active.identity = ownMember.deviceUniqueId;
      // A fresh membership has no custom data; preserve only this device's data.
      active.memberData4 = bridgeMemberData(
        ownMember?.customData4,
        active.bridge.bridgeId,
        active.peerId,
      );
      this.record(
        'voice identity',
        ownMember.deviceUniqueId === this.deviceId
          ? 'matches-local-device'
          : 'new-server-assigned-identity',
      );
      this.record(
        'voice audio codecs',
        [...data.peer.offer.sdp.matchAll(/^a=rtpmap:\d+ ([A-Za-z\d_/-]+)/gm)]
          .map((m) => m[1])
          .join(', '),
      );
      this.record(
        'voice media directions',
        data.peer.offer.sdp
          .split(/\r?\n/)
          .filter((line) => /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line))
          .join(', '),
      );
      this.record(
        'voice codec parameters',
        data.peer.offer.sdp
          .split(/\r?\n/)
          .filter((line) => /^a=(rtpmap|fmtp):/.test(line))
          .join('; '),
      );
      const peers = await this.api(
        `${RTC}/${active.bridge.bridgeId}?fields=peer.peerId`,
        { headers: this.rtcHeaders() },
        'voice peers',
      );
      this.record('voice peers schema', JSON.stringify(shape(peers)));
      const peerIds = (peers.bridge?.peers ?? [])
        .map((p) => p.peerId)
        .filter((id) => id !== active.peerId && /^[a-f\d-]{36}$/i.test(id));
      this.record('other voice peers', peerIds.length);
      const participants = nativeParticipants(raw, active.bridge.bridgeId, active.identity);
      this.record('mapped voice participants', participants.length);
      return {
        offer: { type: 'offer', sdp: data.peer.offer.sdp },
        peerId: active.peerId,
        peerIds,
        self: { identity: active.identity, accountId: this.accountId, platform: 100001 },
        participants,
        members: voiceMembers(raw, active.identity),
      };
    } catch (error) {
      try {
        await this.stopVoice();
      } catch {
        error.details = { ...error.details, cleanupPending: true };
      }
      throw error;
    }
  }

  async refreshVoiceOffer() {
    const a = this.active;
    const data = await this.api(
      `${RTC}/${a.bridge.bridgeId}/peers/${a.peerId}/offer`,
      {
        method: 'POST',
        headers: this.rtcHeaders(),
        body: { mediaTypes: mediaTypesFor(this.sendSamplingRates) },
      },
      'updated voice offer',
    );
    if (typeof data.offer?.sdp !== 'string')
      throw new AppError(502, 'PEER_SCHEMA_CHANGED', 'Sony did not return an updated voice offer.');
    return { offer: { type: 'offer', sdp: data.offer.sdp } };
  }

  rtcHeaders() {
    return {
      'X-PSN-RTC-TITLE-ID': 'METROPOL_AND',
      'X-PSN-BRIDGE-TOKEN': this.active.bridge.bridgeToken,
    };
  }

  async registerVoice() {
    const a = this.active;
    if (!a?.peerId || !a.answerSubmitted)
      throw new AppError(
        409,
        'VOICE_NOT_PREPARED',
        'The voice answer must be accepted before bridge registration.',
      );
    // Native voice joins advertise activation before publishing bridge info.
    // This flag expresses joining intent, not verified audio readiness.
    if (!a.voiceActivated) {
      await this.api(
        `${SESSION}/${a.id}/members/me`,
        { method: 'PATCH', body: { voiceChatActivated: true } },
        'activate party voice',
      );
      a.voiceActivated = true;
    }
    if (!a.peerRegistered) {
      await this.api(
        `${SESSION}/${a.id}/members/me`,
        { method: 'PATCH', body: { customData4: a.memberData4 } },
        'register voice peer in party',
      );
      a.peerRegistered = true;
    }
    return { registered: true };
  }

  async voiceState() {
    const a = this.active;
    if (!a?.peerId) throw new AppError(409, 'NO_PEER', 'There is no voice session to inspect.');
    const raw = await this.party(a.id);
    const own = membersOf(raw).find(
      (m) => String(m.accountId) === this.accountId && m.deviceUniqueId === a.identity,
    );
    if (!own)
      throw new AppError(409, 'MEMBERSHIP_LOST', 'This device is no longer a party member.');
    if (!raw.bridges?.some((b) => b.bridgeId === a.bridge.bridgeId))
      throw new AppError(409, 'BRIDGE_REPLACED', 'The party changed voice bridges.');
    return {
      participants: nativeParticipants(raw, a.bridge.bridgeId, a.identity),
      members: voiceMembers(raw, a.identity),
    };
  }

  async answer(sdp) {
    if (!this.active?.peerId)
      throw new AppError(409, 'NO_PEER', 'Start voice before sending an answer.');
    if (typeof sdp !== 'string' || sdp.length > 65536 || !sdp.startsWith('v=0'))
      throw new AppError(400, 'INVALID_SDP', 'Invalid WebRTC answer.');
    const { bridge, peerId } = this.active;
    await this.api(
      `${RTC}/${bridge.bridgeId}/peers/${peerId}/answer`,
      { method: 'POST', headers: this.rtcHeaders(), body: { answer: { sdp } } },
      'voice answer',
    );
    this.active.answerSubmitted = true;
    return { state: 'answer-submitted', verified: false };
  }

  stopVoice() {
    if (this.stoppingVoice) return this.stoppingVoice;
    this.stoppingVoice = this.stopVoiceInternal().finally(() => {
      this.stoppingVoice = null;
    });
    return this.stoppingVoice;
  }

  async stopVoiceInternal() {
    const a = this.active;
    if (!a?.bridge) return;
    if (a.peerId) {
      try {
        await this.api(
          `${RTC}/${a.bridge.bridgeId}/peers/${a.peerId}`,
          { method: 'DELETE', headers: this.rtcHeaders() },
          'remove voice peer',
        );
      } catch (error) {
        if (![404, 410].includes(error.details?.upstreamStatus)) throw error;
      }
      a.peerId = null;
    }
    if (a.peerRegistered) {
      try {
        await this.api(
          `${SESSION}/${a.id}/members/me`,
          { method: 'PATCH', body: { customData4: bridgeMemberData(a.memberData4, null, null) } },
          'unregister party voice peer',
        );
        a.peerRegistered = false;
      } catch (error) {
        if (error.details?.upstreamStatus !== 403 || error.details?.upstreamCode !== 2233351)
          throw error;
        this.active = null;
        return;
      }
    }
    if (a.voiceActivated) {
      try {
        await this.api(
          `${SESSION}/${a.id}/members/me`,
          { method: 'PATCH', body: { voiceChatActivated: false } },
          'deactivate party voice',
        );
      } catch (error) {
        // Sony can remove this device's membership while media is connected.
        // Its explicit nonmember code means there is no voice flag left to clear.
        if (error.details?.upstreamStatus !== 403 || error.details?.upstreamCode !== 2233351)
          throw error;
        this.record('party membership', 'removed by Sony');
        this.active = null;
      }
      a.voiceActivated = false;
    }
    if (a.ownsBridge && !a.bridgeLinked) {
      // Only an unlinked, failed creation is private to this client. Once a
      // bridge is linked to a party, deleting it disconnects OTHER participants
      // too, even if this PC originally created it. Leave its lifetime to Sony.
      try {
        await this.api(
          `${RTC}/${a.bridge.bridgeId}`,
          { method: 'DELETE', headers: this.rtcHeaders() },
          'remove own voice bridge',
        );
      } catch (error) {
        if (![404, 410].includes(error.details?.upstreamStatus)) throw error;
      }
    }
    // A linked bridge survives this client's departure, regardless of creator.
    a.bridge = null;
    a.ownsBridge = false;
    a.bridgeLinked = false;
    a.answerSubmitted = false;
    a.identity = null;
  }

  leave() {
    if (this.leavingParty) return this.leavingParty;
    this.leavingParty = this.leaveInternal().finally(() => {
      this.leavingParty = null;
    });
    return this.leavingParty;
  }

  async leaveInternal() {
    if (!this.active) return;
    await this.stopVoice();
    if (!this.active) return;
    try {
      await this.api(
        `${SESSION}/${this.active.id}/members/me`,
        { method: 'DELETE' },
        'leave party',
      );
    } catch (error) {
      if (
        ![404, 410].includes(error.details?.upstreamStatus) &&
        !(error.details?.upstreamStatus === 403 && error.details?.upstreamCode === 2233351)
      )
        throw error;
    }
    this.active = null;
  }

  clear() {
    this.push.close();
    this.tokens = null;
    this.profile = null;
    this.active = null;
    this.accountId = null;
    this._profileCache?.clear();
    this._avatarCache?.clear();
  }
}
