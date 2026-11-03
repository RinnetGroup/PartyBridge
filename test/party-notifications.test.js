import test from 'node:test';
import assert from 'node:assert/strict';
import { PartyNotifications } from '../public/party-notifications.js';
const party = (id, extra = {}) => ({ id, name: 'Weekend crew', joinable: true, ...extra }),
  context = { accountId: '88', onlineId: 'Self' };
test('party notifications skip the initial list and notify once for new parties', () => {
  const notifications = new PartyNotifications();
  assert.equal(notifications.observe([party('old')], context), null);
  assert.equal(
    notifications.observe([party('old'), party('new', { owner: 'NorthStar' })], context),
    'NorthStar opened a party.',
  );
  assert.equal(notifications.observe([party('new')], context), null);
  notifications.observe([], context);
  assert.equal(notifications.observe([party('new')], context), null);
});
test('party notifications ignore your party and unavailable parties, and handle a party becoming open', () => {
  const notifications = new PartyNotifications();
  notifications.observe([], context);
  assert.equal(
    notifications.observe(
      [party('mine', { owner: 'Self' }), party('private', { joinable: false })],
      context,
    ),
    null,
  );
  assert.equal(notifications.observe([party('private')], context), 'New party: Weekend crew.');
  assert.equal(
    notifications.observe([party('active')], { ...context, activeParty: 'active' }),
    null,
  );
});
test('notification baseline resets across accounts and combines simultaneous openings', () => {
  const notifications = new PartyNotifications();
  notifications.observe([], context);
  assert.equal(
    notifications.observe([party('a'), party('b')], context),
    '2 new parties are available.',
  );
  assert.equal(notifications.observe([party('c')], { accountId: '99' }), null);
  notifications.reset();
  assert.equal(notifications.observe([party('d')], context), null);
});
