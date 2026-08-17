/* Where a piece of data came from.
 *
 * Every response the site or the MCP sidecar returns carries a `provenance`
 * from this vocabulary, so a consumer can never mistake a community
 * recommendation for an authoritative fact about a character.
 *
 * The hard rule: character gear may only ever be BLIZZARD. Everything else may
 * come from anywhere, provided it says so. `assertGearProvenance` exists to
 * make that rule enforceable by the test suite rather than by convention.
 */

export const PROVENANCE = Object.freeze({
  /** Character-owned facts read from the Blizzard Profile API. Authoritative. */
  BLIZZARD: 'blizzard',
  /** Season reward rules we maintain by hand. Carries season/patch/verifiedAt. */
  CURATED: 'curated',
  /** Third-party community data. Always accompanied by a `source`. */
  COMMUNITY: 'community',
  /** Values the visitor typed in, such as crest balances. Never persisted. */
  USER: 'user'
});

export const PROVENANCE_VALUES = Object.freeze(Object.values(PROVENANCE));

/** Named community sources, so `source` is never a free-text typo. */
export const COMMUNITY_SOURCES = Object.freeze({
  CLASSCODEX: 'classcodex',
  RAIDERIO: 'raiderio'
});

export function isProvenance(value) {
  return PROVENANCE_VALUES.includes(value);
}

/**
 * Stamp a payload with its origin. `source` is required for community data and
 * rejected for everything else, so the two can't drift apart.
 */
export function withProvenance(payload, provenance, source) {
  if (!isProvenance(provenance)) {
    throw new TypeError(`Unknown provenance: ${provenance}`);
  }
  if (provenance === PROVENANCE.COMMUNITY) {
    if (!Object.values(COMMUNITY_SOURCES).includes(source)) {
      throw new TypeError(`Community data needs a known source, got: ${source}`);
    }
    return { ...payload, provenance, source };
  }
  if (source !== undefined) {
    throw new TypeError(`Only community data carries a source, got: ${provenance}`);
  }
  return { ...payload, provenance };
}

/**
 * Throws unless every gear-bearing part of a payload is Blizzard-sourced.
 *
 * "Gear-bearing" means a response that reports what a character actually has
 * equipped. Recommendations *about* gear are not gear; they are community data
 * and are checked by their own provenance instead.
 */
export function assertGearProvenance(payload) {
  const looksLikeEquipment = Array.isArray(payload?.items)
    && payload.items.some((item) => item && ('itemLevel' in item || 'slot' in item));
  if (!looksLikeEquipment) return payload;
  if (payload.provenance !== PROVENANCE.BLIZZARD) {
    throw new Error(
      `Equipment must be provenance '${PROVENANCE.BLIZZARD}', got '${payload.provenance}'.`
    );
  }
  return payload;
}
