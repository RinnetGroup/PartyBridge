import { AppError } from './errors.js';

export function invalidatePartyList(session) {
  session.cachedList = null;
  session.partyListVersion = (session.partyListVersion ?? 0) + 1;
}

// List reads have their own cache/flight, independent of joining and voice setup.
export async function readPartyList(session) {
  const client = session.client,
    account = client.accountId,
    profile = client.profile;
  if (session.accountChanging)
    throw new AppError(409, 'BUSY', 'Wait for your account connection to finish.');
  if (!client.tokens)
    throw new AppError(401, 'NOT_CONNECTED', 'Connect your PlayStation account first.');
  if (
    session.cachedList &&
    session.cachedListAccount === account &&
    Date.now() - session.lastListAt < 10000
  )
    return session.cachedList;
  if (Date.now() < (session.partyListRetryAt ?? 0))
    throw new AppError(
      429,
      'PARTY_LIST_WAIT',
      'PlayStation is busy. Party updates will retry shortly.',
    );
  if (
    session.partyListPending &&
    session.partyListPending.account === account &&
    session.partyListPending.profile === profile
  )
    return session.partyListPending.promise;
  const version = session.partyListVersion ?? 0,
    flight = { account, profile };
  flight.promise = Promise.resolve()
    .then(() => client.parties())
    .then((result) => {
      if (
        !client.tokens ||
        client.accountId !== account ||
        client.profile !== profile ||
        session.accountChanging
      )
        throw new AppError(409, 'BUSY', 'Your account changed. Reload your parties.');
      if ((session.partyListVersion ?? 0) === version) {
        session.cachedList = result;
        session.cachedListAccount = account;
        session.lastListAt = Date.now();
      }
      return result;
    })
    .catch((error) => {
      if (error.status === 429 && client.accountId === account)
        session.partyListRetryAt = Date.now() + 30000;
      throw error;
    })
    .finally(() => {
      if (session.partyListPending === flight) session.partyListPending = null;
    });
  session.partyListPending = flight;
  return flight.promise;
}

// This socket carries invalidations only. It never starts/stops voice or joins a
// party. Share the already-authenticated Sony push connection with voice.
export function watchPartyUpdates(session, ws) {
  let feed = session.partyUpdates;
  if (!feed) {
    const sockets = new Set();
    let closed = false,
      connecting = false,
      lastConnect = -Infinity;
    const send = (socket) => {
      if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'parties-changed' }));
    };
    const notify = () => {
      invalidatePartyList(session);
      for (const socket of sockets) send(socket);
    };
    const ensurePush = () => {
      if (
        closed ||
        connecting ||
        session.accountChanging ||
        !session.client.tokens ||
        session.client.push?.state === 'authenticated' ||
        Date.now() - lastConnect < 30000
      )
        return;
      connecting = true;
      lastConnect = Date.now();
      Promise.resolve()
        .then(() => {
          if (!closed && session.client.tokens && !session.accountChanging)
            return session.client.push?.connect?.();
        })
        .catch(() =>
          session.client.record('party list push', 'unavailable; periodic refresh active'),
        )
        .finally(() => {
          connecting = false;
        });
    };
    const unsubscribe = session.client.push?.onPartyChanged?.(notify);
    const timer = setInterval(() => {
      if (!session.client.tokens) {
        feed.close();
        return;
      }
      ensurePush();
      for (const socket of sockets) {
        if (!socket.partyListAlive) {
          socket.terminate();
          continue;
        }
        socket.partyListAlive = false;
        if (socket.readyState === 1) socket.ping();
      }
    }, 15000).unref();
    feed = session.partyUpdates = {
      sockets,
      notify,
      ensurePush,
      close() {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        unsubscribe?.();
        if (session.partyUpdates === feed) session.partyUpdates = null;
        for (const socket of sockets) socket.close(1000);
        sockets.clear();
      },
    };
  }
  feed.sockets.add(ws);
  ws.partyListAlive = true;
  ws.on('pong', () => {
    ws.partyListAlive = true;
    session.lastSeen = Date.now();
  });
  ws.on('error', () => {});
  ws.on('close', () => {
    feed.sockets.delete(ws);
    if (!feed.sockets.size) feed.close();
  });
  invalidatePartyList(session);
  ws.send(JSON.stringify({ t: 'parties-changed' }));
  feed.ensurePush();
}
