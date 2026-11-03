# Architecture

The Electron main process owns desktop windows, the tray, saved login and the lifetime of one private Node helper. The renderer is sandboxed, has no Node integration and uses a narrow isolated preload. Sony sign-in has a separate, temporary browser session.

The helper binds HTTP and WebSockets to loopback. Host, Origin, session-cookie and CSRF checks protect local routes. The desktop process transfers saved credentials to its helper over private process IPC, not through the renderer or HTTP bootstrap response.

`PsnClient` in `server/psn.js` owns Sony authentication, party membership, RTC allocation and cleanup. `server/push.js` supplies authenticated party-change events. `server/party-updates.js` shares party discovery and push notifications without serializing them behind voice actions.

`server/voice-engine.js` owns the WebRTC transport and Opus audio. The renderer captures microphone PCM and plays incoming mixed PCM over a local WebSocket. Incoming RTP sources have separate decoder and leveling state before a clocked mix. Queued offer/answer transactions prevent overlapping negotiations. Stopped receiver replacement handles Sony reactivating an audio media section after a participant returns.

`protocol/` implements bridge configuration, participant control, user tables, media routing and the participant data channel. Transport connection alone is not proof that participant signaling and audio have completed. The interface reports those stages separately.

The initial voice transport has a bounded retry and deadline. Sony REST preparation happens before that stage and has its own request/retry limits. An unavailable bridge is surfaced as an API error rather than deleting or replacing a shared party bridge.

PS5 screen viewing uses a separate connection through `server/screen-share.js` and `public/screen-share.js`. Closing the viewer does not close party voice. PC capture preview is local; publisher authorization and PC-to-party screen broadcasting are not implemented.

The older browser voice adapter remains for compatibility and offline lifecycle tests. The current desktop interface uses the Node voice engine. Preserve Sony's negotiated 16 kHz media format on that path rather than rewriting it to a browser codec clock.

The pinned werift ESM bundle receives three reproducible compatibility changes: registration and serialization of `GOOG-NETWORK-INFO`, and selection of the SCTP client/server role from the DTLS role. `test/werift-compat.test.js` checks the authenticated STUN packet and the role mismatch case without contacting Sony.

Diagnostic events omit credentials, raw SDP, microphone recordings and full request/response bodies. New diagnostics should record stage names, codes, timings and counters rather than secrets or payloads.
