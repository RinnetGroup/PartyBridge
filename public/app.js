// PartyBridge control UI. The browser owns local audio I/O (mic capture +
// speaker playout, both device-selectable) and shows party/people/call state.
// All PlayStation party voice runs in the Node helper (16 kHz opus via werift);
// raw 16 kHz mono PCM streams both ways over a WebSocket. See server/voice-engine.js.

import { partyMembers } from './party-state.js';
import { initScreenSharing } from './screen-share.js';
import { MicFrameGate } from './mic-frame.js';
import { initAppHub } from './hub.js';
import { bootstrapSession } from './session.js';
import { initPartyCreation } from './start-party.js';
import { initParticipantDetails } from './participant-details.js';
import { createPartyLiveUpdates } from './party-live.js';
import { svgIcon, updateVoiceMeter } from './ui-elements.js';
import { PartyNotifications } from './party-notifications.js';
import { voiceSummaryLabel } from './voice-status.js';

const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
// Show an account's profile picture (proxied same-origin) over an initial that
// stays if there is no picture or it fails to load.
function setAvatar(span, name, accountId) {
  span.textContent = (name || '?').slice(0, 1).toUpperCase();
  const old = span.querySelector('img');
  if (old) old.remove();
  span.classList.remove('has-img');
  if (!accountId) return;
  const img = document.createElement('img');
  img.className = 'avatar-img';
  img.alt = '';
  img.onload = () => {
    span.textContent = '';
    span.classList.add('has-img');
    span.append(img);
  };
  img.src = `/api/avatar/${accountId}`;
}
const state = {
  csrf: '',
  connected: false,
  profile: null,
  busy: false,
  parties: [],
  partyStatus: 'idle',
  active: null,
  inCall: false,
  muted: false,
  micId: '',
  speakerId: '',
  ctx: null,
  micStream: null,
  micNode: null,
  playNode: null,
  micAnalyser: null,
  partyAnalyser: null,
  raf: 0,
  ws: null,
  preview: null,
  micGate: null,
  lastMicAt: 0,
  callMembers: [],
  voicePeers: [],
  voiceSummary: null,
  voiceStatus: 'connecting',
};
let screenSharing;
let appHub;
let participantDetails;
let partyLive;
let partiesRequest;
const partyNotifications = new PartyNotifications();

function browserLog(event, details = {}) {
  if (!state.csrf) return;
  fetch('/api/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PartyBridge-CSRF': state.csrf },
    body: JSON.stringify({
      event,
      details: { ...details, inCall: state.inCall, muted: state.muted },
    }),
    keepalive: true,
  }).catch(() => {});
}
document.addEventListener?.(
  'click',
  (event) => {
    const control = event.target.closest?.('button');
    if (control?.id) browserLog('ui.click', { control: control.id });
  },
  true,
);
document.addEventListener?.('change', (event) => {
  if (['mic-select', 'speaker-select'].includes(event.target.id))
    browserLog('ui.device-change', { control: event.target.id });
});
document.addEventListener?.('visibilitychange', () =>
  browserLog('page.visibility', { visibility: document.visibilityState }),
);
window.addEventListener('pagehide', () => browserLog('page.hide'));
window.addEventListener('online', () => browserLog('network.online'));
window.addEventListener('offline', () => browserLog('network.offline'));
window.addEventListener('error', (event) =>
  browserLog('browser.error', {
    message: String(event.message).slice(0, 300),
    line: event.lineno,
    column: event.colno,
  }),
);
window.addEventListener('unhandledrejection', (event) =>
  browserLog('browser.rejection', {
    name: event.reason?.name,
    message: String(event.reason?.message ?? 'Unhandled browser error').slice(0, 300),
  }),
);

let toastTimer = 0;
function toast(text, kind = '') {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.hidden = !text;
  clearTimeout(toastTimer);
  if (text)
    toastTimer = setTimeout(() => {
      t.hidden = true;
    }, 6000);
}

