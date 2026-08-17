/* Season registry.
 *
 * Curated reward data is keyed by Blizzard's own Mythic Keystone season id, so
 * nothing in the codebase hardcodes "Season 2". When Blizzard rolls the season
 * over, the resolver stops finding a module and says so.
 *
 * THE RULE THAT MATTERS: an unknown season returns `seasonDataUnavailable`. It
 * must never fall back to the previous season's tables. Serving Season 2 Delve
 * values into Season 3 would be confidently wrong, which is the one failure
 * this project consistently designs against.
 *
 * Adding a season is two lines: import its module and register it. Keep this
 * file free of network calls so it stays loadable in a browser — fetching the
 * current season id belongs to the server.
 */

import { SEASON_ID as SEASON_18, SEASON_REWARDS as REWARDS_18, recommendActivities as recommend18, planCrestSpend as plan18, raidAvailability as raidAvailability18 } from './18.js';

const MODULES = new Map([
  [SEASON_18, Object.freeze({
    seasonId: SEASON_18,
    rewards: REWARDS_18,
    recommendActivities: recommend18,
    planCrestSpend: plan18,
    raidAvailability: raidAvailability18
  })]
]);

export const KNOWN_SEASON_IDS = Object.freeze([...MODULES.keys()].sort((a, b) => a - b));

/** The module for a season, or null when we have no curated data for it. */
export function resolveSeasonModule(seasonId) {
  return MODULES.get(seasonId) || null;
}

/**
 * A structured "we don't have this season" answer. Returned instead of data so
 * callers surface the gap rather than silently serving the wrong season.
 */
export function seasonDataUnavailable(seasonId) {
  return {
    seasonDataUnavailable: true,
    seasonId,
    knownSeasonIds: KNOWN_SEASON_IDS,
    provenance: 'curated',
    message:
      `No curated reward data for season ${seasonId}. `
      + `Curated data exists for: ${KNOWN_SEASON_IDS.join(', ')}. `
      + 'Season rules must be re-verified and added before this tool can answer for a new season.'
  };
}
