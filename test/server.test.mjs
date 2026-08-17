import assert from 'node:assert/strict';
import test from 'node:test';
import {
  API_ROUTES,
  SEASON_REWARD_CATEGORIES,
  seasonRewards,
  createApp,
  createCharacterService,
  clientAddress,
  findSeasonUpgrades,
  normaliseCharacter,
  normaliseRealm,
  resolveUpgrade
} from '../server.mjs';
import { PROVENANCE as P, assertGearProvenance as assertGear } from '../lib/providers.mjs';
import { resolveSeasonModule } from '../site/seasons/index.js';

function callApp(app, { method, url, address = '203.0.113.7' }) {
  return new Promise((resolve) => {
    const headers = {};
    const chunks = [];
    const response = {
      setHeader(name, value) { headers[name] = value; },
      writeHead(status, extra) { this.status = status; Object.assign(headers, extra || {}); },
      end(body) { if (body) chunks.push(body); resolve({ status: this.status, headers, body: chunks.join('') }); }
    };
    app({ method, url, headers: { 'x-forwarded-for': `198.51.100.1, ${address}` }, socket: { remoteAddress: '172.18.0.2' } }, response);
  });
}

test('normalises Blizzard realm and character path values', () => {
  assert.equal(normaliseRealm(" Dath'Remar "), 'dathremar');
  assert.equal(normaliseRealm('Area 52'), 'area-52');
  assert.equal(normaliseRealm('아즈샤라'), '아즈샤라');
  assert.equal(normaliseCharacter(' Bluehoof '), 'bluehoof');
});

test('uses the proxy-appended address instead of a client-supplied XFF value', () => {
  assert.equal(clientAddress({
    headers: { 'x-forwarded-for': '198.51.100.9, 203.0.113.42' },
    socket: { remoteAddress: '172.18.0.2' }
  }), '203.0.113.42');
});

test('resolves an exact Midnight Season 2 track from Blizzard bonus IDs', () => {
  assert.deepEqual(
    resolveUpgrade({
      level: { value: 292 },
      bonus_list: [12833, 13439, 6652],
      name_description: { display_string: 'Mythic' }
    }),
    {
      kind: 'season-track',
      season: 'Midnight 12.1',
      track: 'Champion',
      rank: 1,
      ranks: 6,
      currentItemLevel: 292,
      maximumItemLevel: 308,
      upgradesRemaining: 5,
      crestName: 'Champion Mistcrests',
      crestCostRemaining: 100
    }
  );
});

test('does not reinterpret legacy and special gear as a current track', () => {
  assert.equal(resolveUpgrade({
    level: { value: 289 },
    bonus_list: [12806],
    name_description: { display_string: 'Mythic+' }
  }).kind, 'legacy-or-unknown');

  assert.deepEqual(resolveUpgrade({
    level: { value: 298 },
    bonus_list: [13654],
    name_description: { display_string: 'Mythic+ Ascendant Voidforged: Myth' }
  }), {
    kind: 'special',
    label: 'Mythic+ Ascendant Voidforged: Myth',
    currentItemLevel: 298
  });
});

test('finds the first rank in every Season 2 track that beats an equipped item', () => {
  assert.deepEqual(findSeasonUpgrades(289), [
    { track: 'Veteran', rank: 5, ranks: 6, itemLevel: 292, maximumItemLevel: 295, crestCostFromRankOne: 80 },
    { track: 'Champion', rank: 1, ranks: 6, itemLevel: 292, maximumItemLevel: 308, crestCostFromRankOne: 0 },
    { track: 'Hero', rank: 1, ranks: 6, itemLevel: 305, maximumItemLevel: 321, crestCostFromRankOne: 0 },
    { track: 'Myth', rank: 1, ranks: 6, itemLevel: 318, maximumItemLevel: 334, crestCostFromRankOne: 0 }
  ]);
  assert.deepEqual(findSeasonUpgrades(334), []);
  assert.deepEqual(findSeasonUpgrades(null), []);
});

