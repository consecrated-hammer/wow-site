/* Import structured guidance from the ClassCodex addon.
 *
 * The addon directory is mounted read-only. We snapshot it before serving
 * requests so a Syncthing update can never be read half-written by an MCP
 * request. This parser deliberately understands Lua table literals only; it
 * never evaluates addon code.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_ADDON_PATH = '/classcodex';

/** Parse a Lua table literal. Returns a JS value; throws on executable Lua. */
export function parseLuaTable(source, startIndex = 0) {
  let index = startIndex;

  const skipTrivia = () => {
    for (;;) {
      while (index < source.length && /\s/.test(source[index])) index += 1;
      if (source.startsWith('--', index)) {
        const newline = source.indexOf('\n', index);
        index = newline === -1 ? source.length : newline + 1;
        continue;
      }
      break;
    }
  };

  const readString = () => {
    const quote = source[index++];
    let value = '';
    while (index < source.length && source[index] !== quote) {
      if (source[index] === '\\') {
        const next = source[index + 1];
        value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
        index += 2;
      } else value += source[index++];
    }
    if (source[index] !== quote) throw new SyntaxError('Unterminated Lua string');
    index += 1;
    return value;
  };

  const readValue = () => {
    skipTrivia();
    const character = source[index];
    if (character === '{') return readTable();
    if (character === '"' || character === "'") return readString();
    const rest = source.slice(index);
    const literal = /^(true|false|nil)\b/.exec(rest);
    if (literal) {
      index += literal[0].length;
      return literal[0] === 'true' ? true : literal[0] === 'false' ? false : null;
    }
    const number = /^-?\d+(\.\d+)?/.exec(rest);
    if (number) {
      index += number[0].length;
      return Number(number[0]);
    }
    // An identifier would require evaluating Lua, which this importer refuses.
    throw new SyntaxError(`Unparseable Lua value at ${index}: ${rest.slice(0, 40)}`);
  };

  function readTable() {
    index += 1;
    const array = [];
    const record = {};
    let hasKeys = false;
    for (;;) {
      skipTrivia();
      if (source[index] === '}') { index += 1; break; }
      if (index >= source.length) throw new SyntaxError('Unterminated Lua table');
      let key = null;
      if (source[index] === '[') {
        index += 1;
        key = readValue();
        skipTrivia();
        if (source[index++] !== ']') throw new SyntaxError('Malformed Lua table key');
        skipTrivia();
        if (source[index++] !== '=') throw new SyntaxError('Malformed Lua table assignment');
      } else {
        const identifier = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(source.slice(index));
        if (identifier) {
          key = identifier[1];
          index += identifier[0].length;
        }
      }
      const value = readValue();
      if (key === null) array.push(value);
      else { record[key] = value; hasKeys = true; }
      skipTrivia();
      if (source[index] === ',' || source[index] === ';') index += 1;
    }
    if (hasKeys && array.length) return { ...record, entries: array };
    return hasKeys ? record : array;
  }

  skipTrivia();
  return readValue();
}

/** Compatibility helper retained for the parser's focused unit tests. */
export function extractAssignment(source, globalName) {
  const marker = new RegExp(`${globalName}\\s*\\[\\s*"([A-Z_]+)"\\s*\\]\\s*=\\s*\\{`);
  const match = marker.exec(source);
  if (!match) return null;
  return { classToken: match[1], value: parseLuaTable(source, source.indexOf('{', match.index)) };
}

function extractNamedSource(source, sourceName) {
  const marker = new RegExp(`ClassCodexSource\\s*\\[\\s*"${sourceName}"\\s*\\]\\s*=\\s*\\{`);
  const match = marker.exec(source);
  if (!match) throw new Error(`ClassCodexSource["${sourceName}"] not found`);
  return parseLuaTable(source, source.indexOf('{', match.index));
}

function contextFor(heroKey, rawKey, reference = {}) {
  const [rawActivity, variant] = String(rawKey).split(':', 2);
  const activity = rawActivity === 'all' ? 'general' : rawActivity;
  const context = {
    heroTalent: heroKey === 'all' ? null : heroKey,
    heroTalentName: heroKey === 'all' ? null : reference.heroNames?.[heroKey] ?? heroKey,
    activity
  };
  if (!variant) return context;
  if (/^\d+$/.test(variant)) {
    context.encounterId = Number(variant);
    context.encounter = reference.encounters?.dungeons?.[variant] ?? reference.encounters?.bosses?.[variant] ?? null;
  } else context.variant = variant;
  return context;
}