async function api(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'X-PartyBridge-CSRF': state.csrf,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(90000),
    });
  } catch {
    throw new Error(
      'The local helper did not respond. Keep its terminal open, then reload this page.',
    );
  }
  const data = await response.json();
  if (!response.ok) {
    const e = new Error(data.error?.message ?? 'The request failed.');
    e.code = data.error?.code;
    if (e.code === 'SONY_SESSION_EXPIRED') {
      participantDetails?.close();
      if (state.inCall) endCall();
      state.connected = false;
      state.profile = null;
      state.active = null;
      state.parties = [];
      renderAccount();
      renderParties();
    }
    throw e;
  }
  return data;
}

/* ---------- Devices ---------- */
const canSetSink = () =>
  typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
const rms = (bytes) => {
  let s = 0;
  for (const b of bytes) {
    const v = (b - 128) / 128;
    s += v * v;
  }
  return Math.sqrt(s / bytes.length);
};

function fillSelect(sel, devices, fallback) {
  const val = sel.value;
  sel.replaceChildren(new Option('System default', ''));
  for (const d of devices)
    if (d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      sel.add(new Option(d.label || fallback, d.deviceId));
  if ([...sel.options].some((o) => o.value === val)) sel.value = val;
}
async function enumerate() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  fillSelect(
    $('mic-select'),
    devices.filter((d) => d.kind === 'audioinput'),
    'Microphone',
  );
  const spk = $('speaker-select');
  if (!canSetSink()) {
    spk.disabled = true;
    $('audio-note').textContent = 'Output uses the system default device.';
  } else {
    fillSelect(
      spk,
      devices.filter((d) => d.kind === 'audiooutput'),
      'Speakers',
    );
  }
}

/* ---------- Mic preview (audio setup) ---------- */
async function togglePreview() {
  if (state.preview) return stopPreview();
  if (state.inCall) {
    try {
      await state.ctx?.resume();
      toast('Audio resumed.');
    } catch {
      toast('Audio could not resume. Rejoin voice to reopen it.', 'error');
    }
    return;
  }
  try {
    const deviceId = $('mic-select').value;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const data = new Uint8Array(an.fftSize);
    state.preview = { stream, ctx, raf: 0 };
    await enumerate();
    $('enable-audio').textContent = 'Stop';
    const draw = () => {
      an.getByteTimeDomainData(data);
      const level = rms(data);
      $('mic-meter').style.width = Math.min(100, level * 280) + '%';
      updateVoiceMeter($('input-voice-meter'), level);
      state.preview.raf = requestAnimationFrame(draw);
    };
    draw();
  } catch (e) {
    toast(
      e.name === 'NotAllowedError'
        ? 'Microphone access was denied. Allow it in your browser, then try again.'
        : 'Could not open the microphone.',
      'error',
    );
  }
}
function stopPreview() {
  if (!state.preview) return;
  cancelAnimationFrame(state.preview.raf);
  state.preview.stream.getTracks().forEach((t) => t.stop());
  state.preview.ctx.close();
  state.preview = null;
  $('enable-audio').textContent = 'Enable';
  $('mic-meter').style.width = '0%';
  updateVoiceMeter($('input-voice-meter'), 0);
}

/* ---------- Rendering ---------- */
function renderAccount() {
  appHub?.accountChanged();
  partyLive?.sync();
  $('account-name').textContent = state.connected
    ? state.profile?.onlineId || 'PlayStation player'
    : 'Connect account';
  setAvatar(
    $('account-avatar'),
    state.connected ? state.profile?.onlineId || 'P' : '?',
    state.connected ? state.profile?.accountId : null,
  );
  $('welcome').hidden = state.connected;
  if (!state.connected) partyNotifications.reset();
  $('account-chip').title = state.connected ? 'Sign out' : 'Sign in';
  $('refresh-parties').disabled = !state.connected || state.busy;
  $('start-party').disabled = !state.connected || state.busy || !!state.active;
  $('parties-caption').textContent = state.connected
    ? 'Open and joinable parties'
    : 'Sign in to see parties';
}

