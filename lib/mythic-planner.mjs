/* Curated Mythic+ target catalogue.  This deliberately lives apart from
 * ClassCodex: dungeon availability and loot are season facts, while a guide's
 * opinion on a target is a separate, dated signal. */

const SOURCE = 'https://www.wowhead.com/guide/midnight/mythic-plus-season-overview';
export const MYTHIC_LOOT_CATALOGUE = Object.freeze({
  seasonId: 18,
  patch: '12.1',
  verifiedAt: '2026-08-18',
  provenance: 'curated',
  sourceUrls: [SOURCE],
  // Each entry is a drop/bonus-loot candidate, not a promise that the item
  // will drop. New and changed dungeon tables are intentionally kept here.
  dungeons: Object.freeze([
    { name: 'Altar of Fangs', sourceUrl: 'https://www.wowhead.com/guide/midnight/altar-of-fangs-dungeon-overview-location-rewards', drops: [
      ['Poison-Proof Stompers', 'FEET', 'Rav\'i', ['paladin', 'warrior', 'death knight']],
      ['Aged Interwoven Scaleplate', 'CHEST', 'The Writhing Coil', ['paladin', 'warrior', 'death knight']],
      ['Ancient General\'s Obsidian Pillars', 'LEGS', 'Zul\'jan', ['paladin', 'warrior', 'death knight']],
      ['Strand of Warding Fangs', 'NECK', 'The Writhing Coil', ['all']],
      ['Band of the Amani Warlord', 'FINGER', 'Zul\'jan', ['all']],
      ['Venom-Etched Crescent', 'MAIN_HAND', 'Rav\'i', ['paladin']],
      ['Coiled Fangstone', 'TRINKET', 'Rav\'i', ['paladin', 'warrior']],
      ['Vile Vial of Volatile Venom', 'TRINKET', 'Rav\'i', ['all']],
      ['Knot of Writhing Serpents', 'TRINKET', 'The Writhing Coil', ['all']],
      ['Tattered Amani War Banner', 'TRINKET', 'Zul\'jan', ['all']]
    ] },
    { name: 'Murder Row', sourceUrl: 'https://www.wowhead.com/guide/midnight/murder-row-dungeon-overview-location-rewards', drops: [] },
    { name: 'Den of Nalorakk', sourceUrl: 'https://www.wowhead.com/guide/midnight/den-of-nalorakk-dungeon-overview-location-rewards', drops: [
      ['Bonds of the Hash\'ura', 'HANDS', 'Nalorakk', ['paladin', 'warrior', 'death knight']],
      ['Sentinel Challenger\'s Prize', 'CHEST', 'Sentinel of Winter', ['paladin', 'warrior', 'death knight']],
      ['Autumn\'s Boon Belt', 'WAIST', 'The Hoardmonger', ['paladin', 'warrior', 'death knight']],
      ['Yoke of the Charging Bear', 'NECK', 'Nalorakk', ['all']],
      ['Pilfered Precious Band', 'FINGER', 'The Hoardmonger', ['all']],
      ['Mycolic Medicine', 'TRINKET', 'The Hoardmonger', ['paladin']],
      ['Tempest\'s Shelter', 'OFF_HAND', 'Sentinel of Winter', ['paladin']]
    ] },
    { name: 'The Blinding Vale', sourceUrl: 'https://www.wowhead.com/guide/midnight/the-blinding-vale-dungeon-overview-location-rewards', drops: [
      ['Lightwarden\'s Bind', 'FINGER', 'Lightwarden Ruia', ['all']],
      ['Bloodthorn Burnous', 'BACK', 'Ikuzz the Light Hunter', ['all']],
      ['Teldrassil\'s Sacrifice', 'OFF_HAND', 'Ziekket', ['paladin']]
    ] },
    { name: 'Voidscar Arena', sourceUrl: 'https://www.wowhead.com/guide/midnight/voidscar-arena-dungeon-overview-location-rewards', drops: [
      ['Visor of the Predator', 'HEAD', 'Atroxus', ['paladin', 'warrior', 'death knight']],
      ["Despondent's Gauntlets", 'HANDS', "Taz'Rah", ['paladin', 'warrior', 'death knight']],
      ['Graft of the Domanaar', 'NECK', 'Charonus', ['all']],
      ['Sickening Signet of Atroxus', 'FINGER', 'Atroxus', ['all']],
      ["Taz'Rah's Cosmic Edge", 'MAIN_HAND', "Taz'Rah", ['paladin']],
      ['Charonic Crescent', 'MAIN_HAND', 'Charonus', ['paladin']],
      ["Mindpiercer's Sigil", 'TRINKET', 'Charonus', ['paladin']],
      ['Void Execution Mandate', 'TRINKET', "Taz'Rah", ['all']],
      ['Tumor of the Swarm', 'TRINKET', 'Atroxus', ['paladin']]
    ] },
    { name: "King's Rest", sourceUrl: 'https://www.wowhead.com/ptr/guide/midnight/kings-rest-dungeon-overview-mythic-plus', drops: [] },
    { name: 'Ruby Life Pools', sourceUrl: SOURCE, drops: [] },
    { name: 'Temple of Sethraliss', sourceUrl: SOURCE, drops: [] }
  ])
});

