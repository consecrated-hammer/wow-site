import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SEASON } from './site/season-data.js';
import { SEASON_REWARDS, recommendActivities } from './site/season-rewards.js';

const SITE_ROOT = resolve(fileURLToPath(new URL('./site/', import.meta.url)));
const PORT = positiveInteger(process.env.PORT, 80);
const CHARACTER_TTL_MS = positiveInteger(process.env.CHARACTER_CACHE_TTL_SECONDS, 300) * 1000;
const REFRESH_COOLDOWN_MS = positiveInteger(process.env.REFRESH_COOLDOWN_SECONDS, 60) * 1000;
const MEDIA_TTL_MS = positiveInteger(process.env.MEDIA_CACHE_TTL_SECONDS, 86400) * 1000;
const REALM_TTL_MS = positiveInteger(process.env.REALM_CACHE_TTL_SECONDS, 86400) * 1000;
const MAX_CHARACTER_ENTRIES = positiveInteger(process.env.MAX_CHARACTER_CACHE_ENTRIES, 250);
const MAX_MEDIA_ENTRIES = positiveInteger(process.env.MAX_MEDIA_CACHE_ENTRIES, 1500);
const FETCH_TIMEOUT_MS = positiveInteger(process.env.BLIZZARD_TIMEOUT_MS, 10000);

const REGION_LOCALES = Object.freeze({
  us: 'en_US',
  eu: 'en_GB',
  kr: 'ko_KR',
  tw: 'zh_TW'
});

const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
});

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normaliseRealm(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .normalize('NFC');
}

export function normaliseCharacter(value) {
  return String(value || '').trim().toLocaleLowerCase('en-US');
}

export function resolveUpgrade(item) {
  const bonusList = Array.isArray(item?.bonus_list) ? item.bonus_list : [];

  for (const track of SEASON.tracks) {
    const rankIndex = track.bonusIds.findIndex((bonusId) => bonusList.includes(bonusId));
    if (rankIndex !== -1) {
      const remaining = SEASON.ranksPerTrack - rankIndex - 1;
      return {
        kind: 'season-track',
        season: SEASON.label,
        track: track.name,
        rank: rankIndex + 1,
        ranks: SEASON.ranksPerTrack,
        currentItemLevel: item.level?.value ?? track.ilvls[rankIndex],
        maximumItemLevel: track.ilvls.at(-1),
        upgradesRemaining: remaining,
        crestName: `${track.name} Mistcrests`,
        crestCostRemaining: remaining * SEASON.crestPerRank
      };
    }
  }

  const description = item?.name_description?.display_string || '';
  if (/Ascendant|Voidforged|Venomstone/i.test(description)) {
    return {
      kind: 'special',
      label: description,
      currentItemLevel: item.level?.value ?? null
    };
  }

  return {
    kind: 'legacy-or-unknown',
    label: description || 'No current Season 2 upgrade track',
    currentItemLevel: item?.level?.value ?? null
  };
}

export function findSeasonUpgrades(itemLevel) {
  if (itemLevel === null || itemLevel === undefined || itemLevel === '') return [];
  const currentItemLevel = Number(itemLevel);
  if (!Number.isFinite(currentItemLevel)) return [];

  return SEASON.tracks.flatMap((track) => {
    const rankIndex = track.ilvls.findIndex((level) => level > currentItemLevel);
    if (rankIndex === -1) return [];
    return [{
      track: track.name,
      rank: rankIndex + 1,
      ranks: SEASON.ranksPerTrack,
      itemLevel: track.ilvls[rankIndex],
      maximumItemLevel: track.ilvls.at(-1),
      crestCostFromRankOne: rankIndex * SEASON.crestPerRank
    }];
  });
}

