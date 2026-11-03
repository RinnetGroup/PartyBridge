import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { partyMembers } from '../public/party-state.js';
import { svgIcon } from '../public/ui-elements.js';
import { PartyNotifications } from '../public/party-notifications.js';
import { voiceSummaryLabel } from '../public/voice-status.js';

// Run the actual UI message handler with a small DOM, without microphones,
// browser launches, timers, helper connections or external requests.
class Element {
  children = [];
  dataset = {};
  style = {};
  className = '';
  textContent = '';
  constructor(tag = 'div') {
    this.tag = tag;
    this.classList = {
      add: (name) => {
        this.className = [...new Set([...this.className.split(' '), name])].join(' ').trim();
      },
      remove: (name) => {
        this.className = this.className
          .split(' ')
          .filter((n) => n !== name)
          .join(' ');
      },
      toggle: (name, enabled) => (enabled ? this.classList.add(name) : this.classList.remove(name)),
    };
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const node of this.children) node.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
    this.parent = null;
  }
  addEventListener() {}
  setAttribute(name, value) {
    this[name] = value;
  }
  querySelector(selector) {
    const matches = (node) =>
      selector.startsWith('.')
        ? node.className.split(' ').includes(selector.slice(1))
        : node.tag === selector;
    for (const child of this.children) {
      if (matches(child)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
}
async function ui() {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const context = vm.createContext({
    partyMembers,
    svgIcon,
    PartyNotifications,
    voiceSummaryLabel,
    updateVoiceMeter: () => {},
    bootstrapSession: () => new Promise(() => {}),
    document: { getElementById: get, createElement: (tag) => new Element(tag) },
    navigator: { mediaDevices: {} },
    window: { addEventListener() {} },
    setInterval() {},
    clearInterval() {},
    setTimeout() {},
    clearTimeout() {},
    fetch: () => new Promise(() => {}),
  });
  let source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  source = source.replace(/^import[\s\S]*?;\r?\n/gm, '');
  vm.runInContext(
    source +
      '\nglobalThis.driver = { state, showCall, handleVoiceMsg, setDetails: controller => { participantDetails=controller; } };',
    context,
  );
  return { ...context.driver, get };
}

test('live participant messages update actual call tiles, names, readiness and departures without rebuilding healthy tiles', async () => {
  const f = await ui();
  const self = { accountId: '88', onlineId: 'Self' },
    first = { accountId: '99', onlineId: 'First' },
    late = { accountId: '100', onlineId: 'Late' };
  const party = { id: 'party', name: 'Crew', members: [self, first], maxMembers: 16 };
  Object.assign(f.state, {
    connected: true,
    profile: self,
    active: party.id,
    parties: [party],
    inCall: true,
  });
  f.showCall(party, 'connecting');
  assert.equal(f.get('lounge-voice-status').textContent, 'Connecting');
  const wrap = f.get('call-members'),
    firstTile = wrap.children[1];
  const peers = [{ accountIds: ['99'], routeReady: true, state: 'ready' }];
  f.handleVoiceMsg({
    t: 'participants',
    peers,
    members: [self, first, late],
    summary: { ready: 1, total: 2 },
  });
  f.handleVoiceMsg({ t: 'state', state: 'partial', summary: { ready: 1, total: 2 } });
  assert.equal(wrap.children.length, 3);
  assert.equal(wrap.children[1], firstTile);
  assert.equal(wrap.children[2].querySelector('.label').textContent, 'Late');
  assert.equal(wrap.children[2].querySelector('.voice-status').textContent, 'Joining voice');
  assert.equal(f.get('call-status').textContent, '1 of 2 voice participants ready');
  peers.push({ accountIds: ['100'], routeReady: true, state: 'ready' });
  f.handleVoiceMsg({
    t: 'participants',
    peers,
    members: [self, first, late],
    summary: { ready: 2, total: 2 },
  });
  assert.equal(wrap.children[2].querySelector('.voice-status').textContent, 'Voice ready');
  f.handleVoiceMsg({
    t: 'participants',
    peers: [peers[0]],
    members: [self, first],
    summary: { ready: 1, total: 1 },
  });
  assert.equal(wrap.children.length, 2);
  assert.equal(wrap.children[1], firstTile);
});

test('voice avatars open details for the clicked device, including a console sharing the local account', async () => {
  const f = await ui(),
    opened = [];
  const self = {
    accountId: '88',
    onlineId: 'Self',
    platform: 'MOBILE_APP',
    memberKey: 'pc',
    isSelf: true,
  };
  const console = {
    accountId: '88',
    onlineId: 'Self',
    platform: 'PS5',
    memberKey: 'console',
    isSelf: false,
  };
  const party = { id: 'party', name: 'Crew', members: [self, console], maxMembers: 16 };
  Object.assign(f.state, {
    connected: true,
    profile: self,
    active: 'party',
    parties: [party],
    inCall: true,
  });
  f.setDetails({ open: (value) => opened.push(value) });
  f.showCall(party, 'ready');
  f.handleVoiceMsg({
    t: 'participants',
    members: [self, console],
    peers: [{ accountIds: ['88'], memberKeys: ['console'], routeReady: true, state: 'ready' }],
  });
  const tiles = f.get('call-members').children;
  assert.equal(tiles.length, 2);
  assert.equal(tiles[1].dataset.voiceState, 'ready');
  tiles[1].querySelector('.ring').onclick();
  tiles[0].querySelector('.ring').onclick();
  assert.equal(opened[0].memberKey, 'console');
  assert.equal(opened[0].platform, 'PS5');
  assert.equal(opened[0].isSelf, false);
  assert.equal(opened[1].isSelf, true);
  assert.equal(opened[0].partyId, 'party');
  assert.equal(f.state.inCall, true);
});
