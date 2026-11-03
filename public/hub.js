import { svgIcon } from './ui-elements.js';
const TABS = [
  ['party', 'Parties'],
  ['friends', 'Friends'],
  ['messages', 'Messages'],
  ['library', 'Library'],
  ['trophies', 'Trophies'],
  ['captures', 'Captures'],
  ['explore', 'Explore'],
  ['consoles', 'Consoles'],
  ['notifications', 'Notifications'],
  ['settings', 'Account'],
];
const node = (tag, text, className) => {
  const e = document.createElement(tag);
  if (tag === 'form') e.addEventListener('submit', (event) => event.preventDefault());
  if (text !== undefined && text !== null) e.textContent = text;
  if (className) e.className = className;
  return e;
};
const button = (text, action, className = 'quiet small') => {
  const e = node('button', text, className);
  e.type = 'button';
  e.onclick = action;
  return e;
};
const link = (label, href) => {
  const e = node('a', label, 'link');
  e.href = href;
  e.target = '_blank';
  e.rel = 'noopener noreferrer';
  return e;
};
const badge = (label, className = '') => node('span', label, 'hub-badge ' + className);
const pickName = (p) => p.onlineId || p.name || 'PlayStation player';
export function formatDuration(value) {
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value ?? '');
  if (!m) return '';
  const minutes = (Number(m[1]) || 0) * 1440 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : minutes
      ? `${minutes}m`
      : 'Less than a minute';
}
export function formatDate(value) {
  if (!value) return '';
  const dateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const d = new Date(
    dateOnly
      ? value + 'T00:00:00'
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : value,
  );
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : '';
}
export function sortedMessages(items) {
  const seen = new Set();
  return items
    .filter((m) => !seen.has(m.id) && seen.add(m.id))
    .sort(
      (a, b) =>
        new Date(
          typeof a.createdAt === 'string' && /^\d+$/.test(a.createdAt)
            ? Number(a.createdAt)
            : a.createdAt,
        ) -
        new Date(
          typeof b.createdAt === 'string' && /^\d+$/.test(b.createdAt)
            ? Number(b.createdAt)
            : b.createdAt,
        ),
    );
}
function image(url, name, className = 'hub-cover') {
  const fallback = node(
    'div',
    String(name || 'PS')
      .slice(0, 2)
      .toUpperCase(),
    className + ' fallback',
  );
  if (!url) return fallback;
  const img = node('img', null, className);
  img.src = url;
  img.alt = '';
  img.loading = 'lazy';
  img.onerror = () => img.replaceWith(fallback);
  return img;
}
function stateBox(title, description, action) {
  const e = node('div', null, 'hub-state');
  e.append(node('h3', title), node('p', description));
  if (action) e.append(action);
  return e;
}
function panel(title) {
  const e = node('section', null, 'panel');
  if (title) e.append(node('h2', title, 'hub-section-title'));
  return e;
}
function heading(title, subtitle, refresh) {
  const h = node('div', null, 'hub-heading'),
    left = node('div');
  left.append(node('h1', title), node('p', subtitle));
  h.append(left);
  if (refresh) h.append(button('Refresh', refresh));
  return h;
}
function input(placeholder, type = 'text') {
  const e = node('input');
  e.type = type;
  e.placeholder = placeholder;
  if (placeholder) e.setAttribute('aria-label', placeholder);
  e.autocomplete = 'off';
  return e;
}
function dialog(title) {
  document.querySelector('.hub-dialog')?.close();
  const previous = document.activeElement;
  const d = node('dialog', null, 'hub-dialog'),
    h = node('div', null, 'hub-dialog-head'),
    body = node('div');
  const close = button('Close', () => d.close());
  d.setAttribute('aria-label', title);
  h.append(node('h2', title), close);
  d.append(h, body);
  document.body.append(d);
  d.addEventListener('close', () => {
    d.remove();
    previous?.focus?.();
  });
  d.showModal();
  return { element: d, body, close: () => d.close() };
}

