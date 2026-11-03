import test from 'node:test';
import assert from 'node:assert/strict';
import { RTCPeerConnection, RTCRtpCodecParameters, RtpPacket, RtpHeader } from 'werift';
import { installSonyReceiveReuse } from '../server/sony-receivers.js';

function offer(version, first = 101, second = 201, extra = []) {
  const section = (mid, ssrc) =>
    [
      `m=audio ${ssrc === null ? 0 : 9} UDP/TLS/RTP/SAVPF 111`,
      'c=IN IP4 127.0.0.1',
      `a=mid:${mid}`,
      `a=${ssrc === null ? 'inactive' : 'sendonly'}`,
      'a=rtcp-mux',
      ...(ssrc === null
        ? []
        : [
            'a=rtpmap:111 opus/16000/2',
            `a=ssrc:${ssrc} cname:source-${mid}`,
            `a=msid:stream-${mid} track-${ssrc}`,
          ]),
      'a=ice-ufrag:localfixture',
      'a=ice-pwd:localfixturepassword123456789',
      'a=setup:actpass',
      'a=fingerprint:sha-256 ' + Array(32).fill('AA').join(':'),
    ].join('\r\n') + '\r\n';
  const sources = [first, second, ...extra];
  return {
    type: 'offer',
    sdp:
      [
        'v=0',
        `o=- 1 ${version} IN IP4 127.0.0.1`,
        's=-',
        't=0 0',
        'a=group:BUNDLE ' + sources.map((_, i) => i).join(' '),
        'a=msid-semantic: WMS *',
      ].join('\r\n') +
      '\r\n' +
      sources.map((source, i) => section(String(i), source)).join(''),
  };
}
function fixture(t, compatible) {
  const pc = new RTCPeerConnection({
    iceServers: [],
    codecs: {
      audio: [
        new RTCRtpCodecParameters({
          mimeType: 'audio/opus',
          clockRate: 16000,
          channels: 2,
          payloadType: 111,
        }),
      ],
    },
  });
  // Exercise real SDP/transceiver/packet routing without opening ICE sockets,
  // running STUN/DTLS, contacting PSN, or requiring a second live participant.
  pc.gatherCandidates = async () => {};
  pc.connect = async () => {};
  if (compatible) installSonyReceiveReuse(pc);
  t.after(() => pc.close());
  const received = [];
  pc.onTrack.subscribe((track) =>
    track.onReceiveRtp.subscribe((packet) => received.push(packet.header.ssrc)),
  );
  const negotiate = async (version, ssrc, other = 201, extra = []) => {
    await pc.setRemoteDescription(offer(version, ssrc, other, extra));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return answer.sdp.split(/(?=^m=)/m).filter((section) => section.startsWith('m=audio'));
  };
  const route = (ssrc) => {
    for (const receiver of pc.getReceivers()) receiver.runRtcp = async () => {};
    pc.router.routeRtp(
      new RtpPacket(
        new RtpHeader({ ssrc, sequenceNumber: 1, timestamp: 320, payloadType: 111 }),
        Buffer.from([1]),
      ),
    );
  };
  return { pc, received, negotiate, route };
}

test('installed werift reproduces permanent rejection when Sony reactivates the same audio MID', async (t) => {
  const f = fixture(t, false);
  await f.negotiate(1, 101);
  f.route(101);
  assert.deepEqual(f.received, [101]);
  await f.negotiate(2, null);
  const answer = await f.negotiate(3, 301);
  assert.ok(answer[0].startsWith('m=audio 0 '));
  assert.equal(f.pc.getTransceivers()[0].receiver.stopped, true);
  f.route(301);
  assert.deepEqual(f.received, [101]);
});

test('Sony rejoin compatibility replaces stopped receivers, routes the new SSRC, and preserves the other participant', async (t) => {
  const f = fixture(t, true);
  await f.negotiate(1, 101);
  f.route(101);
  f.route(201);
  const first = f.pc.getTransceivers()[0],
    healthy = f.pc.getTransceivers()[1];
  await f.negotiate(2, null);
  assert.equal(first.receiver.stopped, true);
  const answer = await f.negotiate(3, 301);
  assert.ok(!answer[0].startsWith('m=audio 0 '));
  assert.notEqual(f.pc.getTransceivers()[0], first);
  assert.equal(f.pc.getTransceivers()[0].receiver.stopped, false);
  assert.equal(f.pc.getTransceivers()[1], healthy);
  f.route(101);
  f.route(301);
  f.route(201);
  assert.deepEqual(f.received, [101, 201, 301, 201]);
  await f.negotiate(4, null);
  await f.negotiate(5, 401);
  f.route(401);
  assert.equal(f.received.at(-1), 401);
  assert.equal(f.pc.getTransceivers().length, 2);
});

test('both incoming sections recover when Sony briefly rejects all receive slots during participant churn', async (t) => {
  const f = fixture(t, true);
  await f.negotiate(1, 101, 201);
  await f.negotiate(2, null, null);
  assert.ok(f.pc.getTransceivers().every((t) => t.receiver.stopped));
  const answer = await f.negotiate(3, 301, 401);
  assert.ok(answer.every((section) => !section.startsWith('m=audio 0 ')));
  assert.ok(f.pc.getTransceivers().every((t) => !t.receiver.stopped));
  f.route(301);
  f.route(401);
  assert.deepEqual(f.received, [301, 401]);
});

test('eight real werift receive paths keep routing while one remote source leaves and rejoins', async (t) => {
  const f = fixture(t, true),
    sources = [101, 201, 301, 401, 501, 601, 701, 801];
  await f.negotiate(1, sources[0], sources[1], sources.slice(2));
  for (const ssrc of sources) f.route(ssrc);
  assert.deepEqual(f.received, sources);
  const healthy = f.pc.getTransceivers().filter((_, i) => i !== 4);
  await f.negotiate(2, 101, 201, [301, 401, null, 601, 701, 801]);
  f.route(501);
  assert.equal(f.received.length, 8);
  const answer = await f.negotiate(3, 101, 201, [301, 401, 901, 601, 701, 801]);
  assert.equal(answer.length, 8);
  assert.ok(answer.every((section) => !section.startsWith('m=audio 0 ')));
  assert.deepEqual(
    f.pc.getTransceivers().filter((_, i) => i !== 4),
    healthy,
  );
  f.route(901);
  for (const ssrc of sources.filter((s) => s !== 501)) f.route(ssrc);
  assert.equal(f.received.length, 16);
});