class HttpError extends Error {
  constructor(status, code, message, retryAfter = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function pruneMap(map, maximum, currentTime = Date.now()) {
  for (const [key, entry] of map) {
    if (entry.expiresAt && entry.expiresAt <= currentTime) map.delete(key);
  }
  while (map.size >= maximum) map.delete(map.keys().next().value);
}

function touchMapEntry(map, key, entry) {
  map.delete(key);
  map.set(key, entry);
}

export function createCharacterService(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || (() => Date.now());
  const characterTtlMs = options.characterTtlMs ?? CHARACTER_TTL_MS;
  const refreshCooldownMs = options.refreshCooldownMs ?? REFRESH_COOLDOWN_MS;
  const mediaTtlMs = options.mediaTtlMs ?? MEDIA_TTL_MS;
  const realmTtlMs = options.realmTtlMs ?? REALM_TTL_MS;
  const characterCache = new Map();
  const mediaCache = new Map();
  const realmCache = new Map();
  const pending = new Map();
  const mediaPending = new Map();
  const realmPending = new Map();
  let token = null;
  let tokenExpiresAt = 0;
  let tokenPending = null;

  async function fetchJson(url, init = {}) {
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        signal: init.signal || AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
    } catch (error) {
      throw new HttpError(502, 'upstream_unavailable', `Blizzard request failed: ${error.message}`);
    }

    if (!response.ok) {
      const retryAfter = response.headers?.get?.('retry-after');
      if (response.status === 404) throw new HttpError(404, 'upstream_not_found', 'Blizzard resource not found.');
      if (response.status === 429) throw new HttpError(503, 'upstream_rate_limited', 'Blizzard is rate limiting requests.', retryAfter);
      throw new HttpError(502, 'upstream_error', `Blizzard returned HTTP ${response.status}.`);
    }
    try {
      return await response.json();
    } catch {
      throw new HttpError(502, 'upstream_error', 'Blizzard returned an invalid response.');
    }
  }

  async function getToken() {
    if (token && tokenExpiresAt - now() > 60_000) return token;
    if (tokenPending) return tokenPending;

    tokenPending = (async () => {
      const clientId = process.env.BLIZZARD_CLIENT_ID;
      const clientSecret = process.env.BLIZZARD_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw new HttpError(503, 'not_configured', 'Blizzard API credentials are not configured.');
      }

      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const payload = await fetchJson('https://oauth.battle.net/token', {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
      });
      token = payload.access_token;
      tokenExpiresAt = now() + positiveInteger(payload.expires_in, 3600) * 1000;
      return token;
    })();

    try {
      return await tokenPending;
    } finally {
      tokenPending = null;
    }
  }

  async function getMediaIcon(mediaHref, accessToken) {
    if (!mediaHref) return null;
    const cached = mediaCache.get(mediaHref);
    if (cached && cached.expiresAt > now()) {
      touchMapEntry(mediaCache, mediaHref, cached);
      return cached.url;
    }
    if (mediaPending.has(mediaHref)) return mediaPending.get(mediaHref);

    const request = (async () => {
      try {
        const payload = await fetchJson(mediaHref, {
          headers: { authorization: `Bearer ${accessToken}` }
        });
        const icon = payload.assets?.find((asset) => asset.key === 'icon')?.value || null;
        pruneMap(mediaCache, MAX_MEDIA_ENTRIES, now());
        mediaCache.set(mediaHref, { url: icon, expiresAt: now() + mediaTtlMs });
        return icon;
      } catch {
        // Equipment is still useful when a non-essential media lookup fails.
        return null;
      } finally {
        mediaPending.delete(mediaHref);
      }
    })();
    mediaPending.set(mediaHref, request);
    return request;
  }

