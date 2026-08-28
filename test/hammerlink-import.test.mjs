import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import { HammerLinkImportError, parseHammerLinkExport } from '../lib/hammerlink-import.mjs';

const now = Date.UTC(2026, 7, 17, 6, 0, 0);
const fixturePath = new URL('./fixtures/hammerlink-valid.hl1', import.meta.url);

async function fixture() {
  return (await readFile(fixturePath, 'utf8')).trim();
}

function encodeForPrint(buffer) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()';
  let output = '';
  let cache = 0;
  let bitLength = 0;
  for (const byte of buffer) {
    cache += byte * (2 ** bitLength);
    bitLength += 8;
    while (bitLength >= 6) {
      output += alphabet[cache & 63];
      cache >>>= 6;
      bitLength -= 6;
    }
  }
  if (bitLength > 0) output += alphabet[cache & 63];
  return output;
}

function exportSnapshot(snapshot) {
  return `HL1:${encodeForPrint(deflateRawSync(JSON.stringify(snapshot), { level: 9 }))}`;
}

test('decodes and validates a controlled HammerLink HL1 export', async () => {
  const snapshot = parseHammerLinkExport(await fixture(), { now });
  assert.equal(snapshot.format, 1);
  assert.equal(snapshot.character.name, 'Bluehoof');
  assert.equal(snapshot.character.realm, "Dath'Remar");
  assert.equal(snapshot.equipment[0].slot, 'HEAD');
  assert.equal(snapshot.vault.activities[0].progress, 4);
});

for (const [name, mutate, code] of [
  ['wrong envelope', (value) => value.replace('HL1:', 'HL2:'), 'unsupported-envelope'],
  ['invalid printable character', (value) => `${value.slice(0, -1)}!`, 'invalid-encoding'],
  ['truncated compressed data', (value) => value.slice(0, -8), 'decompression-failed'],
  ['stale capture time', (value) => value, 'stale-export']
]) {
  test(`rejects ${name}`, async () => {
    const options = name === 'stale capture time'
      ? { now: now + 32 * 24 * 60 * 60 * 1000 }
      : { now };
    const input = mutate(await fixture());
    assert.throws(() => parseHammerLinkExport(input, options), (error) => {
      assert.ok(error instanceof HammerLinkImportError);
      assert.equal(error.code, code);
      return true;
    });
  });
}

test('never retains an imported snapshot', async () => {
  const first = parseHammerLinkExport(await fixture(), { now });
  first.character.name = 'Changed only in this test';
  const second = parseHammerLinkExport(await fixture(), { now });
  assert.equal(second.character.name, 'Bluehoof');
});

test('accepts every occupied bag slot, with rich gear metadata where available', async () => {
  const snapshot = parseHammerLinkExport(await fixture(), { now });
  snapshot.bagEquipment = [{
    bag: 0,
    slot: 7,
    itemID: 228843,
    link: '|cffa335ee|Hitem:228843:7468:213743:0:0:0:0:0:80:66:0:0:1:12000:1:28:2462|h[Test Helm]|h|r',
    name: 'Test Helm',
    quality: 4,
    itemLevel: 710,
    baseItemLevel: 684,
    requiredLevel: 80,
    itemType: 'Armor',
    itemSubType: 'Plate',
    inventoryType: 'INVTYPE_HEAD',
    classID: 4,
    subclassID: 4,
    stackCount: 1,
    isBound: true,
    durability: { current: 99, maximum: 100 },
    equipmentSets: 'Raid',
    stats: { ITEM_MOD_STRENGTH_SHORT: 1234, ITEM_MOD_HASTE_RATING_SHORT: 567 },
    gems: [{ socket: 1, itemID: 213743, name: 'Test Gem', link: '|cff0070dd|Hitem:213743|h[Test Gem]|h|r' }]
  }, {
    bag: 0,
    slot: 8,
    itemID: 212653,
    link: '|cffffffff|Hitem:212653|h[Test Potion]|h|r',
    name: 'Test Potion',
    itemType: 'Consumable',
    itemSubType: 'Potion',
    quality: 1,
    stackCount: 20,
    isBound: false
  }];
  const decoded = parseHammerLinkExport(exportSnapshot(snapshot), { now });
  assert.equal(decoded.bagEquipment[0].itemLevel, 710);
  assert.equal(decoded.bagEquipment[0].stats.ITEM_MOD_STRENGTH_SHORT, 1234);
  assert.equal(decoded.bagEquipment[0].gems[0].itemID, 213743);
  assert.equal(decoded.bagEquipment[1].stackCount, 20);
  assert.equal(decoded.bagEquipment[1].inventoryType, undefined);
});

