import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalScreenCapture } from '../public/screen-capture.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
function stream({ audio = true, video = true } = {}) {
  const track = (kind) => ({
    kind,
    readyState: 'live',
    stops: 0,
    getSettings: () => ({ width: 1280, height: 720, frameRate: 30, displaySurface: 'window' }),
    stop() {
      this.stops++;
      this.readyState = 'ended';
      this.onended?.();
    },
  });
  const tracks = [...(video ? [track('video')] : []), ...(audio ? [track('audio')] : [])];
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
  };
}
function fixture(getDisplayMedia) {
  const states = [],
    video = { srcObject: null, muted: false, play: async () => {}, pause() {} };
  const capture = new LocalScreenCapture({
    video,
    getDisplayMedia,
    onState: (state, detail) => states.push({ state, detail }),
  });
  return { video, capture, states };
}

test('local capture uses an explicit screen picker, muted preview and optional source audio without a transport', async () => {
  const media = stream(),
    requests = [],
    f = fixture(async (options) => {
      requests.push(options);
      return media;
    });
  await f.capture.start({ audio: true });
  assert.equal(requests[0].audio, true);
  assert.equal(requests[0].video.frameRate.max, 30);
  assert.equal(f.video.srcObject, media);
  assert.equal(f.video.muted, true);
  assert.equal(f.states.at(-1).state, 'previewing');
  assert.equal(f.states.at(-1).detail.localOnly, true);
  assert.equal(f.states.at(-1).detail.displaySurface, 'window');
  f.capture.stop();
  assert.equal(f.video.srcObject, null);
  assert.ok(media.getTracks().every((t) => t.stops === 1));
});

test('permission denial leaves no active capture and gives a clear cancelled state', async () => {
  const f = fixture(async () => {
    const error = new Error('denied');
    error.name = 'NotAllowedError';
    throw error;
  });
  await f.capture.start();
  assert.equal(f.states.at(-1).state, 'cancelled');
  assert.equal(f.video.srcObject, null);
  assert.equal(f.capture.stream, null);
});

test('stopping while the picker is pending releases every track in its late result', async () => {
  const pending = deferred(),
    media = stream(),
    f = fixture(() => pending.promise);
  const opening = f.capture.start();
  f.capture.stop();
  pending.resolve(media);
  await opening;
  assert.ok(media.getTracks().every((t) => t.stops === 1));
  assert.equal(f.video.srcObject, null);
  assert.equal(f.states.at(-1).state, 'stopped');
  assert.equal(
    f.states.some((s) => s.state === 'previewing'),
    false,
  );
});

test('a stale picker cannot replace or stop the latest selected screen', async () => {
  const pending = deferred(),
    old = stream(),
    current = stream();
  let calls = 0;
  const f = fixture(() => (++calls === 1 ? pending.promise : Promise.resolve(current)));
  const first = f.capture.start();
  await f.capture.start();
  pending.resolve(old);
  await first;
  assert.equal(f.video.srcObject, current);
  assert.ok(old.getTracks().every((t) => t.stops === 1));
  assert.ok(current.getTracks().every((t) => t.stops === 0));
  f.capture.stop();
});

test('the browser Stop sharing action releases both video and source audio', async () => {
  const media = stream(),
    f = fixture(async () => media);
  await f.capture.start();
  media.getVideoTracks()[0].onended();
  assert.equal(f.capture.stream, null);
  assert.equal(f.video.srcObject, null);
  assert.equal(f.states.at(-1).state, 'stopped');
  f.capture.stop();
  assert.ok(media.getTracks().every((t) => t.stops === 1));
});

test('an unusable source cleans up its tracks instead of leaving audio capture running', async () => {
  const media = stream({ video: false }),
    f = fixture(async () => media);
  await f.capture.start();
  assert.equal(f.states.at(-1).state, 'error');
  assert.ok(media.getTracks().every((t) => t.stops === 1));
  assert.equal(f.capture.stream, null);
});
