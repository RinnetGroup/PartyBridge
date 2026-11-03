// Protocol pongs are handled by the browser even when page timers are delayed.
// They are better evidence of a live call tab than its HTTP heartbeat alone.
export class VoiceSocketHeartbeat {
  constructor(
    socket,
    session,
    {
      now = () => Date.now(),
      schedule = setInterval,
      cancel = clearInterval,
      interval = 25000,
      timeout = 75000,
    } = {},
  ) {
    Object.assign(this, { socket, session, now, cancel, timeout });
    this.closed = false;
    this.lastReply = now();
    this.activity = () => {
      if (!this.closed && session.voiceSocket === socket) this.lastReply = session.lastSeen = now();
    };
    socket.on('pong', this.activity);
    socket.on('message', this.activity);
    this.activity();
    socket.once('close', () => this.close());
    this.timer = schedule(() => this.tick(), interval);
    this.timer?.unref?.();
  }
  tick() {
    if (this.closed) return;
    if (this.session.voiceSocket !== this.socket || this.socket.readyState !== 1) {
      this.close();
      return;
    }
    if (this.now() - this.lastReply >= this.timeout) {
      this.session.client.record('voice socket heartbeat', 'timed out');
      this.close();
      this.socket.terminate();
      return;
    }
    try {
      this.socket.ping();
    } catch {
      this.close();
      this.socket.terminate();
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.cancel(this.timer);
    this.socket.off('pong', this.activity);
    this.socket.off('message', this.activity);
  }
}