function renderParties() {
  const people = new Set(
    state.parties.flatMap((p) => p.members.map((m) => m.accountId || m.onlineId)),
  );
  $('lounge-party-count').textContent = state.parties.length;
  $('lounge-people-count').textContent = people.size;
  $('lounge-voice-status').textContent = voiceSummaryLabel(state);
  const grid = $('party-grid');
  grid.replaceChildren();
  const empty = $('party-empty');
  empty.hidden = state.parties.length > 0;
  if (!state.parties.length) {
    const h = empty.querySelector('h3'),
      p = empty.querySelector('p');
    if (!state.connected) {
      h.textContent = 'No parties';
      p.textContent = 'Connect your account to see your parties.';
    } else if (state.partyStatus === 'loading') {
      h.textContent = 'Loading';
      p.textContent = 'Checking your parties and invitations.';
    } else if (state.partyStatus === 'error') {
      h.textContent = 'Could not load parties';
      p.textContent = 'The account is connected, but the party request failed.';
    } else {
      h.textContent = 'No available parties';
      p.textContent = 'New parties and invitations will appear here automatically.';
    }
  }
  for (const party of state.parties) {
    const card = el('article', null, 'party-card' + (state.active === party.id ? ' active' : ''));
    const top = el('div', null, 'party-card-top'),
      glyph = el('span', null, 'party-card-glyph');
    glyph.innerHTML = svgIcon('party');
    top.append(
      glyph,
      el(
        'span',
        state.active === party.id ? 'Joined' : party.joinable ? 'Open' : 'Invite only',
        'party-card-tag',
      ),
    );
    card.append(top);
    card.append(
      el('h3', party.name),
      el('div', party.owner ? 'Hosted by ' + party.owner : 'PlayStation party', 'host'),
    );
    const members = el('div', null, 'members');
    for (const m of party.members.slice(0, 6)) {
      const button = el('button', null, 'member member-profile');
      button.type = 'button';
      button.setAttribute('aria-label', `View ${m.onlineId || 'player'}'s party details`);
      const avatar = el('span', null, 'avatar member-avatar');
      setAvatar(avatar, m.onlineId, m.accountId);
      button.append(avatar, el('span', m.onlineId + (m.screenShare ? ' · sharing' : '')));
      button.onclick = () =>
        participantDetails?.open({
          partyId: party.id,
          accountId: m.accountId,
          platform: m.platform,
          username: m.onlineId,
        });
      members.append(button);
    }
    if (party.members.length) card.append(members);
    const meta = el('div', null, 'party-meta');
    meta.append(
      el('span', `${party.members.length} / ${party.maxMembers}`),
      el('span', party.visibility),
    );
    card.append(meta);
    const btn = document.createElement('button');
    if (state.active === party.id) {
      if (state.inCall) {
        btn.className = 'quiet';
        btn.textContent = 'In this party';
        btn.disabled = true;
      } else {
        btn.className = 'primary';
        btn.textContent = 'Rejoin';
        btn.onclick = () => guard(() => startCall(party));
      }
    } else {
      btn.className = 'primary';
      btn.textContent = party.joinable ? 'Join' : 'Invite only';
      btn.disabled = !party.joinable || !!state.active || state.busy;
      btn.onclick = () => guard(() => joinAndCall(party));
    }
    card.append(btn);
    if (state.active === party.id && !state.inCall) {
      const leave = el('button', 'Leave party', 'quiet');
      leave.disabled = state.busy;
      leave.onclick = () => guard(leaveCall);
      card.append(leave);
    }
    grid.append(card);
  }
  renderPeople();
}

