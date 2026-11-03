// WebRTC Encoded Transform worker — two modes.
//
// RECEIVE (default): Sony's incoming Opus is clocked at 16 kHz; Chrome plays it
// ~3x fast and we can't re-clock in place (timestamp read-only). So we TAP each
// Opus payload and hand it to the page, which decodes it with WebCodecs and plays
// at real time. Frames are enqueued unchanged so Chrome's own (muted) pipeline
// keeps running.
//
// SEND-PROBE (options.mode === 'send-probe'): on the OUTGOING audio, report what
// the browser lets us do to packets before they're sent — whether the RTP
// timestamp is writable and what the payload looks like. This tells us whether a
// browser-side send fix (re-clock / re-encode to match Sony) is even possible.
// Frames pass through unchanged.

self.onrtctransform = (event) => {
  const transformer = event.transformer;
  const opts = transformer.options || {};

  if (opts.mode === 'send-probe') {
    let first = true;
    transformer.readable
      .pipeThrough(
        new TransformStream({
          transform(frame, controller) {
            if (first) {
              first = false;
              const before = frame.timestamp;
              let tsWritable = false;
              try {
                frame.timestamp = (before + 3) >>> 0;
                tsWritable = frame.timestamp !== before;
                frame.timestamp = before;
              } catch (e) {}
              let meta = null;
              try {
                meta = frame.getMetadata ? frame.getMetadata() : null;
              } catch (e) {}
              self.postMessage({
                kind: 'send-probe',
                tsWritable,
                before,
                dataLen: frame.data ? frame.data.byteLength : 0,
                metaKeys: meta ? Object.keys(meta) : [],
                metaRtpTimestamp: meta ? meta.rtpTimestamp : undefined,
                payloadType: meta ? meta.payloadType : undefined,
              });
            }
            controller.enqueue(frame);
          },
        }),
      )
      .pipeTo(transformer.writable)
      .catch(() => {});
    return;
  }

  // RECEIVE tap (default)
  let seq = 0;
  transformer.readable
    .pipeThrough(
      new TransformStream({
        transform(frame, controller) {
          try {
            const copy = frame.data.slice(0);
            self.postMessage({ payload: copy, ts: frame.timestamp >>> 0, seq: seq++ }, [copy]);
          } catch (e) {}
          controller.enqueue(frame);
        },
      }),
    )
    .pipeTo(transformer.writable)
    .catch(() => {});
};