function contextual(value, reference, callback) {
  for (const [heroKey, activities] of Object.entries(value || {})) {
    if (!activities || typeof activities !== 'object' || Array.isArray(activities)) continue;
    for (const [activity, payload] of Object.entries(activities)) callback(contextFor(heroKey, activity, reference), payload);
  }
}

function abilitiesFromSteps(steps) {
  const ids = new Set();
  for (const step of steps || []) {
    const text = typeof step === 'string' ? step : step?.text;
    for (const match of String(text || '').matchAll(/\{(\d+)\}/g)) ids.add(Number(match[1]));
  }
  return [...ids];
}

function normalizeSource(sourceName, raw, reference = {}) {
  const rows = {
    statPriorities: [], statTargets: [], talentBuilds: [], rotation: [], trinkets: [],
    gear: [], enchants: [], gems: [], consumables: [], crafting: [], omniumFolio: [], rankings: []
  };
  const add = (field, context, value) => rows[field].push({ source: sourceName, ...context, ...value });

  contextual(raw.statPriority, reference, (context, value) => add('statPriorities', context, {
    primary: value?.primary ?? null, secondary: value?.secondary ?? []
  }));
  contextual(raw.statTargets, reference, (context, value) => add('statTargets', context, { targets: value }));
  contextual(raw.talents, reference, (context, value) => {
    for (const build of Array.isArray(value) ? value : []) add('talentBuilds', context, {
      exportString: build.export ?? null, label: build.label ?? null, labels: build.labels ?? null,
      recommended: build.recommended ?? false, pickRate: build.pickrate ?? null, topDps: build.topDps ?? false,
      honorTalentSpellIds: build.honor ?? null
    });
  });
  // Source guide prose is intentionally not copied into the MCP. Ability IDs
  // and a source URL provide a compact, attributable rotation summary instead.
  contextual(raw.rotation, reference, (context, value) => add('rotation', context, {
    stepCount: Array.isArray(value?.steps) ? value.steps.length : 0,
    abilityIds: abilitiesFromSteps(value?.steps)
  }));
  contextual(raw.gear, reference, (context, value) => {
    for (const item of Array.isArray(value) ? value : []) add('gear', context, {
      itemId: item.itemId ?? null, bonusIds: item.bonusIDs ?? [], slot: item.slot ?? null,
      itemLevel: item.ilvl ?? null, popularity: item.pop ?? null, droppedBy: item.source ?? null
    });
  });
  contextual(raw.trinkets, reference, (context, value) => {
    for (const item of Array.isArray(value) ? value : []) add('trinkets', context, {
      itemId: item.itemId ?? null, bonusIds: item.bonusIDs ?? [], tier: item.tier ?? null,
      popularity: item.pop ?? null, droppedBy: item.source ?? null
    });
  });
  contextual(raw.enchants, reference, (context, value) => {
    for (const [slot, choices] of Object.entries(value || {})) {
      for (const choice of Array.isArray(choices) ? choices : []) add('enchants', context, {
        slot, enchantId: choice.id ?? null, spellId: choice.spellId ?? null, popularity: choice.pop ?? null
      });
    }
  });
  contextual(raw.gems, reference, (context, value) => {
    for (const gem of Array.isArray(value) ? value : []) add('gems', context, {
      primaryItemId: gem.primary ?? null, secondaryItemIds: gem.secondary ?? [], popularity: gem.pop ?? null
    });
  });
  contextual(raw.consumables, reference, (context, value) => {
    for (const [kind, itemIds] of Object.entries(value || {})) {
      for (const itemId of Array.isArray(itemIds) ? itemIds : []) add('consumables', context, { kind, itemId });
    }
  });
  contextual(raw.crafting, reference, (context, value) => {
    for (const kind of ['crafts', 'embellishments']) {
      for (const item of Array.isArray(value?.[kind]) ? value[kind] : []) add('crafting', context, {
        kind, itemId: typeof item === 'number' ? item : item.itemId ?? null,
        bonusIds: typeof item === 'number' ? [] : item.bonusIDs ?? [], popularity: typeof item === 'number' ? null : item.pop ?? null
      });
    }
  });
  contextual(raw.omniumFolio, reference, (context, value) => {
    for (const entry of Array.isArray(value) ? value : []) add('omniumFolio', context, { spellId: entry.spellId ?? null, label: entry.label ?? null });
  });
  contextual(raw.tierRank, reference, (context, value) => add('rankings', context, {
    count: value?.count ?? null, popularity: value?.pop ?? null, tier: value?.tier ?? null,
    rank: value?.rank ?? null, dps: value?.dps ?? null, hps: value?.hps ?? null
  }));
  return rows;
}

