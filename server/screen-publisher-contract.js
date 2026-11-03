// Recovered host-side membership/control formats, not an operational publisher.
// No network calls or production routes use this module. Allocation ownership
// and publisher authorization must be established before announcing a stream.
import { screenAllocation } from './screen-share.js';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const uint64 = (value, allowZero = false) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new Error('Use a decimal string or bigint for a uint64');
  const decimal = String(value);
  if (
    !/^(?:0|[1-9]\d{0,19})$/.test(decimal) ||
    (!allowZero && decimal === '0') ||
    BigInt(decimal) > 0xffffffffffffffffn
  )
    throw new Error('Invalid uint64');
  return decimal;
};
const identifier = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[\x00-\x1f]/.test(value);
function rootOf(member) {
  if (member.customData1 === undefined || member.customData1 === null || member.customData1 === '')
    return {};
  if (typeof member.customData1 !== 'string' || member.customData1.length > 32768)
    throw new Error('Invalid current member metadata');
  let root;
  try {
    root = JSON.parse(
      Buffer.from(member.customData1, 'base64').toString('utf8'),
      (_key, value, context) =>
        typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(context.source)
          ? JSON.rawJSON(context.source)
          : value,
    );
  } catch {
    throw new Error('Invalid current member metadata');
  }
  if (!object(root)) throw new Error('Invalid current member metadata');
  return root;
}
const encode = (root) => Buffer.from(JSON.stringify(root)).toString('base64');

// GetJsonStringFromMemberData (iOS 0x2e1598) always writes PreviewId,
// StartedTime, IsRestricted, titleId and lastThumbnailUploadedTime. It writes ConnectionInfo/SessionId
// only after the host has a real allocation. ConnectionInfo is a JSON STRING.
// startedTick is the native RTC uint64, not a JavaScript Date.now() value.
export function screenPublisherAnnouncement(
  member,
  {
    previewId,
    startedTick,
    titleId = '',
    restricted = false,
    lastThumbnailUploadedTick = 0n,
    allocation = null,
  } = {},
) {
  if (
    (!identifier(previewId) && !(allocation !== null && previewId === '')) ||
    typeof titleId !== 'string' ||
    titleId.length > 15 ||
    typeof restricted !== 'boolean'
  )
    throw new Error('Invalid screen announcement');
  const root = rootOf(member);
  const streaming = {
    PreviewId: previewId,
    StartedTime: JSON.rawJSON(uint64(startedTick)),
    IsRestricted: restricted,
    titleId,
    lastThumbnailUploadedTime: JSON.rawJSON(uint64(lastThumbnailUploadedTick, true)),
  };
  if (allocation !== null) {
    if (!object(allocation) || !identifier(allocation.sessionID))
      throw new Error('Invalid publisher allocation');
    streaming.ConnectionInfo = JSON.stringify(allocation);
    streaming.SessionId = allocation.sessionID;
    // Reuse the viewer's recovered Sony host/port/session validation. This is
    // format validation only; it does not prove that this client owns the room.
    screenAllocation({ customData1: encode({ Streaming: streaming }) });
  }
  root.Streaming = streaming;
  return encode(root);
}

// A late stop for an old room must not erase a replacement stream or Watching.
export function removeScreenPublisherAnnouncement(member, { sessionId, previewId } = {}) {
  if (!identifier(sessionId) && !identifier(previewId)) throw new Error('Stream identity required');
  const root = rootOf(member),
    current = root.Streaming;
  if (!object(current)) return member.customData1 ?? encode(root);
  const matches = identifier(sessionId)
    ? current.SessionId === sessionId
    : !current.SessionId && current.PreviewId === previewId;
  if (!matches) return member.customData1;
  delete root.Streaming;
  return encode(root);
}

// BasicMessaging channel 1, dataType 4, payload uint32=2. A future publisher
// must additionally authenticate the sender against the party and source
// envelope; decoding a claimed account ID is not sender authentication.
export function decodeScreenWatchRequest(packet) {
  if (
    !Buffer.isBuffer(packet) ||
    packet.length !== 48 ||
    packet.readUInt32LE(0) !== 1 ||
    packet.readUInt32LE(8) !== 4 ||
    packet.readUInt32LE(40) !== 4 ||
    packet.readUInt32LE(44) !== 2
  )
    return null;
  const sequence = packet.readUInt32LE(4),
    accountId = packet.readBigUInt64LE(16).toString(),
    platform = packet.readUInt32LE(24);
  if (accountId === '0') return null;
  return { operation: 'watch', sequence, accountId, platform };
}