  async function fetchCharacter(region, realm, character) {
    const accessToken = await getToken();
    const locale = REGION_LOCALES[region];
    const url = new URL(`https://${region}.api.blizzard.com/profile/wow/character/${encodeURIComponent(realm)}/${encodeURIComponent(character)}/equipment`);
    url.searchParams.set('namespace', `profile-${region}`);
    url.searchParams.set('locale', locale);
    let payload;
    try {
      payload = await fetchJson(url, {
        headers: { authorization: `Bearer ${accessToken}` }
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        throw new HttpError(404, 'character_not_found', 'Character not found.');
      }
      throw error;
    }

    const items = await Promise.all((payload.equipped_items || []).map(async (item) => ({
      slot: item.slot?.type || null,
      slotName: item.slot?.name || null,
      itemId: item.item?.id || null,
      name: item.name || 'Unknown item',
      itemLevel: item.level?.value ?? null,
      quality: item.quality?.type || null,
      sourceLabel: item.name_description?.display_string || null,
      icon: await getMediaIcon(item.media?.key?.href, accessToken),
      upgrade: resolveUpgrade(item),
      seasonUpgrades: findSeasonUpgrades(item.level?.value)
    })));

    return {
      source: 'Blizzard',
      character: {
        name: payload.character?.name || character,
        realm: payload.character?.realm?.name || realm,
        region: region.toUpperCase()
      },
      items
    };
  }

  function characterUrl(region, realm, character, resource = '') {
    const suffix = resource ? `/${resource}` : '';
    const url = new URL(`https://${region}.api.blizzard.com/profile/wow/character/${encodeURIComponent(realm)}/${encodeURIComponent(character)}${suffix}`);
    url.searchParams.set('namespace', `profile-${region}`);
    url.searchParams.set('locale', REGION_LOCALES[region]);
    return url;
  }

  async function fetchCharacterResource(region, realm, character, resource = '') {
    const accessToken = await getToken();
    try {
      return await fetchJson(characterUrl(region, realm, character, resource), {
        headers: { authorization: `Bearer ${accessToken}` }
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        throw new HttpError(404, 'character_not_found', 'Character not found.');
      }
      throw error;
    }
  }

  function characterIdentity(payload, region, realm, character) {
    const source = payload.character || payload;
    return {
      name: source.name || character,
      realm: source.realm?.name || realm,
      realmSlug: source.realm?.slug || realm,
      realmId: source.realm?.id ?? null,
      region: region.toUpperCase()
    };
  }

  function normaliseTalent(talent) {
    const tooltip = talent?.tooltip || {};
    return {
      nodeId: talent?.id ?? null,
      rank: talent?.rank ?? 0,
      talentId: tooltip.talent?.id ?? null,
      name: tooltip.talent?.name || tooltip.spell_tooltip?.spell?.name || null,
      spellId: tooltip.spell_tooltip?.spell?.id ?? null
    };
  }

  async function fetchTalents(region, realm, character) {
    const payload = await fetchCharacterResource(region, realm, character, 'specializations');
    const activeSpecialization = payload.active_specialization || null;
    const specialization = (payload.specializations || [])
      .find((entry) => entry.specialization?.id === activeSpecialization?.id) || null;
    const loadout = specialization?.loadouts?.find((entry) => entry.is_active)
      || specialization?.loadouts?.[0]
      || null;
    const mapTalents = (values) => (values || []).map(normaliseTalent);

    return {
      source: 'Blizzard',
      character: characterIdentity(payload, region, realm, character),
      activeSpecialization: activeSpecialization
        ? { id: activeSpecialization.id, name: activeSpecialization.name }
        : null,
      activeHeroTalentTree: payload.active_hero_talent_tree
        ? { id: payload.active_hero_talent_tree.id, name: payload.active_hero_talent_tree.name }
        : null,
      loadout: loadout ? {
        importCode: loadout.talent_loadout_code || null,
        classTalents: mapTalents(loadout.selected_class_talents),
        specializationTalents: mapTalents(loadout.selected_spec_talents),
        heroTalents: mapTalents(loadout.selected_hero_talents)
      } : null
    };
  }

  async function fetchProfile(region, realm, character) {
    const [payload, mythicIndexResult] = await Promise.all([
      fetchCharacterResource(region, realm, character),
      fetchCharacterResource(region, realm, character, 'mythic-keystone-profile')
        .then((value) => ({ value, error: null }))
        .catch((error) => ({ value: null, error }))
    ]);
    let mythicPlus = null;
    let mythicPlusWarning = null;
    if (mythicIndexResult.error) {
      if (!(mythicIndexResult.error instanceof HttpError && mythicIndexResult.error.status === 404)) {
        mythicPlusWarning = 'Mythic+ data is temporarily unavailable.';
      }
    } else {
      const seasonId = mythicIndexResult.value.seasons?.at(-1)?.id;
      if (seasonId) {
        try {
          const season = await fetchCharacterResource(region, realm, character, `mythic-keystone-profile/season/${seasonId}`);
          mythicPlus = {
            seasonId,
            rating: season.mythic_rating?.rating ?? null,
            bestRuns: (season.best_runs || []).map((run) => ({
              dungeonId: run.dungeon?.id ?? null,
              dungeon: run.dungeon?.name || null,
              keystoneLevel: run.keystone_level ?? null,
              completedWithinTime: run.is_completed_within_time ?? null,
              durationMs: run.duration ?? null,
              rating: run.mythic_rating?.rating ?? null,
              completedAt: run.completed_timestamp
                ? new Date(run.completed_timestamp).toISOString()
                : null
            }))
          };
        } catch (error) {
          if (!(error instanceof HttpError && error.status === 404)) {
            mythicPlusWarning = 'Mythic+ data is temporarily unavailable.';
          }
        }
      }
    }

    return {
      source: 'Blizzard',
      character: characterIdentity(payload, region, realm, character),
      level: payload.level ?? null,
      faction: payload.faction?.name || payload.faction?.type || null,
      race: payload.race ? { id: payload.race.id, name: payload.race.name } : null,
      characterClass: payload.character_class
        ? { id: payload.character_class.id, name: payload.character_class.name }
        : null,
      activeSpecialization: payload.active_spec
        ? { id: payload.active_spec.id, name: payload.active_spec.name }
        : null,
      guild: payload.guild ? { id: payload.guild.id, name: payload.guild.name } : null,
      averageItemLevel: payload.average_item_level ?? null,
      equippedItemLevel: payload.equipped_item_level ?? null,
      achievementPoints: payload.achievement_points ?? null,
      lastLoginAt: payload.last_login_timestamp
        ? new Date(payload.last_login_timestamp).toISOString()
        : null,
      mythicPlus,
      mythicPlusWarning
    };
  }

  async function fetchAchievements(region, realm, character) {
    const payload = await fetchCharacterResource(region, realm, character, 'achievements');
    return {
      source: 'Blizzard',
      character: characterIdentity(payload, region, realm, character),
      totalCompleted: payload.total_quantity ?? null,
      totalPoints: payload.total_points ?? null,
      recentAchievements: (payload.recent_events || []).slice(0, 25).map((event) => ({
        id: event.achievement?.id ?? null,
        name: event.achievement?.name || null,
        completedAt: event.timestamp ? new Date(event.timestamp).toISOString() : null
      }))
    };
  }

  async function listRealms(region) {
    const cached = realmCache.get(region);
    if (cached && cached.expiresAt > now()) {
      touchMapEntry(realmCache, region, cached);
      return cached.data;
    }
    if (realmPending.has(region)) return realmPending.get(region);

    const request = (async () => {
      try {
        const accessToken = await getToken();
        const locale = REGION_LOCALES[region];
        const url = new URL(`https://${region}.api.blizzard.com/data/wow/realm/index`);
        url.searchParams.set('namespace', `dynamic-${region}`);
        url.searchParams.set('locale', locale);
        const payload = await fetchJson(url, {
          headers: { authorization: `Bearer ${accessToken}` }
        });
        const realms = (payload.realms || [])
          .filter((realm) => realm.name && realm.slug && !/partner/i.test(realm.slug))
          .map((realm) => ({ id: realm.id, name: realm.name, slug: realm.slug }))
          .sort((left, right) => left.name.localeCompare(right.name, locale.replace('_', '-')));
        const data = {
          source: 'Blizzard',
          region: region.toUpperCase(),
          fetchedAt: new Date(now()).toISOString(),
          realms
        };
        realmCache.set(region, { data, expiresAt: now() + realmTtlMs });
        return data;
      } catch (error) {
        if (cached) return { ...cached.data, warning: 'Using a cached realm list because Blizzard is unavailable.' };
        throw error;
      } finally {
        realmPending.delete(region);
      }
    })();
    realmPending.set(region, request);
    return request;
  }

  async function lookup({ region, realm, character, forceRefresh = false }) {
    return lookupCached('equipment', { region, realm, character, forceRefresh }, fetchCharacter);
  }

  async function lookupCached(resource, { region, realm, character, forceRefresh = false }, fetcher) {
    const key = `${resource}/${region}/${realm}/${character}`;
    const cached = characterCache.get(key);
    if (cached) touchMapEntry(characterCache, key, cached);
    const currentTime = now();
    const lastAttemptAt = cached?.lastAttemptAt ?? cached?.fetchedAt;

    if (cached && forceRefresh && currentTime - lastAttemptAt < refreshCooldownMs) {
      return decorate(cached.data, cached.fetchedAt, 'refresh-cooldown', refreshCooldownMs, null, lastAttemptAt);
    }
    if (cached && !forceRefresh && cached.expiresAt > currentTime) {
      return decorate(cached.data, cached.fetchedAt, 'hit', refreshCooldownMs, null, lastAttemptAt);
    }
    if (pending.has(key)) return pending.get(key);

    const request = (async () => {
      try {
        const data = await fetcher(region, realm, character);
        const fetchedAt = now();
        pruneMap(characterCache, MAX_CHARACTER_ENTRIES, now());
        characterCache.set(key, {
          data,
          fetchedAt,
          lastAttemptAt: fetchedAt,
          expiresAt: fetchedAt + characterTtlMs
        });
        return decorate(data, fetchedAt, forceRefresh ? 'refreshed' : (cached ? 'revalidated' : 'miss'), refreshCooldownMs);
      } catch (error) {
        if (cached) {
          const attemptedAt = now();
          cached.lastAttemptAt = attemptedAt;
          characterCache.set(key, cached);
          return decorate(cached.data, cached.fetchedAt, 'stale', refreshCooldownMs, error.message, attemptedAt);
        }
        throw error;
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, request);
    return request;
  }

  async function lookupTalents(query) {
    return lookupCached('talents', query, fetchTalents);
  }

  async function lookupProfile(query) {
    return lookupCached('profile', query, fetchProfile);
  }

  async function lookupAchievements(query) {
    return lookupCached('achievements', query, fetchAchievements);
  }

  return { lookup, lookupTalents, lookupProfile, lookupAchievements, listRealms };
}

function decorate(data, fetchedAt, status, refreshCooldownMs, warning = null, refreshBaseAt = fetchedAt) {
  return {
    ...data,
    fetchedAt: new Date(fetchedAt).toISOString(),
    cache: {
      status,
      refreshAvailableAt: new Date(refreshBaseAt + refreshCooldownMs).toISOString()
    },
    ...(warning ? { warning } : {})
  };
}

function setSecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  response.setHeader('X-XSS-Protection', '0');
}

function json(response, status, payload, extraHeaders = {}, headOnly = false) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  response.end(headOnly ? undefined : JSON.stringify(payload));
}

function validateLookup(url) {
  const region = String(url.searchParams.get('region') || '').toLowerCase();
  const realm = normaliseRealm(url.searchParams.get('realm'));
  const character = normaliseCharacter(url.searchParams.get('name'));
  if (!REGION_LOCALES[region]) throw new HttpError(400, 'invalid_region', 'Choose a supported region.');
  if (!realm || realm.length > 80) throw new HttpError(400, 'invalid_realm', 'Enter a valid realm.');
  if (!character || character.length > 24 || !/^[\p{L}-]+$/u.test(character)) {
    throw new HttpError(400, 'invalid_character', 'Enter a valid character name.');
  }
  return { region, realm, character, forceRefresh: url.searchParams.get('refresh') === '1' };
}

function validateRegion(url) {
  const region = String(url.searchParams.get('region') || '').toLowerCase();
  if (!REGION_LOCALES[region]) throw new HttpError(400, 'invalid_region', 'Choose a supported region.');
  return region;
}

export const SEASON_REWARD_CATEGORIES = Object.freeze([
  'all',
  'delves',
  'mythic_plus',
  'crests',
  'great_vault',
  'raid',
  'currencies',
  'recommended_activities'
]);

function validateSeasonQuery(url) {
  const category = String(url.searchParams.get('category') || 'all').toLowerCase();
  if (!SEASON_REWARD_CATEGORIES.includes(category)) {
    throw new HttpError(400, 'invalid_category', 'Choose a supported reward category.');
  }
  const rawItemLevel = url.searchParams.get('itemLevel');
  let itemLevel = null;
  if (rawItemLevel !== null && rawItemLevel !== '') {
    itemLevel = Number(rawItemLevel);
    if (!Number.isInteger(itemLevel) || itemLevel < 1 || itemLevel > 1000) {
      throw new HttpError(400, 'invalid_item_level', 'Item level must be a whole number between 1 and 1000.');
    }
  }
  if (category === 'recommended_activities' && itemLevel === null) {
    throw new HttpError(400, 'item_level_required', 'Recommended activities need an item level.');
  }
  return { category, itemLevel };
}

// Curated data only. The envelope repeats provenance/season/patch/verifiedAt on
// every response so a consumer can never mistake it for Blizzard API output.
export function seasonRewards({ category, itemLevel }) {
  const { season, patch, verifiedAt, provenance, disclaimer, sources } = SEASON_REWARDS;
  const envelope = { season, patch, verifiedAt, provenance, disclaimer, sources, category };

  const sections = {
    delves: () => ({ delves: SEASON_REWARDS.delves }),
    mythic_plus: () => ({ mythicPlus: SEASON_REWARDS.mythicPlus }),
    crests: () => ({ crests: SEASON_REWARDS.crests }),
    great_vault: () => ({ greatVault: SEASON_REWARDS.greatVault }),
    raid: () => ({ raid: SEASON_REWARDS.raid, aboveTrack: SEASON_REWARDS.aboveTrack }),
    currencies: () => ({ currencies: SEASON_REWARDS.currencies }),
    recommended_activities: () => ({ recommendedActivities: recommendActivities(itemLevel) })
  };

  if (category === 'all') {
    const all = Object.assign({}, ...Object.keys(sections)
      .filter((key) => key !== 'recommended_activities')
      .map((key) => sections[key]()));
    if (itemLevel !== null) all.recommendedActivities = recommendActivities(itemLevel);
    return { ...envelope, ...all };
  }
  return { ...envelope, ...sections[category]() };
}

export function clientAddress(request) {
  const forwarded = String(request.headers['x-forwarded-for'] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return forwarded.at(-1) || request.socket.remoteAddress || '';
}

function createRateLimiter(limit = 60, windowMs = 60_000, maximumClients = 1000) {
  const clients = new Map();
  return function allow(address) {
    const currentTime = Date.now();
    let entry = clients.get(address);
    if (!entry || entry.resetAt <= currentTime) entry = { count: 0, resetAt: currentTime + windowMs };
    entry.count += 1;
    clients.set(address, entry);
    if (clients.size >= maximumClients) {
      for (const [key, value] of clients) if (value.resetAt <= currentTime) clients.delete(key);
      while (clients.size >= maximumClients) clients.delete(clients.keys().next().value);
    }
    return entry.count <= limit;
  };
}

async function serveStatic(requestPath, response, headOnly = false) {
  let path = requestPath;
  if (path === '/') path = '/index.html';
  if (path === '/gear-advisor') {
    response.writeHead(301, { Location: '/gear-advisor.html' });
    response.end();
    return;
  }
  if (path === '/index') {
    response.writeHead(301, { Location: '/' });
    response.end();
    return;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new HttpError(400, 'bad_path', 'Invalid path.');
  }
  if (decoded.startsWith('/my/')) throw new HttpError(404, 'not_found', 'Not found.');
  const filename = resolve(SITE_ROOT, `.${decoded}`);
  if (filename !== SITE_ROOT && !filename.startsWith(`${SITE_ROOT}${sep}`)) {
    throw new HttpError(404, 'not_found', 'Not found.');
  }
  const fileStat = await stat(filename).catch(() => null);
  if (!fileStat?.isFile()) throw new HttpError(404, 'not_found', 'Not found.');
  const extension = extname(filename).toLowerCase();
  const body = await readFile(filename);
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extension] || 'application/octet-stream',
    'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=604800'
  });
  response.end(headOnly ? undefined : body);
}