export class AppHub {
  constructor({ api, getContext, toast }) {
    Object.assign(this, { api, getContext, toast });
    this.tab = 'party';
    this.generation = 0;
    this.identity = '';
    this.friendFilter = 'friends';
    this.libraryFilter = 'games';
    this.captureFilter = 'all';
    this.captureCursors = {};
    this.offsets = {};
    this.drafts = new Map();
    this.selectedGroup = null;
    this.profileAccount = 'me';
    this.friendProfiles = [];
    this.nav = document.getElementById('app-nav');
    this.root = document.getElementById('app-hub');
    this.party = document.getElementById('party-page');
    for (const [key, label] of TABS) {
      const b = button(label, () => this.show(key), '');
      const swatch = node('span', null, 'psel__swatch nav-icon');
      swatch.innerHTML = svgIcon(key);
      const text = node('span', label, 'psel__label');
      b.replaceChildren(swatch, text);
      b.setAttribute('aria-label', label);
      b.id = 'hub-tab-' + key;
      b.dataset.tab = key;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', key === 'party' ? 'party-page' : 'app-hub');
      b.setAttribute('aria-selected', String(key === 'party'));
      b.tabIndex = key === 'party' ? 0 : -1;
      this.nav.append(b);
    }
    this.nav.setAttribute('role', 'tablist');
    this.nav.onkeydown = (e) => {
      const tabs = [...this.nav.children],
        index = tabs.indexOf(document.activeElement);
      if (index < 0) return;
      let next;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % tabs.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
        next = (index + tabs.length - 1) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      else return;
      e.preventDefault();
      tabs[next].focus();
      tabs[next].click();
    };
    this.poll = setInterval(() => {
      if (
        this.tab === 'messages' &&
        this.selectedGroup &&
        this.getContext().connected &&
        !document.hidden
      )
        void this.loadConversation(this.selectedGroup, true);
    }, 20000);
    this.accountChanged();
  }
  accountChanged() {
    const s = this.getContext(),
      identity = s.connected
        ? String(s.profile?.accountId ?? s.profile?.onlineId ?? 'connected')
        : '';
    if (identity === this.identity) return;
    this.identity = identity;
    this.generation++;
    this.drafts.clear();
    this.friendProfiles = [];
    this.selectedGroup = null;
    this.messageHistory = null;
    this.offsets = {};
    this.captureCursors = {};
    this.profileAccount = 'me';
    document.querySelector('.hub-dialog')?.close();
    if (this.tab !== 'party') void this.show(this.tab);
  }
  get(feature, params = {}, fresh = false) {
    return this.api(
      '/api/app/' +
        feature +
        '?' +
        new URLSearchParams({
          ...params,
          ...(fresh ? { refresh: String(Date.now()) } : {}),
        }),
    );
  }
  async mutate(action, params = {}, after) {
    if (this.actionPending) return;
    this.actionPending = true;
    try {
      const result = await this.api('/api/app/action', { action, ...params });
      this.toast(
        action === 'message.send'
          ? 'Message sent.'
          : action.startsWith('console.')
            ? 'Command sent to your PS5.'
            : 'Updated.',
        'success',
      );
      await after?.(result);
    } catch (e) {
      this.toast(e.message, 'error');
    } finally {
      this.actionPending = false;
    }
  }
  showError(parent, error, retry) {
    const denied = ['SONY_DENIED', 'SONY_UNAUTHORIZED'].includes(error.code);
    parent.replaceChildren(
      stateBox(
        denied ? 'Sony hasn’t made this available' : 'Couldn’t load this page',
        denied
          ? 'This account or connection does not have access to this feature. You can retry or use PlayStation App.'
          : error.code
            ? error.message
            : 'Something went wrong while loading this page. Try refreshing.',
        button('Try again', retry),
      ),
    );
  }
  async show(tab, fresh = false) {
    if (!TABS.some(([key]) => key === tab)) return;
    this.tab = tab;
    const generation = ++this.generation;
    for (const b of this.nav.children) {
      b.setAttribute('aria-selected', String(b.dataset.tab === tab));
      b.tabIndex = b.dataset.tab === tab ? 0 : -1;
    }
    this.root.setAttribute('role', 'tabpanel');
    this.root.setAttribute('aria-labelledby', 'hub-tab-' + tab);
    this.party.setAttribute('role', 'tabpanel');
    this.party.setAttribute('aria-labelledby', 'hub-tab-party');
    this.party.hidden = tab !== 'party';
    this.root.hidden = tab === 'party';
    if (tab === 'party') return;
    const label = TABS.find(([key]) => key === tab)[1];
    this.root.replaceChildren(
      heading(
        label,
        {
          friends: 'Friends and requests',
          messages: 'Conversations',
          library: 'Games and play time',
          trophies: 'Trophy progress',
          captures: 'Screenshots and videos uploaded from your PS5.',
          explore: 'Updates from the games you follow.',
          consoles: 'Manage the PS5 linked to your account.',
          notifications: 'Your latest PlayStation activity.',
          settings: 'Your profile, presence, and memberships.',
        }[tab],
        () => this.show(tab, true),
      ),
    );
    if (!this.getContext().connected) {
      this.root.append(
        stateBox(
          'Connect your account',
          'Sign in to see your PlayStation friends, messages, games, and more.',
          button(
            'Connect PlayStation',
            () => document.getElementById('welcome-connect').click(),
            'primary',
          ),
        ),
      );
      return;
    }
    const body = node('div');
    this.root.append(body);
    body.append(stateBox('Loading…', 'Connecting to PlayStation.'));
    body.firstChild.classList.add('hub-loading');
    try {
      await this[tab](body, fresh);
    } catch (error) {
      if (generation === this.generation) this.showError(body, error, () => this.show(tab, true));
    }
  }
  tabs(options, selected, onSelect) {
    const row = node('div', null, 'hub-tabs');
    for (const [key, label] of options)
      row.append(
        button(label, () => onSelect(key), 'quiet small' + (key === selected ? ' selected' : '')),
      );
    return row;
  }
  pager(parent, data, key, refresh) {
    const stack = this.offsets[key] ?? [0],
      offset = stack.at(-1);
    if (!offset && data.nextOffset === null) return;
    const bar = node('div', null, 'hub-pagination'),
      prev = button('Previous', () => {
        stack.pop();
        this.offsets[key] = stack;
        refresh();
      }),
      next = button('Next', () => {
        stack.push(data.nextOffset);
        this.offsets[key] = stack;
        refresh();
      });
    prev.disabled = stack.length <= 1;
    next.disabled = data.nextOffset === null || data.nextOffset === undefined;
    bar.append(
      prev,
      node(
        'span',
        `${offset + 1}–${offset + data.items.length}${data.total !== null && data.total !== undefined ? ' of ' + data.total : ''}`,
      ),
      next,
    );
    parent.append(bar);
  }
  offset(key) {
    return (this.offsets[key] ?? [0]).at(-1);
  }
  personRow(person, actions = []) {
    const row = node('div', null, 'hub-row'),
      main = node('div', null, 'hub-row-main'),
      name = node('h3', pickName(person));
    if (person.plus) name.append(' ', badge('Plus', 'plus'));
    const status =
      person.game || [person.status, person.platform].filter(Boolean).join(' · ') || person.about;
    main.append(name, node('p', status || 'PlayStation player'));
    const controls = node('div', null, 'hub-row-actions');
    controls.append(
      button('Profile', () => this.openProfile(person.accountId)),
      ...actions,
    );
    row.append(
      image(person.avatar ?? person.image, pickName(person), 'hub-avatar'),
      main,
      controls,
    );
    return row;
  }
  async friends(parent, fresh) {
    const filter = this.friendFilter,
      data = await this.get(filter, { offset: this.offset(filter) }, fresh);
    if (filter === 'friends') this.friendProfiles = data.items;
    parent.replaceChildren(
      this.tabs(
        [
          ['friends', 'Friends'],
          ['requests', 'Received requests'],
          ['sent', 'Sent requests'],
          ['blocked', 'Blocked'],
        ],
        filter,
        (key) => {
          this.friendFilter = key;
          this.show('friends');
        },
      ),
    );
    const toolbar = node('form', null, 'hub-toolbar'),
      search = input('Search PlayStation players');
    search.setAttribute('aria-label', 'Search PlayStation players');
    const submit = button('Search players', () => searchPlayers());
    toolbar.append(search, submit);
    parent.append(toolbar);
    toolbar.onsubmit = (e) => {
      e.preventDefault();
      searchPlayers();
    };
    const results = node('div');
    parent.append(results);
    const searchPlayers = async () => {
      if (search.value.trim().length < 2) return;
      submit.disabled = true;
      try {
        const found = await this.get('search', {
          q: search.value.trim(),
          type: 'users',
        });
        results.replaceChildren(node('h2', 'Search results', 'hub-section-title'));
        if (!found.items.length)
          results.append(stateBox('No players found', 'Try another Online ID.'));
        for (const p of found.items)
          if (/^[1-9]\d{0,19}$/.test(p.accountId)) {
            const knownFriend =
              this.friendProfiles.some((f) => f.accountId === p.accountId) ||
              ['friend', 'friends'].includes((p.relationship ?? '').toLowerCase());
            const actions =
              p.accountId === String(this.getContext().profile?.accountId)
                ? []
                : [
                    knownFriend
                      ? button('Message', () => this.newGroup([p]))
                      : button('Add friend', () =>
                          this.mutate('friend.request', {
                            accountId: p.accountId,
                          }),
                        ),
                  ];
            results.append(this.personRow({ ...p, onlineId: p.name, avatar: p.image }, actions));
          }
      } catch (e) {
        this.toast(e.message, 'error');
      } finally {
        submit.disabled = false;
      }
    };
    const content = panel();
    parent.append(content);
    if (!data.items.length)
      content.append(
        stateBox(
          {
            friends: 'No friends yet',
            requests: 'No friend requests',
            sent: 'No pending requests',
            blocked: 'No blocked players',
          }[filter],
          filter === 'friends' ? 'Search for someone by their Online ID.' : 'You’re all caught up.',
        ),
      );
    for (const person of data.items) {
      const params = { accountId: person.accountId },
        refresh = () => this.show('friends', true);
      const actions = [];
      if (filter === 'requests')
        actions.push(
          button('Accept', () => this.mutate('friend.accept', params, refresh), 'primary small'),
          button('Decline', () => this.mutate('friend.decline', params, refresh)),
        );
      if (filter === 'sent')
        actions.push(button('Cancel request', () => this.mutate('friend.cancel', params, refresh)));
      if (filter === 'blocked')
        actions.push(button('Unblock', () => this.mutate('user.unblock', params, refresh)));
      if (filter === 'friends')
        actions.push(
          button('Message', () => this.newGroup([person])),
          button('Remove', () => {
            if (confirm(`Remove ${pickName(person)} from your friends?`))
              this.mutate('friend.remove', params, refresh);
          }),
        );
      content.append(this.personRow(person, actions));
    }
    this.pager(parent, data, filter, () => this.show('friends'));
  }
  async openProfile(accountId) {
    if (!/^[1-9]\d{0,19}$/.test(accountId ?? '')) return;
    const d = dialog('Player profile');
    d.body.append(node('p', 'Loading…', 'hub-muted'));
    try {
      const p = await this.get('profile', { accountId });
      if (!d.element.isConnected) return;
      d.body.replaceChildren(
        image(p.avatar, p.onlineId, 'hub-avatar large'),
        node('h2', p.onlineId),
        node('p', p.about || 'No About Me added.', 'hub-muted'),
      );
      const actions = node('div', null, 'hub-card-actions');
      actions.append(
        button('View trophies', () => {
          this.profileAccount = accountId;
          d.close();
          this.show('trophies');
        }),
        button('Message', () => {
          d.close();
          this.newGroup([p]);
        }),
      );
      if (accountId !== this.getContext().profile?.accountId)
        actions.append(
          button('Add friend', () => this.mutate('friend.request', { accountId })),
          button('Block', () => {
            if (confirm(`Block ${p.onlineId}?`))
              this.mutate('user.block', { accountId }, () => d.close());
          }),
        );
      d.body.append(actions);
      if (p.languages.length)
        d.body.append(node('p', 'Languages: ' + p.languages.join(', '), 'hub-muted'));
    } catch (e) {
      this.showError(d.body, e, () => {
        d.close();
        this.openProfile(accountId);
      });
    }
  }
  async messages(parent, fresh) {
    const groups = await this.get('groups', { offset: this.offset('groups'), limit: 20 }, fresh);
    const tools = node('div', null, 'hub-toolbar');
    tools.append(button('New conversation', () => this.newGroup(), 'primary small'));
    parent.replaceChildren(tools);
    const split = node('div', null, 'hub-split'),
      sidebar = node('div', null, 'panel hub-group-list'),
      chat = node('div');
    chat.id = 'hub-conversation';
    for (const group of groups.items) {
      const b = button('', () => this.loadConversation(group.id), '');
      b.dataset.group = group.id;
      const names = group.members
        .filter((m) => m.accountId !== this.getContext().profile?.accountId)
        .map((m) => m.onlineId)
        .filter(Boolean)
        .slice(0, 2)
        .join(', ');
      b.append(
        node('strong', (group.unread ? '● ' : '') + group.name),
        node('small', names || `${group.members.length} members`),
      );
      sidebar.append(b);
    }
    if (!groups.items.length) sidebar.append(node('p', 'No conversations yet.', 'hub-muted'));
    split.append(sidebar, chat);
    parent.append(split);
    this.pager(parent, groups, 'groups', () => this.show('messages'));
    const selected = groups.items.some((g) => g.id === this.selectedGroup)
      ? this.selectedGroup
      : groups.items[0]?.id;
    if (selected) await this.loadConversation(selected, false, fresh);
    else
      chat.append(
        stateBox(
          'Start a conversation',
          'Choose friends to create a group or send a direct message.',
        ),
      );
  }
  async loadConversation(groupId, poll = false, fresh = false) {
    const host = document.getElementById('hub-conversation');
    if (!host || this.tab !== 'messages') return;
    if (poll && this.messagePending) return;
    this.selectedGroup = groupId;
    this.messagePending = true;
    for (const b of document.querySelectorAll('[data-group]'))
      b.classList.toggle('selected', b.dataset.group === groupId);
    if (!poll) host.replaceChildren(node('p', 'Loading conversation…', 'hub-muted'));
    try {
      const data = await this.get('messages', { groupId, limit: 50 }, fresh);
      if (this.selectedGroup !== groupId || this.tab !== 'messages' || !host.isConnected) return;
      if (poll) {
        const timeline = host.querySelector('.hub-timeline'),
          history = this.messageHistory;
        if (timeline && history?.groupId === groupId) {
          history.items = sortedMessages([...data.items, ...history.items]).slice(-1000);
          this.renderTimeline(timeline, history.items);
        }
        return;
      }
      const chat = node('div', null, 'hub-chat'),
        head = node('div', null, 'hub-chat-head'),
        title = node('div');
      title.append(
        node('h2', data.group.name),
        node('p', data.group.members.map((p) => p.onlineId || 'Player').join(', ')),
      );
      const controls = node('div', null, 'hub-row-actions');
      controls.append(
        button('Refresh', () => this.loadConversation(groupId, true, true)),
        button('Manage', () => this.manageGroup(data.group)),
      );
      head.append(title, controls);
      const timeline = node('div', null, 'hub-timeline');
      this.renderTimeline(timeline, data.items);
      const history = { groupId, items: data.items, previous: data.previous };
      this.messageHistory = history;
      const older = button('Load older messages', async () => {
        older.disabled = true;
        try {
          const before = history.previous,
            next = await this.get('messages', {
              groupId,
              limit: 50,
              until: before,
            });
          if (!timeline.isConnected || this.messageHistory !== history) return;
          const oldHeight = timeline.scrollHeight,
            oldTop = timeline.scrollTop;
          history.items = sortedMessages([...history.items, ...next.items]).slice(-1000);
          history.previous = next.items.length && next.previous !== before ? next.previous : null;
          this.renderTimeline(timeline, history.items);
          timeline.scrollTop = oldTop + timeline.scrollHeight - oldHeight;
        } catch (e) {
          this.toast(e.message, 'error');
        } finally {
          older.disabled = false;
          older.hidden = !history.previous || history.items.length >= 1000;
        }
      });
      older.hidden = !history.previous;
      const form = node('form', null, 'hub-form hub-compose'),
        draft = node('textarea');
      draft.placeholder = 'Write a message';
      draft.setAttribute('aria-label', 'Message');
      draft.maxLength = 1000;
      draft.value = this.drafts.get(groupId) || '';
      draft.oninput = () => this.drafts.set(groupId, draft.value);
      const foot = node('div', null, 'hub-compose-foot'),
        send = node('button', 'Send message', 'primary small');
      send.type = 'submit';
      foot.append(node('span', 'Only sent when you press Send.'), send);
      form.append(draft, foot);
      form.onsubmit = async (e) => {
        e.preventDefault();
        if (!draft.value.trim() || this.actionPending) return;
        send.disabled = true;
        await this.mutate('message.send', { groupId, text: draft.value }, async () => {
          draft.value = '';
          this.drafts.delete(groupId);
          await this.loadConversation(groupId, true, true);
        });
        send.disabled = false;
      };
      const attachment = node('div', null, 'hub-toolbar'),
        photo = input('', 'file'),
        photoName = node('span', '', 'hub-muted'),
        sendPhoto = button('Send photo', async () => {
          const file = photo.files?.[0];
          if (!file || this.actionPending) return;
          if (file.size > 1048576 || !['image/png', 'image/jpeg'].includes(file.type)) {
            this.toast('Choose a PNG or JPEG photo up to 1 MiB.', 'error');
            return;
          }
          sendPhoto.disabled = true;
          this.actionPending = true;
          try {
            const response = await fetch('/api/app/photo?' + new URLSearchParams({ groupId }), {
              method: 'POST',
              headers: {
                'X-PartyBridge-CSRF': this.getContext().csrf,
                'Content-Type': file.type,
              },
              body: file,
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error?.message ?? 'Photo could not be sent.');
            photo.value = '';
            photoName.textContent = '';
            this.toast('Photo sent.', 'success');
            await this.loadConversation(groupId, true, true);
          } catch (error) {
            this.toast(error.message, 'error');
          } finally {
            this.actionPending = false;
            sendPhoto.disabled = !photo.files?.length;
          }
        });
      photo.accept = 'image/png,image/jpeg';
      photo.hidden = true;
      sendPhoto.disabled = true;
      photo.onchange = () => {
        const file = photo.files?.[0];
        photoName.textContent = file ? `${file.name} · ${Math.ceil(file.size / 1024)} KiB` : '';
        sendPhoto.disabled = !file;
      };
      attachment.append(
        button('Choose photo', () => photo.click()),
        photo,
        photoName,
        sendPhoto,
      );
      form.append(attachment);
      chat.append(head, older, timeline, form);
      host.replaceChildren(chat);
    } catch (e) {
      if (!poll && this.selectedGroup === groupId)
        this.showError(host, e, () => this.loadConversation(groupId, false, true));
    } finally {
      this.messagePending = false;
    }
  }
  renderTimeline(timeline, items) {
    const groupId = this.selectedGroup;
    const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 90;
    timeline.replaceChildren();
    if (!items.length) timeline.append(node('p', 'No messages yet. Say hello.', 'hub-muted'));
    for (const message of sortedMessages(items)) {
      const row = node('article', null, 'hub-message' + (message.mine ? ' mine' : '')),
        body = node(
          'div',
          message.body ||
            ({
              3: message.image ? '' : 'Image',
              1013: 'Sticker',
              1011: 'Voice message',
              210: 'Video',
            }[message.type] ??
              'Shared content'),
          'hub-message-body',
        );
      if (message.image) body.append(image(message.image, 'Shared image'));
      const meta = node(
        'div',
        `${message.sender.onlineId || 'Player'} · ${formatDate(message.createdAt)}`,
        'hub-message-meta',
      );
      meta.append(
        button(
          'Hide for me',
          () => {
            if (confirm('Hide this message from your conversation history?'))
              this.mutate('message.hide', { groupId, messageId: message.id }, () =>
                this.loadConversation(groupId, false, true),
              );
          },
          'hub-message-hide',
        ),
      );
      row.append(body, meta);
      timeline.append(row);
    }
    if (nearBottom || !timeline.dataset.loaded) timeline.scrollTop = timeline.scrollHeight;
    timeline.dataset.loaded = 'true';
  }
  async newGroup(preselected = []) {
    const d = dialog('New conversation');
    const form = node('form', null, 'hub-form'),
      name = input('Group name (optional)'),
      checks = node('div', null, 'hub-checks'),
      status = node('p', '', 'hub-error');
    form.append(name, checks, status);
    const send = node('button', 'Create conversation', 'primary');
    send.type = 'submit';
    send.disabled = true;
    checks.append(node('p', 'Loading friends…', 'hub-muted'));
    form.append(send);
    d.body.append(form);
    try {
      const data = await this.get('friends', { limit: 100 });
      const people = [
        ...new Map([...preselected, ...data.items].map((p) => [p.accountId, p])).values(),
      ];
      checks.replaceChildren();
      send.disabled = !people.length;
      for (const p of people) {
        const label = node('label'),
          check = input('', 'checkbox');
        check.value = p.accountId;
        check.checked = preselected.some((v) => v.accountId === p.accountId);
        label.append(check, document.createTextNode(pickName(p)));
        checks.append(label);
      }
      if (!people.length)
        checks.append(node('p', 'Add friends first to start a conversation.', 'hub-muted'));
      form.onsubmit = async (e) => {
        e.preventDefault();
        const ids = [...checks.querySelectorAll('input:checked')].map((v) => v.value);
        if (!ids.length) {
          status.textContent = 'Select at least one player.';
          return;
        }
        send.disabled = true;
        await this.mutate('group.create', { accountIds: ids }, async (result) => {
          if (name.value.trim() && result.groupId && ids.length > 1)
            await this.api('/api/app/action', {
              action: 'group.rename',
              groupId: result.groupId,
              name: name.value.trim(),
            });
          this.selectedGroup = result.groupId ?? null;
          d.close();
          await this.show('messages', true);
        });
        send.disabled = false;
      };
    } catch (e) {
      status.textContent = e.message;
    }
  }
  manageGroup(group) {
    const d = dialog('Manage conversation'),
      form = node('form', null, 'hub-form'),
      name = input('Group name');
    name.value = group.name;
    name.maxLength = 100;
    const save = node('button', 'Save name', 'primary small');
    save.type = 'submit';
    form.append(name, save);
    form.onsubmit = (e) => {
      e.preventDefault();
      this.mutate('group.rename', { groupId: group.id, name: name.value }, async () => {
        d.close();
        this.show('messages', true);
      });
    };
    d.body.append(form, node('h3', 'Members', 'hub-section-title'));
    for (const p of group.members) d.body.append(this.personRow(p));
    const actions = node('div', null, 'hub-card-actions');
    actions.append(
      button(group.favorite ? 'Remove favorite' : 'Add to favorites', () =>
        this.mutate('group.favorite', { groupId: group.id, enabled: !group.favorite }, () => {
          d.close();
          this.show('messages', true);
        }),
      ),
      button(group.muted ? 'Unmute notifications' : 'Mute notifications', () =>
        this.mutate('group.mute', { groupId: group.id, enabled: !group.muted }, () => {
          d.close();
          this.show('messages', true);
        }),
      ),
      button('Invite friends', () => this.inviteToGroup(group)),
      button(
        'Leave conversation',
        () => {
          if (confirm(`Leave “${group.name}”?`))
            this.mutate('group.leave', { groupId: group.id }, () => {
              this.selectedGroup = null;
              d.close();
              this.show('messages', true);
            });
        },
        'danger small',
      ),
    );
    d.body.append(actions);
  }
  async inviteToGroup(group) {
    const d = dialog('Invite friends');
    try {
      const data = await this.get('friends', { limit: 100 });
      for (const p of data.items.filter(
        (p) => !group.members.some((m) => m.accountId === p.accountId),
      ))
        d.body.append(
          this.personRow(p, [
            button('Invite', () =>
              this.mutate('group.invite', { groupId: group.id, accountIds: [p.accountId] }, () =>
                d.close(),
              ),
            ),
          ]),
        );
    } catch (e) {
      this.showError(d.body, e, () => this.inviteToGroup(group));
    }
  }
  async library(parent, fresh) {
    const type = this.libraryFilter,
      data = await this.get(type, { offset: this.offset(type) }, fresh);
    parent.replaceChildren(
      this.tabs(
        [
          ['games', 'Recently played'],
          ['owned', 'Owned content'],
        ],
        type,
        (key) => {
          this.libraryFilter = key;
          this.show('library');
        },
      ),
    );
    const toolbar = node('div', null, 'hub-toolbar'),
      filter = input('Filter these games');
    filter.setAttribute('aria-label', 'Filter games');
    toolbar.append(filter, link('PlayStation Store', 'https://store.playstation.com/'));
    parent.append(toolbar);
    const grid = node('div', null, 'hub-grid games');
    parent.append(grid);
    const render = () => {
      grid.replaceChildren();
      for (const game of data.items.filter((g) =>
        g.name.toLowerCase().includes(filter.value.toLowerCase()),
      )) {
        const card = button('', () => this.gameDialog(game), 'hub-card');
        card.append(image(game.image, game.name));
        const body = node('div', null, 'hub-card-body');
        body.append(
          node('h3', game.name),
          node(
            'p',
            type === 'games'
              ? [formatDuration(game.playDuration), game.platform].filter(Boolean).join(' · ')
              : game.isGame
                ? 'Game'
                : game.isSubscription
                  ? 'Subscription'
                  : 'Add-on / content',
          ),
        );
        card.append(body);
        grid.append(card);
      }
      if (!grid.children.length)
        grid.append(stateBox('No games found', 'Try a different filter or the next page.'));
    };
    filter.oninput = render;
    render();
    this.pager(parent, data, type, () => this.show('library'));
  }
  gameDialog(game) {
    const d = dialog(game.name);
    d.body.append(image(game.image, game.name, 'hub-cover hub-banner'));
    if (game.playDuration)
      d.body.append(node('p', formatDuration(game.playDuration) + ' played', 'hub-muted'));
    if (game.lastPlayed)
      d.body.append(node('p', 'Last played ' + formatDate(game.lastPlayed), 'hub-muted'));
    const actions = node('div', null, 'hub-card-actions');
    actions.append(
      button('Trophies', () => {
        this.profileAccount = 'me';
        d.close();
        this.show('trophies');
      }),
    );
    if (game.productId)
      actions.append(
        link(
          'View in PlayStation Store',
          'https://store.playstation.com/product/' + encodeURIComponent(game.productId),
        ),
      );
    else if (game.conceptId || (/^\d+$/.test(game.id ?? '') && game.type === 'game'))
      actions.append(
        link(
          'View in PlayStation Store',
          'https://store.playstation.com/concept/' + encodeURIComponent(game.conceptId || game.id),
        ),
      );
    if (
      game.id &&
      ((game.kind === 'owned' && game.active && !game.isSubscription) || game.kind === 'played')
    )
      actions.append(
        button(game.kind === 'owned' ? 'Download to PS5' : 'Launch on PS5', () =>
          this.chooseConsole(game, game.kind === 'owned' ? 'console.download' : 'console.launch'),
        ),
      );
    d.body.append(actions);
  }
  async trophies(parent, fresh) {
    const accountId = this.profileAccount,
      key = 'trophies-' + accountId;
    const [summary, data] = await Promise.all([
      this.get('trophy-summary', { accountId }, fresh),
      this.get('trophies', { accountId, offset: this.offset(key) }, fresh),
    ]);
    const stats = node('div', null, 'hub-trophy-summary'),
      level = node('div');
    level.append(
      node('div', String(summary.level), 'hub-level'),
      node('span', `${summary.progress}% to next level`, 'hub-muted'),
    );
    stats.append(level);
    for (const type of ['platinum', 'gold', 'silver', 'bronze']) {
      const item = node('div', null, 'hub-trophy-count ' + type);
      item.append(node('strong', String(summary.earned[type])), node('span', type.toUpperCase()));
      stats.append(item);
    }
    parent.replaceChildren(stats);
    if (accountId !== 'me')
      parent.append(
        button('Back to my trophies', () => {
          this.profileAccount = 'me';
          this.show('trophies');
        }),
      );
    const grid = node('div', null, 'hub-grid');
    for (const title of data.items) {
      const card = button('', () => this.trophyDialog(title, accountId), 'hub-card');
      card.append(image(title.image, title.name));
      const body = node('div', null, 'hub-card-body'),
        progress = node('progress');
      progress.max = 100;
      progress.value = title.progress;
      progress.setAttribute('aria-label', title.name + ' trophy completion');
      const bar = node('div', null, 'hub-progress');
      bar.append(progress);
      body.append(
        node('h3', title.name),
        badge(title.platform),
        bar,
        node('p', `${title.progress}% complete`),
      );
      card.append(body);
      grid.append(card);
    }
    parent.append(grid);
    if (!data.items.length)
      parent.append(
        stateBox(
          'No trophy titles',
          'Trophies appear here after they sync with PlayStation Network.',
        ),
      );
    this.pager(parent, data, key, () => this.show('trophies'));
  }
  async trophyDialog(title, accountId) {
    const d = dialog(title.name);
    d.body.append(node('p', 'Loading trophies…', 'hub-muted'));
    try {
      const data = await this.get('trophy-detail', {
        titleId: title.id,
        service: title.service,
        accountId,
      });
      if (!d.element.isConnected) return;
      const controls = node('div', null, 'hub-toolbar'),
        filter = node('select'),
        reveal = node('label', null, 'hub-search-label'),
        check = input('', 'checkbox');
      filter.setAttribute('aria-label', 'Filter trophies');
      for (const [v, n] of [
        ['all', 'All trophies'],
        ['earned', 'Earned'],
        ['locked', 'Not earned'],
      ]) {
        const o = node('option', n);
        o.value = v;
        filter.append(o);
      }
      reveal.append(check, document.createTextNode(' Reveal hidden trophies'));
      controls.append(filter, reveal);
      const rows = node('div');
      const more = button('Load more trophies', async () => {
        more.disabled = true;
        try {
          const next = await this.get('trophy-detail', {
            titleId: title.id,
            service: title.service,
            accountId,
            offset: data.nextOffset,
          });
          if (!d.element.isConnected) return;
          const seen = new Set(data.items.map((t) => t.id));
          data.items.push(...next.items.filter((t) => !seen.has(t.id)));
          data.nextOffset = next.nextOffset === data.nextOffset ? null : next.nextOffset;
          render();
        } catch (e) {
          this.toast(e.message, 'error');
        } finally {
          more.disabled = false;
          more.hidden = data.nextOffset === null || data.nextOffset === undefined;
        }
      });
      more.hidden = data.nextOffset === null || data.nextOffset === undefined;
      d.body.replaceChildren(controls, rows, more);
      const render = () => {
        rows.replaceChildren();
        for (const t of data.items.filter(
          (t) => filter.value === 'all' || (filter.value === 'earned' ? t.earned : !t.earned),
        )) {
          const hidden = t.hidden && !t.earned && !check.checked,
            row = node('div', null, 'hub-row'),
            main = node('div', null, 'hub-row-main');
          main.append(
            node('h3', hidden ? 'Hidden trophy' : t.name),
            node('p', hidden ? 'Reveal hidden trophies to see its description.' : t.description),
            badge(`${t.type} · ${t.earned ? 'Earned ' + formatDate(t.earnedAt) : 'Not earned'}`),
          );
          row.append(image(hidden ? null : t.image, t.type, 'hub-avatar'), main);
          rows.append(row);
        }
      };
      filter.onchange = render;
      check.onchange = render;
      render();
    } catch (e) {
      this.showError(d.body, e, () => {
        d.close();
        this.trophyDialog(title, accountId);
      });
    }
  }
  async captures(parent, fresh) {
    let data;
    const type = this.captureFilter,
      stack = this.captureCursors[type] ?? [null];
    try {
      data = await this.get(
        'captures',
        { type, ...(stack.at(-1) ? { cursor: stack.at(-1) } : {}) },
        fresh,
      );
    } catch (e) {
      this.showError(parent, e, () => this.show('captures', true));
      parent.append(
        node('p', 'Use the same account on PS5 and enable Auto-upload for captures.', 'hub-muted'),
        link(
          'Capture setup on PlayStation',
          'https://www.playstation.com/en-us/support/games/ps5-game-captures-ps-app/',
        ),
      );
      return;
    }
    parent.replaceChildren(
      this.tabs(
        [
          ['all', 'All captures'],
          ['screenshot', 'Screenshots'],
          ['video', 'Videos'],
        ],
        this.captureFilter,
        (type) => {
          this.captureFilter = type;
          this.show('captures');
        },
      ),
    );
    const grid = node('div', null, 'hub-grid');
    for (const capture of data.items) {
      const card = button('', () => this.captureDialog(capture), 'hub-card');
      card.append(image(capture.image, capture.name, 'hub-cover hub-banner'));
      const body = node('div', null, 'hub-card-body');
      body.append(node('h3', capture.name), node('p', formatDate(capture.createdAt)));
      card.append(body);
      grid.append(card);
    }
    parent.append(grid);
    if (!data.items.length)
      parent.append(
        stateBox(
          'No uploaded captures',
          'Enable Auto-upload on your PS5. Uploaded captures will appear here when Sony makes them available.',
        ),
      );
    if (stack.length > 1 || data.nextCursor) {
      const pager = node('div', null, 'hub-pagination'),
        previous = button('Previous', () => {
          stack.pop();
          this.captureCursors[type] = stack;
          this.show('captures');
        }),
        next = button('Next', () => {
          stack.push(data.nextCursor);
          this.captureCursors[type] = stack;
          this.show('captures');
        });
      previous.disabled = stack.length === 1;
      next.disabled = !data.nextCursor || data.nextCursor === stack.at(-1);
      pager.append(previous, node('span', 'Page ' + stack.length), next);
      parent.append(pager);
    }
  }
  async captureDialog(capture) {
    const d = dialog(capture.name);
    d.body.append(node('p', 'Opening capture…', 'hub-muted'));
    try {
      const data = await this.get('capture-url', { captureId: capture.id }, true);
      if (!d.element.isConnected) return;
      const video = /video|clip|movie/i.test(capture.type),
        media = node(video ? 'video' : 'img');
      media.src = data.url;
      media.className = video ? '' : 'capture-image';
      if (video) {
        media.controls = true;
        media.playsInline = true;
      } else media.alt = capture.name;
      const download = link('Download capture', data.url);
      download.download = capture.name;
      d.body.replaceChildren(media, download);
      d.element.addEventListener('close', () => {
        if (video) {
          media.pause();
          media.removeAttribute('src');
          media.load();
        }
      });
    } catch (e) {
      this.showError(d.body, e, () => {
        d.close();
        this.captureDialog(capture);
      });
    }
  }
  async explore(parent, fresh) {
    const data = await this.get('explore', {}, fresh);
    parent.replaceChildren();
    const toolbar = node('form', null, 'hub-toolbar'),
      term = input('Search games in PlayStation Store');
    const results = node('div');
    const search = async () => {
      if (term.value.trim().length < 2) return;
      try {
        const found = await this.get('search', {
          q: term.value.trim(),
          type: 'games',
        });
        results.replaceChildren(node('h2', 'Search results', 'hub-section-title'));
        const grid = node('div', null, 'hub-grid');
        for (const game of found.items) {
          const card = button('', () => this.gameDialog(game), 'hub-card');
          card.append(image(game.image, game.name), node('h3', game.name, 'hub-card-body'));
          grid.append(card);
        }
        results.append(grid);
      } catch (e) {
        this.toast(e.message, 'error');
      }
    };
    toolbar.append(
      term,
      button('Search', search),
      link('Open Store', 'https://store.playstation.com/'),
    );
    toolbar.onsubmit = (e) => {
      e.preventDefault();
      search();
    };
    parent.append(toolbar, results);
    const grid = node('div', null, 'hub-grid');
    for (const story of data.items) {
      const card = node('article', null, 'hub-card');
      card.append(image(story.image, story.game, 'hub-cover hub-banner'));
      const body = node('div', null, 'hub-card-body');
      body.append(
        node('p', story.game),
        node('h3', story.name),
        node('p', story.description),
        node('p', formatDate(story.createdAt)),
      );
      if (story.url) body.append(link('Read more', story.url));
      card.append(body);
      grid.append(card);
    }
    parent.append(grid);
    if (!data.items.length)
      parent.append(
        stateBox('No updates yet', 'Follow games in PlayStation App to see their updates here.'),
      );
  }
  async consoles(parent, fresh) {
    const data = await this.get('consoles', {}, fresh);
    parent.replaceChildren();
    for (const device of data.items) {
      const card = panel(),
        head = node('div', null, 'hub-profile'),
        text = node('div');
      text.append(
        node('h2', device.name),
        node('p', [device.platform, device.status].filter(Boolean).join(' · '), 'hub-muted'),
      );
      head.append(image(null, 'PS', 'hub-avatar'), text);
      const actions = node('div', null, 'hub-card-actions');
      actions.append(
        button('Wake PS5', () => this.mutate('console.wake', { consoleId: device.id })),
        button('Enter rest mode', () => {
          if (confirm(`Put ${device.name} into rest mode? This can interrupt anyone using it.`))
            this.mutate('console.rest', { consoleId: device.id });
        }),
      );
      card.append(head, actions);
      parent.append(card);
    }
    if (!data.items.length)
      parent.append(
        stateBox('No linked PS5', 'Sign in on your console with this account, then refresh.'),
      );
    parent.append(
      node(
        'p',
        'Remote features depend on your PS5’s network and rest mode settings.',
        'hub-muted',
      ),
    );
  }
  async chooseConsole(game, action) {
    const d = dialog(action === 'console.download' ? 'Download to PS5' : 'Launch on PS5');
    d.body.append(node('p', 'Choose a console for ' + game.name, 'hub-muted'));
    try {
      const devices = await this.get('consoles');
      if (!devices.items.length)
        d.body.append(stateBox('No linked PS5', 'Sign in to a PS5 with this account.'));
      for (const device of devices.items)
        d.body.append(
          button(
            device.name,
            () => {
              if (
                confirm(
                  `${action === 'console.download' ? 'Download' : 'Launch'} ${game.name} on ${device.name}?`,
                )
              )
                this.mutate(
                  action,
                  {
                    consoleId: device.id,
                    ...(action === 'console.download'
                      ? { entitlementId: game.id }
                      : { titleId: game.id }),
                  },
                  () => d.close(),
                );
            },
            'primary',
          ),
        );
    } catch (e) {
      this.showError(d.body, e, () => {
        d.close();
        this.chooseConsole(game, action);
      });
    }
  }
  async notifications(parent, fresh) {
    const data = await this.get('notifications', { offset: this.offset('notifications') }, fresh);
    parent.replaceChildren();
    const content = panel();
    for (const n of data.items) {
      const row = node('div', null, 'hub-row'),
        main = node('div', null, 'hub-row-main');
      main.append(node('h3', n.title), node('p', n.body), node('p', formatDate(n.createdAt)));
      row.append(main, badge(n.state || 'Activity'));
      if (n.state.toLowerCase() !== 'read')
        row.append(
          button('Mark read', () =>
            this.mutate('notification.read', { notificationId: n.id }, () =>
              this.show('notifications', true),
            ),
          ),
        );
      content.append(row);
    }
    parent.append(content);
    if (!data.items.length)
      content.append(
        stateBox('No new notifications', 'New PlayStation notifications will appear here.'),
      );
    this.pager(parent, data, 'notifications', () => this.show('notifications'));
  }
  async settings(parent, fresh) {
    const [profile, presence, subscriptions] = await Promise.allSettled([
      this.get('profile', {}, fresh),
      this.get('presence-settings', {}, fresh),
      this.get('subscriptions', {}, fresh),
    ]);
    parent.replaceChildren();
    const grid = node('div', null, 'hub-settings');
    parent.append(grid);
    if (profile.status === 'fulfilled') {
      const p = profile.value,
        card = panel('Profile'),
        row = node('div', null, 'hub-profile'),
        copy = node('div');
      copy.append(node('h3', p.onlineId), node('p', p.about || 'No About Me added.', 'hub-muted'));
      row.append(image(p.avatar, p.onlineId, 'hub-avatar'), copy);
      card.append(row);
      grid.append(card);
    }
    const status = panel('Presence');
    if (presence.status === 'fulfilled')
      for (const [key, label, description] of [
        ['offline', 'Appear offline', 'Control how your online presence appears to friends.'],
        ['busy', 'Busy', 'Let your friends know you’re busy.'],
      ]) {
        const labelNode = node('label', null, 'hub-setting'),
          copy = node('div');
        copy.append(node('strong', label), node('small', description));
        const check = input('', 'checkbox');
        check.checked = presence.value[key];
        check.onchange = async () => {
          check.disabled = true;
          const before = !check.checked;
          try {
            await this.api('/api/app/action', {
              action: 'presence.' + key,
              enabled: check.checked,
            });
          } catch (e) {
            check.checked = before;
            this.toast(e.message, 'error');
          } finally {
            check.disabled = false;
          }
        };
        labelNode.append(copy, check);
        status.append(labelNode);
      }
    else status.append(node('p', presence.reason.message, 'hub-error'));
    grid.append(status);
    const membership = panel('Memberships');
    if (subscriptions.status === 'fulfilled') {
      for (const sub of subscriptions.value.items) {
        const row = node('div', null, 'hub-row'),
          copy = node('div', null, 'hub-row-main');
        copy.append(
          node('h3', sub.name),
          node('p', [sub.type, sub.status, formatDate(sub.expires)].filter(Boolean).join(' · ')),
        );
        row.append(copy);
        membership.append(row);
      }
      if (!subscriptions.value.items.length)
        membership.append(node('p', 'No memberships found.', 'hub-muted'));
    } else membership.append(node('p', subscriptions.reason.message, 'hub-error'));
    membership.append(
      link('Manage subscriptions', 'https://www.playstation.com/en-us/support/subscriptions/'),
    );
    grid.append(membership);
    const links = panel('Account and privacy');
    for (const [label, url] of [
      ['Manage Sony account', 'https://www.playstation.com/acct/management/'],
      [
        'Privacy settings',
        'https://www.playstation.com/en-us/support/account/privacy-settings-psn/',
      ],
      ['PlayStation Store', 'https://store.playstation.com/'],
      [
        'PS5 capture setup',
        'https://www.playstation.com/en-us/support/games/ps5-game-captures-ps-app/',
      ],
    ]) {
      const row = node('div', null, 'hub-row');
      row.append(link(label, url));
      links.append(row);
    }
    grid.append(links);
    const media = panel('Share Screen');
    media.append(
      node('p', 'Watch PS5 Share Screens from the Parties tab.', 'hub-muted'),
      node('p', 'Sharing your PC screen is unavailable.', 'hub-muted'),
      link('Preview your PC screen', 'http://127.0.0.1:' + location.port + '/screen-capture.html'),
    );
    grid.append(media);
  }
}
export function initAppHub(options) {
  return new AppHub(options);
}