test('accepts bounded current-currency and reputation observations', async () => {
  const snapshot = parseHammerLinkExport(await fixture(), { now });
  snapshot.currencies = { available: true, capturedAt: snapshot.capturedAt, truncated: false, entries: [{ currencyID: 3000, name: 'Traveler Coin', quantity: 17, isAccountWide: true }] };
  snapshot.reputations = { available: true, capturedAt: snapshot.capturedAt, truncated: false, entries: [{ factionID: 2507, name: 'Dornogal', reaction: 5, currentStanding: 6000, currentReactionThreshold: 3000, nextReactionThreshold: 9000, isWatched: true }] };
  const decoded = parseHammerLinkExport(exportSnapshot(snapshot), { now });
  assert.equal(decoded.currencies.entries[0].quantity, 17);
  assert.equal(decoded.reputations.entries[0].factionID, 2507);
  snapshot.reputations.entries[0] = { factionID: 9999, name: 'Hostile faction', reaction: 2, currentStanding: -3000, currentReactionThreshold: -6000, nextReactionThreshold: 0 };
  assert.equal(parseHammerLinkExport(exportSnapshot(snapshot), { now }).reputations.entries[0].currentStanding, -3000);
});

test('accepts an occupied bag item whose optional client name is blank or null', async () => {
  const snapshot = parseHammerLinkExport(await fixture(), { now });
  snapshot.bagEquipment = [{
    bag: 0,
    slot: 1,
    itemID: 228843,
    link: '|cffa335ee|Hitem:228843|h[Fallback from link]|h|r',
    name: ''
  }];
  const decoded = parseHammerLinkExport(exportSnapshot(snapshot), { now });
  assert.equal(decoded.bagEquipment[0].name, '');
  snapshot.bagEquipment[0].name = null;
  assert.equal(parseHammerLinkExport(exportSnapshot(snapshot), { now }).bagEquipment[0].name, null);
});

test('rejects duplicate bag locations', async () => {
  const snapshot = parseHammerLinkExport(await fixture(), { now });
  const item = { bag: 0, slot: 1, itemID: 1, link: '|Hitem:1|h[Test]|h' };
  snapshot.bagEquipment = [item, { ...item }];
  assert.throws(() => parseHammerLinkExport(exportSnapshot(snapshot), { now }), (error) => {
    assert.ok(error instanceof HammerLinkImportError);
    assert.equal(error.code, 'invalid-schema');
    return true;
  });
});

test('accepts option-aware exports with a current spellbook, currency caps and owned housing decor', async () => {
  const legacy = parseHammerLinkExport(await fixture(), { now });
  const snapshot = {
    format: 2,
    capturedAt: legacy.capturedAt,
    character: legacy.character,
    exportOptions: { equipment: false, bagItems: false, currentSpellbook: true, talents: false, vault: false, currencyCaps: true, decorInventory: true },
    currentSpellbook: {
      available: true, capturedAt: legacy.capturedAt,
      scope: 'current_character_active_specialization', truncated: false,
      spells: [
        { spellID: 17364, name: 'Stormstrike', skillLine: 'Enhancement', source: 'spellbook', isPassive: false, isOffSpec: false },
        { spellID: 51490, name: 'Thunderstorm', skillLine: 'Elemental', source: 'spellbook', isPassive: false, isOffSpec: true },
        { spellID: 403092, name: 'Aerial Halt', skillLine: 'General', source: 'flyout', isPassive: false, isOffSpec: false },
      ],
    },
    currencyCaps: [{
      currencyID: 3284, name: 'Gilded Crest', quantity: 42, maxQuantity: 90,
      maxWeeklyQuantity: 30, quantityEarnedThisWeek: 12, totalEarned: 312,
      canEarnPerWeek: true, useTotalEarnedForMaxQty: true, isAccountWide: false,
    }],
    decorInventory: {
      available: true, capturedAt: legacy.capturedAt, totalOwnedCount: 4, exemptOwnedCount: 1, maxOwnedCount: 200,
      items: [{ decorID: 77, itemID: 228000, name: 'Bluehoof\'s Chair', storedCount: 2, placedCount: 1, redeemableCount: 0, destroyableCount: 2, uniqueTrophy: false, allowedIndoors: true, allowedOutdoors: false }],
    },
  };
  const decoded = parseHammerLinkExport(exportSnapshot(snapshot), { now });
  assert.equal(decoded.equipment, undefined);
  assert.equal(decoded.currentSpellbook.spells[1].isOffSpec, true);
  assert.equal(decoded.currentSpellbook.spells[2].source, 'flyout');
  assert.equal(decoded.currencyCaps[0].quantityEarnedThisWeek, 12);
  assert.equal(decoded.decorInventory.items[0].placedCount, 1);
});