// Every JSON endpoint lives here so the method check and the rate limiter are
// applied in exactly one place. Adding a route to this table cannot leave it
// unguarded; adding one outside the table is what a reviewer should reject.
export const API_ROUTES = new Map([
  ['/api/character', (service, url) => service.lookup(validateLookup(url))],
  ['/api/talents', (service, url) => service.lookupTalents(validateLookup(url))],
  ['/api/profile', (service, url) => service.lookupProfile(validateLookup(url))],
  ['/api/achievements', (service, url) => service.lookupAchievements(validateLookup(url))],
  ['/api/realms', (service, url) => service.listRealms(validateRegion(url))],
  ['/api/season-rewards', (_service, url) => seasonRewards(validateSeasonQuery(url))]
]);

export function createApp(options = {}) {
  const characterService = options.characterService || createCharacterService(options);
  const allowRequest = createRateLimiter();

  return async function app(request, response) {
    setSecurityHeaders(response);
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
      }
      if (url.pathname === '/healthz') {
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(request.method === 'HEAD' ? undefined : 'ok\n');
        return;
      }
      const apiHandler = API_ROUTES.get(url.pathname);
      if (apiHandler) {
        if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
        if (!allowRequest(clientAddress(request))) throw new HttpError(429, 'rate_limited', 'Too many requests.', '60');
        json(response, 200, await apiHandler(characterService, url));
        return;
      }
      await serveStatic(url.pathname, response, request.method === 'HEAD');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : 'internal_error';
      const message = error instanceof HttpError ? error.message : 'Unexpected server error.';
      const headers = error.retryAfter ? { 'Retry-After': error.retryAfter } : {};
      if (request.url?.startsWith('/api/')) {
        json(response, status, { error: code, message }, headers, request.method === 'HEAD');
      }
      else {
        response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
        response.end(request.method === 'HEAD' ? undefined : `${status} ${message}\n`);
      }
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer(createApp());
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Consecrated Hammer listening on :${PORT}`);
  });

  function shutdown() {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