function renderPeople() {
  const grid = $('people-grid');
  grid.replaceChildren();
  const me = (state.profile?.onlineId || '').toLowerCase();
  const seen = new Set();
  const people = [];
  for (const p of state.parties)
    for (const m of p.members) {
      const key = (m.onlineId || m.accountId || '').toLowerCase();
      if (!key || key === me || seen.has(key)) continue;
      seen.add(key);
      people.push({
        name: m.onlineId || 'Player',
        where: p.name,
        accountId: m.accountId,
        partyId: p.id,
        platform: m.platform,
      });
    }
  $('people-empty').hidden = people.length > 0;
  for (const person of people.slice(0, 40)) {
    const row = el('div', null, 'person');
    const av = el('button', null, 'avatar profile-avatar');
    av.type = 'button';
    av.setAttribute('aria-label', `View ${person.name}'s party details`);
    setAvatar(av, person.name, person.accountId);
    row.append(av);
    av.onclick = () =>
      participantDetails?.open({
        partyId: person.partyId,
        accountId: person.accountId,
        platform: person.platform,
        username: person.name,
      });
    const col = document.createElement('div');
    col.append(el('div', person.name, 'pname'), el('div', 'in ' + person.where, 'pwhere'));
    row.append(col);
    grid.append(row);
  }
}

async function refreshParties({ quiet = false } = {}) {
  if (!state.connected) return false;
  const profile = state.profile;
  if (partiesRequest?.profile === profile) return partiesRequest.promise;
  if (!quiet) {
    state.partyStatus = 'loading';
    renderParties();
  }
  const request = { profile };
  request.promise = (async () => {
    try {
      const result = await api('/api/parties');
      if (!state.connected || state.profile !== profile) return false;
      if (quiet && state.busy) return false;
      const notification = partyNotifications.observe(result.parties, {
        accountId: profile?.accountId,
        onlineId: profile?.onlineId,
        activeParty: state.active,
      });
      const changed =
        JSON.stringify(state.parties) !== JSON.stringify(result.parties) ||
        state.partyStatus !== 'loaded';
      state.parties = result.parties;
      state.partyStatus = 'loaded';
      if (!quiet && (result.invitationWarning || result.friendsWarning || result.groupsWarning))
        toast('Some party sources could not be checked. The list may be incomplete.');
      if (changed) renderParties();
      if (notification) toast(notification);
      return true;
    } catch (e) {
      if (!quiet && state.connected && state.profile === profile) {
        state.partyStatus = 'error';
        toast(e.message, 'error');
        renderParties();
      }
      return false;
    } finally {
      if (partiesRequest === request) partiesRequest = null;
    }
  })();
  partiesRequest = request;
  return request.promise;
}

/* ---------- Guarded actions ---------- */
async function guard(task) {
  if (state.busy) return;
  state.busy = true;
  renderAccount();
  renderParties();
  try {
    await task();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.busy = false;
    renderAccount();
    renderParties();
  }
}

/* ---------- Join + voice ---------- */
async function joinAndCall(party) {
  if (!state.connected) return openConnect();
  stopPreview();
  await api('/api/party/join', { id: party.id });
  state.active = party.id;
  void screenSharing?.refresh();
  await startCall(party);
  toast(`Joined ${party.name}.`, 'success');
}

async function startCall(party) {
  stopPreview();
  showCall(party, 'connecting');
  try {
    await setupAudio();
    await openSocket(party.id);
    state.inCall = true;
    setCallStatus(state.voiceStatus);
    startMeters();
  } catch (e) {
    endCall();
    throw new Error('Voice could not start: ' + e.message);
  }
}

