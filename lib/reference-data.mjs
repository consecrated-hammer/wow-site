/* Reference data that is not character-owned: talent trees, spell text, and
 * the ClassCodex snapshot.
 *
 * THE REFRESH RULE IS PER-DATASET, NOT GLOBAL. These sources change for
 * different reasons and a single "check daily" rule is wrong for all of them:
 *
 *   build-triggered  Static game data. Only changes when the game build
 *                    changes... except that Blizzard also ships server-side
 *                    hotfixes with no build change, so a build trigger alone
 *                    would silently miss them. Every build-triggered dataset
 *                    therefore also carries a max-age backstop that
 *                    revalidates anyway. Revalidation is nearly free: an ETag
 *                    conditional request returns 304 with no body.
 *   ttl              Dynamic data that simply expires.
 *   synced           Arrives on disk by some other means (Syncthing). We
 *                    snapshot it and report its age; we never refresh it.
 *   manual           Hand-curated. NEVER auto-refreshed — staleness there is a
 *                    signal for a person, surfaced in the admin UI.
 *
 * Everything is persisted so a restart does not re-download, and so an
 * upstream outage degrades to "serve the cached copy with a warning" rather
 * than to failure.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { validateTalentTrees, validateClassCodex, describeViolations } from './contracts.mjs';
import { join } from 'node:path';

export const POLICY = Object.freeze({
  BUILD_TRIGGERED: 'build-triggered',
  TTL: 'ttl',
  SYNCED: 'synced',
  MANUAL: 'manual'
});

const DAY_MS = 86_400_000;

export const RAIDBOTS_TALENTS_URL = 'https://www.raidbots.com/static/data/live/talents.json';
export const WAGO_BUILDS_URL = 'https://wago.tools/api/builds';

/**
 * The registry. Adding a dataset here makes it appear in status() and in the
 * admin UI automatically, rather than needing a second hardcoded list.
 */
export function datasetDefinitions() {
  return [
    {
      id: 'talent-trees',
      label: 'Talent trees',
      source: 'raidbots.com',
      policy: POLICY.BUILD_TRIGGERED,
      backstopMs: DAY_MS,
      note: 'Node ordering used to decode talent loadout strings.',
      validate: validateTalentTrees
    },
    {
      id: 'classcodex',
      label: 'ClassCodex guidance',
      source: 'ClassCodex addon (MIT, jfstn)',
      policy: POLICY.SYNCED,
      note: 'Snapshotted read-only from the Syncthing copy. Refreshes when the addon is updated on the PC.',
      validate: validateClassCodex
    },
    {
      id: 'season-rules',
      label: 'Curated season rules',
      source: 'hand-maintained',
      policy: POLICY.MANUAL,
      note: 'Never auto-refreshed. Re-verify against sources when a patch lands.',
      validate: () => ({ ok: true, contract: 'season-rules', checked: 0, violations: [] })
    }
  ];
}

