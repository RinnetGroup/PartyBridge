// Only the private parent IPC channel transports saved login credentials.
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/index.js';
import { PsnClient } from '../server/psn.js';
import { exportLogin, restoreLogin } from '../server/saved-login.js';
let helper,
  closing = false,
  initialize;
const pending = new Map(),
  initial = new Promise((resolve) => {
    initialize = resolve;
  });
async function shutdown() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(0), 6000).unref();
  try {
    await helper?.close();
  } finally {
    clearTimeout(deadline);
    process.exit(0);
  }
}
function saveSession(value) {
  return new Promise((resolve) => {
    if (!process.connected) {
      resolve(false);
      return;
    }
    const id = randomUUID(),
      timer = setTimeout(() => {
        pending.delete(id);
        resolve(false);
      }, 8000);
    pending.set(id, { resolve, timer });
    process.send({ type: 'session-changed', id, session: value }, () => {});
  });
}
process.on('message', (message) => {
  if (message?.type === 'shutdown') void shutdown();
  if (message?.type === 'initialize') initialize(message.session);
  if (message?.type === 'session-result') {
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message.ok === true);
    }
  }
});
process.on('disconnect', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.send?.({ type: 'initialize' });
const saved = await initial;
const client = new PsnClient({
  allowBridgeCreation: true,
  sendSamplingRates: [16000],
  onSessionChanged: (current) => {
    const data = exportLogin(current);
    return data ? saveSession(data) : false;
  },
  onSessionExpired: () => saveSession(null),
});
restoreLogin(client, saved);
const sessionCookie = randomBytes(32).toString('hex');
const state = {
  sessions: new Map([
    [
      sessionCookie,
      {
        csrf: randomBytes(32).toString('hex'),
        client,
        keepLogin: true,
        busy: false,
        lastAuthAttempt: 0,
        lastListAt: 0,
        cachedList: null,
        lastSeen: Date.now(),
      },
    ],
  ]),
  clients: new Set([client]),
};
helper = createApp({
  state,
  onSignOut: (current) => (current === client ? saveSession(null) : undefined),
});
try {
  const url = await helper.listen(0);
  process.send?.({ type: 'ready', url, sessionCookie });
} catch {
  process.send?.({ type: 'failed' });
  process.exit(1);
}
