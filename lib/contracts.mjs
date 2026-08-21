/* Upstream data contracts.
 *
 * Every external source here is somebody else's data model and can change
 * without notice: raidbots can rename a field, ClassCodex can restructure its
 * Lua globals, Raider.IO can drop `loadout` from a roster entry.
 *
 * The failure mode we are defending against is SILENT DEGRADATION. A shape
 * change usually does not throw — it yields undefined, which flows through as
 * an empty list, a missing talent, or a decode against the wrong node order.
 * The result looks like a working feature with wrong answers, which is the
 * worst outcome this project can produce.
 *
 * So a contract asserts the fields we actually depend on, across a sample of
 * records rather than just the first one, and a violation is treated as
 * "refuse the new data, keep the last known-good copy, and tell a human" — not
 * as something to paper over with a default.
 */

/** A field requirement: path, predicate, and what it is used for. */
export function field(path, predicate, usedFor) {
  return { path, predicate, usedFor };
}

export const is = Object.freeze({
  string: (value) => typeof value === 'string' && value.length > 0,
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  array: (value) => Array.isArray(value),
  nonEmptyArray: (value) => Array.isArray(value) && value.length > 0,
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  arrayOfNumbers: (value) => Array.isArray(value) && value.length > 0 && value.every(Number.isFinite)
});

function read(source, path) {
  return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), source);
}

/**
 * Check a set of records against field requirements.
 *
 * `sampleSize` bounds the work on large payloads while still checking more
 * than the first element, which is where naive validators go wrong: upstream
 * changes are often partial, and element 0 is the one most likely to be fine.
 */
export function checkRecords(records, requirements, { sampleSize = 25, label = 'record' } = {}) {
  const violations = [];
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, checked: 0, violations: [{ path: '(root)', problem: `expected a non-empty array of ${label}s` }] };
  }

  // Sample across the whole payload, not just the head.
  const step = Math.max(1, Math.floor(records.length / sampleSize));
  const sampled = [];
  for (let index = 0; index < records.length && sampled.length < sampleSize; index += step) {
    sampled.push({ index, record: records[index] });
  }

  for (const requirement of requirements) {
    const failures = sampled.filter(({ record }) => !requirement.predicate(read(record, requirement.path)));
    if (failures.length > 0) {
      violations.push({
        path: requirement.path,
        problem: `${failures.length}/${sampled.length} sampled ${label}s failed`,
        usedFor: requirement.usedFor,
        exampleIndex: failures[0].index
      });
    }
  }

  return { ok: violations.length === 0, checked: sampled.length, total: records.length, violations };
}

/** raidbots talents.json — the node ordering the talent decoder relies on. */
export const RAIDBOTS_TALENTS_CONTRACT = Object.freeze({
  name: 'raidbots/talents.json',
  minimumRecords: 30,
  requirements: [
    field('specId', is.integer, 'matching a loadout string to its spec'),
    field('className', is.string, 'labelling decoded builds'),
    field('specName', is.string, 'labelling decoded builds'),
    field('fullNodeOrder', is.arrayOfNumbers, 'THE decode order; a change here silently corrupts every decode'),
    field('classNodes', is.nonEmptyArray, 'resolving node ids to talent names'),
    field('specNodes', is.nonEmptyArray, 'resolving node ids to talent names'),
    field('heroNodes', is.nonEmptyArray, 'resolving hero talent selections')
  ]
});

export function validateTalentTrees(data) {
  const result = checkRecords(data, RAIDBOTS_TALENTS_CONTRACT.requirements, { label: 'spec' });
  if (!result.ok) return { ...result, contract: RAIDBOTS_TALENTS_CONTRACT.name };

  if (data.length < RAIDBOTS_TALENTS_CONTRACT.minimumRecords) {
    return {
      ok: false,
      checked: result.checked,
      contract: RAIDBOTS_TALENTS_CONTRACT.name,
      violations: [{
        path: '(root)',
        problem: `only ${data.length} specs, expected at least ${RAIDBOTS_TALENTS_CONTRACT.minimumRecords}`,
        usedFor: 'a sudden drop in spec count means an upstream restructure, not a game change'
      }]
    };
  }

  // Node entries carry the names we display; check one spec's entries deeply.
  const sample = data[0];
  const entry = sample.classNodes?.[0]?.entries?.[0];
  if (!entry || !is.string(entry.name) || !is.integer(entry.spellId)) {
    return {
      ok: false,
      checked: result.checked,
      contract: RAIDBOTS_TALENTS_CONTRACT.name,
      violations: [{
        path: 'classNodes[].entries[]',
        problem: 'entries lack name/spellId',
        usedFor: 'naming the talents in a decoded build'
      }]
    };
  }
  return { ...result, contract: RAIDBOTS_TALENTS_CONTRACT.name };
}

/** ClassCodex snapshot — guidance we join against Blizzard equipment. */
export const CLASSCODEX_CONTRACT = Object.freeze({
  name: 'classcodex/snapshot',
  minimumSpecs: 30,
  // Specs we know exist; if these vanish the Lua globals were restructured.
  canaries: ['PALADIN/holy', 'DRUID/restoration', 'WARRIOR/arms']
});

