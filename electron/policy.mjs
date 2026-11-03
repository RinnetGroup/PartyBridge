export function isLocalPage(value, origin) {
  try {
    const url = new URL(value);
    return (
      url.origin === origin &&
      !url.username &&
      !url.password &&
      ['/', '/screen-capture.html', '/volume.html'].includes(url.pathname)
    );
  } catch {
    return false;
  }
}
export function externalWebUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
export function isSonyUrl(value) {
  const safe = externalWebUrl(value);
  if (!safe) return false;
  const { hostname } = new URL(safe);
  return ['sony.com', 'playstation.com', 'sonyentertainmentnetwork.com'].some(
    (domain) => hostname === domain || hostname.endsWith('.' + domain),
  );
}
