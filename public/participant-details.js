export function participantDetailsView(data, selected) {
  const people = Array.isArray(data?.participants) ? data.participants : [];
  const matches = people.filter(
    (p) =>
      p.accountId === selected.accountId &&
      (!selected.platform || p.platform === selected.platform),
  );
  const person = selected.isSelf
    ? people.find((p) => p.isSelf)
    : selected.memberKey
      ? people.find((p) => p.key === selected.memberKey)
      : matches.length === 1
        ? matches[0]
        : null;
  // Only an explicit, live per-participant P2P transport can enable these rows.
  // An open data channel or a ready route on the Sony bridge cannot do so.
  const p2p =
    person?.isSelf === false &&
    person.transport === 'p2p' &&
    ['connected', 'completed'].includes(person.transportState);
  const address = (host) => {
    if (typeof host?.address !== 'string') return 'Not available';
    const value = host.address;
    if (
      host.family === 'IPv4' &&
      value.split('.').length === 4 &&
      value.split('.').every((v) => /^(0|[1-9]\d{0,2})$/.test(v) && Number(v) <= 255)
    )
      return `${value} (IPv4)`;
    if (host.family === 'IPv6' && value.includes(':') && /^[a-f\d:.]+$/i.test(value)) {
      try {
        new URL(`http://[${value}]/`);
        return `${value} (IPv6)`;
      } catch {}
    }
    return 'Not available';
  };
  const ping = (value) =>
    Number.isFinite(value) && value >= 0 ? `${Math.round(value)} ms` : 'Not available';
  const directHost =
    p2p && ['host', 'srflx', 'prflx'].includes(person.host?.candidateType) ? person.host : null;
  return {
    username: person?.username || selected.username || 'Player',
    platform: person?.platform || selected.platform || 'PlayStation',
    connection:
      person?.connection ??
      (data?.rosterReady === false
        ? 'Waiting for participant details'
        : !selected.memberKey && matches.length > 1
          ? 'Multiple devices — select a voice avatar'
          : 'Left party or no longer visible'),
    muted:
      typeof person?.micMuted === 'boolean'
        ? person.micMuted
          ? 'Muted'
          : 'Unmuted'
        : 'Not reported',
    showPing: p2p && Number.isFinite(person.pingMs) && person.pingMs >= 0,
    showHost: p2p && address(directHost) !== 'Not available',
    ping: p2p ? ping(person.pingMs) : '',
    host: p2p ? address(directHost) : '',
    note: p2p
      ? 'Microphone state is the latest reported setting.'
      : 'Ping and IP appear only for an active P2P connection. Microphone state is the latest reported setting.',
  };
}

export function initParticipantDetails({ api, getContext }) {
  const $ = (id) => document.getElementById(id),
    dialog = $('participant-details-dialog');
  let selected = null,
    timer = null,
    generation = 0,
    busy = false;
  const fields = {
    username: 'participant-username',
    platform: 'participant-platform',
    connection: 'participant-connection',
    muted: 'participant-muted',
    ping: 'participant-ping',
    host: 'participant-host',
    note: 'participant-note',
  };
  function display(view) {
    for (const [key, id] of Object.entries(fields)) $(id).textContent = view[key];
    $('participant-ping-row').hidden = !view.showPing;
    $('participant-host-row').hidden = !view.showHost;
  }
  async function refresh() {
    if (!selected || !dialog.open || busy || document.hidden) return;
    if (!getContext().connected) {
      dialog.close();
      return;
    }
    const token = generation,
      selection = selected;
    busy = true;
    try {
      const data = await api(
        '/api/party/participant-details?id=' + encodeURIComponent(selection.partyId),
      );
      if (token !== generation || !dialog.open) return;
      display(participantDetailsView(data, selection));
      $('participant-update').textContent = 'Updated ' + new Date().toLocaleTimeString();
    } catch (error) {
      if (token === generation && dialog.open) {
        display({
          ...participantDetailsView(null, selection),
          connection: 'Unavailable',
          muted: 'No recent data',
        });
        $('participant-update').textContent = error.message;
      }
    } finally {
      if (token === generation) busy = false;
    }
  }
  dialog.addEventListener('close', () => {
    generation++;
    selected = null;
    busy = false;
    clearInterval(timer);
    timer = null;
  });
  return {
    open(selection) {
      if (!selection.partyId) return;
      generation++;
      selected = selection;
      busy = false;
      clearInterval(timer);
      display({
        ...participantDetailsView(null, selection),
        connection: 'Loading…',
        muted: 'Loading…',
      });
      $('participant-update').textContent = 'Checking participant details…';
      if (!dialog.open) dialog.showModal();
      void refresh();
      timer = setInterval(() => void refresh(), 2000);
    },
    close() {
      if (dialog.open) dialog.close();
    },
  };
}
