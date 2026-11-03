import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { PsnClient } from './psn.js';
import { AppError } from './errors.js';
import { requireId } from './errors.js';
import { participantRoster, participantDetailsSnapshot } from './participant-details.js';
import { readPartyList, invalidatePartyList, watchPartyUpdates } from './party-updates.js';
import { WebSocketServer } from 'ws';
import { VoiceEngine } from './voice-engine.js';
import { ScreenShareViewer, screenShareList } from './screen-share.js';
import { VoiceSocketHeartbeat } from './voice-socket.js';
import { getDiagnosticLog } from './diagnostic-log.js';
import { audioVolumePatch, DEFAULT_AUDIO_VOLUME } from './audio-volume.js';
import { AppFeatures, allowedMediaUrl } from './app-features.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PUBLIC = new URL('../public/', import.meta.url);
const FILES = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/mic-worklet.js', ['mic-worklet.js', 'text/javascript']],
  ['/playout-worklet.js', ['playout-worklet.js', 'text/javascript']],
  ['/voice.js', ['voice.js', 'text/javascript']],
  ['/retime-worker.js', ['retime-worker.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);
const PROTOCOL_FILES = new Set([
  '/protocol/bridge-session.js',
  '/protocol/participant.js',
  '/protocol/voice-session.js',
  '/protocol/party-data.js',
]);
FILES.set('/party-state.js', ['party-state.js', 'text/javascript']);
FILES.set('/screen-share.js', ['screen-share.js', 'text/javascript']);
FILES.set('/mic-frame.js', ['mic-frame.js', 'text/javascript']);
FILES.set('/volume-controls.js', ['volume-controls.js', 'text/javascript']);
FILES.set('/volume.html', ['volume.html', 'text/html']);
FILES.set('/screen-capture.html', ['screen-capture.html', 'text/html']);
FILES.set('/screen-capture.js', ['screen-capture.js', 'text/javascript']);
FILES.set('/hub.js', ['hub.js', 'text/javascript']);
FILES.set('/hub.css', ['hub.css', 'text/css']);
FILES.set('/session.js', ['session.js', 'text/javascript']);
FILES.set('/voice-status.js', ['voice-status.js', 'text/javascript']);
FILES.set('/start-party.js', ['start-party.js', 'text/javascript']);
FILES.set('/participant-details.js', ['participant-details.js', 'text/javascript']);
FILES.set('/party-live.js', ['party-live.js', 'text/javascript']);
FILES.set('/party-notifications.js', ['party-notifications.js', 'text/javascript']);
FILES.set('/desktop-ui.css', ['desktop-ui.css', 'text/css']);
FILES.set('/desktop-ui.js', ['desktop-ui.js', 'text/javascript']);
FILES.set('/ui-elements.js', ['ui-elements.js', 'text/javascript']);
FILES.set('/pinui/liquid-voice.css', ['vendor/pinui/liquid-voice.css', 'text/css']);
FILES.set('/pinui/selection-list.css', ['vendor/pinui/selection-list.css', 'text/css']);
const SECRET = () => randomBytes(32).toString('hex');
const equal = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function jsonBody(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new AppError(415, 'JSON_REQUIRED', 'This action requires JSON.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 70000) throw new AppError(413, 'BODY_TOO_LARGE', 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError(400, 'INVALID_JSON', 'Invalid request.');
  }
}

export function createApp({
  clientFactory = () => new PsnClient({ allowBridgeCreation: true, sendSamplingRates: [16000] }),
  voiceEngineFactory = (client, callbacks) => new VoiceEngine(client, callbacks),
  screenViewerFactory = (client) => new ScreenShareViewer(client),
  state,
  httpServer,
  onSignOut,
} = {}) {
  const sessions = state?.sessions ?? new Map();
  const clients = state?.clients ?? new Set();
  for (const session of sessions.values()) session.partyUpdates?.close();
  const diagnostics = getDiagnosticLog();
  for (const client of clients) client.diagnosticLog = diagnostics;
  let port = httpServer?.address()?.port;
  const stopScreen = async (session) => {
    session.screenGeneration = (session.screenGeneration ?? 0) + 1;
    const viewer = session.screenViewer;
    session.screenViewer = null;
    session.screenWatchId = null;
    await viewer?.stop();
  };
  const stopVoiceEngine = async (session) => {
    if (session.stoppingVoiceEngine) await session.stoppingVoiceEngine;
    const engine = session.voiceEngine;
    session.voiceEngine = null;
    if (engine) {
      diagnostics?.write('voice.stopping', {
        client: session.client.contextId,
        health: engine.diagnostics?.(),
      });
      const stopping = engine.stop().catch(() => {});
      session.stoppingVoiceEngine = stopping;
      try {
        await stopping;
      } finally {
        if (session.stoppingVoiceEngine === stopping) session.stoppingVoiceEngine = null;
      }
    }
  };
  const handler = async (req, res) => {
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self)');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; worker-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      if (!allowedHosts.includes(req.headers.host))
        throw new AppError(403, 'LOCAL_ONLY', 'PartyBridge only accepts requests to localhost.');
      const ownOrigin = `http://${req.headers.host}`;
      const url = new URL(req.url, ownOrigin);
      const publicNavigation =
        req.method === 'GET' &&
        FILES.has(url.pathname) &&
        req.headers['sec-fetch-mode'] === 'navigate' &&
        req.headers['sec-fetch-dest'] === 'document';
      if (
        (req.headers.origin && req.headers.origin !== ownOrigin) ||
        (!publicNavigation && ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']))
      )
        throw new AppError(403, 'ORIGIN_DENIED', 'Open PartyBridge directly on localhost.');
      const requestStarted = performance.now();
      res.once('finish', () =>
        diagnostics?.write('http.response', {
          method: req.method,
          path: url.pathname,
          status: res.statusCode,
          elapsedMs: Math.round(performance.now() - requestStarted),
        }),
      );
      if (req.method === 'GET' && PROTOCOL_FILES.has(url.pathname)) {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return res.end(await readFile(new URL(`..${url.pathname}`, PUBLIC)));
      }
      if (req.method === 'GET' && FILES.has(url.pathname)) {
        const [name, type] = FILES.get(url.pathname);
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return res.end(await readFile(new URL(name, PUBLIC)));
      }
      if (req.method === 'GET' && url.pathname === '/api/health')
        return send(200, {
          ok: true,
          version: '0.1.0',
          localOnly: true,
          features: {
            appHub: true,
            partyDataChannel: true,
            audioVolume: true,
            screenCapturePreview: true,
            screenBroadcast: false,
            persistentDiagnostics: !!diagnostics,
          },
        });
      const cookie = req.headers.cookie
        ?.split(';')
        .map((x) => x.trim())
        .find((x) => x.startsWith('partybridge='))
        ?.slice(12);
      let session = sessions.get(cookie);
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        if (!session) {
          // Bound unauthenticated tab/session allocation.
          if (sessions.size >= 24)
            throw new AppError(
              429,
              'TOO_MANY_SESSIONS',
              'Close unused tabs and restart the local helper.',
            );
          const id = SECRET();
          session = {
            csrf: SECRET(),
            client: clientFactory(),
            busy: false,
            lastAuthAttempt: 0,
            lastListAt: 0,
            cachedList: null,
            lastSeen: Date.now(),
          };
          sessions.set(id, session);
          clients.add(session.client);
          session.client.diagnosticLog = diagnostics;
          diagnostics?.write('local.session-created', { client: session.client.contextId });
          res.setHeader('Set-Cookie', `partybridge=${id}; HttpOnly; SameSite=Strict; Path=/`);
        }
        return send(200, {
          csrf: session.csrf,
          connected: !!session.client.tokens,
          profile: session.client.profile,
          activeParty: session.client.active?.id ?? null,
          voiceExperimental: true,
        });
      }
      if (!session)
        throw new AppError(
          401,
          'LOCAL_SESSION_REQUIRED',
          'Reload PartyBridge to start a local session.',
        );
      if (req.method === 'GET' && url.pathname.startsWith('/api/app/media/')) {
        if (!session.client.tokens)
          throw new AppError(401, 'NOT_CONNECTED', 'Connect your PlayStation account first.');
        const item = session.appFeatures?.media.get(url.pathname.slice('/api/app/media/'.length));
        if (!item || item.expires < Date.now())
          throw new AppError(
            404,
            'APP_MEDIA_EXPIRED',
            'Refresh this page to load the image or capture again.',
          );
        let target = allowedMediaUrl(item.url);
        const headers = {};
        if (req.headers.range) {
          if (!/^bytes=\d*-\d*$/.test(req.headers.range))
            throw new AppError(416, 'BAD_RANGE', 'Invalid media range.');
          headers.Range = req.headers.range;
        }
        const controller = new AbortController(),
          timeout = setTimeout(() => controller.abort(), 300000);
        res.once('close', () => controller.abort());
        try {
          let upstream;
          for (let redirects = 0; redirects < 4; redirects++) {
            if (!target)
              throw new AppError(502, 'APP_MEDIA_HOST', 'Sony returned an unsupported media host.');
            const requestHeaders = { ...headers };
            if (item.authenticated && new URL(target).origin === 'https://m.np.playstation.com') {
              requestHeaders.Authorization = 'Bearer ' + (await session.client.accessToken());
              requestHeaders['Accept-Language'] = 'en-US';
            }
            upstream = await session.client.fetch(target, {
              headers: requestHeaders,
              redirect: 'manual',
              signal: controller.signal,
            });
            if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
            await upstream.body?.cancel();
            target = allowedMediaUrl(new URL(upstream.headers.get('location'), target).href);
            upstream = null;
          }
          if (!upstream || ![200, 206].includes(upstream.status))
            throw new AppError(
              502,
              'APP_MEDIA_UNAVAILABLE',
              'This media is unavailable. Refresh and try again.',
            );
          const type = upstream.headers.get('content-type') ?? '';
          if (!/^(image|video|audio)\//i.test(type)) {
            await upstream.body?.cancel();
            throw new AppError(
              502,
              'APP_MEDIA_TYPE',
              'Sony did not return a playable image or video.',
            );
          }
          res.statusCode = upstream.status;
          res.setHeader('Content-Type', type);
          for (const header of ['content-length', 'content-range', 'accept-ranges'])
            if (upstream.headers.has(header)) res.setHeader(header, upstream.headers.get(header));
          await pipeline(Readable.fromWeb(upstream.body), res);
        } finally {
          clearTimeout(timeout);
        }
        return;
      }
      // Avatar images are proxied so the page can load them same-origin (strict
      // img-src). An <img> cannot send the CSRF header, so this read-only route
      // is reachable with just the session cookie.
      if (req.method === 'GET' && url.pathname.startsWith('/api/avatar/')) {
        const accountId = decodeURIComponent(url.pathname.slice('/api/avatar/'.length));
        if (!/^[1-9]\d{0,19}$/.test(accountId))
          throw new AppError(400, 'BAD_ID', 'Invalid account id.');
        const img = await session.client.avatar(accountId);
        if (!img) {
          res.writeHead(404, { 'Cache-Control': 'no-store' });
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'private, max-age=3600' });
        return res.end(img.buf);
      }
      if (!equal(req.headers['x-partybridge-csrf'], session.csrf))
        throw new AppError(403, 'CSRF_INVALID', 'Reload PartyBridge and try again.');
      session.lastSeen = Date.now();
      if (url.pathname.startsWith('/api/app/')) {
        if (session.accountChanging)
          throw new AppError(409, 'BUSY', 'Wait for your account connection to finish.');
        if (!session.client.tokens)
          throw new AppError(401, 'NOT_CONNECTED', 'Connect your PlayStation account first.');
        const features = (session.appFeatures ??= new AppFeatures(session.client));
        if (req.method === 'GET')
          return send(
            200,
            await features.read(
              url.pathname.slice('/api/app/'.length),
              Object.fromEntries(url.searchParams),
            ),
          );
        if (req.method === 'POST' && url.pathname === '/api/app/photo') {
          const type = req.headers['content-type']?.split(';')[0];
          if (!['image/png', 'image/jpeg'].includes(type))
            throw new AppError(415, 'APP_PHOTO_TYPE', 'Choose a PNG or JPEG photo.');
          let size = 0;
          const chunks = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 1048576)
              throw new AppError(413, 'APP_PHOTO_SIZE', 'Choose a photo up to 1 MiB.');
            chunks.push(chunk);
          }
          return send(
            200,
            await features.sendPhoto(url.searchParams.get('groupId'), Buffer.concat(chunks), type),
          );
        }
        if (req.method === 'POST' && url.pathname === '/api/app/action') {
          const body = await jsonBody(req);
          return send(200, await features.action(body.action, body));
        }
        throw new AppError(404, 'NOT_FOUND', 'Unknown app route.');
      }
      if (req.method === 'GET' && url.pathname === '/api/heartbeat')
        return send(200, { ok: true, activeParty: session.client.active?.id ?? null });
      if (req.method === 'GET' && url.pathname === '/api/parties')
        return send(200, await readPartyList(session));
      if (req.method === 'GET' && url.pathname === '/api/party/participant-details') {
        const client = session.client,
          account = client.accountId,
          id = requireId(url.searchParams.get('id'));
        if (!client.tokens)
          throw new AppError(401, 'NOT_CONNECTED', 'Connect your PlayStation account first.');
        if (session.accountChanging)
          throw new AppError(409, 'BUSY', 'Wait for your account connection to finish.');
        const engine = session.voiceEngine;
        if (client.active?.id === id && engine && !engine.stopped) {
          const result = await engine.participantDetails();
          if (
            client.accountId !== account ||
            session.voiceEngine !== engine ||
            client.active?.id !== id
          )
            return send(200, { partyId: id, participants: [], bridge: null });
          return send(200, { partyId: id, ...result });
        }
        const raw = await client.party(id);
        if (!client.tokens || client.accountId !== account)
          throw new AppError(409, 'BUSY', 'Your account changed. Reopen the profile.');
        return send(200, {
          partyId: id,
          ...participantDetailsSnapshot({
            members: participantRoster(raw, client.deviceId),
            profile: client.profile,
          }),
        });
      }
      if (url.pathname === '/api/audio/volume' && ['GET', 'POST'].includes(req.method)) {
        if (req.method === 'POST') {
          const body = await jsonBody(req);
          try {
            session.audioVolume = audioVolumePatch(
              body,
              session.audioVolume ?? DEFAULT_AUDIO_VOLUME,
            );
          } catch {
            throw new AppError(400, 'INVALID_AUDIO_VOLUME', 'Choose a volume between 0% and 200%.');
          }
          diagnostics?.write('audio.volume-changed', {
            client: session.client.contextId,
            ...session.audioVolume,
          });
        }
        session.voiceEngine?.setAudioVolume?.(session.audioVolume ?? DEFAULT_AUDIO_VOLUME);
        return send(200, {
          ...(session.audioVolume ?? DEFAULT_AUDIO_VOLUME),
          voiceActive: !!session.voiceEngine && !session.voiceEngine.stopped,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/diagnostics')
        return send(200, {
          events: session.client.events,
          voiceEvents: session.client.voiceEvents ?? [],
          voiceSession: session.voiceEngine?.diagnostics?.() ?? null,
          logging: diagnostics?.status() ?? { enabled: false },
          voiceVerified: false,
        });
      if (url.pathname === '/api/audio/leveling' && ['GET', 'POST'].includes(req.method)) {
        if (req.method === 'POST') {
          const body = await jsonBody(req);
          if (!body || typeof body.enabled !== 'boolean')
            throw new AppError(
              400,
              'INVALID_AUDIO_LEVELING',
              'Choose whether smart voice leveling is on or off.',
            );
          session.audioLeveling = body.enabled;
          diagnostics?.write('audio.leveling-changed', {
            client: session.client.contextId,
            enabled: body.enabled,
          });
        }
        session.voiceEngine?.setSmartLeveling?.(session.audioLeveling === true);
        return send(200, {
          enabled: session.audioLeveling === true,
          voiceActive: !!session.voiceEngine && !session.voiceEngine.stopped,
        });
      }
      const recordBrowserEvent = (message) => {
        if (typeof message.event !== 'string' || !/^[a-z][a-z0-9.-]{0,63}$/.test(message.event))
          return;
        const time = Date.now();
        if (!session.browserLogWindow || time - session.browserLogWindow > 60000) {
          session.browserLogWindow = time;
          session.browserLogCount = 0;
        }
        if (++session.browserLogCount <= 120)
          diagnostics?.write('browser.event', {
            client: session.client.contextId,
            event: message.event,
            details: message.details,
          });
      };
      if (req.method === 'POST' && url.pathname === '/api/client-log') {
        recordBrowserEvent(await jsonBody(req));
        return send(200, { recorded: true });
      }
      // Viewing has its own lifecycle and never takes the voice action lock.
      if (req.method === 'GET' && url.pathname === '/api/screens') {
        const active = session.client.active;
        if (!active) return send(200, { streams: [], viewer: null, activeParty: null });
        const raw = await session.client.party(active.id);
        if (session.client.active !== active) return send(200, { streams: [], viewer: null });
        const streams = screenShareList(raw);
        const viewer = session.screenViewer;
        if (viewer && !streams.some((s) => s.memberKey === viewer.memberKey && !s.restricted))
          await stopScreen(session);
        return send(200, {
          streams,
          activeParty: active.id,
          viewer: session.screenViewer
            ? {
                memberKey: session.screenViewer.memberKey,
                watchId: session.screenWatchId,
                state: session.screenViewer.stage,
              }
            : null,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/screen/start') {
        const body = await jsonBody(req);
        if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(body.watchId ?? ''))
          throw new AppError(400, 'SCREEN_BAD_WATCH_ID', 'Invalid viewing request.');
        const generation = (session.screenGeneration = (session.screenGeneration ?? 0) + 1);
        const previous = session.screenViewer;
        session.screenViewer = null;
        session.screenWatchId = body.watchId;
        await previous?.stop();
        if (session.screenGeneration !== generation)
          throw new AppError(409, 'SCREEN_CANCELLED', 'Screen viewing stopped.');
        const viewer = (session.screenViewer = screenViewerFactory(session.client));
        try {
          const offer = await viewer.start(body.memberKey, body.sdp);
          if (session.screenGeneration !== generation || session.screenViewer !== viewer)
            throw new AppError(409, 'SCREEN_CANCELLED', 'Screen viewing stopped.');
          return send(200, { ...offer, watchId: body.watchId });
        } catch (error) {
          await viewer.stop();
          if (session.screenViewer === viewer) session.screenViewer = null;
          throw error;
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/screen/answer') {
        const body = await jsonBody(req);
        const viewer = session.screenViewer;
        if (!viewer || session.screenWatchId !== body.watchId)
          throw new AppError(409, 'SCREEN_NOT_STARTED', 'Start a screen viewer first.');
        return send(200, await viewer.answer(body.sdp));
      }
      if (req.method === 'POST' && url.pathname === '/api/screen/stop') {
        const body = await jsonBody(req);
        if (body.watchId && session.screenWatchId === body.watchId) await stopScreen(session);
        return send(200, { stopped: true });
      }
      if (session.busy) throw new AppError(409, 'BUSY', 'Wait for the current action to finish.');
      const isPost = req.method === 'POST';
      if (
        !isPost &&
        !(req.method === 'GET' && ['/api/parties', '/api/voice/state'].includes(url.pathname))
      )
        throw new AppError(404, 'NOT_FOUND', 'Unknown route.');
      session.busy = true;
      try {
        const body = isPost ? await jsonBody(req) : {};
        const client = session.client;
        if (isPost && url.pathname === '/api/connect') {
          if (client.tokens)
            throw new AppError(
              409,
              'ALREADY_CONNECTED',
              'Disconnect before connecting another account.',
            );
          if (Date.now() - session.lastAuthAttempt < 5000)
            throw new AppError(429, 'WAIT', 'Wait a few seconds before reconnecting.');
          session.lastAuthAttempt = Date.now();
          session.accountChanging = true;
          invalidatePartyList(session);
          session.partyListRetryAt = 0;
          session.appFeatures?.clear();
          session.appFeatures = null;
          const profile = await client.login(body.npsso);
          return send(200, {
            profile,
            ...(typeof client.loginSaved === 'boolean' ? { loginSaved: client.loginSaved } : {}),
          });
        }
        if (isPost && url.pathname === '/api/disconnect') {
          session.accountChanging = true;
          session.partyUpdates?.close();
          invalidatePartyList(session);
          session.partyListRetryAt = 0;
          session.appFeatures?.clear();
          session.appFeatures = null;
          await stopScreen(session);
          await stopVoiceEngine(session);
          await client.leave();
          client.clear();
          if ((await onSignOut?.(client)) === false)
            throw new AppError(
              500,
              'SAVED_LOGIN_REMOVE_FAILED',
              'Signed out, but the saved login could not be removed. Try signing out again.',
            );
          session.cachedList = null;
          return send(200, { disconnected: true });
        }
        if (isPost && url.pathname === '/api/party/create') {
          try {
            return send(200, await client.createParty(body));
          } finally {
            if (session.partyUpdates) session.partyUpdates.notify();
            else invalidatePartyList(session);
          }
        }
        if (isPost && url.pathname === '/api/party/join') {
          const result = await client.join(body.id);
          if (session.partyUpdates) session.partyUpdates.notify();
          else invalidatePartyList(session);
          return send(200, result);
        }
        if (isPost && url.pathname === '/api/party/leave') {
          await stopScreen(session);
          await stopVoiceEngine(session);
          await client.leave();
          if (session.partyUpdates) session.partyUpdates.notify();
          else invalidatePartyList(session);
          return send(200, { left: true });
        }
        if (isPost && url.pathname === '/api/voice/prepare')
          return send(200, await client.prepareVoice());
        if (isPost && url.pathname === '/api/voice/register')
          return send(200, await client.registerVoice());
        if (!isPost && url.pathname === '/api/voice/state')
          return send(200, await client.voiceState());
        if (isPost && url.pathname === '/api/voice/answer')
          return send(200, await client.answer(body.sdp));
        if (isPost && url.pathname === '/api/voice/stop') {
          await client.stopVoice();
          return send(200, { stopped: true });
        }
        throw new AppError(404, 'NOT_FOUND', 'Unknown route.');
      } finally {
        session.busy = false;
        session.accountChanging = false;
      }
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      // Never expose upstream exceptions: they can contain authentication material.
      if (!res.headersSent)
        send(error instanceof AppError ? error.status : 500, {
          error: {
            code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
            message:
              error instanceof AppError
                ? error.message
                : 'The local helper could not complete this action.',
            ...(error instanceof AppError ? error.details : {}),
          },
        });
      else res.end();
    }
  };
  const server = httpServer ?? http.createServer();
  const runtime = state ?? { sessions, clients };
  server[Symbol.for('partybridge.runtime')] = runtime;
  clearInterval(runtime.diagnosticMonitor);
  let previousHealth = performance.now();
  runtime.diagnosticMonitor = diagnostics
    ? setInterval(() => {
        const now = performance.now(),
          memory = process.memoryUsage();
        diagnostics.write('process.health', {
          eventLoopDelayMs: Math.max(0, Math.round(now - previousHealth - 5000)),
          memory,
          sessions: sessions.size,
          droppedLogEvents: diagnostics.dropped,
        });
        previousHealth = now;
        for (const session of sessions.values()) {
          if (!session.client.tokens && !session.voiceEngine) continue;
          try {
            diagnostics.write('session.health', {
              client: session.client.contextId,
              partyActive: !!session.client.active,
              push: {
                state: session.client.push?.state,
                socket: session.client.push?.socket?.readyState,
                lastPongMsAgo: session.client.push?.socket?.lastDiagnosticPong
                  ? Date.now() - session.client.push.socket.lastDiagnosticPong
                  : null,
              },
              voiceSocket: session.voiceSocket
                ? {
                    state: session.voiceSocket.readyState,
                    queuedBytes: session.voiceSocket.bufferedAmount,
                    lastReplyMsAgo:
                      Date.now() -
                      (session.voiceSocket.partybridgeHeartbeat?.lastReply ?? Date.now()),
                  }
                : null,
              voice: session.voiceEngine?.diagnostics?.() ?? null,
              screen: session.screenViewer?.stage ?? null,
            });
          } catch {
            diagnostics.write('diagnostic.health-error', { client: session.client.contextId });
          }
        }
      }, 5000).unref()
    : null;
  diagnostics?.write('helper.routes-loaded', {
    preservedSessions: sessions.size,
    partyDataChannel: 1,
    audioVolume: true,
  });
  // Development reload can reuse the listener and in-memory session store.
  // No credentials are serialized, and the existing lifecycle timer stays active.
  if (httpServer) {
    server.removeAllListeners('request');
    server.removeAllListeners('upgrade');
  }
  server.on('request', handler);

  // Voice runs over a WebSocket: the browser streams 16 kHz mono mic PCM up and
  // receives decoded party PCM down (binary frames), plus JSON control/state.
  // Auth reuses the session cookie + CSRF as a query param (browsers can't set
  // custom headers on a WebSocket handshake).
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  const wireVoiceSocket = (ws, session) => {
    const previous = session.voiceSocket;
    session.voiceSocket = ws;
    diagnostics?.write('voice.socket-open', {
      client: session.client.contextId,
      replaced: !!previous,
    });
    if (previous && previous !== ws) previous.close(1000, 'Voice moved to another tab');
    ws.partybridgeHeartbeat = new VoiceSocketHeartbeat(ws, session);
    ws.binaryType = 'nodebuffer';
    let starting = false;
    const sendJson = (obj) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    };
    ws.on('message', async (data, isBinary) => {
      if (session.voiceSocket !== ws) return;
      if (isBinary) {
        session.voiceEngine?.pushMic(data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      diagnostics?.write('voice.control', {
        client: session.client.contextId,
        command: msg.t,
        muted: msg.t === 'mute' ? !!msg.on : undefined,
      });
      if (msg.t === 'start') {
        if (starting) return;
        starting = true;
        try {
          await stopVoiceEngine(session);
          if (session.voiceSocket !== ws || ws.readyState !== 1) return;
          const engine = (session.voiceEngine = voiceEngineFactory(session.client, {
            onState: (s, summary) => {
              diagnostics?.write('voice.state', {
                client: session.client.contextId,
                state: s,
                summary,
              });
              sendJson({ t: 'state', state: s, summary });
            },
            onLevel: (l) => sendJson({ t: 'level', self: l.self, party: l.party }),
            onParticipants: (peers, members, summary) => {
              const roster = {
                peers,
                members: members.map((m) => ({
                  key: m.memberKey,
                  accountId: m.accountId,
                  platform: m.platform,
                  self: m.isSelf,
                  active: m.voiceChatActivated,
                })),
                summary,
              };
              const signature = JSON.stringify(roster);
              if (ws.rosterLogSignature !== signature) {
                ws.rosterLogSignature = signature;
                diagnostics?.write('voice.roster', { client: session.client.contextId, ...roster });
              }
              sendJson({ t: 'participants', peers, members, summary });
            },
            onPcm: (pcm) => {
              if (ws.readyState !== 1) return;
              if (ws.bufferedAmount > 8000) {
                if (!ws.playoutCongested) {
                  ws.playoutCongested = true;
                  session.client.record('voice socket playout', 'discarding delayed audio');
                }
                return;
              }
              ws.playoutCongested = false;
              ws.send(pcm, { binary: true });
            },
            onLog: (m) => {
              // Persist the disconnect/control history in diagnostics even after
              // the engine and its WebSocket are gone. Do not retain peer IDs.
              session.client.record(
                'voice',
                m.replace(/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}/gi, '<peer>'),
              );
              sendJson({ t: 'log', msg: m });
            },
          }));
          engine.setAudioVolume?.(session.audioVolume ?? DEFAULT_AUDIO_VOLUME);
          engine.setSmartLeveling?.(session.audioLeveling === true);
          try {
            await engine.start(String(msg.partyId || ''));
          } catch (error) {
            sendJson({
              t: 'error',
              message: error instanceof AppError ? error.message : 'Voice could not start.',
            });
            await stopVoiceEngine(session);
          }
        } finally {
          starting = false;
        }
      } else if (msg.t === 'mute') {
        session.voiceEngine?.setMuted(!!msg.on);
      } else if (msg.t === 'audio-status') {
        session.voiceEngine?.reportAudioStatus?.(msg);
      } else if (msg.t === 'stop') {
        await stopVoiceEngine(session);
        sendJson({ t: 'state', state: 'stopped' });
      }
    });
    ws.on('close', (code) => {
      if (session.voiceSocket !== ws) return;
      session.voiceSocket = null;
      session.client.record('voice socket closed', code);
      void stopVoiceEngine(session);
    });
    ws.on('error', (error) =>
      diagnostics?.write('voice.socket-error', {
        client: session.client.contextId,
        code: error.code,
        name: error.name,
      }),
    );
    sendJson({ t: 'ready' });
  };
  server.on('upgrade', (req, socket, head) => {
    try {
      const p = port ?? server.address()?.port;
      if (![`127.0.0.1:${p}`, `localhost:${p}`].includes(req.headers.host)) return socket.destroy();
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (!['/ws', '/party-updates'].includes(url.pathname)) return socket.destroy();
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
        return socket.destroy();
      const cookie = req.headers.cookie
        ?.split(';')
        .map((x) => x.trim())
        .find((x) => x.startsWith('partybridge='))
        ?.slice(12);
      const session = sessions.get(cookie);
      if (!session || !equal(url.searchParams.get('csrf'), session.csrf)) return socket.destroy();
      if (url.pathname === '/party-updates' && (!session.client.tokens || session.accountChanging))
        return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) =>
        url.pathname === '/party-updates'
          ? watchPartyUpdates(session, ws)
          : wireVoiceSocket(ws, session),
      );
    } catch {
      try {
        socket.destroy();
      } catch {}
    }
  });
  // Release stale party membership after a tab/window closes, even if unload
  // requests were dropped. Keep credentials for at most 2 hours without a tab.
  const reap = httpServer
    ? null
    : setInterval(async () => {
        for (const [id, session] of sessions) {
          if (session.busy) continue;
          if (session.client.active && Date.now() - session.lastSeen > 120000) {
            session.busy = true;
            try {
              await stopScreen(session);
              await stopVoiceEngine(session);
              await session.client.leave();
            } catch {
              session.client.record('idle party cleanup', 'retry-pending');
            } finally {
              session.busy = false;
            }
          }
          if (
            !session.client.active &&
            !session.keepLogin &&
            Date.now() - session.lastSeen > 7200000
          ) {
            session.client.clear();
            clients.delete(session.client);
            sessions.delete(id);
          }
        }
      }, 30000).unref();
  return {
    server,
    async listen(requestedPort = 4317) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(requestedPort, '127.0.0.1', resolve);
      });
      port = server.address().port;
      return `http://127.0.0.1:${port}`;
    },
    async close() {
      clearInterval(reap);
      clearInterval(runtime.diagnosticMonitor);
      for (const session of sessions.values()) session.partyUpdates?.close();
      await Promise.allSettled([...sessions.values()].map((s) => stopScreen(s)));
      await Promise.allSettled([...sessions.values()].map((s) => stopVoiceEngine(s)));
      await Promise.allSettled(
        [...clients].map(async (c) => {
          try {
            await c.leave();
          } finally {
            c.clear();
          }
        }),
      );
      sessions.clear();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await diagnostics?.flush();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createApp();
  try {
    const url = await app.listen(Number(process.env.PARTYBRIDGE_PORT || 4317));
    console.log(
      `PartyBridge is ready: ${url}\nKeep this helper running while using the website. Tokens stay in memory.`,
    );
    console.log('Bridge creation is available when the party has no linked bridge.');
  } catch (error) {
    console.error(
      error.code === 'EADDRINUSE'
        ? 'Port 4317 is already in use. Close the other helper or set PARTYBRIDGE_PORT.'
        : 'Could not start PartyBridge.',
    );
    process.exitCode = 1;
  }
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => process.exit(0), 5000).unref();
    await app.close();
    clearTimeout(timer);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
