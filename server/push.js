import WebSocket from 'ws';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { AppError } from './errors.js';

// Verified against PS App 26.10.0 p028db/g.java, not old client examples.
const RESOLVER =
  'https://mobile-pushcl.np.communication.playstation.net/np/serveraddr?version=3.0&fields=keepAliveStatus&keepAliveStatusType=3';

// Sony's push host currently omits this intermediate from its TLS chain.
// It was fetched from the leaf's public CA Issuers URL and verified against
// Node's existing COMODO RSA root. Hostname, expiry and chain checks stay on.
const PUSH_INTERMEDIATE = readFileSync(
  new URL('./certs/comodo-rsa-domain-validation.pem', import.meta.url),
  'utf8',
);
export function pushTlsOptions() {
  const roots =
    typeof tls.getCACertificates === 'function'
      ? tls.getCACertificates('default')
      : tls.rootCertificates;
  return {
    ca: [...roots, PUSH_INTERMEDIATE],
    rejectUnauthorized: true,
    allowPartialTrustChain: false,
  };
}

export function pushAuthFrame(accountId, token, transaction = '0') {
  if (typeof accountId !== 'string' || !/^[1-9]\d{0,19}$/.test(accountId))
    throw new AppError(
      502,
      'ACCOUNT_ID_MISSING',
      'Sony did not return an exact numeric account ID for the party connection.',
    );
  // Account IDs exceed JS's safe integer limit. Emit validated decimal digits.
  const frame = {
    version: '3.0',
    method: 1003,
    tranId: String(transaction),
    accountId: '__exact_account_id__',
    status: 'active',
    auth: { accessToken: token },
  };
  return JSON.stringify(frame).replace('"__exact_account_id__"', accountId);
}

export function pushAddress(fqdn) {
  if (
    typeof fqdn !== 'string' ||
    !/^[a-z\d.-]+\.np\.communication\.playstation\.net$/i.test(fqdn)
  ) {
    throw new AppError(
      502,
      'INVALID_PUSH_HOST',
      'Sony returned an unrecognized push host. No credentials were sent to it.',
    );
  }
  return `wss://${fqdn}/np/pushNotification`;
}

