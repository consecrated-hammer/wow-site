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

test('decodes a real loadout string identically to the Wowhead-based decoder', async () => {
  const { readFile } = await import('node:fs/promises');
  const { decodeLoadout, diffLoadouts } = await import('../lib/talent-decoder.mjs');
  const tree = JSON.parse(await readFile(new URL('./fixtures/talent-tree-holy-paladin.json', import.meta.url), 'utf8'));
  const code = (await readFile(new URL('./fixtures/bluehoof-loadout.txt', import.meta.url), 'utf8')).trim();

  const decoded = decodeLoadout(code, tree);
  assert.equal(decoded.className, 'Paladin');
  assert.equal(decoded.specName, 'Holy');
  assert.equal(decoded.specId, 65);
  assert.equal(decoded.version, 2);

  // Ground truth from Wowhead's calculator for this exact string:
  // Paladin "Spent: 34/34", Hero "Spent: 13/13", Holy "Spent: 34/34".
  // Wowhead counts POINTS; the node count is lower wherever a node is
  // multi-rank, so both numbers are asserted to keep them from drifting.
  assert.deepEqual(decoded.pointsSpent, { class: 34, spec: 34, hero: 13 });
  assert.deepEqual(decoded.counts, { class: 30, spec: 30, hero: 13 });
  // The original Wowhead-based decoder reports the same 30/30/13 nodes.
  const multiRank = [...decoded.talents.class, ...decoded.talents.spec].filter((t) => t.rank > 1);
  assert.equal(multiRank.length, 6, 'six multi-rank nodes account for the 8 extra points');
  assert.ok(multiRank.some((t) => t.name === 'Beacon of the Savior' && t.rank === 4));
  assert.ok(decoded.talents.hero.some((talent) => talent.name === 'Aurora'));
  assert.ok(decoded.talents.hero.every((talent) => talent.spellId));

  // Decoding against the wrong tree would produce plausible nonsense, so it
  // must fail loudly instead.
  assert.throws(() => decodeLoadout(code, { ...tree, specId: 66 }), /is for spec 65/);
  assert.throws(() => decodeLoadout('not-base64!', tree), /Invalid character/);

  const identical = diffLoadouts(decoded, decodeLoadout(code, tree));
  assert.equal(identical.identical, true);
  assert.equal(identical.comparable, true);
  assert.equal(identical.warning, null);
  assert.deepEqual(identical.take, []);
});

test('flags a talent diff as incomparable when the point budgets differ', async () => {
  const { readFile } = await import('node:fs/promises');
  const { decodeLoadout, diffLoadouts } = await import('../lib/talent-decoder.mjs');
  const tree = JSON.parse(await readFile(new URL('./fixtures/talent-tree-holy-paladin.json', import.meta.url), 'utf8'));
  const mine = decodeLoadout((await readFile(new URL('./fixtures/bluehoof-loadout.txt', import.meta.url), 'utf8')).trim(), tree);

  // ClassCodex's Season 1 Mythic+ build spends 59 points against this build's
  // 81. Diffing them yields a long "drop" list that is budget, not advice.
  const stale = decodeLoadout(
    'CEEAAAAAAAAAAAAAAAAAAAAAAAAAAYBAMDAwglxMzMzYmZWgxwyYbmZxMNxwYmZYY2yAwAwGYjlZmZWmtZmZrBAAAYhNMDbGYGzAAAmZYGjRD',
    tree
  );
  const diff = diffLoadouts(mine, stale);
  assert.equal(diff.comparable, false);
  assert.match(diff.warning, /different totals/);
  assert.match(diff.warning, /stale source/);
  assert.ok(diff.drop.length > 20, 'the raw difference is large, which is exactly why it needs the warning');
});