function normaliseSlot(slot) {
  return String(slot || '').toUpperCase().replaceAll(' ', '_')
    .replace('RING', 'FINGER').replace('RINGS', 'FINGER').replace('CLOAK', 'BACK')
    .replace('BOOTS', 'FEET').replace('HELM', 'HEAD').replace('SHOULDERS', 'SHOULDER')
    .replace('BRACERS', 'WRIST').replace('BELT', 'WAIST').replace('GLOVES', 'HANDS');
}

function matchingEquipped(items, slot) {
  const target = normaliseSlot(slot);
  return (items || []).filter((item) => normaliseSlot(item.slot) === target || normaliseSlot(item.slotName) === target);
}

function guideItemNames(guidance) {
  const names = new Set();
  for (const list of Object.values(guidance?.bisGear || {})) {
    for (const section of list || []) for (const entry of section.slots || []) {
      if (entry.item?.name) names.add(entry.item.name.toLowerCase());
    }
  }
  for (const item of guidance?.trinkets || []) if (item?.name) names.add(item.name.toLowerCase());
  return names;
}

export function buildMythicPlanner({ equipment, profile, guidance, rewards, key = '+10' }) {
  if (!Array.isArray(equipment?.items)) throw new TypeError('planner needs Blizzard equipment');
  const tier = rewards?.mythicPlus?.keys?.find((entry) => entry.key === key)
    || rewards?.mythicPlus?.keys?.find((entry) => entry.key === '+10');
  if (!tier) return { available: false, reason: 'Current-season Mythic+ reward data is unavailable.' };
  const className = String(profile?.characterClass?.name || '').toLowerCase();
  const guides = guideItemNames(guidance);
  const runs = new Map((profile?.mythicPlus?.bestRuns || []).map((run) => [run.dungeon, run]));
  const dungeons = MYTHIC_LOOT_CATALOGUE.dungeons.map((dungeon) => {
    const run = runs.get(dungeon.name) || null;
    const eligible = dungeon.drops.map(([name, slot, boss, classes]) => ({ name, slot, boss, classes }))
      .filter((drop) => drop.classes.includes('all') || drop.classes.includes(className))
      .map((drop) => {
        const equipped = matchingEquipped(equipment.items, drop.slot);
        const lowest = equipped.reduce((best, item) => !best || (item.itemLevel ?? Infinity) < (best.itemLevel ?? Infinity) ? item : best, null);
        return {
          ...drop,
          guideTarget: guides.has(drop.name.toLowerCase()),
          comparedItem: lowest ? { name: lowest.name, itemLevel: lowest.itemLevel, slot: lowest.slotName || lowest.slot } : null,
          itemLevelGain: lowest?.itemLevel != null ? tier.endOfRun.itemLevel - lowest.itemLevel : null,
          improvesSlot: lowest?.itemLevel != null ? tier.endOfRun.itemLevel > lowest.itemLevel : null
        };
      })
      .filter((drop) => drop.improvesSlot !== false)
      .sort((a, b) => Number(b.guideTarget) - Number(a.guideTarget) || (b.itemLevelGain ?? -1) - (a.itemLevelGain ?? -1));
    return {
      name: dungeon.name, sourceUrl: dungeon.sourceUrl, coverage: dungeon.drops.length ? 'verified_targets' : 'catalogue_pending',
      bestRun: run, guideTargets: eligible.filter((drop) => drop.guideTarget), eligibleUpgrades: eligible.filter((drop) => !drop.guideTarget),
      needsPractice: !run || run.completedWithinTime !== true
    };
  }).sort((a, b) => Number(b.needsPractice) - Number(a.needsPractice) || a.name.localeCompare(b.name));
  return {
    available: true, provenance: { character: 'blizzard', rewards: 'curated', guidance: guidance ? 'community' : null },
    catalogue: { seasonId: MYTHIC_LOOT_CATALOGUE.seasonId, patch: MYTHIC_LOOT_CATALOGUE.patch, verifiedAt: MYTHIC_LOOT_CATALOGUE.verifiedAt, sourceUrls: MYTHIC_LOOT_CATALOGUE.sourceUrls, coverage: 'expanding' },
    key: tier.key, reward: tier, character: equipment.character, rating: profile?.mythicPlus?.rating ?? null,
    warning: 'Best runs are Blizzard seasonal snapshots for this character, not group history. A target is not a guaranteed drop or a stat simulation.',
    guidanceStaleness: guidance?.lastScrape ? `Community guide data was scraped ${guidance.lastScrape}.` : null,
    dungeons
  };
}
