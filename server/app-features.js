import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

const fail = (message) => new AppError(400, 'INVALID_APP_INPUT', message);
const text = (value, max = 3000) => (typeof value === 'string' ? value.slice(0, max) : '');
const list = (value) => (Array.isArray(value) ? value : []);
const id = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9~][A-Za-z0-9_.:#~-]{0,255}$/.test(value))
    throw fail('Invalid item identifier.');
  return encodeURIComponent(value);
};
const account = (value) => {
  if (value === 'me') return value;
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value))
    throw fail('Invalid account identifier.');
  return value;
};
const bounded = (value, fallback, max) => {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > max) throw fail('Invalid page.');
  return number;
};
const query = (values) =>
  '?' +
  new URLSearchParams(Object.entries(values).filter(([, v]) => v !== undefined && v !== null));
const page = (raw, items, offset, limit) => {
  const total = Number(raw.totalItemCount ?? raw.totalResults ?? raw.totalCount);
  const nextOffset = Object.hasOwn(raw, 'nextOffset')
    ? raw.nextOffset
    : Number.isFinite(total)
      ? offset + items.length < total
        ? offset + items.length
        : null
      : items.length === limit
        ? offset + limit
        : null;
  return { items, total: Number.isFinite(total) ? total : null, nextOffset };
};
const epoch = (value) =>
  typeof value === 'number' || /^\d+$/.test(String(value ?? '')) ? Number(value) : text(value, 80);
const getName = (value) =>
  text(typeof value === 'string' ? value : (value?.value ?? value?.name), 200);
const platformName = (value) =>
  /ps5|prospero|psgd/i.test(value ?? '')
    ? 'PS5'
    : /ps4/i.test(value ?? '')
      ? 'PS4'
      : /pspc|pc_game/i.test(value ?? '')
        ? 'PC'
        : text(value, 40);
export function allowedMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443') &&
      ['playstation.net', 'playstation.com', 'pscloud.tv'].some(
        (host) => url.hostname === host || url.hostname.endsWith('.' + host),
      )
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function externalLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

