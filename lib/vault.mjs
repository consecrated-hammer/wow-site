/* Great Vault progress, derived honestly.
 *
 * Blizzard does not publish Vault slot state. It can only be inferred, and the
 * inference is INCOMPLETE in ways that matter:
 *
 *   raid slots     Derivable. Each encounter carries last_kill_timestamp, so
 *                  bosses killed inside the current weekly period can be
 *                  counted. Caveat: only the LAST kill is recorded, so a boss
 *                  killed twice counts once — which happens to match how the
 *                  Vault counts distinct bosses.
 *   dungeon slots  PARTIAL. Only Mythic+ runs appear in the keystone profile.
 *                  Heroic, Mythic and Timewalking dungeons also fill these
 *                  slots and are invisible to the API, so a count derived here
 *                  is a FLOOR, never a total.
 *   world slots    NOT DERIVABLE. Delves, Prey hunts and Ritual Sites are not
 *                  exposed at all.
 *
 * Presenting that as "your Vault progress" would be confidently wrong. Every
 * slot therefore reports its own `coverage`, and the caller is told what the
 * number cannot see.
 */

import { PROVENANCE } from './providers.mjs';

export const COVERAGE = Object.freeze({
  COMPLETE: 'complete',
  FLOOR: 'floor',
  UNAVAILABLE: 'unavailable'
});

/**
 * Blizzard groups current-season raids under a literal "Current Season"
 * expansion entry, which is verified present in live responses. It is still a
 * magic string, and a character with no current-season progress may not have
 * the group at all, so fall back to the newest expansion rather than silently
 * reporting nothing.
 */
export function selectCurrentSeason(raidEncounters) {
  const expansions = raidEncounters?.expansions || [];
  return expansions.find((entry) => entry.expansion?.name === 'Current Season')
    || expansions.at(-1)
    || null;
}

/** How many thresholds a count has unlocked. */
function unlockedSlots(count, thresholds) {
  return thresholds.filter((threshold) => count >= threshold).length;
}

/**
 * @param {object} input
 * @param {object} input.period            resolved mythic-keystone period (start/end timestamps)
 * @param {object} input.keystoneProfile   character mythic-keystone-profile payload
 * @param {object} input.raidEncounters    character encounters/raids payload
 * @param {object} input.seasonRewards     curated season module rewards (for thresholds)
 */
export function greatVaultProgress({ period, keystoneProfile, raidEncounters, seasonRewards }) {
  const start = period?.start_timestamp ?? null;
  const end = period?.end_timestamp ?? null;

  const slotRules = seasonRewards?.greatVault?.slots || [];
  const thresholdsFor = (slot) => slotRules.find((rule) => rule.slot === slot)?.thresholds || [];

  // --- raid: complete, from per-encounter kill timestamps -------------------
  const currentSeason = selectCurrentSeason(raidEncounters);
  // Keyed by encounter, NOT by encounter+difficulty. Killing the same boss on
  // Normal and again on Heroic in one reset fills one Vault slot, not two, so
  // counting per difficulty would overstate progress on a slot this same
  // function advertises as 'complete'.
  const raidKillsByEncounter = new Map();
  for (const instance of currentSeason?.instances || []) {
    for (const mode of instance.modes || []) {
      for (const encounter of mode.progress?.encounters || []) {
        const killedAt = encounter.last_kill_timestamp;
        if (!killedAt || !start) continue;
        if (killedAt < start || (end && killedAt > end)) continue;

        const key = encounter.encounter?.id ?? `${instance.instance?.name}/${encounter.encounter?.name}`;
        const existing = raidKillsByEncounter.get(key);
        const difficulty = mode.difficulty?.name ?? null;
        if (existing) {
          if (difficulty && !existing.difficulties.includes(difficulty)) existing.difficulties.push(difficulty);
          if (killedAt > Date.parse(existing.killedAt)) existing.killedAt = new Date(killedAt).toISOString();
          continue;
        }
        raidKillsByEncounter.set(key, {
          instance: instance.instance?.name ?? null,
          encounter: encounter.encounter?.name ?? null,
          difficulties: difficulty ? [difficulty] : [],
          killedAt: new Date(killedAt).toISOString()
        });
      }
    }
  }
  const raidKills = [...raidKillsByEncounter.values()];
  const raidThresholds = thresholdsFor('raid');

  // --- dungeon: a floor, because non-M+ dungeons are invisible --------------
  const periodRuns = keystoneProfile?.current_period?.best_runs || [];
  const dungeonThresholds = thresholdsFor('dungeon');

  // --- world: nothing at all ------------------------------------------------
  const worldThresholds = thresholdsFor('world');

  return {
    provenance: PROVENANCE.BLIZZARD,
    derived: true,
    note:
      'Blizzard publishes no Great Vault state; this is derived from kill timestamps and '
      + 'keystone runs. Read each slot\'s coverage before trusting its count.',
    period: {
      id: period?.id ?? null,
      startsAt: start ? new Date(start).toISOString() : null,
      endsAt: end ? new Date(end).toISOString() : null
    },
    slots: [
      {
        slot: 'raid',
        coverage: COVERAGE.COMPLETE,
        thresholds: raidThresholds,
        count: raidKills.length,
        unlocked: unlockedSlots(raidKills.length, raidThresholds),
        detail: raidKills,
        limitation: null
      },
      {
        slot: 'dungeon',
        coverage: COVERAGE.FLOOR,
        thresholds: dungeonThresholds,
        count: periodRuns.length,
        unlocked: unlockedSlots(periodRuns.length, dungeonThresholds),
        detail: periodRuns.map((run) => ({
          dungeon: run.dungeon?.name ?? null,
          keystoneLevel: run.keystone_level ?? null,
          inTime: run.is_completed_within_time ?? null
        })),
        limitation:
          'Mythic+ runs only. Heroic, Mythic and Timewalking dungeons also fill these slots '
          + 'and are not exposed by the API, so the real count is at least this.'
      },
      {
        slot: 'world',
        coverage: COVERAGE.UNAVAILABLE,
        thresholds: worldThresholds,
        count: null,
        unlocked: null,
        detail: [],
        limitation: 'Delves, Prey hunts and Ritual Sites are not exposed by the Blizzard API at all.'
      }
    ]
  };
}

/** Lifetime raid progress per instance and difficulty. */
export function raidProgress({ raidEncounters, currentOnly = true }) {
  const expansions = raidEncounters?.expansions || [];
  const current = selectCurrentSeason(raidEncounters);
  const selected = currentOnly ? [current].filter(Boolean) : expansions;

  return {
    provenance: PROVENANCE.BLIZZARD,
    expansions: selected.map((entry) => ({
      expansion: entry.expansion?.name ?? null,
      instances: (entry.instances || []).map((instance) => ({
        instance: instance.instance?.name ?? null,
        modes: (instance.modes || []).map((mode) => ({
          difficulty: mode.difficulty?.name ?? null,
          status: mode.status?.name ?? null,
          completed: mode.progress?.completed_count ?? null,
          total: mode.progress?.total_count ?? null,
          encounters: (mode.progress?.encounters || []).map((encounter) => ({
            name: encounter.encounter?.name ?? null,
            kills: encounter.completed_count ?? null,
            lastKillAt: encounter.last_kill_timestamp
              ? new Date(encounter.last_kill_timestamp).toISOString()
              : null
          }))
        }))
      }))
    }))
  };
}
