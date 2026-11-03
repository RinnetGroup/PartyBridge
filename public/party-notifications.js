export class PartyNotifications {
  constructor() {
    this.reset();
  }
  reset() {
    this.account = null;
    this.ready = false;
    this.known = new Map();
  }
  observe(parties, { accountId, onlineId, activeParty } = {}) {
    if (this.account !== accountId) {
      this.reset();
      this.account = accountId;
    }
    const opened = [];
    for (const party of parties) {
      if (!party?.id) continue;
      const available = party.joinable !== false,
        previous = this.known.get(party.id);
      if (
        this.ready &&
        available &&
        previous !== true &&
        party.id !== activeParty &&
        (!onlineId || party.owner !== onlineId)
      )
        opened.push(party);
      this.known.set(party.id, available);
    }
    this.ready = true;
    while (this.known.size > 500) this.known.delete(this.known.keys().next().value);
    if (!opened.length) return null;
    if (opened.length > 1) return `${opened.length} new parties are available.`;
    const party = opened[0];
    return party.owner
      ? `${party.owner} opened a party.`
      : `New party: ${party.name || 'PlayStation party'}.`;
  }
}
