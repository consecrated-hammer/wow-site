/* Curated Midnight Season 2 reward rules.
 *
 * THIS IS NOT BLIZZARD PROFILE API OUTPUT. Blizzard publishes no structured
 * endpoint for Delve tables, Mythic+ reward tables, crest sources or Great
 * Vault thresholds, so these values are hand-curated from the community and
 * Blizzard sources listed in `sources` below. Anything served from this file
 * must stay labelled `provenance: 'curated'` so an agent can tell it apart
 * from character-owned Blizzard data.
 *
 * Values that public sources do not confirm are `null` with an explicit
 * `confirmed: false` sibling. Never replace one with a plausible guess: the
 * whole point of this file is that a consumer can tell the difference.
 *
 * Re-verify `verifiedAt` against the sources whenever a patch lands.
 */

const UNCONFIRMED_CREST_QUANTITY = Object.freeze({
  amount: null,
  confirmed: false,
  note: 'Per-run crest quantities are not confirmed in public sources for 12.1. Plan around crest type, not totals.'
});

export const SEASON_REWARDS = Object.freeze({
  season: 'Midnight Season 2',
  patch: '12.1',
  verifiedAt: '2026-08-17',
  provenance: 'curated',
  disclaimer:
    'Curated community data, not Blizzard Profile API output. Item levels reflect the post-July-8 increase. '
    + 'Crest quantities per run are unconfirmed and are reported as null.',

  mythicPlus: Object.freeze({
    ranksNote: 'Keys above +12 raise rating and resilient-keystone progress but not loot item level.',
    dungeons: Object.freeze([
      'Altar of Fangs',
      'Murder Row',
      'Den of Nalorakk',
      'The Blinding Vale',
      'Voidscar Arena',
      "King's Rest",
      'Ruby Life Pools',
      'Temple of Sethraliss'
    ]),
    keys: Object.freeze([
      { key: '+2-3', endOfRun: { itemLevel: 295, track: 'Champion', rank: 2 }, crestType: 'Champion', crestQuantity: UNCONFIRMED_CREST_QUANTITY, greatVault: { itemLevel: 305, track: 'Hero', rank: 1 } },
      { key: '+4', endOfRun: { itemLevel: 298, track: 'Champion', rank: 3 }, crestType: 'Hero', crestQuantity: UNCONFIRMED_CREST_QUANTITY, greatVault: { itemLevel: 308, track: 'Hero', rank: 2 } },
      { key: '+5', endOfRun: { itemLevel: 302, track: 'Champion', rank: 4 }, crestType: 'Hero', crestQuantity: UNCONFIRMED_CREST_QUANTITY, greatVault: { itemLevel: 308, track: 'Hero', rank: 2 } },
      { key: '+6', endOfRun: { itemLevel: 305, track: 'Hero', rank: 1 }, crestType: 'Hero', crestQuantity: UNCONFIRMED_CREST_QUANTITY, greatVault: { itemLevel: 311, track: 'Hero', rank: 3 } },
      { key: '+7', endOfRun: { itemLevel: 305, track: 'Hero', rank: 1 }, crestType: 'Hero', crestQuantity: UNCONFIRMED_CREST_QUANTITY, greatVault: { itemLevel: 315, track: 'Hero', rank: 4 } },
      { key: '+8', endOfRun: { itemLevel: 308, track: 'Hero', rank: 2 }, crestType: 'Hero', crestQuantity: UNCONFIRMED_CREST_QUANTITY, greatVault: { itemLevel: 315, track: 'Hero', rank: 4 } },
      { key: '+9', endOfRun: { itemLevel: 308, track: 'Hero', rank: 2 }, crestType: 'Myth', crestQuantity: UNCONFIRMED_CREST_QUANTITY, greatVault: { itemLevel: 315, track: 'Hero', rank: 4 } },
      { key: '+10', endOfRun: { itemLevel: 311, track: 'Hero', rank: 3 }, crestType: 'Myth', crestQuantity: UNCONFIRMED_CREST_QUANTITY, greatVault: { itemLevel: 318, track: 'Myth', rank: 1 } },
      { key: '+11', endOfRun: { itemLevel: 311, track: 'Hero', rank: 3 }, crestType: 'Myth', crestQuantity: UNCONFIRMED_CREST_QUANTITY, greatVault: { itemLevel: 318, track: 'Myth', rank: 1 } },
      { key: '+12 and above', endOfRun: { itemLevel: 311, track: 'Hero', rank: 3 }, crestType: 'Myth', crestQuantity: UNCONFIRMED_CREST_QUANTITY, greatVault: { itemLevel: 318, track: 'Myth', rank: 1 } }
    ])
  }),

  delves: Object.freeze({
    bountifulNote: 'Bountiful Coffers need a Restored Coffer Key. Without Bountiful access, end-of-delve gear caps at ilvl 272 (Adventurer 3/6) at Tier 3.',
    tiers: Object.freeze([
      { tier: 1, endOfRun: { itemLevel: 266 }, greatVault: { itemLevel: 279 }, crestType: null },
      { tier: 2, endOfRun: { itemLevel: 269 }, greatVault: { itemLevel: 282 }, crestType: null },
      { tier: 3, endOfRun: { itemLevel: 272 }, greatVault: { itemLevel: 285 }, crestType: 'Adventurer' },
      { tier: 4, endOfRun: { itemLevel: 276 }, greatVault: { itemLevel: 289 }, crestType: 'Adventurer' },
      { tier: 5, endOfRun: { itemLevel: 279 }, greatVault: { itemLevel: 292 }, crestType: 'Veteran' },
      { tier: 6, endOfRun: { itemLevel: 282 }, greatVault: { itemLevel: 298 }, crestType: 'Veteran' },
      { tier: 7, endOfRun: { itemLevel: 292 }, greatVault: { itemLevel: 302 }, crestType: 'Champion' },
      { tier: 8, endOfRun: { itemLevel: 295 }, greatVault: { itemLevel: 305 }, crestType: 'Champion', note: 'Tier 8+ shares the same end-of-run and Vault item levels.' },
      { tier: 11, endOfRun: { itemLevel: 295 }, greatVault: { itemLevel: 305 }, crestType: 'Hero', note: 'Tier 11 Gilded Stashes award Hero and Myth Mistcrests.' }
    ]),
    crestBandsConfirmed: false,
    crestBandsNote: 'Delve crest bands are corroborated by two community sources but are not Blizzard-published; treat as indicative.'
  }),

  greatVault: Object.freeze({
    choiceNote: 'One item is chosen across all unlocked slots.',
    slots: Object.freeze([
      { slot: 'raid', thresholds: [2, 4, 6], requirement: 'Defeat eligible Season 2 raid bosses.', itemLevelRule: 'Determined by the difficulty of the bosses defeated.' },
      { slot: 'dungeon', thresholds: [1, 4, 8], requirement: 'Complete Heroic, Mythic, Mythic+, or Timewalking dungeons.', itemLevelRule: 'For Mythic+, the three slots use the highest, fourth-highest, and eighth-highest qualifying runs.' },
      { slot: 'world', thresholds: [2, 4, 8], requirement: 'Complete Delves, Prey hunts, Ritual Sites, or other qualifying world activities.', itemLevelRule: 'The highest tier completed determines the item level; Hero-track needs Tier 8+ Delves or Nightmare-mode Prey.' }
    ]),
    raidUpgradeNote: 'Season 2 raid Vault rewards jump LFR, Normal and Heroic to the first rank of the next track. Mythic is Myth 6/6 except Very Rare and penultimate/final-boss items, which are Myth-9-equivalent.'
  }),

  raid: Object.freeze({
    name: 'The Venomous Abyss',
    bosses: 8,
    bands: Object.freeze([
      { difficulty: 'LFR', boss1: { itemLevel: 279, track: 'Veteran', rank: 1 }, bosses2to3: { itemLevel: 282, track: 'Veteran', rank: 2 }, bosses4to6: { itemLevel: 285, track: 'Veteran', rank: 3 }, bosses7to8: { itemLevel: 289, track: 'Veteran', rank: 4 } },
      { difficulty: 'Normal', boss1: { itemLevel: 292, track: 'Champion', rank: 1 }, bosses2to3: { itemLevel: 295, track: 'Champion', rank: 2 }, bosses4to6: { itemLevel: 298, track: 'Champion', rank: 3 }, bosses7to8: { itemLevel: 302, track: 'Champion', rank: 4 } },
      { difficulty: 'Heroic', boss1: { itemLevel: 305, track: 'Hero', rank: 1 }, bosses2to3: { itemLevel: 308, track: 'Hero', rank: 2 }, bosses4to6: { itemLevel: 311, track: 'Hero', rank: 3 }, bosses7to8: { itemLevel: 315, track: 'Hero', rank: 4 } },
      { difficulty: 'Mythic', boss1: { itemLevel: 318, track: 'Myth', rank: 1 }, bosses2to3: { itemLevel: 321, track: 'Myth', rank: 2 }, bosses4to6: { itemLevel: 324, track: 'Myth', rank: 3 }, bosses7to8: { itemLevel: 344, track: 'Myth-9-equivalent', rank: null } }
    ])
  }),

  aboveTrack: Object.freeze({
    ordinaryMythMaximum: 334,
    ascendantVenomstone: { itemLevel: 341, equivalent: 'Myth 8', appliesTo: ['weapon', 'trinket', 'neck'] },
    veryRareAndFinalBosses: { itemLevel: 344, equivalent: 'Myth 9' },
    staleValueNote: 'The earlier ilvl 337 figure is pre-July-8 PTR data and is wrong for the live season.'
  }),

  crests: Object.freeze({
    types: Object.freeze(['Adventurer', 'Veteran', 'Champion', 'Hero', 'Myth']),
    costPerRank: 20,
    weeklyCapPerType: 100,
    sources: Object.freeze([
      { crest: 'Adventurer', from: 'Repeatable outdoor content and Tier 4 Delves.' },
      { crest: 'Veteran', from: 'LFR, seasonal Heroic dungeons, and Delves 5-6.' },
      { crest: 'Champion', from: 'Weekly outdoor content, Normal raid, Mythic dungeons and +2-3 keys, and Delves 7-10.' },
      { crest: 'Hero', from: 'Heroic raid, +4 to +8 keys, and Tier 11 Delves.' },
      { crest: 'Myth', from: 'Mythic raid and +9 keys and above.' }
    ])
  }),

  currencies: Object.freeze({
    balanceNote: 'Blizzard publishes no public character-currency endpoint; a live probe returned 404. This tool can explain purpose and source but can never return an owned balance.',
    items: Object.freeze([
      { name: 'Mistcrests', purpose: 'Upgrade gear one rank within its track, 20 per rank.' },
      { name: 'Nebulous Voidcores', purpose: 'Season 2 crafting and upgrade system currency.' },
      { name: 'Ascendant Venomstones', purpose: 'Raise eligible weapons, trinkets and necks to the Myth-8-equivalent ilvl 341.' },
      { name: 'Restored Coffer Keys', purpose: 'Open Bountiful Coffers in Delves.' },
      { name: 'Thalassian Tokens of Merit', purpose: 'Seasonal vendor currency.' }
    ])
  }),

  sources: Object.freeze([
    'https://www.wowhead.com/guide/midnight/season-2-overview-dungeons-raids-dates',
    'https://www.icy-veins.com/wow/midnight-delve-rewards-guide',
    'https://www.icy-veins.com/wow/great-vault-guide/',
    'https://www.wowhead.com/guide/midnight/raids/the-venomous-abyss-overview-location-rewards-bosses',
    'https://warcraft.wiki.gg/wiki/Midnight_Season_2',
    'https://www.method.gg/guides/gear-item-level-from-raid-bosses-and-mythic-dungeons-in-wow-midnight-season-2',
    'https://us.forums.blizzard.com/en/wow/t/curse-of-ulatek-endgame-reward-changes/2317450',
    'https://www.wowhead.com/news/item-levels-increasing-in-midnight-season-2-382120'
  ])
});