async function setupAudio() {
  const ctx = (state.ctx = new AudioContext({ sampleRate: 16000 }));
  await Promise.all([
    ctx.audioWorklet.addModule('/mic-worklet.js'),
    ctx.audioWorklet.addModule('/playout-worklet.js'),
  ]);

  // Playout: party PCM -> jitter buffer -> analyser (talking meter) -> output.
  const playNode = (state.playNode = new AudioWorkletNode(ctx, 'pcm-playout', {
    numberOfInputs: 0,
    outputChannelCount: [1],
  }));
  const partyAn = (state.partyAnalyser = ctx.createAnalyser());
  partyAn.fftSize = 512;
  playNode.connect(partyAn);
  partyAn.connect(ctx.destination);
  if (canSetSink() && state.speakerId) {
    try {
      await ctx.setSinkId(state.speakerId);
    } catch {}
  }

  // Mic: device -> analyser (self meter) + capture worklet -> WS (via onmessage).
  const deviceId = $('mic-select').value;
  state.micId = deviceId;
  const stream = (state.micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  }));
  const src = ctx.createMediaStreamSource(stream);
  const micAn = (state.micAnalyser = ctx.createAnalyser());
  micAn.fftSize = 512;
  src.connect(micAn);
  const micNode = (state.micNode = new AudioWorkletNode(ctx, 'mic-capture', {
    numberOfInputs: 1,
    outputChannelCount: [1],
  }));
  src.connect(micNode);
  // A worklet is only pulled if it reaches the destination; route it through a muted gain.
  const zero = ctx.createGain();
  zero.gain.value = 0;
  micNode.connect(zero);
  zero.connect(ctx.destination);
  state.micGate = new MicFrameGate();
  micNode.port.onmessage = (e) => {
    state.lastMicAt = performance.now();
    if (!state.ws || state.ws.readyState !== 1 || state.muted) return;
    const frame = state.micGate.take(e.data, ctx.currentTime, state.ws.bufferedAmount);
    if (frame) state.ws.send(frame);
  };
  ctx.onstatechange = () => {
    if (state.ctx !== ctx || !state.inCall) return;
    reportAudioStatus();
    if (ctx.state === 'suspended' || ctx.state === 'interrupted')
      ctx.resume().catch(() => toast('Audio paused. Click Enable to resume it.', 'error'));
  };
  stream.getAudioTracks()[0]?.addEventListener('ended', () => {
    if (state.inCall && state.micStream === stream) {
      reportAudioStatus();
      toast('The microphone disconnected. Rejoin voice to reopen it.', 'error');
    }
  });
  micNode.port.postMessage({ muted: state.muted });
  await ctx.resume();
}

function openSocket(partyId) {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = (state.ws = new WebSocket(
      `${proto}://${location.host}/ws?csrf=${encodeURIComponent(state.csrf)}`,
    ));
    ws.binaryType = 'arraybuffer';
    let opened = false;
    ws.onopen = () => {
      opened = true;
      ws.send(JSON.stringify({ t: 'start', partyId }));
      resolve();
    };
    ws.onmessage = (ev) => {
      if (state.ws !== ws) return;
      if (typeof ev.data !== 'string') {
        try {
          state.playNode?.port.postMessage(ev.data, [ev.data]);
        } catch {}
        return;
      }
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      handleVoiceMsg(m);
    };
    ws.onerror = () => {
      if (!opened) reject(new Error('the voice channel failed to open'));
    };
    ws.onclose = () => {
      if (state.inCall) endCall('The voice connection closed.');
    };
  });
}

function reportAudioStatus() {
  if (!state.inCall || state.ws?.readyState !== 1) return;
  state.ws.send(
    JSON.stringify({
      t: 'audio-status',
      context: state.ctx?.state,
      track: state.micStream?.getAudioTracks()[0]?.readyState,
      capture: !state.muted && performance.now() - state.lastMicAt > 3000 ? 'stalled' : 'flowing',
      dropped: (state.micGate?.stale ?? 0) + (state.micGate?.congested ?? 0),
    }),
  );
}
setInterval(reportAudioStatus, 5000);

function handleVoiceMsg(m) {
  if (m.t === 'state') {
    if (m.summary) state.voiceSummary = m.summary;
    setCallStatus(m.state);
    if (m.state === 'failed')
      endCall(
        m.summary?.failureReason || 'The voice connection failed. Leave and rejoin to reconnect.',
      );
  } else if (m.t === 'participants') {
    if (Array.isArray(m.members)) {
      const changed = JSON.stringify(state.callMembers) !== JSON.stringify(m.members);
      state.callMembers = m.members;
      const active = state.parties.find((p) => p.id === state.active);
      if (active) active.members = m.members;
      if (changed) renderParties();
    }
    state.voicePeers = Array.isArray(m.peers) ? m.peers : [];
    if (m.summary) state.voiceSummary = m.summary;
    renderCallMembers();
    setCallStatus(state.voiceStatus);
  } else if (m.t === 'error') {
    endCall(m.message);
  }
  // Local audio analysers supply the meters. Peer readiness comes from signaling.
}