function normalizeSpec(classToken, spec, icyVeins, ugg, references) {
  const iv = normalizeSource('icyveins', icyVeins || { data: {} }, references.icyveins);
  const ug = normalizeSource('ugg', ugg || { data: {} }, references.ugg);
  const links = icyVeins?.links ?? {};
  return {
    classToken, spec,
    ...Object.fromEntries(Object.keys(iv).map((key) => [key, [...iv[key], ...ug[key]]])),
    sourceUrls: Object.keys(links).length ? { icyveins: links } : null
  };
}

function sourceMeta(raw) {
  return {
    generatedAt: raw?.meta?.generatedAt ?? null,
    contentHash: raw?.meta?.contentHash ?? null,
    schemaVersion: raw?.meta?.schemaVersion ?? null
  };
}

/** Import ClassCodex 1.0+ flat source databases into a source-labelled snapshot. */
export async function importClassCodex(addonPath = DEFAULT_ADDON_PATH) {
  const toc = await readFile(join(addonPath, 'ClassCodex.toc'), 'utf8');
  const addonVersion = /^##\s*Version:\s*(.+)$/m.exec(toc)?.[1]?.trim() || null;
  const interfaceVersion = /^##\s*Interface:\s*(.+)$/m.exec(toc)?.[1]?.trim() || null;
  const dataDir = join(addonPath, 'Data');
  const warnings = [];
  const readSource = async (file, name) => {
    try { return extractNamedSource(await readFile(join(dataDir, file), 'utf8'), name); }
    catch (error) { warnings.push({ file, problem: error.message }); return null; }
  };
  const [icyVeins, ugg] = await Promise.all([
    readSource('db_icyveins.lua', 'icyveins'), readSource('db_ugg.lua', 'ugg')
  ]);
  if (!icyVeins || !ugg) throw new Error(`ClassCodex 1.0 source database unavailable: ${warnings.map((warning) => `${warning.file} (${warning.problem})`).join(', ')}`);

  const specs = {};
  const references = { icyveins: icyVeins.reference || {}, ugg: ugg.reference || {} };
  const classes = new Set([...Object.keys(icyVeins.data || {}), ...Object.keys(ugg.data || {})]);
  for (const classToken of classes) {
    const specNames = new Set([...Object.keys(icyVeins.data?.[classToken] || {}), ...Object.keys(ugg.data?.[classToken] || {})]);
    for (const spec of specNames) specs[`${classToken}/${spec}`] = normalizeSpec(
      classToken, spec, icyVeins.data?.[classToken]?.[spec], ugg.data?.[classToken]?.[spec], references
    );
  }
  const sources = { icyveins: sourceMeta(icyVeins), ugg: sourceMeta(ugg) };
  const generated = Object.values(sources).map((entry) => entry.generatedAt).filter(Boolean).sort().at(-1) ?? null;
  return {
    provenance: 'community', source: 'classcodex', addonVersion, interfaceVersion,
    lastScrape: generated, licence: null, importedFrom: addonPath, sources,
    specCount: Object.keys(specs).length, importWarnings: warnings, specs
  };
}

function matchingContext(row, filters) {
  if (filters.activity && row.activity !== filters.activity && row.activity !== 'general') return false;
  if (filters.heroTalent && row.heroTalent !== filters.heroTalent) return false;
  if (filters.encounterId && row.encounterId !== filters.encounterId) return false;
  if (filters.source && row.source !== filters.source) return false;
  return true;
}

/** One spec's guidance, with source and generated-at metadata attached. */
export function specGuidance(snapshot, classToken, spec, filters = {}) {
  const entry = snapshot?.specs?.[`${classToken.toUpperCase()}/${spec.toLowerCase()}`];
  if (!entry) return null;
  const select = (value) => Array.isArray(value) ? value.filter((row) => matchingContext(row, filters)) : value;
  return {
    provenance: 'community', source: 'classcodex', addonVersion: snapshot.addonVersion,
    lastScrape: snapshot.lastScrape, licence: snapshot.licence, sourceMetadata: snapshot.sources ?? null,
    class: entry.classToken, spec: entry.spec, statPriorities: select(entry.statPriorities),
    statTargets: select(entry.statTargets), talentBuilds: select(entry.talentBuilds),
    rankings: select(entry.rankings), rotation: select(entry.rotation), trinkets: select(entry.trinkets),
    enchants: select(entry.enchants), gems: select(entry.gems), consumables: select(entry.consumables),
    bisGear: { recommendations: select(entry.gear) }, crafting: select(entry.crafting),
    omniumFolio: select(entry.omniumFolio), sourceUrls: entry.sourceUrls
  };
}