// Explicit operations on fixed Sony services. This never accepts an upstream
// URL, HTTP verb, arbitrary request body or raw GraphQL from the browser.
export class AppFeatures {
  constructor(client) {
    this.client = client;
    this.accountId = client.accountId;
    this.cache = new Map();
    this.media = new Map();
    this.devices = new Map();
    this.profileCache = new Map();
    this.closed = false;
    this.actionBusy = false;
  }
  check() {
    if (this.closed || !this.client.tokens || this.client.accountId !== this.accountId)
      throw new AppError(401, 'APP_ACCOUNT_CHANGED', 'Connect your account again.');
  }
  clear() {
    this.closed = true;
    this.cache.clear();
    this.media.clear();
    this.devices.clear();
    this.profileCache.clear();
  }
  api(path, options = {}) {
    this.check();
    return this.client.api(
      path,
      {
        ...options,
        headers: {
          'Accept-Language': 'en-US',
          ...(path.startsWith('/cloudAssistedNavigation/')
            ? { 'X-Psn-Can-Mobile-App-Type': 'PSAPP' }
            : {}),
          ...options.headers,
        },
      },
      'app ' + path.split('/')[1],
    );
  }
  image(url) {
    // Older profile responses still contain HTTP CDN links. Register only their
    // HTTPS equivalent; the proxy never requests plaintext media.
    if (typeof url === 'string' && url.startsWith('http://')) url = 'https://' + url.slice(7);
    const valid = allowedMediaUrl(url);
    if (!valid) return null;
    const now = Date.now();
    for (const [key, value] of this.media) if (value.expires < now) this.media.delete(key);
    for (const [key, value] of this.media) if (value.url === valid) return '/api/app/media/' + key;
    while (this.media.size >= 1500) this.media.delete(this.media.keys().next().value);
    const key = randomUUID();
    this.media.set(key, { url: valid, expires: now + 3600000 });
    return '/api/app/media/' + key;
  }
  resource(groupId, resourceId) {
    const url =
      'https://m.np.playstation.com/api/gamingLoungeGroups/v1/groups/' +
      id(groupId) +
      '/resources/' +
      id(resourceId);
    const local = this.image(url);
    this.media.get(local.slice('/api/app/media/'.length)).authenticated = true;
    return local;
  }
  profile(raw, accountId) {
    const p = raw.profile ?? raw.profiles?.[0] ?? raw;
    return {
      accountId,
      onlineId: text(p.onlineId, 100) || 'PlayStation player',
      about: text(p.aboutMe, 2000),
      plus: !!p.isPlus,
      avatar: this.image(
        p.personalDetail?.profilePictures?.find((a) => a.size === 'm')?.url ??
          p.avatars?.find((a) => a.size === 'm')?.url ??
          p.avatars?.[0]?.url,
      ),
      languages: list(p.languages).map((v) => text(v, 30)),
      verified: !!p.isOfficiallyVerified,
    };
  }
  async profiles(ids) {
    if (!ids.length) return [];
    ids.forEach(account);
    const missing = [
      ...new Set(
        ids.filter((a) => !this.profileCache.has(a) || this.profileCache.get(a).until < Date.now()),
      ),
    ];
    if (!missing.length) return ids.map((a) => ({ ...this.profileCache.get(a).profile }));
    const raw = await this.api(
      '/userProfile/v1/internal/users/profiles' + query({ accountIds: missing.join(',') }),
    );
    // The bulk endpoint is positional and omits accountId in each profile.
    const profiles =
      !Array.isArray(raw.profiles) || raw.profiles.length !== missing.length
        ? await Promise.all(
            missing.map(async (a) =>
              this.profile(await this.api(`/userProfile/v1/internal/users/${a}/profiles`), a),
            ),
          )
        : raw.profiles.map((p, i) => this.profile(p, missing[i]));
    for (const p of profiles)
      this.profileCache.set(p.accountId, {
        profile: p,
        until: Date.now() + 300000,
      });
    return ids.map((a) => ({ ...this.profileCache.get(a).profile }));
  }
  async read(feature, params = {}) {
    this.check();
    const key = feature + JSON.stringify(params),
      previous = this.cache.get(key);
    if (previous && previous.until > Date.now()) return previous.promise;
    const promise = this.load(feature, params)
      .then((data) => {
        this.check();
        return data;
      })
      .catch((error) => {
        if (this.cache.get(key)?.promise === promise) this.cache.delete(key);
        throw error;
      });
    this.cache.set(key, {
      promise,
      until: Date.now() + (feature === 'messages' ? 5000 : 20000),
    });
    while (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value);
    return promise;
  }
  async load(feature, params) {
    const limit = Math.max(1, bounded(params.limit, 24, 100)),
      offset = bounded(params.offset, 0, 100000);
    const who = params.accountId ? account(params.accountId) : 'me';
    if (['friends', 'requests', 'sent', 'blocked'].includes(feature)) {
      const suffix = {
        friends: 'friends',
        requests: 'friends/receivedRequests',
        sent: 'friends/sentRequests',
        blocked: 'blocks',
      }[feature];
      const raw = await this.api(
        `/userProfile/v1/internal/users/me/${suffix}` + query({ limit, offset }),
      );
      const entries = list(
        raw[
          {
            friends: 'friends',
            requests: 'receivedRequests',
            sent: 'sentRequests',
            blocked: 'blocks',
          }[feature]
        ] ??
          raw.blockingUsers ??
          raw.blockedUsers,
      );
      const ids = entries
        .map((v) => (typeof v === 'string' ? v : String(v.accountId ?? '')))
        .filter((v) => /^[1-9]\d{0,19}$/.test(v));
      const profiles = await this.profiles(ids);
      if (feature === 'friends' && ids.length) {
        try {
          const presence = await this.api(
            '/userProfile/v2/internal/users/basicPresences' +
              query({
                accountIds: ids.join(','),
                type: 'primary',
                platforms: 'PS4,PS5,MOBILE_APP,PSPC',
                withOwnGameTitleInfo: true,
              }),
          );
          for (const p of profiles) {
            const state = list(presence.basicPresences).find(
                (s) => String(s.accountId) === p.accountId,
              ),
              primary = state?.primaryPlatformInfo ?? {};
            p.status = text(primary.onlineStatus ?? state?.availability, 50);
            p.platform = text(primary.platform, 40);
            p.game = text(
              primary.gameTitleInfoList?.[0]?.titleName ?? state?.gameTitleInfo?.titleName,
              200,
            );
          }
        } catch {
          /* Profiles remain useful when a presence permission is absent. */
        }
      }
      return page(raw, profiles, offset, limit);
    }
    if (feature === 'profile') {
      const target = who === 'me' ? this.client.accountId : who;
      return this.profile(
        await this.api(`/userProfile/v1/internal/users/${target}/profiles`),
        target,
      );
    }
    if (feature === 'games') {
      const raw = await this.api(`/gamelist/v2/users/${who}/titles` + query({ limit, offset }));
      return page(
        raw,
        list(raw.titles).map((g) => ({
          kind: 'played',
          id: text(g.titleId, 100),
          name: text(g.name, 300),
          image: this.image(g.imageUrl ?? g.concept?.imageUrl),
          platform: platformName(g.category ?? g.service),
          playDuration: text(g.playDuration, 80),
          playCount: Number(g.playCount) || 0,
          lastPlayed: text(g.lastPlayedDateTime, 80),
          conceptId: String(g.concept?.id ?? g.concept?.conceptId ?? ''),
          productId: text(g.productId, 100),
        })),
        offset,
        limit,
      );
    }
    if (feature === 'owned') {
      // PS App module 3927: request metadata with the licenses, rather than
      // showing opaque entitlement IDs as if they were game names.
      const raw = await this.api(
        '/entitlement/v2/users/me/internal/entitlements' +
          query({
            limit,
            offset,
            fields:
              'titleMeta,gameMeta,conceptMeta,rewardMeta,rewardMeta.retentionPolicy,rewardMeta.rewardMembershipType',
            gameMetaPackageType: 'PSGD,PS4GD',
            sortBy: 'ACTIVE_DATE',
            sortDirection: 'desc',
            isActive: 'true',
          }),
      );
      const items = list(raw.entitlements).map((g) => ({
        kind: 'owned',
        id: text(g.id, 160),
        titleId: text(g.titleMeta?.titleId ?? g.gameMeta?.titleId, 100),
        name: text(
          g.titleMeta?.name ??
            g.titleMeta?.titleName ??
            g.gameMeta?.name ??
            g.gameMeta?.titleName ??
            g.conceptMeta?.name ??
            g.name ??
            g.productId,
          300,
        ),
        productId: text(g.productId, 160),
        skuId: text(g.skuId, 160),
        platform: g.gameMeta?.packageType === 'PS4GD' ? 'PS4' : 'PS5',
        active: !!g.activeFlag,
        isGame: !!g.isGame,
        isSubscription: !!g.isSubscription,
        image: this.image(
          g.titleMeta?.iconUrl ?? g.gameMeta?.iconUrl ?? g.conceptMeta?.imageUrl ?? g.imageUrl,
        ),
        acquired: epoch(g.activeDate),
      }));
      return page(raw, items, offset, limit);
    }
    if (feature === 'trophy-summary') {
      const raw = await this.api(`/trophy/v1/users/${who}/trophySummary`);
      return {
        level: Number(raw.trophyLevel) || 0,
        progress: Number(raw.progress) || 0,
        earned: {
          bronze: Number(raw.earnedTrophies?.bronze) || 0,
          silver: Number(raw.earnedTrophies?.silver) || 0,
          gold: Number(raw.earnedTrophies?.gold) || 0,
          platinum: Number(raw.earnedTrophies?.platinum) || 0,
        },
      };
    }
    if (feature === 'trophies') {
      const raw = await this.api(`/trophy/v1/users/${who}/trophyTitles` + query({ limit, offset }));
      return page(
        raw,
        list(raw.trophyTitles).map((t) => ({
          id: text(t.npCommunicationId, 100),
          service: text(t.npServiceName, 40),
          name: text(t.trophyTitleName, 300),
          image: this.image(t.trophyTitleIconUrl),
          platform: text(t.trophyTitlePlatform, 60),
          progress: Number(t.progress) || 0,
          earned: t.earnedTrophies,
          defined: t.definedTrophies,
          updated: text(t.lastUpdatedDateTime, 80),
        })),
        offset,
        limit,
      );
    }
    if (feature === 'trophy-detail') {
      const title = id(params.titleId),
        service = params.service === 'trophy2' ? 'trophy2' : 'trophy';
      const q = query({ npServiceName: service, limit: 100, offset });
      const [definitions, earnings] = await Promise.all([
        this.api(`/trophy/v1/npCommunicationIds/${title}/trophyGroups/all/trophies` + q),
        this.api(
          `/trophy/v1/users/${who}/npCommunicationIds/${title}/trophyGroups/all/trophies` + q,
        ),
      ]);
      const items = list(definitions.trophies).map((t) => {
        const earning = list(earnings.trophies).find((e) => e.trophyId === t.trophyId) ?? {};
        return {
          id: String(t.trophyId),
          name: text(t.trophyName, 300),
          description: text(t.trophyDetail, 2000),
          type: text(t.trophyType, 30),
          hidden: !!t.trophyHidden,
          image: this.image(t.trophyIconUrl),
          earned: !!earning.earned,
          earnedAt: text(earning.earnedDateTime, 80),
          rarity: Number(earning.trophyEarnedRate ?? t.trophyEarnedRate) || 0,
        };
      });
      return page(definitions, items, offset, 100);
    }
    if (feature === 'groups') {
      const raw = await this.api(
        '/gamingLoungeGroups/v1/members/me/groups' +
          query({
            limit: Math.min(limit, 20),
            offset,
            includeFields: 'members',
          }),
      );
      const items = await Promise.all(
        list(raw.groups).map(async (g) => {
          try {
            return await this.group(text(g.groupId));
          } catch {
            return {
              id: text(g.groupId),
              name: 'Conversation',
              members: list(g.members).map((m) => ({
                accountId: String(m.accountId ?? ''),
                onlineId: text(m.onlineId, 100),
              })),
              threadId: text(g.groupId),
            };
          }
        }),
      );
      return page(raw, items, offset, Math.min(limit, 20));
    }
    if (feature === 'group') return this.group(params.groupId);
    if (feature === 'messages') {
      const group = await this.group(params.groupId),
        thread = id(group.threadId);
      const raw = await this.api(
        `/gamingLoungeGroups/v1/members/me/groups/${id(params.groupId)}/threads/${thread}/messages` +
          query({
            limit: Math.min(limit, 100),
            until: params.until ? text(params.until, 80) : undefined,
          }),
      );
      return {
        group,
        previous: raw.previous ?? null,
        items: list(raw.messages).map((m) => ({
          id: text(m.messageUid, 200),
          type: Number(m.messageType) || 0,
          body: text(m.body, 6000),
          createdAt: epoch(m.createdTimestamp),
          sender: {
            accountId: String(m.sender?.accountId ?? ''),
            onlineId: text(m.sender?.onlineId, 100),
          },
          image: m.messageDetail?.imageMessageDetail?.resourceId
            ? this.resource(params.groupId, m.messageDetail.imageMessageDetail.resourceId)
            : this.image(
                m.messageDetail?.imageMessageDetail?.url ??
                  m.messageDetail?.imageMessageDetail?.thumbnailUrl,
              ),
          mine: String(m.sender?.accountId) === this.client.accountId,
        })),
      };
    }
    if (feature === 'notifications') {
      const raw = await this.api(
        '/userNotificationManager/v1/users/me/notifications' +
          query({ limit, offset, templateVersion: '26.10', npLanguage: 'en' }),
      );
      return page(
        raw,
        list(raw.notifications)
          .filter((n) => String(n.state).toLowerCase() !== 'deleted')
          .map((n) => ({
            id: text(n.notificationId, 200),
            title:
              getName(n.title ?? n.body?.title ?? n.notificationBody?.title) ||
              'PlayStation notification',
            body: getName(
              typeof n.body === 'string'
                ? n.body
                : (n.body?.body ?? n.body?.message ?? n.message ?? n.notificationBody?.message),
            ),
            state: text(n.state, 50),
            createdAt: text(n.createdDateTime, 80),
          })),
        offset,
        limit,
      );
    }
    if (feature === 'explore') {
      const raw = await this.api('/explore/v2/users/me/hub');
      return {
        items: list(raw.stories)
          .slice(0, 80)
          .map((s) => ({
            id: text(s.storyId, 100),
            name: text(s.storyContents?.headline ?? s.source?.conceptName, 300),
            description: text(s.storyContents?.description, 3000),
            image: this.image(s.storyContents?.images?.[0]?.url ?? s.source?.conceptImageUrl),
            url: externalLink(s.storyContents?.externalUrl),
            game: text(s.source?.conceptName, 200),
            createdAt: text(s.createdDateTime, 80),
          })),
        followed: list(raw.conceptsFollowed).map(String),
      };
    }
    if (feature === 'consoles') {
      const raw = await this.api(
        '/cloudAssistedNavigation/v2/users/me/clients' +
          query({ platform: 'PS5', includeFields: 'device,systemData' }),
      );
      const items = list(raw.clients).map((c) => {
        const key = randomUUID();
        this.devices.set(key, c);
        return {
          id: key,
          name: text(
            c.device?.name ?? c.device?.deviceName ?? c.device?.deviceNickname ?? 'PS5',
            200,
          ),
          platform: text(c.platform, 40),
          status: text(
            c.systemData?.powerState ?? c.systemData?.status ?? c.deviceProperties?.powerState,
            80,
          ),
          updated: text(c.updatedDateTime, 80),
        };
      });
      while (this.devices.size > 100) this.devices.delete(this.devices.keys().next().value);
      return { items };
    }
    if (feature === 'subscriptions') {
      const raw = await this.api('/subscriptions/v2/users/me/services/pssubscriptions');
      return {
        items: list(raw.services ?? raw).map((s) => ({
          id: text(s.id, 160),
          name: text(s.title, 300),
          type: text(s.membershipType ?? s.type, 80),
          status: getName(s.state?.status ?? s.state?.membershipState),
          expires: text(s.state?.nextPaymentDate ?? s.state?.endDate ?? s.endDate, 80),
        })),
      };
    }
    if (feature === 'presence-settings') {
      const [offline, busy] = await Promise.all(
        ['appearOffline', 'busy'].map((k) =>
          this.api('/userProfile/v1/internal/users/me/userSettings/' + k),
        ),
      );
      return { offline: !!offline.settingValue, busy: !!busy.settingValue };
    }
    if (feature === 'captures') {
      const type = params.type ?? 'all';
      if (!['all', 'screenshot', 'video'].includes(type))
        throw fail('Choose screenshots, videos, or all captures.');
      const cursor = params.cursor ? text(params.cursor, 2048) : undefined;
      const raw = await this.api(
        '/gameMediaService/v2/c2s/category/cloudMediaGallery/ugcType/' +
          type +
          query({ limit, nextCursorMark: cursor }),
      );
      const items = list(raw.ugcDocument ?? raw.contents ?? raw.content ?? raw.items ?? raw).map(
        (c) => ({
          id: text(c.ugcId ?? c.id, 200),
          name: text(c.title ?? c.sceTitleName ?? c.name, 300) || 'Capture',
          type: text(c.ugcType ?? c.type ?? type, 50),
          image: this.image(c.thumbnailUrl ?? c.thumbnail?.url ?? c.streamingPreviewImage),
          createdAt: epoch(c.createdTimestamp ?? c.createdDateTime ?? c.creationDate),
        }),
      );
      return {
        items,
        nextOffset: null,
        nextCursor: text(raw.nextCursorMark, 2048) || null,
      };
    }
    if (feature === 'capture-url') {
      const raw = await this.api('/gameMediaService/v2/c2s/ugc/' + id(params.captureId) + '/url');
      const url = this.image(raw.url ?? raw.tokenizedUrl ?? raw.tokenizedURL);
      if (!url)
        throw new AppError(502, 'APP_MEDIA_UNAVAILABLE', 'Sony did not return a playable capture.');
      return { url };
    }
    if (feature === 'search') {
      const term = text(params.q, 100).trim();
      if (term.length < 2) throw fail('Enter at least two characters.');
      const users = params.type !== 'games';
      const variables = {
        searchTerm: term,
        searchContext: users ? 'MobileUniversalSearchSocial' : 'MobileUniversalSearchGame',
        displayTitleLocale: 'en-US',
      };
      const extensions = {
        persistedQuery: {
          version: 1,
          sha256Hash: users
            ? 'ac5fb2b82c4d086ca0d272fba34418ab327a7762dd2cd620e63f175bbc5aff10'
            : 'a2fbc15433b37ca7bfcd7112f741735e13268f5e9ebd5ffce51b85acc126f41d',
        },
      };
      const raw = await this.api(
        '/graphql/v1/op' +
          query({
            operationName: 'metGetContextSearchResults',
            variables: JSON.stringify(variables),
            extensions: JSON.stringify(extensions),
          }),
      );
      if (raw.errors?.length)
        throw new AppError(
          502,
          'APP_SEARCH_UNAVAILABLE',
          'PlayStation search is unavailable right now. Try again shortly.',
        );
      const results = list(raw.data?.universalContextSearch?.results).flatMap((r) =>
        list(r.searchResults),
      );
      return {
        items: results
          .map((r) => {
            const v = r.result ?? r.socialMetadata ?? r.gameMetadata ?? r.metadata ?? r,
              media = list(v.media),
              cover =
                media.find(
                  (m) => /MASTER|GAMEHUB_COVER_ART/i.test(m.role) && /image/i.test(m.type),
                ) ?? media.find((m) => /image/i.test(m.type));
            return {
              accountId: users ? String(v.accountId ?? r.id ?? '') : '',
              id: String(v.conceptId ?? v.id ?? r.id ?? ''),
              conceptId: users ? '' : String(v.conceptId ?? v.id ?? ''),
              productId: users ? '' : text(v.defaultProduct?.id, 200),
              name: text(v.onlineId ?? v.name ?? v.titleName ?? r.name, 300),
              image: this.image(v.avatarUrl ?? v.imageUrl ?? cover?.url ?? r.imageUrl),
              platform: list(v.platforms).map(platformName).join(', '),
              relationship: text(v.relationshipState, 60),
              type: users ? 'user' : 'game',
            };
          })
          .filter((item) => item.name && (users ? /^[1-9]\d{0,19}$/.test(item.accountId) : true)),
      };
    }
    throw new AppError(404, 'APP_FEATURE_UNKNOWN', 'Unknown app feature.');
  }
  async group(groupId) {
    const raw = await this.api(
      '/gamingLoungeGroups/v1/members/me/groups/' +
        id(groupId) +
        query({
          includeFields:
            'groupName,groupIcon,members,mainThread,joinedTimestamp,modifiedTimestamp,isFavorite,existsNewArrival,notificationSetting',
        }),
    );
    const members = list(raw.members).map((m) => ({
      accountId: typeof m === 'string' ? m : String(m.accountId ?? ''),
      onlineId: text(m.onlineId, 100),
      platform: text(m.platform, 40),
    }));
    const missing = members.filter((m) => !m.onlineId && /^[1-9]\d{0,19}$/.test(m.accountId));
    if (missing.length)
      try {
        const profiles = await this.profiles(missing.map((m) => m.accountId));
        for (const member of missing)
          member.onlineId = profiles.find((p) => p.accountId === member.accountId)?.onlineId ?? '';
      } catch {}
    return {
      id: groupId,
      name:
        getName(raw.groupName) ||
        members
          .map((m) => m.onlineId)
          .filter(Boolean)
          .slice(0, 3)
          .join(', ') ||
        'Conversation',
      members,
      threadId: text(raw.mainThread?.threadId ?? raw.mainThread?.id ?? groupId, 256),
      unread: !!raw.existsNewArrival,
      favorite: !!raw.isFavorite,
      muted: !!raw.notificationSetting?.isMute,
      image: this.image(raw.groupIcon?.url),
      updatedAt: epoch(raw.modifiedTimestamp),
    };
  }
  async sendPhoto(groupId, bytes, type) {
    this.check();
    id(groupId);
    if (!Buffer.isBuffer(bytes) || bytes.length > 1048576 || !bytes.length)
      throw fail('Choose a photo up to 1 MiB.');
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!((type === 'image/png' && png) || (type === 'image/jpeg' && jpeg)))
      throw fail('Choose a PNG or JPEG photo.');
    if (this.actionBusy)
      throw new AppError(409, 'APP_ACTION_BUSY', 'Wait for the current action to finish.');
    this.actionBusy = true;
    try {
      const group = await this.group(groupId),
        token = await this.client.accessToken();
      this.check();
      const uploaded = await this.client.request(
        'https://m.np.playstation.com/api/gamingLoungeGroups/v1/groups/' +
          id(groupId) +
          '/resources',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': type,
            'Accept-Language': 'en-US',
          },
          body: bytes,
        },
        'app photo upload',
      );
      this.check();
      const resourceId = uploaded.resourceId;
      id(resourceId);
      await this.api(
        '/gamingLoungeGroups/v1/groups/' +
          id(groupId) +
          '/threads/' +
          id(group.threadId) +
          '/messages',
        {
          method: 'POST',
          body: {
            messageType: 3,
            messageDetail: { imageMessageDetail: { resourceId } },
          },
        },
      );
      this.cache.clear();
      return { ok: true };
    } finally {
      this.actionBusy = false;
    }
  }
  async action(action, params = {}) {
    this.check();
    if (this.actionBusy)
      throw new AppError(409, 'APP_ACTION_BUSY', 'Wait for the current action to finish.');
    this.actionBusy = true;
    try {
      let path,
        method = 'POST',
        body;
      if (
        [
          'friend.request',
          'friend.accept',
          'friend.remove',
          'friend.decline',
          'friend.cancel',
          'user.block',
          'user.unblock',
        ].includes(action)
      ) {
        const target = account(params.accountId);
        if (target === 'me' || target === this.client.accountId)
          throw fail('Choose another player.');
        path =
          '/userProfile/v1/internal/users/me/' +
          (action.startsWith('user.') ? 'blocks/' : 'friends/') +
          target;
        method =
          action === 'friend.accept'
            ? 'PUT'
            : ['friend.remove', 'friend.decline', 'friend.cancel', 'user.unblock'].includes(action)
              ? 'DELETE'
              : 'POST';
      } else if (action === 'group.create' || action === 'group.invite') {
        const ids = [...new Set(list(params.accountIds))];
        if (!ids.length || ids.length > 99) throw fail('Choose between 1 and 99 players.');
        ids.forEach(account);
        if (ids.includes('me') || ids.includes(this.client.accountId))
          throw fail('Choose other players.');
        path =
          '/gamingLoungeGroups/v1/groups' +
          (action === 'group.invite' ? '/' + id(params.groupId) + '/invitees' : '');
        body = { invitees: ids.map((accountId) => ({ accountId })) };
      } else if (action === 'group.rename') {
        const name = text(params.name, 101).trim();
        if (!name || name.length > 100)
          throw fail('Use a group name between 1 and 100 characters.');
        path = '/gamingLoungeGroups/v1/groups/' + id(params.groupId);
        method = 'PATCH';
        body = { groupName: { value: name } };
      } else if (action === 'group.leave') {
        path = '/gamingLoungeGroups/v1/groups/' + id(params.groupId) + '/members/me';
        method = 'DELETE';
      } else if (action === 'group.favorite' || action === 'group.mute') {
        if (typeof params.enabled !== 'boolean') throw fail('Choose an on or off setting.');
        path =
          '/gamingLoungeGroups/v1/members/me/groups/' +
          id(params.groupId) +
          (action === 'group.mute' ? '/notificationSetting' : '');
        method = 'PATCH';
        body =
          action === 'group.mute' ? { isMute: params.enabled } : { isFavorite: params.enabled };
      } else if (action === 'message.send') {
        const message = text(params.text, 1001).trim();
        if (!message || message.length > 1000)
          throw fail('Use a message between 1 and 1,000 characters.');
        const group = await this.group(params.groupId);
        path =
          '/gamingLoungeGroups/v1/groups/' +
          id(params.groupId) +
          '/threads/' +
          id(group.threadId) +
          '/messages';
        body = { messageType: 1, body: message };
      } else if (action === 'message.hide') {
        const group = await this.group(params.groupId);
        path =
          '/gamingLoungeGroups/v1/members/me/groups/' +
          id(params.groupId) +
          '/threads/' +
          id(group.threadId) +
          '/messages/' +
          id(params.messageId);
        method = 'DELETE';
      } else if (action === 'presence.offline' || action === 'presence.busy') {
        if (typeof params.enabled !== 'boolean') throw fail('Choose an on or off setting.');
        path =
          '/userProfile/v1/internal/users/me/userSettings/' +
          (action === 'presence.offline' ? 'appearOffline' : 'busy');
        method = 'PUT';
        body = { settingValue: params.enabled };
      } else if (action === 'notification.read') {
        id(params.notificationId);
        path = '/userNotificationManager/v1/users/me/notifications';
        method = 'PUT';
        body = {
          notifications: [{ notificationId: params.notificationId, state: 'Read' }],
        };
      } else if (
        ['console.wake', 'console.rest', 'console.launch', 'console.download'].includes(action)
      ) {
        const device = this.devices.get(params.consoleId);
        if (!device?.duid) throw fail('Refresh your consoles and choose a device.');
        if (action === 'console.download') {
          path = '/rdl/v2/add';
          body = [
            {
              entitlementId: id(params.entitlementId) && params.entitlementId,
              duid: device.duid,
              platform: 'PS5',
              playGoScenario: '1',
            },
          ];
        } else {
          path = '/cloudAssistedNavigation/v2/users/me/commands';
          const detail = {
            platform: 'PS5',
            duid: device.duid,
            commandType: {
              'console.wake': 'enterWorkingMode',
              'console.rest': 'enterRestMode',
              'console.launch': 'launchTitle',
            }[action],
          };
          if (action === 'console.launch')
            detail.parameters = {
              titleIds: [id(params.titleId) && params.titleId],
            };
          body = { commandDetail: detail };
        }
      } else throw new AppError(404, 'APP_ACTION_UNKNOWN', 'Unknown app action.');
      const raw = await this.api(path, {
        method,
        ...(body !== undefined ? { body } : {}),
      });
      this.check();
      this.cache.clear();
      return {
        ok: true,
        ...(action === 'group.create' && typeof raw.groupId === 'string'
          ? { groupId: raw.groupId }
          : {}),
      };
    } finally {
      this.actionBusy = false;
    }
  }
}