function setCallStatus(status) {
  state.voiceStatus = status;
  $('lounge-voice-status').textContent = voiceSummaryLabel(state);
  const dot = $('call-dot');
  const label = $('call-status');
  const summary = state.voiceSummary;
  dot.className =
    'call-status-dot ' +
    (['connected', 'ready'].includes(status)
      ? 'connected'
      : status === 'failed'
        ? 'failed'
        : 'connecting');
  label.textContent =
    status === 'connected'
      ? 'Voice ready · audio received'
      : status === 'ready'
        ? 'Voice ready · waiting for audio'
        : status === 'negotiating'
          ? 'Updating voice connection'
          : status === 'partial'
            ? `${summary?.ready ?? 0} of ${summary?.total ?? '?'} voice participants ready`
            : status === 'waiting'
              ? 'Waiting for the party'
              : status === 'preparing'
                ? 'Preparing'
                : status === 'connecting'
                  ? 'Connecting'
                  : status === 'failed'
                    ? 'Connection failed'
                    : status === 'stopped'
                      ? 'Stopped'
                      : 'Connecting';
}

function tile(name, isSelf, accountId) {
  const t = el('div', null, 'tile' + (isSelf ? ' self' : ''));
  t.dataset.memberKey = isSelf ? 'self' : accountId || name;
  if (isSelf) t.id = 'self-tile';
  const ring = el('button', null, 'ring');
  ring.type = 'button';
  ring.setAttribute('aria-label', `View ${name}'s party details`);
  ring.onclick = () =>
    participantDetails?.open({
      partyId: state.active,
      memberKey: t.dataset.memberKey,
      accountId,
      username: name,
      isSelf,
    });
  const av = el('span', null, 'av');
  setAvatar(av, name, accountId);
  ring.append(av);
  t.append(ring, el('div', name, 'label'), el('div', '', 'voice-status'));
  t.title = name;
  return t;
}
function renderCallMembers() {
  const wrap = $('call-members');
  const existing = new Map([...wrap.children].map((node) => [node.dataset.memberKey, node]));
  const current = new Set(['self']);
  if (!existing.has('self'))
    wrap.append(tile(state.profile?.onlineId || 'You', true, state.profile?.accountId));
  const labels = {
    ready: 'Voice ready',
    partial: 'Partly connected',
    routing: 'Routing',
    failed: 'Unavailable',
    reconnecting: 'Reconnecting',
    connecting: 'Connecting',
    inactive: 'Not in voice',
    pending: 'Joining voice',
  };
  for (const member of partyMembers(
    state.callMembers,
    state.voicePeers,
    state.profile?.accountId,
  )) {
    current.add(member.key);
    const node =
      existing.get(member.key) ?? tile(member.onlineId || 'Player', false, member.accountId);
    node.dataset.memberKey = member.key;
    node.dataset.voiceState = member.state;
    node.querySelector('.label').textContent = member.onlineId || 'Player';
    node.querySelector('.voice-status').textContent = labels[member.state];
    const avatarButton = node.querySelector('.ring');
    avatarButton.setAttribute('aria-label', `View ${member.onlineId || 'player'}'s party details`);
    avatarButton.onclick = () =>
      participantDetails?.open({
        partyId: state.active,
        memberKey: member.key,
        accountId: member.accountId,
        platform: member.platform,
        username: member.onlineId,
        isSelf: false,
      });
    node.title = `${member.onlineId || 'Player'} · ${labels[member.state]}`;
    if (!existing.has(member.key)) wrap.append(node);
  }
  for (const [key, node] of existing) if (!current.has(key)) node.remove();
}
function showCall(party, status) {
  $('call-party-name').textContent = party.name;
  $('call-panel').hidden = false;
  state.callMembers = party.members;
  state.voicePeers = [];
  state.voiceSummary = null;
  $('call-members').replaceChildren();
  renderCallMembers();
  $('mute').textContent = 'Mute';
  $('mute').classList.remove('mute-on');
  setCallStatus(status);
}

