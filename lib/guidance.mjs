/* Class guidance: ClassCodex recommendations, decoded and joined to gear.
 *
 * Composes three things that can each be independently unavailable:
 *   - the ClassCodex snapshot (synced from the addon)
 *   - talent trees (raidbots, needed to decode build strings)
 *   - Blizzard equipment (for the audit)
 *
 * Every one of those degrades rather than fails. If talent trees are missing
 * or failed their contract, builds are still returned as export strings with a
 * warning — an agent can still paste them into the game. Returning nothing
 * because a decoration is unavailable would be worse than returning less.
 */

import { importClassCodex, specGuidance } from './classcodex.mjs';
import { decodeLoadout, diffLoadouts } from './talent-decoder.mjs';
import { auditGear } from './gear-audit.mjs';
import { PROVENANCE, COMMUNITY_SOURCES } from './providers.mjs';

const CLASS_TOKENS = Object.freeze({
  'death knight': 'DEATHKNIGHT',
  'demon hunter': 'DEMONHUNTER',
  druid: 'DRUID',
  evoker: 'EVOKER',
  hunter: 'HUNTER',
  mage: 'MAGE',
  monk: 'MONK',
  paladin: 'PALADIN',
  priest: 'PRIEST',
  rogue: 'ROGUE',
  shaman: 'SHAMAN',
  warlock: 'WARLOCK',
  warrior: 'WARRIOR'
});

export function classToken(value) {
  const key = String(value || '').trim().toLowerCase();
  return CLASS_TOKENS[key] || key.replace(/[^a-z]/g, '').toUpperCase() || null;
}

export function createGuidanceService(options = {}) {
  const referenceData = options.referenceData;
  const addonPath = options.addonPath || process.env.CLASSCODEX_PATH || '/classcodex';
  const importImpl = options.importImpl || importClassCodex;
  if (!referenceData) throw new TypeError('guidance service needs a reference data store');

  /** Import the addon into the snapshot store. Safe to call repeatedly. */
  async function refreshSnapshot() {
    try {
      const snapshot = await importImpl(addonPath);
      return await referenceData.putSnapshot('classcodex', snapshot, {
        extra: {
          addonVersion: snapshot.addonVersion,
          lastScrape: snapshot.lastScrape,
          specCount: snapshot.specCount,
          importWarnings: snapshot.importWarnings?.length ?? 0
        }
      });
    } catch (error) {
      return { id: 'classcodex', outcome: 'unavailable', reason: `import failed: ${error.message}` };
    }
  }

  async function snapshot() {
    const { data, meta } = await referenceData.get('classcodex');
    return { data, meta };
  }

  /** The spec tree needed to decode a build, or null with a reason. */
  async function talentTreeFor(specId) {
    const { data, meta } = await referenceData.get('talent-trees');
    if (!Array.isArray(data)) return { tree: null, warning: 'Talent trees are unavailable; builds are returned undecoded.' };
    const tree = data.find((entry) => entry.specId === specId);
    if (!tree) return { tree: null, warning: `No talent tree for spec ${specId}; build returned undecoded.` };
    if (meta?.contractViolation) {
      return { tree, warning: 'Talent tree data last failed its upstream contract; decoded names may be stale.' };
    }
    return { tree, warning: null };
  }

  /**
   * Guidance for one spec, with recommended builds decoded where possible.
   * `specId` is optional and only used to decode; omitting it just means the
   * build strings come back undecoded.
   */
  async function classGuidance({ className, spec, specId = null }) {
    const { data: snap, meta } = await snapshot();
    if (!snap) {
      return {
        provenance: PROVENANCE.COMMUNITY,
        source: COMMUNITY_SOURCES.CLASSCODEX,
        available: false,
        reason: 'No ClassCodex snapshot has been imported yet.',
        contractViolation: meta?.contractViolation ?? null
      };
    }

    const token = classToken(className);
    const guidance = specGuidance(snap, token, spec);
    if (!guidance) {
      return {
        provenance: PROVENANCE.COMMUNITY,
        source: COMMUNITY_SOURCES.CLASSCODEX,
        available: false,
        reason: `No guidance for ${token}/${String(spec).toLowerCase()}.`,
        knownSpecs: Object.keys(snap.specs).slice(0, 8)
      };
    }

    const warnings = [];
    if (meta?.contractViolation) warnings.push('The ClassCodex snapshot last failed its contract; some fields may be missing.');

    let builds = guidance.talentBuilds || [];
    if (specId) {
      const { tree, warning } = await talentTreeFor(specId);
      if (warning) warnings.push(warning);
      if (tree) {
        builds = builds.map((build) => {
          if (!build?.exportString) return build;
          try {
            const decoded = decodeLoadout(build.exportString, tree);
            return { ...build, decoded: { pointsSpent: decoded.pointsSpent, counts: decoded.counts, talents: decoded.talents } };
          } catch (error) {
            // A build that will not decode is still a usable import string.
            return { ...build, decodeError: error.message };
          }
        });
      }
    }

    return { ...guidance, available: true, talentBuilds: builds, warnings: warnings.length ? warnings : null };
  }

  /** Diff a character's current build against a recommended one. */
  async function talentComparison({ currentExportString, className, spec, specId, context = null }) {
    const guidance = await classGuidance({ className, spec, specId });
    if (!guidance.available) return guidance;

    const { tree, warning } = await talentTreeFor(specId);
    if (!tree) {
      return { ...guidance, comparison: null, warnings: [...(guidance.warnings || []), warning] };
    }

    const candidates = (guidance.talentBuilds || []).filter((build) => build?.exportString);
    const chosen = context
      ? candidates.find((build) => String(build.context || '').toLowerCase() === String(context).toLowerCase())
      : candidates[0];
    if (!chosen) return { ...guidance, comparison: null };

    try {
      const mine = decodeLoadout(currentExportString, tree);
      const theirs = decodeLoadout(chosen.exportString, tree);
      return {
        ...guidance,
        comparison: {
          provenance: PROVENANCE.COMMUNITY,
          source: COMMUNITY_SOURCES.CLASSCODEX,
          against: { context: chosen.context ?? null, heroTalent: chosen.heroTalent ?? null, buildLabel: chosen.buildLabel ?? null },
          ...diffLoadouts(mine, theirs)
        }
      };
    } catch (error) {
      return { ...guidance, comparison: null, comparisonError: error.message };
    }
  }

  /** Equipment vs guidance. Equipment must be Blizzard-sourced. */
  async function gearAudit({ equipment, className, spec }) {
    const guidance = await classGuidance({ className, spec });
    if (!guidance.available) {
      return { ...auditGear({ equipment, guidance: null }), guidanceUnavailable: guidance.reason };
    }
    return auditGear({ equipment, guidance });
  }

  return { refreshSnapshot, snapshot, classGuidance, talentComparison, gearAudit, talentTreeFor };
}
