// Only the data needed to refresh a desktop login is persisted.
export function savedLogin(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) return null;
  const { refreshToken, deviceId, accountId, onlineId } = value;
  if (
    typeof refreshToken !== 'string' ||
    !refreshToken.length ||
    refreshToken.length > 16384 ||
    /[\s\x00-\x1f]/.test(refreshToken)
  )
    return null;
  if (typeof deviceId !== 'string' || !/^00000007000801a8[a-f\d]{106}$/i.test(deviceId))
    return null;
  if (typeof accountId !== 'string' || !/^[1-9]\d{0,19}$/.test(accountId)) return null;
  return {
    version: 1,
    refreshToken,
    deviceId,
    accountId,
    onlineId: typeof onlineId === 'string' ? onlineId.slice(0, 100) : 'PlayStation player',
  };
}
export function exportLogin(client) {
  return savedLogin({
    version: 1,
    refreshToken: client.tokens?.refresh,
    deviceId: client.deviceId,
    accountId: client.accountId,
    onlineId: client.profile?.onlineId,
  });
}
export function restoreLogin(client, value) {
  const saved = savedLogin(value);
  if (!saved) return false;
  client.deviceId = saved.deviceId;
  client.accountId = saved.accountId;
  client.profile = { accountId: saved.accountId, onlineId: saved.onlineId };
  // Existing accessToken() refreshes on the first Sony request. Offline startup
  // does not erase a valid stored refresh credential or rejoin a voice party.
  client.tokens = { access: '', refresh: saved.refreshToken, expiresAt: 0 };
  client.loginSaved = true;
  return true;
}
