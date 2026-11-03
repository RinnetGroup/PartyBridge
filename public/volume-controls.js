import { bootstrapSession } from './session.js';
// A standalone controller can adjust a live call without reopening its audio
// devices, replacing its WebSocket, or reloading the party tab.
const host = document.getElementById('volume-controls');
if (host) {
  const controls = new Map();
  for (const [key, text] of [
    ['microphone', 'Microphone volume'],
    ['party', 'Party volume'],
  ]) {
    const label = document.createElement('label');
    label.className = 'volume-control';
    const heading = document.createElement('span');
    heading.className = 'volume-label';
    const name = document.createElement('span');
    name.textContent = text;
    const value = document.createElement('output');
    value.textContent = '100%';
    const input = document.createElement('input');
    Object.assign(input, {
      type: 'range',
      min: '0',
      max: '200',
      step: '1',
      value: '100',
      disabled: true,
      id: `${key}-volume`,
    });
    input.setAttribute('aria-label', text);
    value.htmlFor = input.id;
    heading.append(name, value);
    label.append(heading, input);
    host.append(label);
    controls.set(key, { input, value });
  }
  const levelingLabel = document.createElement('label');
  levelingLabel.className = 'audio-toggle';
  const leveling = document.createElement('input');
  leveling.type = 'checkbox';
  leveling.id = 'smart-voice-leveling';
  leveling.disabled = true;
  const levelingName = document.createElement('span');
  levelingName.textContent = 'Smart voice leveling';
  levelingLabel.append(leveling, levelingName);
  host.append(levelingLabel);
  const levelingNote = document.createElement('p');
  levelingNote.className = 'leveling-note';
  levelingNote.textContent =
    'Raises quiet voices and softens loud voices separately. Only changes what you hear.';
  host.append(levelingNote);
  const status = document.createElement('p');
  status.className = 'tiny volume-status';
  status.setAttribute('role', 'status');
  status.textContent = 'Loading volume controls…';
  host.append(status);
  let csrf = '',
    pending = null,
    saving = false,
    debounce,
    levelingSaving = false,
    levelingVersion = 0;
  async function request(method = 'GET', body, path = '/api/audio/volume') {
    const response = await fetch(path, {
      method,
      headers: {
        'X-PartyBridge-CSRF': csrf,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(8000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message ?? 'Volume could not be updated.');
    return result;
  }
  function display(result) {
    for (const [key, control] of controls) {
      control.input.value = result[key];
      control.value.textContent = `${result[key]}%`;
    }
    status.textContent = result.voiceActive
      ? 'Applied to your current call.'
      : 'Saved for your next call.';
  }
  async function save() {
    if (saving || !pending) return;
    saving = true;
    try {
      while (pending) {
        const patch = pending;
        pending = null;
        const result = await request('POST', patch);
        if (!pending) display(result);
      }
    } catch (error) {
      status.textContent = error.message;
    } finally {
      saving = false;
    }
  }
  for (const [key, control] of controls)
    control.input.addEventListener('input', () => {
      control.value.textContent = `${control.input.value}%`;
      pending = { ...pending, [key]: Number(control.input.value) };
      clearTimeout(debounce);
      debounce = setTimeout(save, 70);
    });
  for (const control of controls.values())
    control.input.addEventListener('change', () => {
      clearTimeout(debounce);
      void save();
    });
  leveling.addEventListener('change', async () => {
    if (levelingSaving) return;
    levelingVersion++;
    levelingSaving = true;
    leveling.disabled = true;
    const enabled = leveling.checked;
    try {
      const result = await request('POST', { enabled }, '/api/audio/leveling');
      leveling.checked = result.enabled;
      status.textContent = result.voiceActive
        ? 'Applied to your current call.'
        : 'Saved for your next call.';
    } catch (error) {
      leveling.checked = !enabled;
      status.textContent = error.message;
    } finally {
      levelingSaving = false;
      leveling.disabled = false;
    }
  });
  async function refresh() {
    if (!csrf || saving || pending || document.activeElement?.type === 'range') return;
    try {
      display(await request());
      if (!levelingSaving) {
        const version = levelingVersion,
          result = await request('GET', undefined, '/api/audio/leveling');
        if (!levelingSaving && version === levelingVersion) leveling.checked = result.enabled;
      }
    } catch (error) {
      status.textContent = error.message;
    }
  }
  (async () => {
    try {
      const bootstrap = await bootstrapSession();
      if (!bootstrap.csrf) throw new Error('Keep the PartyBridge helper running.');
      csrf = bootstrap.csrf;
      const [volumes, smart] = await Promise.all([
        request(),
        request('GET', undefined, '/api/audio/leveling'),
      ]);
      display(volumes);
      leveling.checked = smart.enabled;
      leveling.disabled = false;
      for (const control of controls.values()) control.input.disabled = false;
      setInterval(() => {
        if (!document.hidden) void refresh();
      }, 5000);
    } catch (error) {
      status.textContent = error.message;
    }
  })();
}
