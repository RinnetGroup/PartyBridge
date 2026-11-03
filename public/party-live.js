// Push invalidations refresh just the party list. Periodic reads recover missed
// notifications, while hidden/offline pages release the notification socket.
export function createPartyLiveUpdates({
  getContext,
  refresh,
  socketFactory = (url) => new WebSocket(url),
  socketUrl = () => {
    const url = new URL('/party-updates', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return url;
  },
  visible = () => !document.hidden,
  online = () => navigator.onLine !== false,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
} = {}) {
  let running = false,
    identity,
    socket,
    refreshTimer,
    reconnectTimer,
    inFlight = false,
    queued = false;
  let generation = 0,
    lastRefresh = -Infinity,
    retry = 1000,
    failures = 0;
  let refreshDue = Infinity;
  const eligible = () => getContext().connected && visible() && online();
  const schedule = (delay) => {
    clearTimer(refreshTimer);
    refreshDue = now() + delay;
    refreshTimer = setTimer(run, delay);
  };
  async function run() {
    refreshDue = Infinity;
    if (!running || !eligible()) return;
    if (inFlight) {
      queued = true;
      return;
    }
    if (getContext().busy) {
      schedule(1000);
      return;
    }
    inFlight = true;
    queued = false;
    const current = generation;
    lastRefresh = now();
    try {
      const result = await refresh({ quiet: true });
      if (current === generation) failures = result === false ? failures + 1 : 0;
    } catch {
      if (current === generation) failures++;
    } finally {
      if (current === generation && running) {
        inFlight = false;
        schedule(
          queued
            ? Math.max(0, 1000 - (now() - lastRefresh))
            : Math.min(60000, 15000 * 2 ** Math.min(failures, 2)),
        );
      }
    }
  }
  function request() {
    if (!running) return;
    if (inFlight) {
      queued = true;
      return;
    }
    const delay = Math.max(150, 1000 - (now() - lastRefresh));
    if (now() + delay < refreshDue) schedule(delay);
  }
  function connect() {
    if (!running || !eligible()) return;
    const url = socketUrl();
    url.searchParams.set('csrf', getContext().csrf);
    const current = generation;
    let candidate;
    try {
      candidate = socketFactory(String(url));
    } catch {
      reconnect();
      return;
    }
    socket = candidate;
    candidate.onopen = () => {
      if (generation === current) retry = 1000;
    };
    candidate.onmessage = (event) => {
      if (generation !== current) return;
      try {
        if (JSON.parse(event.data).t === 'parties-changed') request();
      } catch {}
    };
    candidate.onclose = () => {
      if (generation === current && running) {
        socket = null;
        reconnect();
      }
    };
    candidate.onerror = () => {
      try {
        candidate.close();
      } catch {}
    };
  }
  function reconnect() {
    clearTimer(reconnectTimer);
    if (!running) return;
    reconnectTimer = setTimer(connect, retry);
    retry = Math.min(30000, retry * 2);
  }
  function stop() {
    running = false;
    generation++;
    inFlight = false;
    queued = false;
    clearTimer(refreshTimer);
    clearTimer(reconnectTimer);
    const previous = socket;
    socket = null;
    if (previous) {
      previous.onclose = null;
      previous.onmessage = null;
      try {
        previous.close();
      } catch {}
    }
  }
  return {
    sync() {
      const nextIdentity = getContext().profile;
      if (!eligible()) {
        if (running) stop();
        return;
      }
      if (running && identity === nextIdentity) return;
      stop();
      running = true;
      identity = nextIdentity;
      retry = 1000;
      failures = 0;
      lastRefresh = -Infinity;
      schedule(0);
      connect();
    },
    request,
    stop,
  };
}