/* Deterministic advice derived from the table above plus a supplied item
 * level. Every suggestion carries the rule that selected it. This is advice,
 * not a Blizzard fact and not a simulation: no BiS ranking, no drop-chance
 * claim, no throughput estimate. */
export function recommendActivities(itemLevel, goal = 'any') {
  if (!Number.isInteger(itemLevel) || itemLevel < 1 || itemLevel > 1000) {
    throw new TypeError('itemLevel must be an integer between 1 and 1000');
  }

  const suggestions = [];
  const add = (activity, source, reward, reason) => suggestions.push({ activity, source, rewardItemLevel: reward, reason });

  for (const entry of SEASON_REWARDS.mythicPlus.keys) {
    if (entry.endOfRun.itemLevel > itemLevel) {
      add(`Mythic+ ${entry.key}`, 'mythic_plus', entry.endOfRun.itemLevel,
        `End-of-run ${entry.endOfRun.itemLevel} beats your ${itemLevel} and awards ${entry.crestType} crests.`);
      break;
    }
  }

  for (const tier of SEASON_REWARDS.delves.tiers) {
    if (tier.endOfRun.itemLevel > itemLevel) {
      add(`Delve Tier ${tier.tier}`, 'delves', tier.endOfRun.itemLevel,
        `End-of-delve ${tier.endOfRun.itemLevel} beats your ${itemLevel}.`);
      break;
    }
  }

  // Scan every encounter band, not just each difficulty's first boss: a well
  // geared character can be past every boss1 value while later bosses on the
  // same table still beat them (ilvl 330 vs Mythic bosses 7-8 at 344).
  const RAID_BANDS = [
    ['boss1', 'first boss'],
    ['bosses2to3', 'bosses 2-3'],
    ['bosses4to6', 'bosses 4-6'],
    ['bosses7to8', 'bosses 7-8']
  ];
  const raidRewards = SEASON_REWARDS.raid.bands.flatMap((band) =>
    RAID_BANDS
      .filter(([key]) => band[key]?.itemLevel > itemLevel)
      .map(([key, label]) => ({ difficulty: band.difficulty, label, itemLevel: band[key].itemLevel })));
  const bestRaid = raidRewards.sort((a, b) => a.itemLevel - b.itemLevel)[0];
  if (bestRaid) {
    add(`${bestRaid.difficulty} ${SEASON_REWARDS.raid.name}`, 'raid', bestRaid.itemLevel,
      `${bestRaid.label} at ${bestRaid.itemLevel} beats your ${itemLevel}.`);
  }

  const bestVault = SEASON_REWARDS.mythicPlus.keys
    .filter((entry) => entry.greatVault.itemLevel > itemLevel)
    .sort((a, b) => a.greatVault.itemLevel - b.greatVault.itemLevel)[0];
  if (bestVault) {
    add(`Great Vault via Mythic+ ${bestVault.key}`, 'great_vault', bestVault.greatVault.itemLevel,
      `The lowest key whose Vault reward (${bestVault.greatVault.itemLevel}) beats your ${itemLevel}.`);
  }

  const filtered = goal === 'any' ? suggestions : suggestions.filter((entry) => entry.source === goal);
  return {
    itemLevel,
    goal,
    provenance: 'curated',
    advisory: true,
    note: filtered.length
      ? 'Deterministic suggestions from the curated reward table. Not a simulation or BiS ranking.'
      : 'No listed activity rewards a higher item level than the one supplied.',
    suggestions: filtered
  };
}