export function createReferenceData(options = {}) {
  const cacheDir = options.cacheDir || process.env.REFERENCE_CACHE_DIR || '/data/reference';
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || (() => Date.now());
  const memory = new Map();

  const dataPath = (id) => join(cacheDir, `${id}.json`);
  const metaPath = (id) => join(cacheDir, `${id}.meta.json`);

  async function readJson(path) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return null;
    }
  }

  async function writeJson(path, value) {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path, JSON.stringify(value), 'utf8');
  }

  /** Current game build, used as the change trigger for static data. */
  async function currentBuild() {
    try {
      const response = await fetchImpl(WAGO_BUILDS_URL, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return null;
      const payload = await response.json();
      const products = payload?.wow || payload?.wowt || [];
      return products[0]?.version || null;
    } catch {
      return null;
    }
  }

  async function load(id) {
    if (memory.has(id)) return memory.get(id);
    const [data, meta] = await Promise.all([readJson(dataPath(id)), readJson(metaPath(id))]);
    const entry = { data, meta: meta || {} };
    if (data !== null) memory.set(id, entry);
    return entry;
  }

  /**
   * True when a build-triggered dataset needs revalidating: the build moved,
   * the backstop expired, or we have nothing cached at all.
   */
  function needsRevalidation(definition, meta, build) {
    if (!meta?.fetchedAt) return { stale: true, reason: 'no cached copy' };
    if (definition.policy === POLICY.MANUAL) return { stale: false, reason: 'manual policy' };
    if (definition.policy === POLICY.SYNCED) return { stale: false, reason: 'synced externally' };
    if (definition.policy === POLICY.BUILD_TRIGGERED) {
      if (build && meta.build && build !== meta.build) {
        return { stale: true, reason: `build changed ${meta.build} -> ${build}` };
      }
      const age = now() - Date.parse(meta.fetchedAt);
      if (age >= (definition.backstopMs ?? DAY_MS)) {
        return { stale: true, reason: 'backstop elapsed; hotfixes do not change the build' };
      }
      return { stale: false, reason: 'build unchanged and within backstop' };
    }
    const age = now() - Date.parse(meta.fetchedAt);
    return age >= (definition.ttlMs ?? DAY_MS)
      ? { stale: true, reason: 'ttl expired' }
      : { stale: false, reason: 'within ttl' };
  }

  /**
   * Revalidate one dataset.
   *
   * Returns `trigger` (why we checked) separately from `reason` (what upstream
   * said), because the admin UI needs both: "backstop elapsed" + "304" means
   * the hotfix check ran and found nothing, which is a different story from
   * "build changed" + "downloaded a new copy".
   */
  async function refreshTalentTrees({ force = false } = {}) {
    const definition = datasetDefinitions().find((entry) => entry.id === 'talent-trees');
    const { data: cached, meta } = await load('talent-trees');
    const build = await currentBuild();
    const decision = force
      ? { stale: true, reason: 'forced' }
      : needsRevalidation(definition, meta, build);

    if (!decision.stale && cached) {
      return { id: 'talent-trees', outcome: 'skipped', trigger: decision.reason, reason: decision.reason, build: meta.build ?? build };
    }

    const headers = {};
    // The whole point: an unchanged upstream costs a 304 and no body.
    if (meta?.etag && !force) headers['if-none-match'] = meta.etag;

    let response;
    try {
      response = await fetchImpl(RAIDBOTS_TALENTS_URL, { headers, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      if (cached) return { id: 'talent-trees', outcome: 'stale', trigger: decision.reason, reason: `upstream unreachable: ${error.message}`, build };
      throw error;
    }

    if (response.status === 304) {
      const nextMeta = { ...meta, checkedAt: new Date(now()).toISOString(), build: build ?? meta.build };
      await writeJson(metaPath('talent-trees'), nextMeta);
      memory.set('talent-trees', { data: cached, meta: nextMeta });
      return { id: 'talent-trees', outcome: 'unchanged', trigger: decision.reason, reason: '304 from upstream', build: nextMeta.build };
    }

    if (!response.ok) {
      if (cached) return { id: 'talent-trees', outcome: 'stale', trigger: decision.reason, reason: `upstream HTTP ${response.status}`, build };
      throw new Error(`Talent tree fetch failed: HTTP ${response.status}`);
    }

    const data = await response.json();
    const contract = definition.validate(data);
    if (!contract.ok) {
      // An upstream shape change must never overwrite good data, and must
      // never take the site or the MCP down with it. Keep the last known-good
      // copy, record the violation, and let consumers degrade with a warning.
      const violation = {
        at: new Date(now()).toISOString(),
        contract: contract.contract,
        violations: contract.violations
      };
      await writeJson(metaPath('talent-trees'), { ...meta, checkedAt: violation.at, contractViolation: violation });
      memory.set('talent-trees', { data: cached, meta: { ...meta, contractViolation: violation } });
      console.error(describeViolations(contract));
      if (cached) {
        return {
          id: 'talent-trees', outcome: 'rejected', trigger: decision.reason,
          reason: 'upstream data failed its contract; keeping the last known-good copy',
          contractViolation: violation, build
        };
      }
      return {
        id: 'talent-trees', outcome: 'unavailable', trigger: decision.reason,
        reason: 'upstream data failed its contract and nothing is cached',
        contractViolation: violation, build
      };
    }

    const nextMeta = {
      fetchedAt: new Date(now()).toISOString(),
      checkedAt: new Date(now()).toISOString(),
      etag: response.headers?.get?.('etag') || null,
      lastModified: response.headers?.get?.('last-modified') || null,
      build,
      specCount: data.length
    };
    await writeJson(dataPath('talent-trees'), data);
    await writeJson(metaPath('talent-trees'), nextMeta);
    memory.set('talent-trees', { data, meta: nextMeta });
    return { id: 'talent-trees', outcome: 'updated', trigger: decision.reason, reason: 'downloaded a new copy', build };
  }

  /** Store an externally produced snapshot (ClassCodex) with its own stamps. */
  async function putSnapshot(id, data, meta = {}) {
    const definition = datasetDefinitions().find((entry) => entry.id === id);
    const contract = definition ? definition.validate(data) : { ok: true, violations: [] };
    if (!contract.ok) {
      const violation = { at: new Date(now()).toISOString(), contract: contract.contract, violations: contract.violations };
      const existing = await load(id);
      console.error(describeViolations(contract));
      await writeJson(metaPath(id), { ...existing.meta, checkedAt: violation.at, contractViolation: violation });
      if (existing.data) memory.set(id, { data: existing.data, meta: { ...existing.meta, contractViolation: violation } });
      return {
        id,
        outcome: existing.data ? 'rejected' : 'unavailable',
        reason: 'snapshot failed its contract; the previous copy is untouched',
        contractViolation: violation
      };
    }
    const nextMeta = { ...meta, fetchedAt: new Date(now()).toISOString(), checkedAt: new Date(now()).toISOString() };
    await writeJson(dataPath(id), data);
    await writeJson(metaPath(id), nextMeta);
    memory.set(id, { data, meta: nextMeta });
    return { id, outcome: 'updated', reason: 'snapshot imported' };
  }

  async function get(id) {
    const { data, meta } = await load(id);
    return { data, meta };
  }

  /** Registry-driven, so a dataset added above appears here with no extra code. */
  async function status() {
    const build = await currentBuild();
    const rows = [];
    for (const definition of datasetDefinitions()) {
      const { data, meta } = await load(definition.id);
      const decision = needsRevalidation(definition, meta, build);
      rows.push({
        id: definition.id,
        label: definition.label,
        source: definition.source,
        policy: definition.policy,
        note: definition.note,
        present: data !== null,
        fetchedAt: meta.fetchedAt ?? null,
        checkedAt: meta.checkedAt ?? null,
        build: meta.build ?? null,
        currentBuild: build,
        ageMs: meta.fetchedAt ? now() - Date.parse(meta.fetchedAt) : null,
        stale: decision.stale,
        staleReason: decision.reason,
        extra: meta.extra ?? null,
        contractViolation: meta.contractViolation ?? null,
        contractOk: !meta.contractViolation
      });
    }
    return { checkedAt: new Date(now()).toISOString(), currentBuild: build, datasets: rows };
  }

  return { get, status, refreshTalentTrees, putSnapshot, currentBuild, needsRevalidation };
}
