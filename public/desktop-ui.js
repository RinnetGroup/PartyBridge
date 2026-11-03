// Native requests go through the isolated preload and are checked in main.
if (window.partybridgeDesktop?.isDesktop) {
  document.documentElement.dataset.desktop = 'true';
  document.getElementById('desktop-titlebar').hidden = false;
  document.getElementById('npsso-link').textContent = 'Open Sony sign-in';
  document.getElementById('connect-instructions').textContent =
    'Sign in in the Sony window. Use its Sony sign-in menu to show your NPSSO, then paste it here. Your login is saved securely on this PC. Signing out removes it.';
  const network = document.getElementById('voice-network-access');
  if (window.partybridgeDesktop.canConfigureVoiceNetwork) {
    network.hidden = false;
    network.onclick = () => window.partybridgeDesktop.requestVoiceNetworkAccess();
  }
}