export class SonyPush {
  constructor(client) {
    this.client = client;
    this.socket = null;
    this.state = 'idle';
    this.pending = null;
    this.timer = null;
  }
  attachDiagnostics(socket) {
    const flag = Symbol.for('partybridge.push-diagnostics');
    if (socket[flag]) return;
    socket[flag] = true;
    const record = (event, detail = {}) =>
      this.client.diagnosticLog?.write(event, { client: this.client.contextId, ...detail });
    socket.on('open', () => record('push.socket-open'));
    socket.on('pong', () => {
      socket.lastDiagnosticPong = Date.now();
      record('push.pong');
    });
    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        record('push.unparsed-message', { bytes: raw.length });
        return;
      }
      socket.lastDiagnosticMessage = Date.now();
      record('push.message', {
        bytes: raw.length,
        method: typeof message.method === 'number' ? message.method : undefined,
        type: typeof message.dataType === 'string' ? message.dataType : undefined,
        returnCode: typeof message.returnCode === 'number' ? message.returnCode : undefined,
      });
    });
    socket.on('close', (code, reason) =>
      record('push.socket-closed', { code, reasonPresent: !!reason?.length }),
    );
    socket.on('error', (error) =>
      record('push.socket-error', { name: error.name, code: error.code }),
    );
  }
  onPartyChanged(callback) {
    this.partyListeners ??= new Set();
    this.partyListeners.add(callback);
    return () => this.partyListeners.delete(callback);
  }
  partyChanged() {
    for (const callback of this.partyListeners ?? []) {
      try {
        callback();
      } catch {
        this.client.record('party refresh notification', 'callback-failed');
      }
    }
  }
  async connect() {
    if (this.state === 'authenticated') return;
    if (this.pending) return this.pending;
    this.pending = this.open().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async open() {
    this.close();
    this.state = 'resolving';
    const token = await this.client.accessToken();
    const data = await this.client.request(
      RESOLVER,
      { headers: { Authorization: `Bearer ${token}` } },
      'resolve push server',
    );
    const url = pushAddress(data.fqdn);
    this.client.record('push server', new URL(url).hostname);
    const frame = pushAuthFrame(this.client.accountId, token);
    this.state = 'connecting';
    await new Promise((resolve, reject) => {
      let settled = false,
        failed = false;
      const socket = (this.socket = new WebSocket(url, 'np-pushpacket', {
        ...pushTlsOptions(),
        handshakeTimeout: 12000,
        maxPayload: 1024 * 1024,
        followRedirects: false,
        headers: {
          Authorization: `Bearer ${token}`,
          'X-PSN-PROTOCOL-VERSION': '3.0',
          'X-PSN-RECONNECTION': 'false',
          'X-PSN-KEEP-ALIVE-STATUS-TYPE': '3',
          'X-PSN-APP-TYPE': 'MOBILE_APP.PSAPP',
          'X-PSN-APP-VER': '26.10.0',
          'X-PSN-OS-VER': '16',
        },
      }));
      socket[Symbol.for('partybridge.push-notifies')] = true;
      this.attachDiagnostics(socket);
      const fail = (code) => {
        if (failed) return;
        failed = true;
        this.state = 'disconnected';
        this.client.record('push connection', code);
        clearTimeout(timeout);
        clearInterval(this.timer);
        this.timer = null;
        if (!settled) {
          settled = true;
          reject(
            new AppError(
              502,
              'PUSH_NOT_CONNECTED',
              'Sony’s party event connection could not be established. Check connection diagnostics.',
              { step: 'push authentication' },
            ),
          );
        }
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      };
      const timeout = setTimeout(() => fail('timeout'), 15000);
      socket.on('upgrade', (response) => {
        this.client.record('push upgrade', response.statusCode);
        this.client.record(
          'push subprotocol',
          response.headers['sec-websocket-protocol'] === 'np-pushpacket'
            ? 'expected'
            : response.headers['sec-websocket-protocol']
              ? 'different'
              : 'missing',
        );
      });
      socket.on('unexpected-response', (_request, response) => {
        response.resume();
        fail(`HTTP ${response.statusCode}`);
      });
      socket.on('open', () => {
        this.state = 'authenticating';
        socket.send(frame);
      });
      socket.on('message', (raw) => {
        let event;
        try {
          event = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (event.method === 1003 && String(event.tranId) === '0' && !settled) {
          if (event.returnCode !== 0) return fail('auth-rejected');
          settled = true;
          clearTimeout(timeout);
          this.state = 'authenticated';
          this.client.record('push authentication', 'accepted');
          const interval = Math.max(
            5000,
            Math.min(60000, Number(data.keepAliveStatus?.clientKeepAliveInterval) || 30000),
          );
          let alive = true;
          socket.on('pong', () => {
            alive = true;
          });
          this.timer = setInterval(() => {
            if (!alive) return fail('heartbeat-timeout');
            if (socket.readyState === WebSocket.OPEN) {
              alive = false;
              socket.ping();
            }
          }, interval).unref();
          resolve();
        } else if (
          typeof event.dataType === 'string' &&
          event.dataType.includes('sessionManager')
        ) {
          // The full Miranda custom-message decoder is still a research item.
          // Never retain other participants' payloads in diagnostics.
          this.client.record('party push notification', 'received');
          this.partyChanged();
        }
      });
      socket.on('error', (error) => {
        const known = new Map([
          ['Server sent no subprotocol', 'missing-subprotocol'],
          ['Server sent an invalid subprotocol', 'invalid-subprotocol'],
          ['Invalid Sec-WebSocket-Accept header', 'invalid-accept-header'],
        ]);
        fail(
          known.get(error.message) ??
            (/^[A-Z_]{3,40}$/.test(error.code ?? '') ? error.code : 'network-error'),
        );
      });
      socket.on('close', () => {
        clearTimeout(timeout);
        clearInterval(this.timer);
        this.timer = null;
        this.state = 'disconnected';
        if (!settled) fail('closed-before-auth');
      });
    });
  }
  close() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.on('error', () => {});
      this.socket.terminate();
      this.socket = null;
    }
    this.state = 'idle';
  }
}
