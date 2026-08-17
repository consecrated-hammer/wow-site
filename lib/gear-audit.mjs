/* Join a character's Blizzard equipment against ClassCodex recommendations.
 *
 * This is where the two provider families meet, so every finding says which
 * side it came from: what you have equipped is `blizzard` and authoritative;
 * what you "should" have is `community`/classcodex and is somebody's opinion,
 * carrying its own age.
 *
 * All joins are local lookups on itemId. Nothing here calls an API.
 */

import { PROVENANCE, COMMUNITY_SOURCES } from './providers.mjs';

/** Flatten a BiS list into { itemId -> {label, bis, slot, source} } entries. */
function indexBisList(bisGear) {
  const byItemId = new Map();
  for (const list of bisGear || []) {
    for (const entry of list.slots || []) {
      const itemId = entry.item?.itemId ?? entry.itemId;
      if (!itemId) continue;
      byItemId.set(itemId, {
        listLabel: list.label ?? null,
        slot: entry.slot ?? null,
        isBis: entry.bis !== false,
        droppedBy: entry.source ?? null
      });
    }
  }
  return byItemId;
}

/**
 * Compare equipped items against every available BiS list.
 *
 * A slot is only reported as "not recommended" when the guidance actually has
 * an opinion about it; silence from a guide is not a criticism.
 */
export function auditGear({ equipment, guidance }) {
  if (!Array.isArray(equipment?.items)) {
    throw new TypeError('equipment must be a Blizzard equipment payload with items');
  }
  if (equipment.provenance && equipment.provenance !== PROVENANCE.BLIZZARD) {
    throw new Error('Gear audit requires Blizzard-sourced equipment.');
  }

  const lists = Object.entries(guidance?.bisGear || {})
    .filter(([, value]) => Array.isArray(value) && value.length > 0)
    .map(([name, value]) => ({ name, index: indexBisList(value) }));

  const trinketsByItemId = new Map(
    (guidance?.trinkets || []).map((trinket) => [trinket.itemId, trinket])
  );

  const slots = equipment.items.map((item) => {
    const matches = lists
      .map(({ name, index }) => {
        const hit = index.get(item.itemId);
        return hit ? { list: name, ...hit } : null;
      })
      .filter(Boolean);

    const trinket = trinketsByItemId.get(item.itemId) || null;

    return {
      slot: item.slotName || item.slot,
      itemId: item.itemId,
      name: item.name,
      itemLevel: item.itemLevel,
      equipped: { provenance: PROVENANCE.BLIZZARD },
      recommendation: matches.length
        ? {
            provenance: PROVENANCE.COMMUNITY,
            source: COMMUNITY_SOURCES.CLASSCODEX,
            listedIn: matches,
            isBisSomewhere: matches.some((match) => match.isBis)
          }
        : null,
      trinketTier: trinket
        ? {
            provenance: PROVENANCE.COMMUNITY,
            source: COMMUNITY_SOURCES.CLASSCODEX,
            tier: trinket.tier,
            contexts: trinket.contexts ?? null,
            droppedBy: trinket.source ?? null
          }
        : null
    };
  });

  // Trinkets the guidance rates highly that are not currently equipped. This is
  // the actionable half: it names the boss to go and kill.
  const equippedIds = new Set(equipment.items.map((item) => item.itemId));
  const trinketUpgrades = (guidance?.trinkets || [])
    .filter((trinket) => !equippedIds.has(trinket.itemId) && /^[SA]$/.test(String(trinket.tier || '')))
    .map((trinket) => ({
      itemId: trinket.itemId,
      tier: trinket.tier,
      contexts: trinket.contexts ?? null,
      droppedBy: trinket.source ?? null
    }));

  const matched = slots.filter((slot) => slot.recommendation);
  return {
    character: equipment.character ?? null,
    guidance: guidance
      ? {
          provenance: PROVENANCE.COMMUNITY,
          source: COMMUNITY_SOURCES.CLASSCODEX,
          addonVersion: guidance.addonVersion ?? null,
          lastScrape: guidance.lastScrape ?? null,
          licence: guidance.licence ?? null,
          sourceUrls: guidance.sourceUrls ?? null,
          staleness: guidance.lastScrape
            ? `Guidance was scraped ${guidance.lastScrape}; treat as advice from that date, not current.`
            : 'Guidance has no scrape date; treat its age as unknown.'
        }
      : null,
    summary: {
      slotsEquipped: slots.length,
      slotsWithGuidance: matched.length,
      slotsAlreadyBis: matched.filter((slot) => slot.recommendation.isBisSomewhere).length,
      trinketUpgradesSuggested: trinketUpgrades.length
    },
    slots,
    trinketUpgrades
  };
}
