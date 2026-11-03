import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceConnectWatch, voiceTransportSnapshot } from '../server/voice-connect.js';
import { voiceSummaryLabel } from '../public/voice-status.js';

function fixture() {
  let now = 0,
    retries = 0,
    timeouts = [],
    cancelled = 0;
  const pairs = [0, 1].map(() => ({ state: 4, requestsSent: 1, responsesReceived: 0 }));
  const connection = {
    checkList: pairs,
    remoteCandidates: [{}],
    checkStart(pair) {
      retries++;
      pair.state = 2;
      return { awaitable: Promise.resolve() };
    },
  };
  const pc = { connectionState: 'connecting', iceTransports: [{ state: 'checking', connection }] };
  const watch = new VoiceConnectWatch(pc, {
    now: () => now,
    schedule: () => 1,
    cancel: () => cancelled++,
    onTimeout: (s) => timeouts.push(s),
  });
  return {
    pc,
    connection,
    pairs,
    watch,
    timeouts,
    get retries() {
      return retries;
    },
    get cancelled() {
      return cancelled;
    },
    at(t) {
      now = t;
      watch.tick();
    },
  };
}
test('exhausted trickle checks retry once, then finish instead of waiting indefinitely', () => {
  const f = fixture();
  f.at(7999);
  assert.equal(f.retries, 0);
  f.at(8000);
  assert.equal(f.retries, 2);
  for (const pair of f.pairs) pair.state = 4;
  f.at(16000);
  assert.equal(f.retries, 2);
  f.at(25000);
  assert.equal(f.timeouts.length, 1);
  assert.equal(f.cancelled, 1);
  f.at(60000);
  assert.equal(f.timeouts.length, 1);
});
test('ongoing checks, nominated ICE and established calls are never restarted', () => {
  const f = fixture();
  f.pairs[0].state = 2;
  f.at(8000);
  assert.equal(f.retries, 0);
  f.pairs[0].state = 4;
  f.connection.nominated = {};
  f.at(9000);
  assert.equal(f.retries, 0);
  f.pc.connectionState = 'connected';
  f.at(10000);
  f.at(60000);
  assert.equal(f.timeouts.length, 0);
  assert.equal(f.cancelled, 1);
});
test('leaving cancels startup monitoring and diagnostics omit credentials and addresses', () => {
  const f = fixture();
  f.connection.remotePassword = 'secret';
  f.pairs[0].remoteAddr = ['203.0.113.20', 50000];
  f.watch.close();
  f.at(60000);
  assert.equal(f.retries, 0);
  assert.equal(f.timeouts.length, 0);
  const serialized = JSON.stringify(voiceTransportSnapshot(f.pc));
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('203.0.113.20'), false);
});
test('the summary reports voice readiness consistently during roster refreshes and mute changes', () => {
  const state = { connected: true, inCall: true, muted: false, voiceStatus: 'connecting' };
  assert.equal(voiceSummaryLabel(state), 'Connecting');
  state.muted = true;
  assert.equal(voiceSummaryLabel(state), 'Connecting');
  state.voiceStatus = 'ready';
  assert.equal(voiceSummaryLabel(state), 'Muted');
  state.muted = false;
  assert.equal(voiceSummaryLabel(state), 'In party');
  state.inCall = false;
  assert.equal(voiceSummaryLabel(state), 'Ready');
  state.connected = false;
  assert.equal(voiceSummaryLabel(state), 'Offline');
});
