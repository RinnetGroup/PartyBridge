export function voiceSummaryLabel({ connected, inCall, muted, voiceStatus }) {
  if (!connected) return 'Offline';
  if (!inCall) return 'Ready';
  if (!['connected', 'ready'].includes(voiceStatus)) return 'Connecting';
  return muted ? 'Muted' : 'In party';
}