test('caches character responses and guards forced refreshes', async () => {
  const originalId = process.env.BLIZZARD_CLIENT_ID;
  const originalSecret = process.env.BLIZZARD_CLIENT_SECRET;
  process.env.BLIZZARD_CLIENT_ID = 'test-id';
  process.env.BLIZZARD_CLIENT_SECRET = 'test-secret';
  let clock = Date.UTC(2026, 7, 15, 0, 0, 0);
  let equipmentCalls = 0;
  let failEquipment = false;

  const fetchImpl = async (input) => {
    const url = String(input);
    if (url === 'https://oauth.battle.net/token') {
      return Response.json({ access_token: 'token', expires_in: 86400 });
    }
    if (url.includes('/equipment')) {
      equipmentCalls += 1;
      if (failEquipment) return new Response('{}', { status: 503 });
      return Response.json({
        character: { name: 'Bluehoof', realm: { name: "Dath'Remar" } },
        equipped_items: [{
          slot: { type: 'HEAD', name: 'Head' },
          item: { id: 251126 },
          name: 'Greathelm of Temptation',
          level: { value: 292 },
          quality: { type: 'EPIC' },
          name_description: { display_string: 'Mythic' },
          bonus_list: [12833],
          media: { key: { href: 'https://us.api.blizzard.com/data/wow/media/item/251126' } }
        }]
      });
    }
    if (url.includes('/media/item/')) {
      return Response.json({ assets: [{ key: 'icon', value: 'https://render.example/icon.jpg' }] });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const service = createCharacterService({
      fetchImpl,
      now: () => clock,
      characterTtlMs: 300_000,
      refreshCooldownMs: 60_000
    });
    const query = { region: 'us', realm: 'dathremar', character: 'bluehoof' };

    const first = await service.lookup(query);
    assert.equal(first.cache.status, 'miss');
    assert.equal(equipmentCalls, 1);

    const cached = await service.lookup(query);
    assert.equal(cached.cache.status, 'hit');
    assert.equal(equipmentCalls, 1);

    clock += 30_000;
    const guarded = await service.lookup({ ...query, forceRefresh: true });
    assert.equal(guarded.cache.status, 'refresh-cooldown');
    assert.equal(equipmentCalls, 1);

    clock += 31_000;
    const refreshed = await service.lookup({ ...query, forceRefresh: true });
    assert.equal(refreshed.cache.status, 'refreshed');
    assert.equal(equipmentCalls, 2);

    clock += 61_000;
    failEquipment = true;
    const stale = await service.lookup({ ...query, forceRefresh: true });
    assert.equal(stale.cache.status, 'stale');
    assert.equal(equipmentCalls, 3);

    clock += 30_000;
    failEquipment = false;
    const hitAfterFailedRefresh = await service.lookup(query);
    assert.equal(hitAfterFailedRefresh.cache.status, 'hit');
    assert.ok(new Date(hitAfterFailedRefresh.cache.refreshAvailableAt).getTime() > clock);

    const retryGuarded = await service.lookup({ ...query, forceRefresh: true });
    assert.equal(retryGuarded.cache.status, 'refresh-cooldown');
    assert.equal(equipmentCalls, 3);
    assert.ok(new Date(retryGuarded.cache.refreshAvailableAt).getTime() > clock);
  } finally {
    if (originalId === undefined) delete process.env.BLIZZARD_CLIENT_ID;
    else process.env.BLIZZARD_CLIENT_ID = originalId;
    if (originalSecret === undefined) delete process.env.BLIZZARD_CLIENT_SECRET;
    else process.env.BLIZZARD_CLIENT_SECRET = originalSecret;
  }
});

test('coalesces concurrent OAuth token requests at cold start', async () => {
  const originalId = process.env.BLIZZARD_CLIENT_ID;
  const originalSecret = process.env.BLIZZARD_CLIENT_SECRET;
  process.env.BLIZZARD_CLIENT_ID = 'test-id';
  process.env.BLIZZARD_CLIENT_SECRET = 'test-secret';
  let tokenCalls = 0;

  const fetchImpl = async (input) => {
    const url = String(input);
    if (url === 'https://oauth.battle.net/token') {
      tokenCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({ access_token: 'token', expires_in: 86400 });
    }
    if (url.includes('/equipment')) {
      return Response.json({ character: { name: 'Test', realm: { name: 'Realm' } }, equipped_items: [] });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const service = createCharacterService({ fetchImpl });
    await Promise.all([
      service.lookup({ region: 'us', realm: 'realm', character: 'one' }),
      service.lookup({ region: 'us', realm: 'realm', character: 'two' })
    ]);
    assert.equal(tokenCalls, 1);
  } finally {
    if (originalId === undefined) delete process.env.BLIZZARD_CLIENT_ID;
    else process.env.BLIZZARD_CLIENT_ID = originalId;
    if (originalSecret === undefined) delete process.env.BLIZZARD_CLIENT_SECRET;
    else process.env.BLIZZARD_CLIENT_SECRET = originalSecret;
  }
});

test('coalesces concurrent media requests for the same item icon', async () => {
  const originalId = process.env.BLIZZARD_CLIENT_ID;
  const originalSecret = process.env.BLIZZARD_CLIENT_SECRET;
  process.env.BLIZZARD_CLIENT_ID = 'test-id';
  process.env.BLIZZARD_CLIENT_SECRET = 'test-secret';
  let mediaCalls = 0;

  const fetchImpl = async (input) => {
    const url = String(input);
    if (url === 'https://oauth.battle.net/token') {
      return Response.json({ access_token: 'token', expires_in: 86400 });
    }
    if (url.includes('/equipment')) {
      return Response.json({
        character: { name: 'Test', realm: { name: 'Realm' } },
        equipped_items: [{
          slot: { type: 'HEAD', name: 'Head' }, item: { id: 1 }, name: 'Shared Helm',
          level: { value: 289 }, quality: { type: 'EPIC' }, bonus_list: [12806],
          media: { key: { href: 'https://us.api.blizzard.com/data/wow/media/item/1' } }
        }]
      });
    }
    if (url.includes('/media/item/')) {
      mediaCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({ assets: [{ key: 'icon', value: 'https://render.example/icon.jpg' }] });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const service = createCharacterService({ fetchImpl });
    const results = await Promise.all([
      service.lookup({ region: 'us', realm: 'realm', character: 'one' }),
      service.lookup({ region: 'us', realm: 'realm', character: 'two' })
    ]);
    assert.equal(mediaCalls, 1);
    assert.equal(results[0].items[0].icon, 'https://render.example/icon.jpg');
    assert.equal(results[1].items[0].icon, 'https://render.example/icon.jpg');
  } finally {
    if (originalId === undefined) delete process.env.BLIZZARD_CLIENT_ID;
    else process.env.BLIZZARD_CLIENT_ID = originalId;
    if (originalSecret === undefined) delete process.env.BLIZZARD_CLIENT_SECRET;
    else process.env.BLIZZARD_CLIENT_SECRET = originalSecret;
  }
});

test('loads, filters, sorts, and caches Blizzard realm indexes', async () => {
  const originalId = process.env.BLIZZARD_CLIENT_ID;
  const originalSecret = process.env.BLIZZARD_CLIENT_SECRET;
  process.env.BLIZZARD_CLIENT_ID = 'test-id';
  process.env.BLIZZARD_CLIENT_SECRET = 'test-secret';
  let realmCalls = 0;
  let clock = Date.UTC(2026, 7, 16, 0, 0, 0);

  const fetchImpl = async (input) => {
    const url = String(input);
    if (url === 'https://oauth.battle.net/token') {
      return Response.json({ access_token: 'token', expires_in: 86400 });
    }
    if (url.includes('/realm/index')) {
      realmCalls += 1;
      return Response.json({
        realms: [
          { id: 2, name: 'Zulu', slug: 'zulu' },
          { id: 3, name: 'US1 Partner', slug: 'us1-partner' },
          { id: 1, name: 'Alpha', slug: 'alpha' },
          { id: 4, name: null, slug: 'hidden' }
        ]
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const service = createCharacterService({ fetchImpl, now: () => clock, realmTtlMs: 1000 });
    const first = await service.listRealms('us');
    const second = await service.listRealms('us');
    assert.deepEqual(first.realms, [
      { id: 1, name: 'Alpha', slug: 'alpha' },
      { id: 2, name: 'Zulu', slug: 'zulu' }
    ]);
    assert.deepEqual(second, first);
    assert.equal(realmCalls, 1);
    clock += 1001;
    await service.listRealms('us');
    assert.equal(realmCalls, 2);
  } finally {
    if (originalId === undefined) delete process.env.BLIZZARD_CLIENT_ID;
    else process.env.BLIZZARD_CLIENT_ID = originalId;
    if (originalSecret === undefined) delete process.env.BLIZZARD_CLIENT_SECRET;
    else process.env.BLIZZARD_CLIENT_SECRET = originalSecret;
  }
});

test('distinguishes missing characters from other missing Blizzard resources', async () => {
  const originalId = process.env.BLIZZARD_CLIENT_ID;
  const originalSecret = process.env.BLIZZARD_CLIENT_SECRET;
  process.env.BLIZZARD_CLIENT_ID = 'test-id';
  process.env.BLIZZARD_CLIENT_SECRET = 'test-secret';

  const fetchImpl = async (input) => {
    const url = String(input);
    if (url === 'https://oauth.battle.net/token') {
      return Response.json({ access_token: 'token', expires_in: 86400 });
    }
    return new Response('{}', { status: 404 });
  };

  try {
    const service = createCharacterService({ fetchImpl });
    await assert.rejects(
      service.lookup({ region: 'us', realm: 'dathremar', character: 'missing' }),
      { status: 404, code: 'character_not_found', message: 'Character not found.' }
    );
    await assert.rejects(
      service.listRealms('us'),
      { status: 404, code: 'upstream_not_found', message: 'Blizzard resource not found.' }
    );
  } finally {
    if (originalId === undefined) delete process.env.BLIZZARD_CLIENT_ID;
    else process.env.BLIZZARD_CLIENT_ID = originalId;
    if (originalSecret === undefined) delete process.env.BLIZZARD_CLIENT_SECRET;
    else process.env.BLIZZARD_CLIENT_SECRET = originalSecret;
  }
});

test('retries transient media failures instead of caching a missing icon', async () => {
  const originalId = process.env.BLIZZARD_CLIENT_ID;
  const originalSecret = process.env.BLIZZARD_CLIENT_SECRET;
  process.env.BLIZZARD_CLIENT_ID = 'test-id';
  process.env.BLIZZARD_CLIENT_SECRET = 'test-secret';
  let mediaCalls = 0;

  const fetchImpl = async (input) => {
    const url = String(input);
    if (url === 'https://oauth.battle.net/token') {
      return Response.json({ access_token: 'token', expires_in: 86400 });
    }
    if (url.includes('/equipment')) {
      return Response.json({
        character: { name: 'Test', realm: { name: 'Realm' } },
        equipped_items: [{
          slot: { type: 'HEAD', name: 'Head' },
          item: { id: 1 },
          name: 'Test Helm',
          level: { value: 292 },
          quality: { type: 'EPIC' },
          bonus_list: [12833],
          media: { key: { href: 'https://us.api.blizzard.com/data/wow/media/item/1' } }
        }]
      });
    }
    if (url.includes('/media/item/')) {
      mediaCalls += 1;
      if (mediaCalls === 1) return new Response('{}', { status: 503 });
      return Response.json({ assets: [{ key: 'icon', value: 'https://render.example/icon.jpg' }] });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const service = createCharacterService({ fetchImpl });
    const first = await service.lookup({ region: 'us', realm: 'realm', character: 'one' });
    const second = await service.lookup({ region: 'us', realm: 'realm', character: 'two' });
    assert.equal(first.items[0].icon, null);
    assert.equal(second.items[0].icon, 'https://render.example/icon.jpg');
    assert.equal(mediaCalls, 2);
  } finally {
    if (originalId === undefined) delete process.env.BLIZZARD_CLIENT_ID;
    else process.env.BLIZZARD_CLIENT_ID = originalId;
    if (originalSecret === undefined) delete process.env.BLIZZARD_CLIENT_SECRET;
    else process.env.BLIZZARD_CLIENT_SECRET = originalSecret;
  }
});

test('classifies malformed successful Blizzard responses as upstream errors', async () => {
  const originalId = process.env.BLIZZARD_CLIENT_ID;
  const originalSecret = process.env.BLIZZARD_CLIENT_SECRET;
  process.env.BLIZZARD_CLIENT_ID = 'test-id';
  process.env.BLIZZARD_CLIENT_SECRET = 'test-secret';

  const fetchImpl = async (input) => {
    if (String(input) === 'https://oauth.battle.net/token') {
      return Response.json({ access_token: 'token', expires_in: 86400 });
    }
    return new Response('<html>temporary error</html>', { status: 200 });
  };

  try {
    const service = createCharacterService({ fetchImpl });
    await assert.rejects(
      service.listRealms('us'),
      { status: 502, code: 'upstream_error', message: 'Blizzard returned an invalid response.' }
    );
  } finally {
    if (originalId === undefined) delete process.env.BLIZZARD_CLIENT_ID;
    else process.env.BLIZZARD_CLIENT_ID = originalId;
    if (originalSecret === undefined) delete process.env.BLIZZARD_CLIENT_SECRET;
    else process.env.BLIZZARD_CLIENT_SECRET = originalSecret;
  }
});

test('normalises and independently caches talents, profile progression, and recent achievements', async () => {
  const originalId = process.env.BLIZZARD_CLIENT_ID;
  const originalSecret = process.env.BLIZZARD_CLIENT_SECRET;
  process.env.BLIZZARD_CLIENT_ID = 'test-id';
  process.env.BLIZZARD_CLIENT_SECRET = 'test-secret';
  const calls = new Map();

  const respond = (key, payload) => {
    calls.set(key, (calls.get(key) || 0) + 1);
    return Response.json(payload);
  };
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url === 'https://oauth.battle.net/token') {
      return Response.json({ access_token: 'token', expires_in: 86400 });
    }
    if (url.includes('/specializations')) {
      return respond('talents', {
        character: { name: 'Bluehoof', realm: { name: "Dath'Remar", slug: 'dathremar', id: 3735 } },
        active_specialization: { id: 65, name: 'Holy' },
        active_hero_talent_tree: { id: 50, name: 'Herald of the Sun' },
        specializations: [{
          specialization: { id: 65, name: 'Holy' },
          loadouts: [{
            is_active: true,
            talent_loadout_code: 'IMPORT-CODE',
            selected_class_talents: [{ id: 1, rank: 1, tooltip: { talent: { id: 2, name: 'Lay on Hands' }, spell_tooltip: { spell: { id: 633 } } } }],
            selected_spec_talents: [],
            selected_hero_talents: [],
            selected_pvp_talent_slots: []
          }]
        }]
      });
    }
    if (url.includes('/mythic-keystone-profile/season/17')) {
      return respond('mythic-season', {
        mythic_rating: { rating: 3034.8923 },
        best_runs: [{
          dungeon: { id: 560, name: 'Maisara Caverns' },
          keystone_level: 12,
          is_completed_within_time: true,
          duration: 1735102,
          mythic_rating: { rating: 369.6382 },
          completed_timestamp: Date.UTC(2026, 7, 1)
        }]
      });
    }
    if (url.includes('/mythic-keystone-profile')) {
      return respond('mythic-index', { seasons: [{ id: 17 }] });
    }
    if (url.includes('/achievements')) {
      return respond('achievements', {
        character: { name: 'Bluehoof', realm: { name: "Dath'Remar", slug: 'dathremar', id: 3735 } },
        total_quantity: 3201,
        total_points: 24710,
        recent_events: [{ achievement: { id: 61643, name: 'Mythic: Den of Nalorakk' }, timestamp: Date.UTC(2026, 7, 2) }]
      });
    }
    if (url.includes('/profile/wow/character/dathremar/bluehoof?')) {
      return respond('profile', {
        name: 'Bluehoof',
        realm: { name: "Dath'Remar", slug: 'dathremar', id: 3735 },
        level: 90,
        faction: { name: 'Alliance' },
        race: { id: 11, name: 'Draenei' },
        character_class: { id: 2, name: 'Paladin' },
        active_spec: { id: 65, name: 'Holy' },
        guild: { id: 7, name: 'Checklist Champions' },
        average_item_level: 290,
        equipped_item_level: 290,
        achievement_points: 24710,
        last_login_timestamp: Date.UTC(2026, 7, 3)
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const service = createCharacterService({ fetchImpl });
    const query = { region: 'us', realm: 'dathremar', character: 'bluehoof' };
    const talents = await service.lookupTalents(query);
    const profile = await service.lookupProfile(query);
    const achievements = await service.lookupAchievements(query);
    await service.lookupTalents(query);
    await service.lookupProfile(query);
    await service.lookupAchievements(query);

    assert.equal(talents.activeSpecialization.name, 'Holy');
    assert.equal(talents.loadout.importCode, 'IMPORT-CODE');
    assert.equal(talents.loadout.classTalents[0].name, 'Lay on Hands');
    assert.equal(profile.character.realmSlug, 'dathremar');
    assert.equal(profile.mythicPlus.rating, 3034.8923);
    assert.equal(profile.mythicPlusWarning, null);
    assert.equal(profile.mythicPlus.bestRuns[0].dungeon, 'Maisara Caverns');
    assert.equal(achievements.totalCompleted, 3201);
    assert.equal(achievements.recentAchievements[0].id, 61643);
    assert.deepEqual(Object.fromEntries(calls), {
      talents: 1,
      profile: 1,
      'mythic-index': 1,
      'mythic-season': 1,
      achievements: 1
    });
  } finally {
    if (originalId === undefined) delete process.env.BLIZZARD_CLIENT_ID;
    else process.env.BLIZZARD_CLIENT_ID = originalId;
    if (originalSecret === undefined) delete process.env.BLIZZARD_CLIENT_SECRET;
    else process.env.BLIZZARD_CLIENT_SECRET = originalSecret;
  }
});

test('keeps profile data available when the optional Mythic+ endpoint fails', async () => {
  const originalId = process.env.BLIZZARD_CLIENT_ID;
  const originalSecret = process.env.BLIZZARD_CLIENT_SECRET;
  process.env.BLIZZARD_CLIENT_ID = 'test-id';
  process.env.BLIZZARD_CLIENT_SECRET = 'test-secret';

  const fetchImpl = async (input) => {
    const url = String(input);
    if (url === 'https://oauth.battle.net/token') {
      return Response.json({ access_token: 'token', expires_in: 86400 });
    }
    if (url.includes('/mythic-keystone-profile')) return new Response('{}', { status: 503 });
    if (url.includes('/profile/wow/character/realm/test?')) {
      return Response.json({
        name: 'Test',
        realm: { name: 'Realm', slug: 'realm', id: 1 },
        level: 90,
        achievement_points: 100
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const service = createCharacterService({ fetchImpl });
    const profile = await service.lookupProfile({ region: 'us', realm: 'realm', character: 'test' });
    assert.equal(profile.character.name, 'Test');
    assert.equal(profile.mythicPlus, null);
    assert.equal(profile.mythicPlusWarning, 'Mythic+ data is temporarily unavailable.');
  } finally {
    if (originalId === undefined) delete process.env.BLIZZARD_CLIENT_ID;
    else process.env.BLIZZARD_CLIENT_ID = originalId;
    if (originalSecret === undefined) delete process.env.BLIZZARD_CLIENT_SECRET;
    else process.env.BLIZZARD_CLIENT_SECRET = originalSecret;
  }
});

test('guards every API route against non-GET methods and rate limits', async () => {
  // Iterates API_ROUTES rather than naming paths, so a route added to the
  // table is covered here automatically and one added outside it is not
  // reachable at all.
  assert.ok(API_ROUTES.size >= 5, 'expected the known API routes to be registered');

  const stub = new Proxy({}, { get: () => async () => ({ ok: true }) });

  for (const pathname of API_ROUTES.keys()) {
    const app = createApp({ characterService: stub });

    const post = await callApp(app, { method: 'POST', url: pathname });
    assert.equal(post.status, 405, `${pathname} must reject non-GET`);
    assert.equal(JSON.parse(post.body).error, 'method_not_allowed');

    const head = await callApp(app, { method: 'HEAD', url: pathname });
    assert.equal(head.status, 405, `${pathname} must reject HEAD`);

    let limited = null;
    for (let attempt = 0; attempt < 62 && !limited; attempt += 1) {
      const result = await callApp(app, { method: 'GET', url: pathname });
      if (result.status === 429) limited = result;
    }
    assert.ok(limited, `${pathname} must be rate limited`);
    assert.equal(JSON.parse(limited.body).error, 'rate_limited');
    assert.equal(limited.headers['Retry-After'], '60');
  }
});

test('labels every season reward response as curated, never Blizzard output', () => {
  for (const category of SEASON_REWARD_CATEGORIES) {
    const itemLevel = category === 'recommended_activities' ? 289 : null;
    const result = seasonRewards({ category, itemLevel, seasonId: 18 });
    assert.equal(result.provenance, 'curated', `${category} must declare curated provenance`);
    assert.equal(result.season, 'Midnight Season 2');
    assert.equal(result.patch, '12.1');
    assert.ok(result.verifiedAt, `${category} must carry verifiedAt`);
    assert.ok(Array.isArray(result.sources) && result.sources.length > 0);
    assert.equal(result.category, category);
  }
});

test('reports unconfirmed crest quantities as null rather than guessing', () => {
  const { mythicPlus } = seasonRewards({ category: 'mythic_plus', itemLevel: null, seasonId: 18 });
  assert.equal(mythicPlus.keys.length, 10);
  for (const entry of mythicPlus.keys) {
    assert.equal(entry.crestQuantity.amount, null, `${entry.key} must not invent a crest quantity`);
    assert.equal(entry.crestQuantity.confirmed, false);
    assert.ok(entry.crestType, `${entry.key} must still name its crest type`);
  }
});

test('derives deterministic activity advice with the rule that selected it', () => {
  const { recommendedActivities } = seasonRewards({ category: 'recommended_activities', itemLevel: 289, seasonId: 18, asOf: '2026-09-30' });
  assert.equal(recommendedActivities.advisory, true);
  assert.equal(recommendedActivities.provenance, 'curated');
  assert.ok(recommendedActivities.suggestions.length > 0);
  for (const suggestion of recommendedActivities.suggestions) {
    assert.ok(suggestion.rewardItemLevel > 289, 'must only suggest activities that beat the supplied level');
    assert.match(suggestion.reason, /289/, 'each suggestion must explain itself against the supplied level');
  }
  // Regression for the review finding: a well-geared character must still be
  // offered later raid bosses, not a false "nothing improves your gear".
  const geared = seasonRewards({ category: 'recommended_activities', itemLevel: 330, seasonId: 18, asOf: '2026-09-30' });
  const raid = geared.recommendedActivities.suggestions.find((entry) => entry.source === 'raid');
  assert.ok(raid, 'ilvl 330 must still be offered the 344 raid band');
  assert.equal(raid.rewardItemLevel, 344);
  assert.match(raid.reason, /bosses 7-8/);

  // Only past the top of every listed reward is an empty answer correct.
  const topped = seasonRewards({ category: 'recommended_activities', itemLevel: 999, seasonId: 18, asOf: '2026-09-30' });
  assert.deepEqual(topped.recommendedActivities.suggestions, []);
});

test('rejects unknown categories and item levels at the query boundary', async () => {
  const app = createApp({ characterService: new Proxy({}, { get: () => async () => ({}) }) });
  const bad = await callApp(app, { method: 'GET', url: '/api/season-rewards?category=loot_pinata' });
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.body).error, 'invalid_category');

  const missing = await callApp(app, { method: 'GET', url: '/api/season-rewards?category=recommended_activities' });
  assert.equal(missing.status, 400);
  assert.equal(JSON.parse(missing.body).error, 'item_level_required');

  const fractional = await callApp(app, { method: 'GET', url: '/api/season-rewards?itemLevel=289.5' });
  assert.equal(fractional.status, 400);
  assert.equal(JSON.parse(fractional.body).error, 'invalid_item_level');
});

test('never serves a previous season\'s tables for an unknown season', () => {
  // The failure this guards against is silent and confidently wrong: serving
  // Season 2 Delve values into Season 3.
  assert.equal(resolveSeasonModule(18)?.seasonId, 18);
  assert.equal(resolveSeasonModule(19), null);

  const unknown = seasonRewards({ category: 'all', itemLevel: null, seasonId: 19 });
  assert.equal(unknown.seasonDataUnavailable, true);
  assert.equal(unknown.seasonId, 19);
  assert.deepEqual(unknown.knownSeasonIds, [18]);
  assert.equal(unknown.delves, undefined, 'must not leak another season\'s tables');
  assert.equal(unknown.mythicPlus, undefined);

  const missing = seasonRewards({ category: 'all', itemLevel: null, seasonId: null });
  assert.equal(missing.seasonDataUnavailable, true);
});

test('only recommends raid content that is actually open on the given date', () => {
  const before = seasonRewards({ category: 'recommended_activities', itemLevel: 289, seasonId: 18, asOf: '2026-08-18' });
  const beforeRaid = before.recommendedActivities.suggestions.find((s) => s.source === 'raid');
  assert.equal(beforeRaid, undefined, 'nothing is open on 18 Aug');
  assert.ok(before.recommendedActivities.lockedUntilOpen.length > 0, 'locked content is reported, not hidden');
  assert.ok(before.recommendedActivities.lockedUntilOpen.every((e) => e.opensOn));

  // 20 Aug: LFR Wing 1 and Normal/Heroic are open, Mythic is not. At ilvl 289
  // the lowest beating reward is Normal (292), which is not wing-gated.
  const after = seasonRewards({ category: 'recommended_activities', itemLevel: 289, seasonId: 18, asOf: '2026-08-20' });
  const afterRaid = after.recommendedActivities.suggestions.find((s) => s.source === 'raid');
  assert.ok(afterRaid, 'open content is offered once its date passes');
  assert.match(afterRaid.activity, /^Normal/);

  // At ilvl 270 the answer is LFR, which is wing-gated, so the wing state shows.
  const lowGeared = seasonRewards({ category: 'recommended_activities', itemLevel: 270, seasonId: 18, asOf: '2026-08-20' });
  const lfrPick = lowGeared.recommendedActivities.suggestions.find((s) => s.source === 'raid');
  assert.match(lfrPick.activity, /^LFR/);
  assert.match(lfrPick.reason, /Wing 1 open/);
  assert.match(lfrPick.reason, /next opens 2026-08-26/);

  const { raidAvailability } = resolveSeasonModule(18);
  assert.equal(raidAvailability('Mythic', '2026-08-20').open, false);
  assert.equal(raidAvailability('Mythic', '2026-08-26').open, true);
  const lfr = raidAvailability('LFR', '2026-08-20');
  assert.deepEqual(lfr.wings.open.map((w) => w.wing), [1]);
  assert.deepEqual(lfr.wings.locked.map((w) => w.wing), [2, 3, 4]);
  assert.deepEqual(lfr.wings.open[0].bosses, ["Nek'zali the Soulcoiler", 'The Twin Fangs']);
});

test('bounds crest spending by the weekly cap, not the balance', () => {
  const { planCrestSpend } = resolveSeasonModule(18);

  // Under the cap: spend what you have.
  const small = planCrestSpend({ Champion: 60 }).crests[0];
  assert.equal(small.ranksAffordableThisWeek, 3);
  assert.equal(small.capLimited, false);

  // Over the cap: the cap decides the week, not the balance.
  const large = planCrestSpend({ Champion: 400 }).crests[0];
  assert.equal(large.ranksAffordableThisWeek, 5, '100/week cap at 20 per rank');
  assert.equal(large.capLimited, true);
  assert.match(large.note, /waits for reset/);

  assert.equal(planCrestSpend({ Champion: 400 }).provenance, 'user');
  assert.throws(() => planCrestSpend({ Champion: -1 }), TypeError);
  assert.throws(() => planCrestSpend({ Champion: 1.5 }), TypeError);
});

test('enforces that equipment can only ever be Blizzard-sourced', () => {
  const gear = { provenance: P.BLIZZARD, items: [{ slot: 'HEAD', itemLevel: 292 }] };
  assert.equal(assertGear(gear), gear);
  assert.throws(
    () => assertGear({ provenance: P.COMMUNITY, source: 'classcodex', items: [{ slot: 'HEAD', itemLevel: 292 }] }),
    /Equipment must be provenance 'blizzard'/
  );
  // Recommendations about gear are not gear and are checked by their own provenance.
  const advice = { provenance: P.COMMUNITY, source: 'classcodex', recommendations: [{ itemId: 1 }] };
  assert.equal(assertGear(advice), advice);
});