test('rejects duplicate current-spellbook IDs', async () => {
  const snapshot = parseHammerLinkExport(await fixture(), { now });
  snapshot.format = 3;
  snapshot.exportOptions = { currentSpellbook: true };
  snapshot.currentSpellbook = {
    available: true,
    spells: [
      { spellID: 17364, name: 'Stormstrike' },
      { spellID: 17364, name: 'Stormstrike again' },
    ],
  };
  assert.throws(() => parseHammerLinkExport(exportSnapshot(snapshot), { now }), (error) => {
    assert.ok(error instanceof HammerLinkImportError);
    assert.equal(error.code, 'invalid-schema');
    return true;
  });
});

test('accepts a large valid Housing catalog and reports an explicit decompressed-size limit', () => {
  const snapshot = {
    format: 2,
    capturedAt: now / 1000,
    character: { name: 'Test', realm: 'Test Realm', region: 1, class: 'Paladin', level: 90 },
    exportOptions: { equipment: false, bagItems: false, talents: false, vault: false, currencyCaps: false, decorInventory: true },
    decorInventory: {
      available: true,
      items: Array.from({ length: 1024 }, (_, index) => ({
        decorID: index + 1,
        itemID: 100_000 + index,
        name: `Decor ${index + 1} ${'x'.repeat(220)}`,
        icon: 200_000 + index,
        storedCount: 1,
        placedCount: 0,
        redeemableCount: 0,
        destroyableCount: 0,
        uniqueTrophy: false,
        allowedIndoors: true,
        allowedOutdoors: true,
      })),
    },
  };
  const exported = exportSnapshot(snapshot);
  const decoded = parseHammerLinkExport(exported, { now });
  assert.equal(decoded.decorInventory.items.length, 1024);

  assert.throws(() => parseHammerLinkExport(exported, {
    now,
    limits: { maxDecompressedBytes: 262_144 },
  }), (error) => {
    assert.ok(error instanceof HammerLinkImportError);
    assert.equal(error.code, 'too-large');
    assert.match(error.message, /safe import limit/);
    return true;
  });
});

test('expands a complete compact format 3 Housing catalog', async () => {
  const legacy = parseHammerLinkExport(await fixture(), { now });
  const packedItems = Array.from({ length: 4096 }, (_, index) => [
    index + 1, `Decor ${index + 1}`, 100_000 + index, 200_000 + index,
    1, index % 2, index % 3, 1, index % 8,
  ]);
  const exported = exportSnapshot({
    format: 3,
    capturedAt: legacy.capturedAt,
    character: legacy.character,
    exportOptions: { equipment: false, bagItems: false, talents: false, vault: false, currencyCaps: false, decorInventory: true },
    decorInventory: { available: true, truncated: false, packedItems },
  });
  assert.ok(exported.length < 262_144, 'expected a 4,096-record compact export to fit one paste');

  const decoded = parseHammerLinkExport(exported, { now });
  assert.equal(decoded.format, 3);
  assert.equal(decoded.decorInventory.items.length, 4096);
  assert.equal(decoded.decorInventory.packedItems, undefined);
  assert.deepEqual(decoded.decorInventory.items[3], {
    decorID: 4, name: 'Decor 4', storedCount: 1, placedCount: 1,
    redeemableCount: 0, destroyableCount: 1, uniqueTrophy: true,
    allowedIndoors: true, allowedOutdoors: false, itemID: 100003, icon: 200003,
  });
});

test('rejects malformed compact Housing rows', async () => {
  const legacy = parseHammerLinkExport(await fixture(), { now });
  const snapshot = {
    format: 3,
    capturedAt: legacy.capturedAt,
    character: legacy.character,
    exportOptions: { decorInventory: true },
    decorInventory: { available: true, packedItems: [[77, 'Chair']] },
  };
  assert.throws(() => parseHammerLinkExport(exportSnapshot(snapshot), { now }), (error) => {
    assert.ok(error instanceof HammerLinkImportError);
    assert.equal(error.code, 'invalid-schema');
    return true;
  });
});