function startMeters() {
  const md = new Uint8Array(state.micAnalyser.fftSize);
  const pd = new Uint8Array(state.partyAnalyser.fftSize);
  const loop = () => {
    if (!state.inCall) return;
    state.micAnalyser.getByteTimeDomainData(md);
    state.partyAnalyser.getByteTimeDomainData(pd);
    const self = state.muted ? 0 : rms(md);
    const party = rms(pd);
    updateVoiceMeter($('input-voice-meter'), self);
    $('mic-meter').style.width = Math.min(100, self * 280) + '%';
    $('self-tile')?.classList.toggle('speaking', self > 0.02);
    // The mixed party meter cannot identify an individual speaker.
    state.raf = requestAnimationFrame(loop);
  };
  loop();
}

function teardownAudio() {
  try {
    state.micStream?.getTracks().forEach((t) => t.stop());
  } catch {}
  try {
    state.playNode?.port.postMessage('flush');
  } catch {}
  try {
    state.ctx?.close();
  } catch {}
  state.ctx =
    state.micStream =
    state.micNode =
    state.playNode =
    state.micAnalyser =
    state.partyAnalyser =
      null;
  $('mic-meter').style.width = '0%';
}
function endCall(msg) {
  const was = state.inCall;
  state.inCall = false;
  state.muted = false;
  updateVoiceMeter($('input-voice-meter'), 0);
  state.callMembers = [];
  state.voicePeers = [];
  state.voiceSummary = null;
  cancelAnimationFrame(state.raf);
  if (state.ws) {
    try {
      state.ws.onclose = null;
      state.ws.close();
    } catch {}
    state.ws = null;
  }
  teardownAudio();
  $('call-panel').hidden = true;
  renderParties();
  if (msg && was) toast(msg, 'error');
}
async function leaveCall() {
  try {
    state.ws?.send(JSON.stringify({ t: 'stop' }));
  } catch {}
  endCall();
  try {
    await api('/api/party/leave', {});
  } catch {}
  state.active = null;
  renderParties();
  await refreshParties();
  void screenSharing?.refresh();
  toast('You left the party.', 'success');
}

/* ---------- Connect ---------- */
function openConnect() {
  $('connect-error').hidden = true;
  $('connect-dialog').showModal();
}

/* ---------- Events ---------- */
$('account-chip').onclick = () => (state.connected ? disconnect() : openConnect());
$('welcome-connect').onclick = openConnect;
$('close-dialog').onclick = () => $('connect-dialog').close();
$('connect-dialog').addEventListener('close', () => {
  $('npsso').value = '';
});
$('connect-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.busy) return;
  state.busy = true;
  $('submit-connect').disabled = true;
  $('submit-connect').textContent = 'Connecting';
  $('connect-error').hidden = true;
  const npsso = $('npsso').value;
  $('npsso').value = '';
  try {
    const result = await api('/api/connect', { npsso });
    state.connected = true;
    state.profile = result.profile;
    $('connect-dialog').close();
    renderAccount();
    toast(
      result.loginSaved === false
        ? 'Signed in. Login could not be saved on this PC.'
        : 'Signed in.',
      result.loginSaved === false ? 'error' : 'success',
    );
    await refreshParties();
  } catch (err) {
    $('connect-error').textContent = err.message;
    $('connect-error').hidden = false;
  } finally {
    state.busy = false;
    $('submit-connect').disabled = false;
    $('submit-connect').textContent = 'Connect';
    renderAccount();
  }
});
async function disconnect() {
  await guard(async () => {
    participantDetails?.close();
    if (state.inCall) {
      endCall();
    }
    if (state.active) {
      try {
        await api('/api/party/leave', {});
      } catch {}
      state.active = null;
    }
    await api('/api/disconnect', {});
    state.connected = false;
    state.profile = null;
    state.parties = [];
    toast('Signed out.', 'success');
  });
}

