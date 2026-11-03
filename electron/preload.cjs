const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld(
  'partybridgeDesktop',
  Object.freeze({
    isDesktop: true,
    canConfigureVoiceNetwork: process.argv.includes('--partybridge-release'),
    requestVoiceNetworkAccess: () => ipcRenderer.send('voice:network-access'),
  }),
);
