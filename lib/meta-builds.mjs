/* Observed top-run compositions and talent builds, from Raider.IO.
 *
 * This is deliberately a different claim from ClassCodex guidance. ClassCodex
 * says "a guide recommends this"; Raider.IO says "the top teams actually ran
 * this last week". Both are community data, so both are labelled, but they are
 * never merged into one voice.
 *
 * Raider.IO's terms permit community use, cap unauthenticated callers at 200
 * requests per minute, and require public attribution — hence ATTRIBUTION
 * travelling on every response.
 */

import { validateRaiderIoRuns, describeViolations } from './contracts.mjs';
import { decodeLoadout } from './talent-decoder.mjs';
import { PROVENANCE, COMMUNITY_SOURCES } from './providers.mjs';

export const RAIDERIO_RUNS_URL = 'https://raider.io/api/v1/mythic-plus/runs';
export const ATTRIBUTION = Object.freeze({
  name: 'Raider.IO',
  url: 'https://raider.io',
  note: 'Mythic+ run data provided by Raider.IO.'
});

const USER_AGENT = 'wow-site/1.0 (https://wow.batserver.au; personal project)';

export function createMetaBuilds(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || (() => Date.now());
  const ttlMs = options.metaTtlMs ?? 6 * 60 * 60 * 1000;
  const referenceData = options.referenceData || null;
  const cache = new Map();
  const pending = new Map();

  async function fetchRuns({ season, region, page }) {
    const url = new URL(RAIDERIO_RUNS_URL);
    url.searchParams.set('season', season);
    url.searchParams.set('region', region);
    url.searchParams.set('affixes', 'all');
    url.searchParams.set('page', String(page));
    // A default user agent is rejected with 403; a real one is required.
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(`Raider.IO returned HTTP ${response.status}`);
    return response.json();
  }

  /** Aggregate comps and builds across a few pages of top runs. */
  async function metaBuilds({ season, region = 'world', pages = 3, spec = null }) {
    const key = `${season}/${region}/${pages}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return shape(cached.data, spec);
    if (pending.has(key)) return shape(await pending.get(key), spec);

    const request = (async () => {
      const payloads = [];
      for (let page = 0; page < pages; page += 1) {
        payloads.push(await fetchRuns({ season, region, page }));
      }

      const contract = validateRaiderIoRuns(payloads[0]);
      if (!contract.ok) {
        console.error(describeViolations(contract));
        const error = new Error('Raider.IO data failed its contract.');
        error.contractViolation = contract;
        throw error;
      }

      const rankings = payloads.flatMap((payload) => payload.rankings || []);
      const comps = new Map();
      const specCounts = new Map();
      const buildsBySpec = new Map();

      for (const ranking of rankings) {
        const run = ranking.run || {};
        const roster = run.roster || [];
        if (roster.length !== 5) continue;

        const labels = [];
        for (const member of roster) {
          const character = member.character || {};
          const label = `${character.spec?.name ?? '?'} ${character.class?.name ?? '?'}`;
          labels.push(label);
          specCounts.set(label, (specCounts.get(label) || 0) + 1);
          if (member.loadout) {
            const forSpec = buildsBySpec.get(label) || new Map();
            forSpec.set(member.loadout, (forSpec.get(member.loadout) || 0) + 1);
            buildsBySpec.set(label, forSpec);
          }
        }
        const compKey = [...labels].sort().join(' + ');
        comps.set(compKey, (comps.get(compKey) || 0) + 1);
      }

      return {
        season,
        region,
        runsAnalysed: rankings.length,
        fetchedAt: new Date(now()).toISOString(),
        comps: [...comps].sort((a, b) => b[1] - a[1]).map(([composition, count]) => ({ composition, count })),
        specs: [...specCounts].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ spec: label, count })),
        builds: [...buildsBySpec].map(([label, forSpec]) => ({
          spec: label,
          distinctBuilds: forSpec.size,
          appearances: [...forSpec.values()].reduce((total, value) => total + value, 0),
          mostCommon: [...forSpec].sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([exportString, count]) => ({ exportString, count }))
        }))
      };
    })();

    pending.set(key, request);
    try {
      const data = await request;
      cache.set(key, { data, expiresAt: now() + ttlMs });
      return shape(data, spec);
    } finally {
      pending.delete(key);
    }
  }

  function shape(data, spec) {
    const filtered = spec
      ? {
          ...data,
          specs: data.specs.filter((entry) => entry.spec.toLowerCase().includes(spec.toLowerCase())),
          builds: data.builds.filter((entry) => entry.spec.toLowerCase().includes(spec.toLowerCase()))
        }
      : data;
    return {
      provenance: PROVENANCE.COMMUNITY,
      source: COMMUNITY_SOURCES.RAIDERIO,
      attribution: ATTRIBUTION,
      ...filtered
    };
  }

  /** Decode a spec's most common build, when talent trees are available. */
  async function decodeBuilds(result, specId) {
    if (!referenceData || !specId) return result;
    const { data: trees, meta } = await referenceData.get('talent-trees');
    const tree = Array.isArray(trees) ? trees.find((entry) => entry.specId === specId) : null;
    if (!tree) {
      return { ...result, decodeWarning: 'Talent trees unavailable; builds returned as import strings only.' };
    }
    const builds = result.builds.map((entry) => ({
      ...entry,
      mostCommon: entry.mostCommon.map((build) => {
        try {
          const decoded = decodeLoadout(build.exportString, tree);
          return { ...build, decoded: { pointsSpent: decoded.pointsSpent, talents: decoded.talents } };
        } catch (error) {
          return { ...build, decodeError: error.message };
        }
      })
    }));
    return {
      ...result,
      builds,
      decodeWarning: meta?.contractViolation ? 'Talent tree data last failed its contract; names may be stale.' : null
    };
  }

  return { metaBuilds, decodeBuilds };
}
