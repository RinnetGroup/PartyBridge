// Sony advertises trickle ICE without sending an end-of-candidates signal.
// Werift can keep waiting after every check has failed. Bound initial setup,
// retry an exhausted checklist once using the same socket/credentials, and
// leave established calls and party membership alone.
export function voiceTransportSnapshot(pc) {
  return (pc?.iceTransports ?? []).map((t) => {
    const c = t.connection;
    return {
      state: t.state,
      nominated: !!c?.nominated,
      remoteCandidates: c?.remoteCandidates?.length ?? 0,
      pairs: (c?.checkList ?? []).map((p) => ({
        state: p.state,
        requests: p.requestsSent ?? 0,
        responses: p.responsesReceived ?? 0,
        incoming: p.requestsReceived ?? 0,
        retransmissions: p.retransmissionsSent ?? 0,
      })),
    };
  });
}

export class VoiceConnectWatch {
  constructor(
    pc,
    {
      onRetry = () => {},
      onTimeout = () => {},
      now = () => performance.now(),
      schedule = setInterval,
      cancel = clearInterval,
      timeoutMs = 25000,
      retryAfterMs = 8000,
    } = {},
  ) {
    Object.assign(this, { pc, onRetry, onTimeout, now, cancel, timeoutMs, retryAfterMs });
    this.startedAt = now();
    this.retried = false;
    this.closed = false;
    this.timer = schedule(() => this.tick(), 250);
    this.timer?.unref?.();
  }
  tick() {
    if (this.closed) return;
    if (['connected', 'closed', 'failed'].includes(this.pc.connectionState)) {
      this.close();
      return;
    }
    const elapsed = this.now() - this.startedAt;
    if (elapsed >= this.timeoutMs) {
      const snapshot = voiceTransportSnapshot(this.pc);
      this.close();
      this.onTimeout(snapshot);
      return;
    }
    if (this.retried || elapsed < this.retryAfterMs) return;
    const transports = this.pc.iceTransports ?? [];
    // Do not race an in-progress check or renominate a successful pair.
    if (
      !transports.length ||
      transports.some(
        (t) =>
          t.state !== 'checking' ||
          !t.connection?.checkList?.length ||
          t.connection.nominated ||
          typeof t.connection.checkStart !== 'function' ||
          t.connection.checkList.some((p) => p.state !== 4),
      )
    )
      return;
    this.retried = true;
    for (const { connection: c } of transports) {
      for (const pair of c.checkList) {
        if (this.closed) break;
        try {
          const check = c.checkStart(pair);
          pair.handle = check;
          // checkStart resolves on protocol failure; guard unexpected rejections.
          check?.awaitable?.catch(() => {});
        } catch {}
      }
    }
    this.onRetry(voiceTransportSnapshot(this.pc));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.cancel(this.timer);
  }
}