test('applies a different refresh rule per dataset and survives outages', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createReferenceData, POLICY } = await import('../lib/reference-data.mjs');

  const cacheDir = await mkdtemp(join(tmpdir(), 'wow-ref-'));
  let clock = Date.UTC(2026, 7, 17, 0, 0, 0);
  let build = '12.1.0.69299';
  let talentCalls = 0;
  let etagSent = null;
  let upstreamStatus = 200;

  // A contract-valid payload: 40 specs shaped like the real upstream file.
  const node = (id) => ({ id, name: `Node ${id}`, maxRanks: 1, entries: [{ id, name: `Talent ${id}`, spellId: 1000 + id }] });
  const payload = Array.from({ length: 40 }, (unused, index) => ({
    specId: 65 + index,
    className: 'Paladin',
    specName: `Spec${index}`,
    fullNodeOrder: [1, 2, 3],
    classNodes: [node(1)],
    specNodes: [node(2)],
    heroNodes: [node(3)]
  }));
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.includes('wago.tools')) {
      return { ok: true, json: async () => ({ wow: [{ version: build }] }) };
    }
    talentCalls += 1;
    etagSent = init.headers?.['if-none-match'] ?? null;
    if (upstreamStatus === 304) {
      return { status: 304, ok: false, headers: { get: () => null } };
    }
    if (upstreamStatus !== 200) {
      return { status: upstreamStatus, ok: false, headers: { get: () => null } };
    }
    return {
      status: 200, ok: true,
      headers: { get: (name) => (name === 'etag' ? '"abc123"' : null) },
      json: async () => payload
    };
  };

  try {
    const reference = createReferenceData({ cacheDir, fetchImpl, now: () => clock });

    const first = await reference.refreshTalentTrees();
    assert.equal(first.outcome, 'updated');
    assert.equal(talentCalls, 1);

    // Same build, inside the backstop: no upstream call at all.
    clock += 60_000;
    const second = await reference.refreshTalentTrees();
    assert.equal(second.outcome, 'skipped');
    assert.equal(talentCalls, 1, 'must not re-request while fresh');

    // A build change is a trigger even inside the backstop.
    clock += 60_000;
    build = '12.1.0.70000';
    upstreamStatus = 304;
    const onBuildChange = await reference.refreshTalentTrees();
    assert.equal(onBuildChange.outcome, 'unchanged');
    assert.match(onBuildChange.reason, /304/);
    assert.match(onBuildChange.trigger, /build changed/);
    assert.equal(etagSent, '"abc123"', 'revalidation must be conditional, not a full re-download');

    // The hotfix case: build unchanged, but the backstop elapses, so we still
    // revalidate. Without this, server-side tuning changes would be missed.
    clock += 25 * 60 * 60 * 1000;
    const beforeHotfixCheck = talentCalls;
    const onBackstop = await reference.refreshTalentTrees();
    assert.equal(talentCalls, beforeHotfixCheck + 1, 'backstop must revalidate even on an unchanged build');
    assert.match(onBackstop.trigger, /hotfixes/, 'the backstop, not the build, is why we checked');

    // Upstream failure degrades to the cached copy rather than to an error.
    clock += 25 * 60 * 60 * 1000;
    upstreamStatus = 503;
    const outage = await reference.refreshTalentTrees();
    assert.equal(outage.outcome, 'stale');
    const { data } = await reference.get('talent-trees');
    assert.equal(data[0].specId, 65, 'cached data still served during an outage');

    // Manual and synced datasets are never auto-refreshed.
    const rows = (await reference.status()).datasets;
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    assert.equal(byId['season-rules'].policy, POLICY.MANUAL);
    assert.equal(byId['season-rules'].stale, true, 'absent manual data reports as stale for a human');
    assert.equal(byId['classcodex'].policy, POLICY.SYNCED);
    assert.equal(byId['talent-trees'].present, true);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('parses ClassCodex Lua tables without executing them', async () => {
  const { parseLuaTable, extractAssignment } = await import('../lib/classcodex.mjs');

  assert.deepEqual(parseLuaTable('{ a = 1, b = "two", c = true, d = nil }'),
    { a: 1, b: 'two', c: true, d: null });
  assert.deepEqual(parseLuaTable('{ 1, 2, 3 }'), [1, 2, 3]);
  assert.deepEqual(parseLuaTable('{ ["holy"] = { label = "Holy Paladin" } }'),
    { holy: { label: 'Holy Paladin' } });
  // Nested, with a trailing comma and a comment, as the generated files have.
  assert.deepEqual(
    parseLuaTable('{ stats = { { "Mastery" }, { "Haste", "Critical Strike" } }, -- note\n }'),
    { stats: [['Mastery'], ['Haste', 'Critical Strike']] }
  );

  const source = 'ClassCodexData = ClassCodexData or {}\nClassCodexData["PALADIN"] = { ["holy"] = { label = "Holy" } }';
  const extracted = extractAssignment(source, 'ClassCodexData');
  assert.equal(extracted.classToken, 'PALADIN');
  assert.deepEqual(extracted.value, { holy: { label: 'Holy' } });
  assert.equal(extractAssignment(source, 'NotPresent'), null);
});

test('audits equipment against guidance and labels each side', async () => {
  const { auditGear } = await import('../lib/gear-audit.mjs');

  const equipment = {
    provenance: 'blizzard',
    character: { name: 'Bluehoof' },
    items: [
      { slotName: 'Main Hand', itemId: 193710, name: 'Spellboon Saber', itemLevel: 298 },
      { slotName: 'Legs', itemId: 249960, name: "Luminant Verdict's Greaves", itemLevel: 289 },
      { slotName: 'Head', itemId: 999999, name: 'Unknown Helm', itemLevel: 289 }
    ]
  };
  const guidance = {
    addonVersion: '0.36.3',
    lastScrape: '2026-07-02',
    bisGear: {
      archon: [{ label: 'Mythic+', slots: [
        { item: { itemId: 193710, name: 'Spellboon Saber' }, bis: true },
        { item: { itemId: 249960, name: "Luminant Verdict's Greaves" }, bis: false }
      ] }]
    },
    trinkets: [
      { itemId: 249343, tier: 'S', contexts: ['raid'], source: 'Chimaerus' },
      { itemId: 264507, tier: 'C', contexts: ['delves'] }
    ]
  };

  const audit = auditGear({ equipment, guidance });
  assert.deepEqual(audit.summary, {
    slotsEquipped: 3, slotsWithGuidance: 2, slotsAlreadyBis: 1, trinketUpgradesSuggested: 1
  });

  const weapon = audit.slots.find((slot) => slot.slot === 'Main Hand');
  assert.equal(weapon.equipped.provenance, 'blizzard', 'what you have is authoritative');
  assert.equal(weapon.recommendation.provenance, 'community', 'what you should have is opinion');
  assert.equal(weapon.recommendation.source, 'classcodex');
  assert.equal(weapon.recommendation.isBisSomewhere, true);

  // Guidance silence is not criticism: an unlisted slot gets no recommendation.
  assert.equal(audit.slots.find((slot) => slot.slot === 'Head').recommendation, null);
  // Only S/A trinkets are suggested, and they name the boss that drops them.
  assert.deepEqual(audit.trinketUpgrades.map((t) => t.droppedBy), ['Chimaerus']);
  assert.match(audit.guidance.staleness, /2026-07-02/);

  // The provider boundary is enforced, not assumed.
  assert.throws(
    () => auditGear({ equipment: { ...equipment, provenance: 'community' }, guidance }),
    /requires Blizzard-sourced equipment/
  );
});

test('rejects upstream data that breaks its contract without losing good data', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createReferenceData } = await import('../lib/reference-data.mjs');

  const cacheDir = await mkdtemp(join(tmpdir(), 'wow-contract-'));
  let clock = Date.UTC(2026, 7, 17, 0, 0, 0);
  let serveBroken = false;

  const node = (id) => ({ id, name: `Node ${id}`, maxRanks: 1, entries: [{ id, name: `Talent ${id}`, spellId: 1000 + id }] });
  const good = Array.from({ length: 40 }, (unused, index) => ({
    specId: 65 + index, className: 'Paladin', specName: `Spec${index}`,
    fullNodeOrder: [1, 2, 3], classNodes: [node(1)], specNodes: [node(2)], heroNodes: [node(3)]
  }));
  // The realistic break: upstream renames the field the decoder depends on.
  const broken = good.map(({ fullNodeOrder, ...rest }) => ({ ...rest, nodeOrder: fullNodeOrder }));

  const fetchImpl = async (url) => {
    if (String(url).includes('wago.tools')) return { ok: true, json: async () => ({ wow: [{ version: '12.1.0.1' }] }) };
    return {
      status: 200, ok: true,
      headers: { get: () => null },
      json: async () => (serveBroken ? broken : good)
    };
  };

  try {
    const reference = createReferenceData({ cacheDir, fetchImpl, now: () => clock });
    assert.equal((await reference.refreshTalentTrees()).outcome, 'updated');

    // Upstream changes its model. The refresh must not overwrite good data.
    serveBroken = true;
    clock += 25 * 60 * 60 * 1000;
    const rejected = await reference.refreshTalentTrees({ force: true });
    assert.equal(rejected.outcome, 'rejected');
    assert.match(rejected.reason, /keeping the last known-good copy/);
    const renamed = rejected.contractViolation.violations.find((v) => v.path === 'fullNodeOrder');
    assert.ok(renamed, 'the violation names the field that changed');
    assert.match(renamed.usedFor, /silently corrupts every decode/);

    // The critical property: consumers still get working data.
    const { data, meta } = await reference.get('talent-trees');
    assert.equal(data.length, 40, 'last known-good copy is still served');
    assert.ok(data[0].fullNodeOrder, 'and it still has the field the decoder needs');
    assert.ok(meta.contractViolation, 'while the violation is recorded for a human');

    // And the admin status surfaces it rather than hiding it.
    const row = (await reference.status()).datasets.find((entry) => entry.id === 'talent-trees');
    assert.equal(row.contractOk, false);
    assert.equal(row.present, true, 'still present and usable');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('a contract violation degrades a snapshot without throwing', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createReferenceData } = await import('../lib/reference-data.mjs');

  const cacheDir = await mkdtemp(join(tmpdir(), 'wow-snap-'));
  try {
    const reference = createReferenceData({ cacheDir, fetchImpl: async () => ({ ok: false }), now: () => 0 });
    // A restructured ClassCodex import must return a result, never throw,
    // because the MCP tool calling it has to keep answering.
    const result = await reference.putSnapshot('classcodex', { specs: { 'PALADIN/holy': {} } });
    assert.equal(result.outcome, 'unavailable');
    assert.ok(result.contractViolation.violations.length > 0);
    assert.match(result.reason, /previous copy is untouched/);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('a broken upstream contract never breaks the MCP surface', async () => {
  // The MCP tools forward to /api/*. If a reference dataset is rejected, those
  // endpoints must still answer with schema-valid output, because a tool that
  // throws takes the whole tool listing down for an agent mid-conversation.
  const stub = new Proxy({}, { get: () => async () => ({ ok: true }) });
  const app = createApp({ characterService: { ...stub, currentSeasonId: async () => 18 } });

  // Season data is independent of any upstream reference dataset.
  const season = await callApp(app, { method: 'GET', url: '/api/season-rewards?category=crests' });
  assert.equal(season.status, 200);
  assert.equal(JSON.parse(season.body).provenance, 'curated');

  // And when the season itself cannot be resolved, the endpoint still returns
  // 200 with a structured explanation rather than an error status, so the MCP
  // tool's success schema still validates.
  const appWithoutSeason = createApp({ characterService: { ...stub, currentSeasonId: async () => null } });
  const unresolved = await callApp(appWithoutSeason, { method: 'GET', url: '/api/season-rewards' });
  assert.equal(unresolved.status, 200);
  const body = JSON.parse(unresolved.body);
  assert.equal(body.seasonDataUnavailable, true);
  assert.ok(body.message, 'the agent is told why, in the success payload');
});

test('class guidance degrades instead of failing when data is missing', async () => {
  const { createGuidanceService } = await import('../lib/guidance.mjs');

  // No snapshot imported at all.
  const empty = createGuidanceService({
    referenceData: { get: async () => ({ data: null, meta: {} }), putSnapshot: async () => ({}) }
  });
  const missing = await empty.classGuidance({ className: 'paladin', spec: 'holy' });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /No ClassCodex snapshot/);
  assert.equal(missing.provenance, 'community');

  // Snapshot present, talent trees absent: builds still come back as import
  // strings with a warning, because an undecoded build is still usable.
  const snapshot = {
    addonVersion: '0.36.3',
    lastScrape: '2026-07-02',
    specs: {
      'PALADIN/holy': {
        classToken: 'PALADIN',
        spec: 'holy',
        guide: { priorities: [{ stats: [['Mastery']] }], talents: [{ context: 'Mythic+', exportString: 'CEEAAAA' }] }
      }
    }
  };
  const noTrees = createGuidanceService({
    referenceData: {
      get: async (id) => (id === 'classcodex' ? { data: snapshot, meta: {} } : { data: null, meta: {} }),
      putSnapshot: async () => ({})
    }
  });
  const degraded = await noTrees.classGuidance({ className: 'paladin', spec: 'holy', specId: 65 });
  assert.equal(degraded.available, true);
  assert.equal(degraded.talentBuilds[0].exportString, 'CEEAAAA', 'the import string survives');
  assert.equal(degraded.talentBuilds[0].decoded, undefined);
  assert.match(degraded.warnings.join(' '), /Talent trees are unavailable/);

  // An unknown spec says so and names some it does know.
  const unknown = await noTrees.classGuidance({ className: 'paladin', spec: 'nonsense' });
  assert.equal(unknown.available, false);
  assert.ok(unknown.knownSpecs.includes('PALADIN/holy'));
});

test('guidance and gear-audit routes are guarded and validated', async () => {
  const guidanceService = {
    classGuidance: async (query) => ({ available: true, echo: query }),
    gearAudit: async () => ({ summary: { slotsEquipped: 0 } })
  };
  const characterService = {
    guidance: guidanceService,
    lookup: async () => ({ items: [], character: { name: 'Bluehoof' } }),
    lookupProfile: async () => ({ characterClass: { name: 'Paladin' }, activeSpecialization: { name: 'Holy' } })
  };
  const app = createApp({ characterService });

  assert.ok(API_ROUTES.has('/api/class-guidance'), 'new routes join the guarded table');
  assert.ok(API_ROUTES.has('/api/gear-audit'));

  const ok = await callApp(app, { method: 'GET', url: '/api/class-guidance?class=paladin&spec=holy&specId=65' });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body).echo, { className: 'paladin', spec: 'holy', specId: 65 });

  for (const [query, code] of [
    ['class=&spec=holy', 'invalid_class'],
    ['class=paladin&spec=', 'invalid_spec'],
    ['class=paladin&spec=holy&specId=abc', 'invalid_spec_id'],
    ['class=<script>&spec=holy', 'invalid_class']
  ]) {
    const bad = await callApp(app, { method: 'GET', url: `/api/class-guidance?${query}` });
    assert.equal(bad.status, 400, query);
    assert.equal(JSON.parse(bad.body).error, code, query);
  }

  // The audit takes class and spec from Blizzard, never from the caller, so a
  // character can't be audited against another spec's guidance.
  let seen = null;
  characterService.guidance.gearAudit = async (args) => { seen = args; return { summary: {} }; };
  const audit = await callApp(app, { method: 'GET', url: '/api/gear-audit?region=us&realm=dathremar&name=Bluehoof&class=warrior&spec=arms' });
  assert.equal(audit.status, 200);
  assert.equal(seen.className, 'Paladin', 'class comes from the profile, not the query string');
  assert.equal(seen.spec, 'Holy');
  assert.equal(seen.equipment.provenance, 'blizzard');
});
