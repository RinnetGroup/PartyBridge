import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { partyMembers } from '../public/party-state.js';

export function reportedMicMuted(customData4) {
  if (
    typeof customData4 !== 'string' ||
    customData4.length > 4096 ||
    !/^[A-Za-z\d+/]*={0,2}$/.test(customData4)
  )
    return null;
  try {
    const slots = JSON.parse(Buffer.from(customData4, 'base64').toString('utf8'));
    // Native MyMicMute property 1 -> ROOM BindParam[4:5] -> binder slot 8
    // -> customData4[5]. Boolean serialization is direct, not inverted.
    if (!Array.isArray(slots) || slots.length !== 10 || slots.some((v) => typeof v !== 'string'))
      return null;
    return slots[5] === '1' ? true : slots[5] === '0' ? false : null;
  } catch {
    return null;
  }
}

export function participantRoster(raw, ownIdentity) {
  const members = Array.isArray(raw.members) ? raw.members : (raw.members?.players ?? []);
  return members.map((m) => ({
    accountId: String(m.accountId ?? ''),
    onlineId: typeof m.onlineId === 'string' ? m.onlineId.slice(0, 100) : 'Player',
    platform: String(m.platform ?? 'PlayStation'),
    memberKey: `${m.accountId}:${m.platform}:${createHash('sha256')
      .update(String(m.deviceUniqueId ?? ''))
      .digest('hex')
      .slice(0, 16)}`,
    isSelf: !!ownIdentity && m.deviceUniqueId === ownIdentity,
    voiceChatActivated:
      typeof m.voiceChatActivated === 'boolean' ? m.voiceChatActivated : undefined,
    micMuted: reportedMicMuted(m.customData4),
  }));
}

export function peerMemberKeys(members, peer, identity) {
  if (typeof identity !== 'string' || !identity) return undefined;
  const suffix = ':' + createHash('sha256').update(identity).digest('hex').slice(0, 16);
  const accounts = new Set(
    (peer.users ?? []).map((u) => String(u.account_id ?? u.accountId ?? '')),
  );
  return members
    .filter((m) => accounts.has(String(m.accountId)) && m.memberKey?.endsWith(suffix))
    .map((m) => m.memberKey);
}

const endpoint = (candidate) => {
  const address = typeof candidate?.address === 'string' ? candidate.address : '';
  const family = isIP(address);
  return family ? { address, family: family === 4 ? 'IPv4' : 'IPv6' } : null;
};
export function bridgeNetworkStats(report, state, sampledAt = Date.now()) {
  const result = {
    state: typeof state === 'string' ? state : 'unknown',
    sampledAt,
    pingMs: null,
    local: null,
    relay: null,
  };
  const rows = report?.values ? [...report.values()] : Array.isArray(report) ? report : [];
  const byId = new Map(rows.filter((v) => v && typeof v.id === 'string').map((v) => [v.id, v]));
  const selected = rows.find(
    (v) => v?.type === 'transport' && typeof v.selectedCandidatePairId === 'string',
  );
  const pair = byId.get(selected?.selectedCandidatePairId);
  // A candidate merely appearing in the SDP is not a connected endpoint.
  if (
    !pair ||
    pair.type !== 'candidate-pair' ||
    pair.state !== 'succeeded' ||
    !['connected', 'completed'].includes(state)
  )
    return result;
  const seconds = pair.currentRoundTripTime;
  if (
    Number.isFinite(seconds) &&
    seconds >= 0 &&
    seconds <= 60 &&
    pair.roundTripTimeMeasurements > 0
  )
    result.pingMs = Math.round(seconds * 1000);
  const local = byId.get(pair.localCandidateId),
    remote = byId.get(pair.remoteCandidateId);
  result.local = local?.type === 'local-candidate' ? endpoint(local) : null;
  result.relay = remote?.type === 'remote-candidate' ? endpoint(remote) : null;
  return result;
}

export function participantDetailsSnapshot({
  members,
  peers = [],
  profile,
  muted = false,
  voiceState,
  observing = false,
  bridge = null,
}) {
  const labels = {
    ready: 'Voice ready',
    partial: 'Partly connected',
    routing: 'Routing',
    failed: 'Connection failed',
    reconnecting: 'Reconnecting',
    connecting: 'Connecting',
    inactive: 'Not in voice',
    pending: 'Joining voice',
  };
  const participants = partyMembers(members, peers, profile?.accountId).map((m) => ({
    key: m.key,
    accountId: m.accountId,
    username: m.onlineId || 'Player',
    platform: m.platform,
    isSelf: false,
    connection: observing
      ? ['failed', 'stopped'].includes(voiceState) ||
        ['failed', 'disconnected', 'closed'].includes(bridge?.state)
        ? 'Unavailable — your voice connection ended'
        : (labels[m.state] ?? 'Unknown')
      : m.voiceChatActivated === false
        ? 'Not in voice'
        : 'Join voice to check',
    // VoiceEngine currently negotiates only the shared Sony bridge. Per-peer
    // control-channel readiness is not evidence of a direct P2P transport.
    transport: observing ? 'bridge' : null,
    transportState: bridge?.state ?? 'unknown',
    micMuted: typeof m.micMuted === 'boolean' ? m.micMuted : null,
    pingMs: null,
    host: null,
  }));
  const own = members.find((m) => m.isSelf);
  if (own || observing)
    participants.unshift({
      key: own?.memberKey ?? 'self',
      accountId: profile?.accountId,
      username: profile?.onlineId || own?.onlineId || 'You',
      platform: own?.platform ?? 'MOBILE_APP',
      isSelf: true,
      connection: observing
        ? ['connected', 'ready'].includes(voiceState)
          ? 'Voice ready'
          : voiceState === 'failed'
            ? 'Connection failed'
            : voiceState === 'stopped'
              ? 'Disconnected'
              : 'Connecting'
        : 'Not in voice',
      transport: observing ? 'bridge' : null,
      transportState: bridge?.state ?? 'unknown',
      micMuted: observing ? !!muted : typeof own?.micMuted === 'boolean' ? own.micMuted : null,
      pingMs: null,
      host: null,
    });
  return { participants, bridge };
}
