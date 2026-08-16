import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCharacterService,
  clientAddress,
  findSeasonUpgrades,
  normaliseCharacter,
  normaliseRealm,
  resolveUpgrade
} from '../server.mjs';

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
