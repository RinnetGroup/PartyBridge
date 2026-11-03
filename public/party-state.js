// The session roster includes people who have not published a voice peer yet.
// Keep them visible while deriving voice readiness separately for each account.
export function partyMembers(members = [], peers = [], selfAccountId = '') {
  const roster = new Map();
  for (const member of members) {
    const key =
      member.memberKey || `${member.accountId || member.onlineId || ''}:${member.platform || ''}`;
    const isSelf =
      member.isSelf ??
      (member.accountId &&
        String(member.accountId) === String(selfAccountId) &&
        !['PS5', 'PS4'].includes(member.platform));
    if (key === ':' || isSelf) continue;
    const previous = roster.get(key);
    roster.set(key, {
      ...member,
      key,
      voiceChatActivated: previous?.voiceChatActivated || member.voiceChatActivated,
    });
  }
  for (const peer of peers)
    for (const id of peer.accountIds ?? []) {
      if (
        String(id) === String(selfAccountId) ||
        [...roster.values()].some((m) => String(m.accountId) === String(id))
      )
        continue;
      roster.set(String(id), {
        key: String(id),
        accountId: String(id),
        onlineId: 'Player',
        voiceChatActivated: true,
      });
    }
  return [...roster.values()].map((member) => {
    const controls = peers.filter((peer) =>
      Array.isArray(peer.memberKeys)
        ? peer.memberKeys.includes(member.key)
        : peer.accountIds?.includes(String(member.accountId)),
    );
    const state = controls.length
      ? controls.every((peer) => peer.routeReady)
        ? 'ready'
        : controls.some((peer) => peer.routeReady)
          ? 'partial'
          : controls.some((peer) => peer.state === 'failed')
            ? 'failed'
            : controls.some((peer) => peer.state === 'reconnecting')
              ? 'reconnecting'
              : controls.some((peer) => peer.handshakeReady)
                ? 'routing'
                : 'connecting'
      : member.voiceChatActivated === false
        ? 'inactive'
        : 'pending';
    return { ...member, state };
  });
}