export function validateClassCodex(snapshot) {
  const violations = [];
  const specs = snapshot?.specs;

  if (!is.object(specs) || Object.keys(specs).length === 0) {
    return { ok: false, contract: CLASSCODEX_CONTRACT.name, checked: 0, violations: [{ path: 'specs', problem: 'missing or empty' }] };
  }

  const count = Object.keys(specs).length;
  if (count < CLASSCODEX_CONTRACT.minimumSpecs) {
    violations.push({
      path: 'specs',
      problem: `only ${count} specs, expected at least ${CLASSCODEX_CONTRACT.minimumSpecs}`,
      usedFor: 'a drop in spec count means globals were renamed and files were skipped silently'
    });
  }

  for (const canary of CLASSCODEX_CONTRACT.canaries) {
    if (!specs[canary]) {
      violations.push({
        path: `specs["${canary}"]`,
        problem: 'known spec missing',
        usedFor: 'detecting a renamed Lua global or a changed directory layout'
      });
    }
  }

  // The fields the MCP and gear audit actually read. These are the ClassCodex
  // 1.0 normalised fields, not the retired per-provider Lua globals.
  const paladin = specs['PALADIN/holy'];
  if (paladin) {
    const checks = [
      ['statPriorities', is.nonEmptyArray, 'source-labelled stat priorities'],
      ['talentBuilds', is.nonEmptyArray, 'recommended and observed talent builds'],
      ['trinkets', is.nonEmptyArray, 'contextual trinket recommendations'],
      ['statTargets', is.nonEmptyArray, 'observed stat targets'],
      ['sourceUrls', is.object, 'Icy Veins attribution URLs']
    ];
    for (const [path, predicate, usedFor] of checks) {
      if (!predicate(read(paladin, path))) {
        violations.push({ path: `specs["PALADIN/holy"].${path}`, problem: 'missing or wrong type', usedFor });
      }
    }
    const build = read(paladin, 'talentBuilds')?.[0];
    if (build && !is.string(build.exportString)) {
      violations.push({
        path: 'specs["PALADIN/holy"].talentBuilds[].exportString',
        problem: 'not a string',
        usedFor: 'decoding recommended builds to diff against yours'
      });
    }
  }

  if (snapshot.importWarnings?.length) {
    violations.push({
      path: '(import)',
      problem: `${snapshot.importWarnings.length} file(s) failed to parse or were missing`,
      usedFor: 'silently skipped files are how an upstream restructure hides',
      detail: snapshot.importWarnings.slice(0, 5)
    });
  }

  return { ok: violations.length === 0, contract: CLASSCODEX_CONTRACT.name, checked: count, violations };
}

/** Raider.IO top runs — comps and loadouts. */
export const RAIDERIO_RUNS_CONTRACT = Object.freeze({
  name: 'raiderio/mythic-plus/runs',
  requirements: [
    field('run.dungeon.name', is.string, 'naming the dungeon a comp was run in'),
    field('run.mythic_level', is.integer, 'filtering comps by key band'),
    field('run.roster', is.nonEmptyArray, 'the team composition itself')
  ]
});

export function validateRaiderIoRuns(payload) {
  const rankings = payload?.rankings;
  const result = checkRecords(rankings, RAIDERIO_RUNS_CONTRACT.requirements, { label: 'ranking', sampleSize: 10 });
  if (!result.ok) return { ...result, contract: RAIDERIO_RUNS_CONTRACT.name };

  const violations = [];
  const roster = rankings[0]?.run?.roster || [];
  if (roster.length !== 5) {
    violations.push({ path: 'run.roster', problem: `roster of ${roster.length}, expected 5`, usedFor: 'team composition' });
  }
  const member = roster[0];
  if (member) {
    if (!is.string(read(member, 'character.class.name'))) {
      violations.push({ path: 'run.roster[].character.class.name', problem: 'missing', usedFor: 'composition' });
    }
    if (!is.string(read(member, 'character.spec.name'))) {
      violations.push({ path: 'run.roster[].character.spec.name', problem: 'missing', usedFor: 'composition' });
    }
    if (!is.string(member.loadout)) {
      violations.push({
        path: 'run.roster[].loadout',
        problem: 'missing or not a string',
        usedFor: 'THE talent build; without it meta builds silently return comps with no talents'
      });
    }
  }
  return { ok: violations.length === 0, contract: RAIDERIO_RUNS_CONTRACT.name, checked: result.checked, violations };
}

/** Render a violation report for logs and the admin page. */
export function describeViolations(result) {
  if (result.ok) return `${result.contract}: contract satisfied (${result.checked} checked)`;
  const lines = result.violations.map((violation) =>
    `  - ${violation.path}: ${violation.problem}${violation.usedFor ? ` (needed for ${violation.usedFor})` : ''}`);
  return `${result.contract}: CONTRACT VIOLATION\n${lines.join('\n')}`;
}
