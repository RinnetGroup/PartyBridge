// Sony re-enables an audio MID after temporarily rejecting it when a member
// leaves. Werift's normal JSEP matching finds the old, permanently stopped
// transceiver by MID and rejects it forever. Let its existing m-line replacement
// path build a NEW receiver for this Sony receive-only compatibility case.
const installed = Symbol.for('partybridge.sony-receive-reuse');

export function installSonyReceiveReuse(pc) {
  if (pc[installed] || typeof pc.findTransceiverForRemoteMedia !== 'function') return;
  const find = pc.findTransceiverForRemoteMedia;
  pc.findTransceiverForRemoteMedia = function (media, index, associated) {
    const existing = find.call(this, media, index, associated);
    if (
      media.kind === 'audio' &&
      media.port !== 0 &&
      ['sendonly', 'sendrecv'].includes(media.direction) &&
      existing?.stopped &&
      !existing.sender.track
    )
      return undefined;
    return existing;
  };
  pc[installed] = true;
}
