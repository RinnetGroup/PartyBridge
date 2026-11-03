// Small local SVGs: no icon font, CDN or remote UI runtime.
const paths = {
  party:
    '<path d="M4 10v5a3 3 0 0 0 3 3h1v-8H7a3 3 0 0 0-3 3Zm16 0v5a3 3 0 0 1-3 3h-1v-8h1a3 3 0 0 1 3 3ZM4 11V9a8 8 0 0 1 16 0v2M16 18c0 2-2 3-5 3"/>',
  friends:
    '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5"/>',
  messages: '<path d="M20 4H4v13h4l4 4v-4h8V4Z"/><path d="M8 8h8M8 12h5"/>',
  library:
    '<rect x="3" y="4" width="6" height="16" rx="1"/><rect x="10" y="4" width="5" height="16" rx="1"/><path d="m17 5 4-1 2 15-4 1-2-15Z"/>',
  trophies:
    '<path d="M7 3h10v6a5 5 0 0 1-10 0V3Zm0 2H3v3a4 4 0 0 0 5 4m9-7h4v3a4 4 0 0 1-5 4m-4 2v6m-4 1h8"/>',
  captures:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 5-5 4 4 4-7 5 7"/>',
  explore: '<circle cx="12" cy="12" r="9"/><path d="m16 8-3 5-5 3 3-5 5-3Z"/>',
  consoles:
    '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5M8 9h3m-1.5-1.5v3M16 9h.01"/>',
  notifications: '<path d="M5 17h14l-2-4V8a5 5 0 0 0-10 0v5l-2 4Zm5 3h4"/>',
  settings: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
};
export function svgIcon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.party}</svg>`;
}

// Pin UI Liquid Voice's fifteen-bar sine envelope, driven by real microphone
// RMS rather than the original demo's generated speech/recording animation.
export function updateVoiceMeter(host, level) {
  if (!host) return;
  const bars = host.querySelectorAll('.plvoice__bar');
  const value = Number.isFinite(level) ? Math.min(1, Math.max(0, level) * 8) : 0;
  for (let i = 0; i < bars.length; i++)
    bars[i].style.height =
      `${3.5 + (0.45 + 0.55 * Math.sin((Math.PI * (i + 0.5)) / bars.length)) * value * 25}px`;
}