$('refresh-parties').onclick = () => guard(refreshParties);
$('leave-call').onclick = () => guard(leaveCall);
$('mute').onclick = () => {
  if (!state.inCall) return;
  state.muted = !state.muted;
  $('lounge-voice-status').textContent = voiceSummaryLabel(state);
  try {
    state.ws?.send(JSON.stringify({ t: 'mute', on: state.muted }));
  } catch {}
  state.micNode?.port.postMessage({ muted: state.muted });
  $('mute').textContent = state.muted ? 'Unmute' : 'Mute';
  $('mute').classList.toggle('mute-on', state.muted);
  $('self-tile')?.classList.toggle('muted', state.muted);
};
$('enable-audio').onclick = togglePreview;
$('mic-select').onchange = () => {
  state.micId = $('mic-select').value;
  if (state.preview) {
    stopPreview();
    togglePreview();
  } else if (state.inCall) toast('Microphone change applies next time you join.');
};
$('speaker-select').onchange = async () => {
  state.speakerId = $('speaker-select').value;
  void screenSharing?.outputChanged();
  if (state.ctx && canSetSink()) {
    try {
      await state.ctx.setSinkId(state.speakerId);
    } catch {}
  }
};
$('test-speaker').onclick = async () => {
  const btn = $('test-speaker');
  btn.disabled = true;
  let ctx;
  try {
    ctx = new AudioContext();
    if (canSetSink() && state.speakerId) {
      try {
        await ctx.setSinkId(state.speakerId);
      } catch {}
    }
    await ctx.resume();
    const g = ctx.createGain();
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.09, ctx.currentTime + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 523.25;
    o.connect(g);
    o.start();
    o.stop(ctx.currentTime + 0.65);
    o.onended = () => {
      ctx.close();
      btn.disabled = false;
    };
  } catch {
    await ctx?.close();
    btn.disabled = false;
    toast('Could not play a test sound.', 'error');
  }
};

navigator.mediaDevices?.addEventListener?.('devicechange', () => enumerate());
window.addEventListener('pagehide', () => {
  try {
    state.ws?.close();
  } catch {}
});
window.addEventListener('pagehide', () => partyLive?.stop());
window.addEventListener('pageshow', () => partyLive?.sync());
window.addEventListener('online', () => partyLive?.sync());
window.addEventListener('offline', () => partyLive?.sync());
document.addEventListener?.('visibilitychange', () => partyLive?.sync());

/* ---------- Boot ---------- */
async function init() {
  try {
    const b = await bootstrapSession();
    Object.assign(state, {
      csrf: b.csrf,
      connected: b.connected,
      profile: b.profile,
      active: b.activeParty,
    });
    screenSharing = initScreenSharing({ api, getContext: () => state });
    appHub = initAppHub({ api, getContext: () => state, toast });
    participantDetails = initParticipantDetails({ api, getContext: () => state });
    partyLive = createPartyLiveUpdates({ getContext: () => state, refresh: refreshParties });
    initPartyCreation({
      api,
      getContext: () => state,
      runAction: guard,
      toast,
      onCreated: async (party, joinVoice) => {
        state.active = party.id;
        state.parties = [party, ...state.parties.filter((p) => p.id !== party.id)];
        renderAccount();
        renderParties();
        void screenSharing?.refresh();
        if (joinVoice) await startCall(party);
      },
    });
    $('helper-label').textContent = 'Helper connected';
    $('helper-dot').classList.add('ready');
    renderAccount();
    await enumerate();
    if (state.connected) await refreshParties();
    if (state.active) toast('Rejoin the party to connect voice.');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.busy = false;
    renderAccount();
    renderParties();
  }
}

setInterval(async () => {
  if (!state.csrf) return;
  try {
    const r = await api('/api/heartbeat');
    if (state.active && !r.activeParty && !state.inCall) {
      state.active = null;
      renderParties();
    }
  } catch {
    $('helper-label').textContent = 'Helper offline';
    $('helper-dot').classList.remove('ready');
  }
}, 30000);

init();
