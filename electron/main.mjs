import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeTheme,
  dialog,
  shell,
  session,
  desktopCapturer,
  ipcMain,
  safeStorage,
} from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { startDesktopHelper } from './helper-process.mjs';
import { isLocalPage, externalWebUrl, isSonyUrl } from './policy.mjs';
import { LoginStore } from './login-store.mjs';
import { requestVoiceFirewall } from './voice-firewall.mjs';

const directory = dirname(fileURLToPath(import.meta.url)),
  root = join(directory, '..');
let window,
  tray,
  helper,
  origin,
  loginStore,
  quitting = false,
  restarting = false;
const localWindows = new Set(),
  pickers = new Map();
const fixtureUrl = process.argv.find((value) => value.startsWith('--fixture-url='))?.slice(14);
// Development UI verification only; packaged apps always own their helper.
const fixture =
  !app.isPackaged && fixtureUrl && /^http:\/\/localhost:\d+$/.test(fixtureUrl) ? fixtureUrl : null;
app.setName('PartyBridge');
app.setAppUserModelId('partybridge.release');
// Keep released builds, source development, and the original working app isolated.
app.setPath(
  'userData',
  join(app.getPath('appData'), app.isPackaged ? 'PartyBridge Release' : 'PartyBridge Release Dev'),
);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('window-all-closed', () => {});
  app.on('activate', showWindow);
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    for (const picker of pickers.values()) picker.window.close();
    void (async () => {
      await helper?.stop();
      await loginStore?.flush();
      app.quit();
    })();
  });
  void app
    .whenReady()
    .then(start)
    .catch(() => {
      dialog.showErrorBox(
        'PartyBridge could not start',
        'The background helper could not start. Reopen PartyBridge or check the application logs.',
      );
      app.quit();
    });
}
function log(event, detail = {}) {
  const folder = join(app.getPath('userData'), 'logs');
  mkdirSync(folder, { recursive: true });
  appendFileSync(
    join(folder, 'desktop.log'),
    JSON.stringify({ time: new Date().toISOString(), event, ...detail }) + '\n',
  );
}
function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
async function openHelper() {
  const nodePath = app.isPackaged
    ? join(process.resourcesPath, 'node', 'node.exe')
    : (process.env.PARTYBRIDGE_NODE_BIN ?? join(root, '.desktop-runtime', 'node', 'node.exe'));
  if (!existsSync(nodePath)) throw new Error('Bundled Node runtime is missing');
  loginStore ??= new LoginStore({
    file: join(app.getPath('userData'), 'auth', 'session.dat'),
    encryption: safeStorage,
  });
  helper = await startDesktopHelper({
    nodePath,
    appRoot: root,
    logDirectory: join(app.getPath('userData'), 'logs'),
    onExit: () => void helperFailed(),
    initialSession: await loginStore.load(),
    onSessionChanged: (value) => loginStore.save(value),
  });
  origin = helper.url;
  log('helper.ready', { pid: helper.pid });
  await session.fromPartition('partybridge-ui').cookies.set({
    url: origin,
    name: 'partybridge',
    value: helper.sessionCookie,
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
  });
}
async function helperFailed() {
  if (quitting || restarting) return;
  restarting = true;
  log('helper.exited');
  const result = await dialog.showMessageBox(window, {
    type: 'error',
    title: 'PartyBridge',
    message: 'The background helper stopped.',
    detail: 'Restart PartyBridge to reconnect. The voice session has ended.',
    buttons: ['Restart', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response === 1) {
    restarting = false;
    app.quit();
    return;
  }
  try {
    await openHelper();
    configureSession();
    await window.loadURL(origin);
  } catch {
    dialog.showErrorBox('Could not restart', 'Close PartyBridge and open it again.');
    app.quit();
  }
  restarting = false;
}
async function start() {
  nativeTheme.themeSource = 'dark';
  app.setAccessibilitySupportEnabled(true);
  if (fixture) origin = fixture;
  else await openHelper();
  configureSession();
  window = createLocalWindow(origin, { width: 1440, height: 980, minWidth: 760, minHeight: 640 });
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  tray = new Tray(join(directory, 'assets', 'tray.png'));
  tray.setToolTip('PartyBridge');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open PartyBridge', click: showWindow },
      {
        label: 'Open logs',
        click: () => void shell.openPath(join(app.getPath('userData'), 'logs')),
      },
      { type: 'separator' },
      { label: 'Quit PartyBridge', click: () => app.quit() },
    ]),
  );
  tray.on('double-click', showWindow);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'PartyBridge',
        submenu: [
          {
            label: 'Open logs',
            click: () => void shell.openPath(join(app.getPath('userData'), 'logs')),
          },
          { type: 'separator' },
          { label: 'Quit', accelerator: 'Ctrl+Q', click: () => app.quit() },
        ],
      },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Voice network access...',
            accelerator: 'Ctrl+Shift+F',
            enabled: app.isPackaged,
            click: () => void requestVoiceFirewall(window),
          },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
    ]),
  );
  log('window.opened');
}
function configureSession() {
  const own = session.fromPartition('partybridge-ui');
  const allowed = (contents, url) =>
    localWindows.has(contents) && isLocalPage(url ?? contents?.getURL(), origin);
  own.setPermissionRequestHandler((contents, permission, callback, details) => {
    const valid = allowed(contents, details.requestingUrl);
    callback(
      valid &&
        ((permission === 'media' &&
          details.mediaTypes?.length > 0 &&
          details.mediaTypes.every((type) => type === 'audio')) ||
          ['speaker-selection', 'fullscreen', 'display-capture'].includes(permission)),
    );
  });
  own.setPermissionCheckHandler(
    (contents, permission, _requestOrigin, details) =>
      allowed(contents, details?.requestingUrl) &&
      ((permission === 'media' && details?.mediaType === 'audio') ||
        ['speaker-selection', 'fullscreen', 'display-capture'].includes(permission)),
  );
  own.setDisplayMediaRequestHandler((request, callback) => {
    if (
      !request.frame ||
      !isLocalPage(request.frame.url, origin) ||
      new URL(request.frame.url).pathname !== '/screen-capture.html'
    ) {
      callback({});
      return;
    }
    void chooseScreen(request, callback);
  });
}
function createLocalWindow(url, options = {}) {
  const local = new BrowserWindow({
    title: 'PartyBridge',
    backgroundColor: '#0b101a',
    show: false,
    autoHideMenuBar: true,
    icon: join(directory, 'assets', 'app.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b101a', symbolColor: '#c1d0e6', height: 39 },
    ...options,
    webPreferences: {
      preload: join(directory, 'preload.cjs'),
      additionalArguments: app.isPackaged ? ['--partybridge-release'] : [],
      partition: 'partybridge-ui',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  const contents = local.webContents;
  localWindows.add(contents);
  local.once('ready-to-show', () => local.show());
  local.on('closed', () => localWindows.delete(contents));
  local.webContents.on('will-navigate', (event, target) => {
    if (!isLocalPage(target, origin)) {
      event.preventDefault();
      openLink(target);
    }
  });
  local.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isLocalPage(target, origin))
      createLocalWindow(target, { width: 1100, height: 850, minWidth: 650, minHeight: 550 });
    else openLink(target);
    return { action: 'deny' };
  });
  local.webContents.on('did-fail-load', (_event, code, _description, _url, isMain) => {
    if (isMain && code !== -3) log('page.load-failed', { code });
  });
  void local.loadURL(url);
  return local;
}
function openLink(value) {
  const safe = externalWebUrl(value);
  if (!safe) return;
  if (isSonyUrl(safe) && new URL(safe).pathname === '/api/v1/ssocookie') {
    sonySignIn(safe);
    return;
  }
  void shell.openExternal(safe);
}
function sonySignIn(cookieUrl) {
  const auth = new BrowserWindow({
    title: 'PlayStation sign-in · PartyBridge',
    width: 1050,
    height: 800,
    backgroundColor: '#111111',
    webPreferences: {
      partition: 'sony-signin',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  auth.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  auth.setMenu(
    Menu.buildFromTemplate([
      {
        label: 'Sony sign-in',
        submenu: [
          {
            label: '1. Sign in to PlayStation',
            click: () =>
              void auth.loadURL('https://www.playstation.com/en-us/playstation-network/'),
          },
          { label: '2. Show NPSSO after sign-in', click: () => void auth.loadURL(cookieUrl) },
          { type: 'separator' },
          { role: 'close' },
        ],
      },
      { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'selectAll' }] },
    ]),
  );
  const navigation = (event, url) => {
    if (!isSonyUrl(url)) event.preventDefault();
  };
  auth.webContents.on('will-navigate', navigation);
  auth.webContents.on('will-redirect', navigation);
  auth.webContents.setWindowOpenHandler(({ url }) => {
    if (isSonyUrl(url)) void auth.loadURL(url);
    return { action: 'deny' };
  });
  void auth.loadURL('https://www.playstation.com/en-us/playstation-network/');
}
async function chooseScreen(request, callback) {
  let completed = false;
  const finish = (value) => {
    if (completed) return;
    completed = true;
    try {
      callback(value);
    } catch {}
  };
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false,
    });
    if (quitting || !sources.length) {
      finish({});
      return;
    }
    const parent =
      BrowserWindow.getAllWindows().find((item) => item.webContents.mainFrame === request.frame) ??
      window;
    const picker = new BrowserWindow({
      title: 'Choose a screen · PartyBridge',
      parent,
      modal: true,
      width: 850,
      height: 650,
      minWidth: 600,
      minHeight: 450,
      autoHideMenuBar: true,
      backgroundColor: '#101111',
      webPreferences: {
        preload: join(directory, 'screen-picker-preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    const state = { window: picker, request, sources, callback: finish, done: false },
      pickerId = picker.webContents.id;
    pickers.set(pickerId, state);
    picker.on('closed', () => {
      pickers.delete(pickerId);
      if (!state.done) {
        state.done = true;
        finish({});
      }
    });
    picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    picker.webContents.on('will-navigate', (event) => event.preventDefault());
    await picker.loadFile(join(directory, 'screen-picker.html'));
  } catch {
    finish({});
  }
}
ipcMain.on('voice:network-access', (event) => {
  if (
    !app.isPackaged ||
    !localWindows.has(event.sender) ||
    event.senderFrame !== event.sender.mainFrame ||
    !isLocalPage(event.sender.getURL(), origin)
  )
    return;
  void requestVoiceFirewall(BrowserWindow.fromWebContents(event.sender));
});

ipcMain.handle('capture:sources', (event) => {
  const state = pickers.get(event.sender.id);
  if (!state || event.senderFrame !== event.sender.mainFrame) return [];
  return state.sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnail: source.thumbnail.toDataURL(),
  }));
});
ipcMain.handle('capture:choose', (event, id) => {
  const state = pickers.get(event.sender.id);
  if (!state || state.done || event.senderFrame !== event.sender.mainFrame) return;
  const source = state.sources.find((item) => item.id === id);
  if (!source) return;
  state.done = true;
  state.callback({ video: source, ...(state.request.audioRequested ? { audio: 'loopback' } : {}) });
  state.window.close();
});
ipcMain.handle('capture:cancel', (event) => pickers.get(event.sender.id)?.window.close());
