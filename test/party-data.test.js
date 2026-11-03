import test from 'node:test';
import assert from 'node:assert/strict';
import { PartyDataChannels, partyDataInitiator } from '../protocol/party-data.js';

const SELF = '11111111-1111-1111-1111-111111111111',
  ONE = '22222222-2222-2222-2222-222222222222',
  TWO = '33333333-3333-3333-3333-333333333333';
const member = (peerId = ONE, eligible = true, identity = 'Z-remote') => ({
  peerId,
  eligible,
  identity,
});
function channel(label, opened = false) {
  return {
    label,
    readyState: opened ? 'open' : 'connecting',
    sent: [],
    send(data) {
      this.sent.push(data);
    },
    close() {
      this.readyState = 'closed';
      this.onclose?.();
    },
    open() {
      this.readyState = 'open';
      this.onopen?.();
    },
    receive(data) {
      this.onmessage?.({ data });
    },
  };
}
function fixture(t, options = {}) {
  let now = 0,
    id = 0;
  const timers = new Map(),
    channels = [],
    logs = [];
  const data = new PartyDataChannels({
    pc: {
      createDataChannel(label, settings) {
        const ch = channel(label);
        ch.options = settings;
        channels.push(ch);
        return ch;
      },
    },
    peerId: SELF,
    self: { identity: 'A-local' },
    onDebug: (message) => logs.push(message),
    schedule: (fn, ms) => {
      const timer = ++id;
      timers.set(timer, { fn, at: now + ms });
      return timer;
    },
    cancel: (timer) => timers.delete(timer),
    ...options,
  });
  t.after(() => data.close());
  return {
    data,
    channels,
    logs,
    timers,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      now = end;
    },
    announce(peerId = ONE, sid = '6', options = { ordered: false, maxRetransmits: 0 }) {
      data.peerChannel({ type: 'dataChannelCreated', peerId, sid, channelNumber: 1, options });
    },
  };
}

test('channel 1 starts after participant control, pairs without hello, and remains ready beyond 180 seconds', (t) => {
  const f = fixture(t);
  f.data.update([member(ONE, false)]);
  assert.equal(f.channels.length, 0);
  f.data.update([member()]);
  const ch = f.channels[0];
  assert.equal(ch.label, `${ONE}_1`);
  assert.deepEqual(ch.options, { ordered: false, maxRetransmits: 0 });
  ch.open();
  assert.equal(f.data.snapshot()[0].ready, false);
  f.announce();
  assert.equal(f.data.snapshot()[0].ready, true);
  assert.equal(ch.sent.length, 0);
  ch.receive(new Uint8Array(12));
  assert.equal(f.data.snapshot()[0].bytesReceived, 12);
  assert.equal(f.data.snapshot()[0].framesReceived, 1);
  f.advance(240000);
  f.data.update([member()]);
  assert.equal(f.data.snapshot()[0].ready, true);
  assert.equal(f.channels.length, 1);
  assert.equal(f.timers.size, 0);
  assert.ok(f.logs.includes('Party data channel 1 paired and ready'));
});

test('channel 1 uses native case-sensitive ownership and waits for the remote initiator', (t) => {
  assert.equal(partyDataInitiator('a-local', 'Z-remote'), false);
  assert.equal(partyDataInitiator('Z-local', 'a-remote'), true);
  const f = fixture(t, { self: { identity: 'a-local' } });
  f.data.update([member()]);
  assert.equal(f.channels.length, 0);
  f.announce();
  assert.equal(f.channels.length, 1);
  f.channels[0].open();
  assert.equal(f.data.snapshot()[0].ready, true);
  assert.equal(f.channels[0].sent.length, 0);
});

test('early incoming channel 1 survives membership and control races without retaining message bodies', (t) => {
  const f = fixture(t),
    early = channel(`${ONE}_1`, true);
  f.data.incoming(early);
  early.receive(new Uint8Array(7));
  f.announce();
  f.data.update([member(ONE, false)]);
  assert.equal(f.data.pending.size, 1);
  f.data.update([member()]);
  assert.equal(f.data.pending.size, 0);
  assert.equal(f.data.peers.get(ONE).channel, early);
  assert.equal(f.channels.length, 0);
  assert.deepEqual([f.data.snapshot()[0].ready, f.data.snapshot()[0].bytesReceived], [true, 7]);
  assert.equal('frames' in f.data.peers.get(ONE), false);
  f.data.close();
  assert.equal(early.readyState, 'closed');
  assert.equal(f.timers.size, 0);
});

test('a stream replacement closes only that peer and ignores late callbacks and duplicate announcements', (t) => {
  const f = fixture(t);
  f.data.update([member(), member(TWO, true, 'Z-second')]);
  for (const id of [ONE, TWO]) {
    f.data.peers.get(id).channel.open();
    f.announce(id);
  }
  const first = f.data.peers.get(ONE).channel,
    healthy = f.data.peers.get(TWO).channel,
    oldClose = first.onclose;
  f.announce(ONE);
  assert.equal(f.data.peers.get(ONE).channel, first);
  f.announce(ONE, '8');
  const next = f.data.peers.get(ONE).channel;
  assert.notEqual(next, first);
  assert.equal(first.readyState, 'closed');
  next.open();
  oldClose();
  assert.equal(f.data.peers.get(ONE).channel, next);
  assert.equal(
    f.data.snapshot().every((p) => p.ready),
    true,
  );
  assert.equal(f.data.peers.get(TWO).channel, healthy);
});

test('control loss suspends channel 1, a rejoin recreates it, and departure cancels resources', (t) => {
  const f = fixture(t);
  f.data.update([member()]);
  f.channels[0].open();
  f.announce();
  const old = f.channels[0];
  f.data.update([member(ONE, false)]);
  assert.equal(old.readyState, 'closed');
  assert.equal(f.data.snapshot()[0].state, 'waiting-control');
  assert.equal(f.data.announcements.size, 0);
  f.data.update([member()]);
  const next = f.data.peers.get(ONE).channel;
  next.open();
  f.announce(ONE, '10');
  assert.equal(f.data.snapshot()[0].ready, true);
  f.data.update([]);
  assert.equal(next.readyState, 'closed');
  assert.equal(f.data.peers.size, 0);
  assert.equal(f.timers.size, 0);
});

test('channel 1 retries are bounded and a fresh announcement can recover the failed pair', (t) => {
  const f = fixture(t, { timeout: 1000, maxRetries: 1 });
  f.data.update([member()]);
  f.advance(3000);
  assert.equal(f.data.snapshot()[0].state, 'failed');
  assert.equal(f.channels.length, 2);
  f.announce(ONE, 'new');
  f.data.peers.get(ONE).channel.open();
  assert.equal(f.data.snapshot()[0].ready, true);
  assert.equal(f.timers.size, 0);
});

test('unknown streams expire, allocations are bounded, and a stopped session rejects new streams', (t) => {
  const f = fixture(t, { timeout: 1000 });
  const early = channel(`${ONE}_1`, true);
  f.data.incoming(early);
  f.advance(1000);
  assert.equal(early.readyState, 'closed');
  assert.equal(f.data.pending.size, 0);
  for (let i = 0; i < 65; i++) {
    const id = `${(i + 16).toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`;
    const ch = channel(`${id}_1`, true);
    f.data.incoming(ch);
    if (i === 64) assert.equal(ch.readyState, 'closed');
  }
  assert.equal(f.data.pending.size, 64);
  f.data.close();
  assert.equal(f.timers.size, 0);
  const late = channel(`${TWO}_1`, true);
  f.data.incoming(late);
  assert.equal(late.readyState, 'closed');
});
