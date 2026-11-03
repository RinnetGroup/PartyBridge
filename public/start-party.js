export function initPartyCreation({ api, getContext, onCreated, runAction, toast }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('start-party-dialog'),
    form = $('start-party-form');
  let friends = [],
    selected = new Set(),
    nextOffset = null,
    loading = false,
    creating = false,
    generation = 0,
    friendError = '';
  function renderFriends() {
    const focusedAccount = document.activeElement?.dataset?.friendAccountId;
    let restoreFocus;
    const host = $('party-friend-list');
    host.replaceChildren();
    const query = $('party-friend-search').value.trim().toLowerCase();
    const visible = friends.filter((p) =>
      `${p.onlineId ?? ''} ${p.name ?? ''}`.toLowerCase().includes(query),
    );
    for (const person of visible) {
      const label = document.createElement('label');
      label.className = 'party-friend';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = selected.has(person.accountId);
      input.dataset.friendAccountId = person.accountId;
      if (focusedAccount === person.accountId) restoreFocus = input;
      input.disabled = creating || (!input.checked && selected.size >= 15);
      input.addEventListener('change', () => {
        if (input.checked) selected.add(person.accountId);
        else selected.delete(person.accountId);
        renderFriends();
      });
      const name = document.createElement('span');
      name.textContent = person.onlineId || person.name || 'Player';
      label.append(input, name);
      host.append(label);
    }
    if (!visible.length && !loading) {
      const empty = document.createElement('p');
      empty.className = 'tiny';
      empty.textContent = query ? 'No matching friends.' : 'No friends loaded.';
      host.append(empty);
    }
    $('party-friend-status').textContent = loading
      ? 'Loading friends…'
      : friendError || `${selected.size} selected · ${friends.length} friends loaded`;
    $('party-more-friends').hidden = nextOffset === null;
    $('party-more-friends').disabled = loading || creating;
    restoreFocus?.focus({ preventScroll: true });
  }
  async function loadFriends(offset, currentGeneration) {
    if (loading) return;
    loading = true;
    friendError = '';
    renderFriends();
    try {
      const data = await api(`/api/app/friends?limit=100&offset=${offset}`);
      if (currentGeneration !== generation || !dialog.open) return;
      for (const person of data.items ?? [])
        if (
          person.accountId !== getContext().profile?.accountId &&
          !friends.some((p) => p.accountId === person.accountId)
        )
          friends.push(person);
      nextOffset =
        Number.isInteger(data.nextOffset) && data.nextOffset > offset ? data.nextOffset : null;
    } catch {
      if (currentGeneration === generation && dialog.open) {
        nextOffset = offset;
        friendError = 'Friends could not load. You can retry or start without invitations.';
      }
      return;
    } finally {
      if (currentGeneration === generation) {
        loading = false;
        renderFriends();
      }
    }
  }
  $('start-party').addEventListener('click', () => {
    const context = getContext();
    if (!context.connected || context.busy || context.active || creating) return;
    generation++;
    friends = [];
    selected = new Set();
    nextOffset = null;
    loading = false;
    form.reset();
    $('party-name').value = `${context.profile?.onlineId || 'My'}'s party`.slice(0, 32);
    $('party-create-error').hidden = true;
    dialog.showModal();
    void loadFriends(0, generation);
  });
  $('party-friend-search').addEventListener('input', renderFriends);
  $('party-friend-search').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') event.preventDefault();
  });
  $('party-more-friends').addEventListener(
    'click',
    () => void loadFriends(nextOffset ?? 0, generation),
  );
  $('cancel-start-party').addEventListener('click', () => {
    if (!creating) dialog.close();
  });
  dialog.addEventListener('cancel', (event) => {
    if (creating) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    generation++;
    loading = false;
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (creating || getContext().busy) return;
    creating = true;
    $('submit-start-party').disabled = true;
    $('cancel-start-party').disabled = true;
    $('submit-start-party').textContent = 'Starting…';
    $('party-create-error').hidden = true;
    renderFriends();
    const joinVoice = $('party-join-voice').checked;
    await runAction(async () => {
      let result;
      try {
        result = await api('/api/party/create', {
          name: $('party-name').value,
          type: $('party-type').value,
          maxMembers: Number($('party-size').value),
          invites: [...selected],
        });
      } catch (error) {
        $('party-create-error').textContent = error.message;
        $('party-create-error').hidden = false;
        return;
      }
      dialog.close();
      try {
        await onCreated(result.party, joinVoice);
      } catch (error) {
        toast(
          `Party created. Voice could not start: ${error.message} Use Rejoin to try voice again.`,
          'error',
        );
        return;
      }
      toast(
        result.inviteWarning
          ? 'Party created, but some invitations could not be sent.'
          : `Started ${result.party.name}.`,
        result.inviteWarning ? 'error' : 'success',
      );
    });
    creating = false;
    $('submit-start-party').disabled = false;
    $('cancel-start-party').disabled = false;
    $('submit-start-party').textContent = 'Start party';
    renderFriends();
  });
}