test('rejects unbounded or malformed decor inventory', async () => {
  const legacy = parseHammerLinkExport(await fixture(), { now });
  legacy.format = 2;
  legacy.decorInventory = { available: true, items: [{ decorID: 1, name: 'Chair', storedCount: -1 }] };
  assert.throws(() => parseHammerLinkExport(exportSnapshot(legacy), { now }), (error) => {
    assert.ok(error instanceof HammerLinkImportError);
    assert.equal(error.code, 'invalid-schema');
    return true;
  });
});

test('accepts a bounded current quest log with progress and waypoint facts', async () => {
  const legacy = parseHammerLinkExport(await fixture(), { now });
  const snapshot = {
    format: 3,
    capturedAt: legacy.capturedAt,
    character: legacy.character,
    exportOptions: { questLog: true },
    questLog: {
      available: true,
      capturedAt: legacy.capturedAt,
      totalQuests: 2,
      truncated: false,
      entries: [{
        questID: 9001, logIndex: 2, title: 'A Dark Errand', level: 80,
        difficultyLevel: 80, suggestedGroup: 3, frequency: 1,
        campaignID: 12, questClassification: 2, watchType: 1,
        isTask: false, isBounty: false, isStory: true, isHidden: false,
        isAutoComplete: false, isComplete: false, isFailed: false,
        objectives: [{ text: 'Collect 2/5 void shards', type: 'item', finished: false, numFulfilled: 2, numRequired: 5, objectiveType: 1 }],
        tag: { name: 'Campaign', id: 128, isElite: false },
        waypoint: { mapID: 2395, x: 0.42, y: 0.73 },
        timer: { totalSeconds: 3600, elapsedSeconds: 1200 },
      }],
    },
  };
  const decoded = parseHammerLinkExport(exportSnapshot(snapshot), { now });
  assert.equal(decoded.questLog.entries[0].objectives[0].numFulfilled, 2);
  assert.deepEqual(decoded.questLog.entries[0].waypoint, { mapID: 2395, x: 0.42, y: 0.73 });
  assert.equal(decoded.exportOptions.questLog, true);
});

test('rejects duplicate or unbounded quest-log data', async () => {
  const legacy = parseHammerLinkExport(await fixture(), { now });
  legacy.format = 3;
  legacy.exportOptions = { questLog: true };
  const quest = { questID: 1, title: 'Duplicate', objectives: [] };
  legacy.questLog = { available: true, entries: [quest, { ...quest }] };
  assert.throws(() => parseHammerLinkExport(exportSnapshot(legacy), { now }), (error) => {
    assert.ok(error instanceof HammerLinkImportError);
    assert.equal(error.code, 'invalid-schema');
    return true;
  });
});

test('accepts a blank-labelled Retail quest objective when progress is present', async () => {
  const legacy = parseHammerLinkExport(await fixture(), { now });
  legacy.format = 3;
  legacy.exportOptions = { questLog: true };
  legacy.questLog = {
    available: true,
    entries: [{ questID: 44, title: 'Unlabelled progress', objectives: [{ text: '', numFulfilled: 1, numRequired: 3 }] }],
  };
  const decoded = parseHammerLinkExport(exportSnapshot(legacy), { now });
  assert.equal(decoded.questLog.entries[0].objectives[0].text, '');
});

test('accepts learned profession recipes as positive cached observations', async () => {
  const legacy = parseHammerLinkExport(await fixture(), { now });
  const snapshot = {
    format: 3, capturedAt: legacy.capturedAt, character: legacy.character,
    exportOptions: { professionRecipes: true },
    professionRecipes: {
      available: true, capturedAt: legacy.capturedAt, truncated: false,
      professions: [{ skillLineID: 755, professionID: 755, name: 'Classic Jewelcrafting', skillLevel: 100, maxSkillLevel: 100, source: 'all', recipes: [{ recipeID: 1261659, name: 'Ironforge Chandelier', learned: true }] }],
    },
  };
  const decoded = parseHammerLinkExport(exportSnapshot(snapshot), { now });
  assert.equal(decoded.professionRecipes.professions[0].recipes[0].name, 'Ironforge Chandelier');
});

test('rejects an unlearned or duplicate cached profession recipe', async () => {
  const legacy = parseHammerLinkExport(await fixture(), { now });
  legacy.format = 3;
  legacy.exportOptions = { professionRecipes: true };
  legacy.professionRecipes = { available: true, professions: [{ skillLineID: 755, name: 'Jewelcrafting', recipes: [{ recipeID: 1, name: 'No', learned: false }] }] };
  assert.throws(() => parseHammerLinkExport(exportSnapshot(legacy), { now }), (error) => {
    assert.ok(error instanceof HammerLinkImportError);
    assert.equal(error.code, 'invalid-schema');
    return true;
  });
});
