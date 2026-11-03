import { AppError } from './errors.js';

export function partyCreateOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AppError(400, 'INVALID_PARTY', 'Choose the party settings.');
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || [...name].length > 32 || /[\x00-\x1f\x7f]/.test(name))
    throw new AppError(400, 'INVALID_PARTY_NAME', 'Use a party name between 1 and 32 characters.');
  const type = value.type ?? 'open';
  if (!['open', 'closed'].includes(type))
    throw new AppError(400, 'INVALID_PARTY_TYPE', 'Choose an open or closed party.');
  const maxMembers = value.maxMembers ?? 16;
  if (!Number.isInteger(maxMembers) || maxMembers < 2 || maxMembers > 16)
    throw new AppError(400, 'INVALID_PARTY_SIZE', 'Choose a party size between 2 and 16.');
  const invites = value.invites ?? [];
  if (
    !Array.isArray(invites) ||
    invites.length > 15 ||
    invites.some(
      (id) =>
        typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id) || BigInt(id) > 0xffffffffffffffffn,
    ) ||
    new Set(invites).size !== invites.length
  )
    throw new AppError(400, 'INVALID_PARTY_INVITES', 'Choose up to 15 different friends.');
  return { name, type, maxMembers, invites };
}

// Native libsession-manager PostV2PartySessionsRequest/CreateJson (0xf6f9c):
// one ROOM in v2PartySessions, creator in members, me/me identity and push context.
export function partyCreateBody(options, { contextId, customData4 }) {
  return {
    v2PartySessions: [
      {
        sessionType: 'ROOM',
        sessionName: options.name,
        maxMembers: options.maxMembers,
        joinableUserType: options.type === 'open' ? 'FRIENDS' : 'INVITE_ONLY',
        visibilityType: options.type === 'open' ? 'FRIENDS_ONLY' : 'INVITE_ONLY',
        members: [
          {
            accountId: 'me',
            platform: 'me',
            voiceChatActivated: false,
            customData4,
            pushContexts: [{ contextId }],
          },
        ],
      },
    ],
  };
}
