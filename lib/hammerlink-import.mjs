import { inflateRawSync } from 'node:zlib';

const PRINT_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()';
const PRINT_VALUES = new Map([...PRINT_ALPHABET].map((character, value) => [character, value]));
const EQUIPMENT_SLOTS = new Set([
  'HEAD', 'NECK', 'SHOULDER', 'BACK', 'CHEST', 'WRIST', 'HANDS', 'WAIST',
  'LEGS', 'FEET', 'FINGER_1', 'FINGER_2', 'TRINKET_1', 'TRINKET_2', 'MAIN_HAND', 'OFF_HAND'
]);

export const HAMMERLINK_LIMITS = Object.freeze({
  maxEncodedLength: 262_144,
  // Rich bag metadata plus a large account-wide Housing catalog can exceed
  // the original 256 KiB allowance while remaining inside every schema bound.
  // Keep inflation bounded independently from the 256 KiB printable envelope.
  maxDecompressedBytes: 2 * 1024 * 1024,
  maxAgeMs: 31 * 24 * 60 * 60 * 1000,
  maxFutureMs: 5 * 60 * 1000
});

export class HammerLinkImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HammerLinkImportError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new HammerLinkImportError(code, message);
}

function decodeForPrint(value) {
  if (value.length < 2) fail('invalid-encoding', 'HammerLink export data is incomplete.');
  const bytes = [];
  let index = 0;
  while (index + 4 <= value.length) {
    const quartet = value.slice(index, index + 4).split('').map((character) => PRINT_VALUES.get(character));
    if (quartet.some((part) => part === undefined)) fail('invalid-encoding', 'HammerLink export contains invalid printable data.');
    const cache = quartet[0] + quartet[1] * 64 + quartet[2] * 4096 + quartet[3] * 262144;
    bytes.push(cache & 0xff, (cache >>> 8) & 0xff, (cache >>> 16) & 0xff);
    index += 4;
  }

  let cache = 0;
  let bitLength = 0;
  while (index < value.length) {
    const part = PRINT_VALUES.get(value[index]);
    if (part === undefined) fail('invalid-encoding', 'HammerLink export contains invalid printable data.');
    cache += part * (2 ** bitLength);
    bitLength += 6;
    index += 1;
  }
  while (bitLength >= 8) {
    bytes.push(cache & 0xff);
    cache >>>= 8;
    bitLength -= 8;
  }
  return Buffer.from(bytes);
}

function object(value, path) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail('invalid-schema', `${path} must be an object.`);
  return value;
}

function string(value, path, { optional = false, maxLength = 512 } = {}) {
  if (value === undefined && optional) return;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) fail('invalid-schema', `${path} must be a non-empty string.`);
}

function finiteNumber(value, path, { integer = false, min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    fail('invalid-schema', `${path} must be a valid number.`);
  }
}

function optionalNumber(value, path, options) {
  if (value === undefined || value === null) return;
  finiteNumber(value, path, options);
}

function optionalBoolean(value, path) {
  if (value !== undefined && typeof value !== 'boolean') fail('invalid-schema', `${path} must be true or false.`);
}

function validateBagEquipment(items, { required = false } = {}) {
  if (items === undefined && required) fail('invalid-schema', 'Bag items must be a bounded list.');
  if (items === undefined) return;
  if (!Array.isArray(items) || items.length > 256) fail('invalid-schema', 'Bag equipment must be a bounded list.');
  const seenLocations = new Set();
  items.forEach((item, index) => {
    const path = `Bag equipment item ${index + 1}`;
    object(item, path);
    finiteNumber(item.bag, `${path} bag`, { integer: true, min: 0, max: 5 });
    finiteNumber(item.slot, `${path} slot`, { integer: true, min: 1, max: 100 });
    const location = `${item.bag}:${item.slot}`;
    if (seenLocations.has(location)) fail('invalid-schema', 'Bag equipment locations must be unique.');
    seenLocations.add(location);
    finiteNumber(item.itemID, `${path} ID`, { integer: true, min: 1 });
    string(item.link, `${path} link`, { maxLength: 2048 });
    string(item.name, `${path} name`, { optional: true, maxLength: 512 });
    string(item.itemType, `${path} type`, { optional: true, maxLength: 128 });
    string(item.itemSubType, `${path} subtype`, { optional: true, maxLength: 128 });
    string(item.inventoryType, `${path} inventory type`, { optional: true, maxLength: 64 });
    string(item.equipmentSets, `${path} equipment sets`, { optional: true, maxLength: 1024 });
    for (const [field, minimum] of [
      ['itemLevel', 0], ['baseItemLevel', 0], ['requiredLevel', 0], ['quality', 0],
      ['iconFileID', 0], ['classID', 0], ['subclassID', 0], ['stackCount', 1],
      ['sellPrice', 0], ['bindType', 0], ['expansionID', 0], ['setID', 0]
    ]) optionalNumber(item[field], `${path} ${field}`, { min: minimum });
    optionalBoolean(item.isBound, `${path} bound flag`);
    optionalBoolean(item.isCraftingReagent, `${path} crafting-reagent flag`);

    if (item.durability !== undefined) {
      object(item.durability, `${path} durability`);
      finiteNumber(item.durability.current, `${path} current durability`, { min: 0 });
      finiteNumber(item.durability.maximum, `${path} maximum durability`, { min: 0 });
    }
    if (item.stats !== undefined) {
      const stats = object(item.stats, `${path} stats`);
      const entries = Object.entries(stats);
      if (entries.length > 64) fail('invalid-schema', `${path} has too many stats.`);
      for (const [stat, amount] of entries) {
        string(stat, `${path} stat name`, { maxLength: 128 });
        finiteNumber(amount, `${path} stat value`);
      }
    }
    if (item.gems !== undefined) {
      if (!Array.isArray(item.gems) || item.gems.length > 4) fail('invalid-schema', `${path} gems must be a bounded list.`);
      item.gems.forEach((gem, gemIndex) => {
        const gemPath = `${path} gem ${gemIndex + 1}`;
        object(gem, gemPath);
        finiteNumber(gem.socket, `${gemPath} socket`, { integer: true, min: 1, max: 4 });
        finiteNumber(gem.itemID, `${gemPath} ID`, { integer: true, min: 1 });
        string(gem.link, `${gemPath} link`, { maxLength: 2048 });
        string(gem.name, `${gemPath} name`, { optional: true, maxLength: 512 });
      });
    }
  });
}

function validateCurrencyCaps(currencies) {
  if (currencies === undefined) return;
  if (!Array.isArray(currencies) || currencies.length > 256) fail('invalid-schema', 'Currency caps must be a bounded list.');
  const seen = new Set();
  currencies.forEach((currency, index) => {
    const path = `Currency cap ${index + 1}`;
    object(currency, path);
    finiteNumber(currency.currencyID, `${path} ID`, { integer: true, min: 1 });
    if (seen.has(currency.currencyID)) fail('invalid-schema', 'Currency cap IDs must be unique.');
    seen.add(currency.currencyID);
    string(currency.name, `${path} name`, { maxLength: 256 });
    optionalNumber(currency.quantity, `${path} quantity`, { min: 0 });
    for (const field of ['iconFileID', 'maxQuantity', 'maxWeeklyQuantity', 'quantityEarnedThisWeek', 'totalEarned']) {
      optionalNumber(currency[field], `${path} ${field}`, { min: 0 });
    }
    for (const field of ['canEarnPerWeek', 'useTotalEarnedForMaxQty', 'isAccountWide', 'isAccountTransferable']) {
      optionalBoolean(currency[field], `${path} ${field}`);
    }
  });
}

function expandPackedDecorInventory(decor) {
  if (decor?.packedItems === undefined) return;
  if (decor.items !== undefined) fail('invalid-schema', 'Decor inventory cannot contain both packed and expanded items.');
  if (!Array.isArray(decor.packedItems) || decor.packedItems.length > 8192) fail('invalid-schema', 'Packed decor inventory must be a bounded list.');
  decor.items = decor.packedItems.map((row, index) => {
    const path = `Packed decor item ${index + 1}`;
    if (!Array.isArray(row) || row.length !== 9) fail('invalid-schema', `${path} must contain nine fields.`);
    finiteNumber(row[0], `${path} ID`, { integer: true, min: 1 });
    string(row[1], `${path} name`, { maxLength: 512 });
    for (let field = 2; field <= 7; field += 1) finiteNumber(row[field], `${path} field ${field + 1}`, { integer: true, min: 0 });
    finiteNumber(row[8], `${path} flags`, { integer: true, min: 0, max: 7 });
    const item = {
      decorID: row[0], name: row[1], storedCount: row[4], placedCount: row[5],
      redeemableCount: row[6], destroyableCount: row[7],
      uniqueTrophy: Boolean(row[8] & 1), allowedIndoors: Boolean(row[8] & 2),
      allowedOutdoors: Boolean(row[8] & 4),
    };
    if (row[2] > 0) item.itemID = row[2];
    if (row[3] > 0) item.icon = row[3];
    return item;
  });
  delete decor.packedItems;
}

function validateDecorInventory(decor) {
  if (decor === undefined) return;
  object(decor, 'Decor inventory');
  expandPackedDecorInventory(decor);
  optionalBoolean(decor.available, 'Decor inventory available flag');
  optionalBoolean(decor.truncated, 'Decor inventory truncated flag');
  string(decor.reason, 'Decor inventory reason', { optional: true, maxLength: 512 });
  string(decor.scope, 'Decor inventory scope', { optional: true, maxLength: 128 });
  optionalNumber(decor.capturedAt, 'Decor inventory capture time', { integer: true, min: 1 });
  for (const field of ['totalOwnedCount', 'exemptOwnedCount', 'maxOwnedCount']) {
    optionalNumber(decor[field], `Decor inventory ${field}`, { integer: true, min: 0 });
  }
  if (decor.items === undefined) return;
  if (!Array.isArray(decor.items) || decor.items.length > 8192) fail('invalid-schema', 'Decor inventory must be a bounded list.');
  const seen = new Set();
  decor.items.forEach((item, index) => {
    const path = `Decor item ${index + 1}`;
    object(item, path);
    finiteNumber(item.decorID, `${path} ID`, { integer: true, min: 1 });
    if (seen.has(item.decorID)) fail('invalid-schema', 'Decor IDs must be unique.');
    seen.add(item.decorID);
    string(item.name, `${path} name`, { maxLength: 512 });
    for (const field of ['itemID', 'icon', 'storedCount', 'placedCount', 'redeemableCount', 'destroyableCount']) {
      optionalNumber(item[field], `${path} ${field}`, { integer: true, min: 0 });
    }
    for (const field of ['uniqueTrophy', 'allowedIndoors', 'allowedOutdoors']) optionalBoolean(item[field], `${path} ${field}`);
  });
}

function validateQuestLog(questLog) {
  if (questLog === undefined) return;
  object(questLog, 'Quest log');
  optionalBoolean(questLog.available, 'Quest log available flag');
  optionalBoolean(questLog.truncated, 'Quest log truncated flag');
  string(questLog.reason, 'Quest log reason', { optional: true, maxLength: 512 });
  optionalNumber(questLog.capturedAt, 'Quest log capture time', { integer: true, min: 1 });
  optionalNumber(questLog.totalQuests, 'Quest log total quests', { integer: true, min: 0 });
  if (!Array.isArray(questLog.entries) || questLog.entries.length > 256) fail('invalid-schema', 'Quest log must be a bounded list.');
  const seen = new Set();
  questLog.entries.forEach((quest, index) => {
    const path = `Quest log entry ${index + 1}`;
    object(quest, path);
    finiteNumber(quest.questID, `${path} ID`, { integer: true, min: 1 });
    if (seen.has(quest.questID)) fail('invalid-schema', 'Quest log IDs must be unique.');
    seen.add(quest.questID);
    string(quest.title, `${path} title`, { maxLength: 512 });
    for (const field of ['logIndex', 'level', 'difficultyLevel', 'suggestedGroup', 'frequency', 'campaignID', 'questClassification', 'watchType']) {
      optionalNumber(quest[field], `${path} ${field}`, { integer: true, min: 0 });
    }
    for (const field of ['isTask', 'isBounty', 'isStory', 'isHidden', 'isAutoComplete', 'isComplete', 'isFailed']) {
      optionalBoolean(quest[field], `${path} ${field}`);
    }
    if (!Array.isArray(quest.objectives) || quest.objectives.length > 64) fail('invalid-schema', `${path} objectives must be a bounded list.`);
    quest.objectives.forEach((objective, objectiveIndex) => {
      const objectivePath = `${path} objective ${objectiveIndex + 1}`;
      object(objective, objectivePath);
      string(objective.text, `${objectivePath} text`, { maxLength: 1024 });
      string(objective.type, `${objectivePath} type`, { optional: true, maxLength: 64 });
      optionalBoolean(objective.finished, `${objectivePath} finished`);
      for (const field of ['numFulfilled', 'numRequired', 'objectiveType']) {
        optionalNumber(objective[field], `${objectivePath} ${field}`, { integer: true, min: 0 });
      }
    });
    if (quest.tag !== undefined) {
      const tag = object(quest.tag, `${path} tag`);
      string(tag.name, `${path} tag name`, { maxLength: 256 });
      for (const field of ['id', 'worldQuestType', 'quality', 'tradeskillLineID']) optionalNumber(tag[field], `${path} tag ${field}`, { integer: true, min: 0 });
      for (const field of ['isElite', 'displayExpiration']) optionalBoolean(tag[field], `${path} tag ${field}`);
    }
    if (quest.waypoint !== undefined) {
      const waypoint = object(quest.waypoint, `${path} waypoint`);
      finiteNumber(waypoint.mapID, `${path} waypoint map ID`, { integer: true, min: 1 });
      finiteNumber(waypoint.x, `${path} waypoint x`, { min: 0, max: 1 });
      finiteNumber(waypoint.y, `${path} waypoint y`, { min: 0, max: 1 });
    }
    if (quest.timer !== undefined) {
      const timer = object(quest.timer, `${path} timer`);
      finiteNumber(timer.totalSeconds, `${path} timer total`, { min: 0 });
      finiteNumber(timer.elapsedSeconds, `${path} timer elapsed`, { min: 0 });
    }
  });
}

function validateSnapshot(snapshot, now, limits) {
  object(snapshot, 'Export');
  if (![1, 2, 3].includes(snapshot.format)) fail('unsupported-format', 'This HammerLink export version is not supported.');
  finiteNumber(snapshot.capturedAt, 'Export capture time', { integer: true, min: 1 });
  const capturedAtMs = snapshot.capturedAt * 1000;
  if (capturedAtMs > now + limits.maxFutureMs) fail('future-export', 'This HammerLink export is dated in the future.');
  if (capturedAtMs < now - limits.maxAgeMs) fail('stale-export', 'This HammerLink export is too old. Export again in-game.');

  const character = object(snapshot.character, 'Character');
  string(character.name, 'Character name', { maxLength: 48 });
  string(character.realm, 'Character realm', { maxLength: 96 });
  string(character.class, 'Character class', { maxLength: 32 });
  optionalNumber(character.region, 'Character region', { integer: true, min: 1 });
  finiteNumber(character.level, 'Character level', { integer: true, min: 1 });
  optionalNumber(character.specID, 'Character spec ID', { integer: true, min: 1 });
  optionalNumber(character.equippedItemLevel, 'Character equipped item level', { min: 0 });
  optionalNumber(character.overallItemLevel, 'Character overall item level', { min: 0 });

  const requiresLegacySections = snapshot.format === 1;
  if (snapshot.exportOptions !== undefined) {
    const options = object(snapshot.exportOptions, 'Export options');
    for (const field of ['equipment', 'bagItems', 'talents', 'vault', 'currencyCaps', 'decorInventory', 'questLog']) optionalBoolean(options[field], `Export option ${field}`);
  }
  if (snapshot.equipment === undefined && requiresLegacySections) fail('invalid-schema', 'Equipment must be a bounded list.');
  if (snapshot.equipment !== undefined && (!Array.isArray(snapshot.equipment) || snapshot.equipment.length > EQUIPMENT_SLOTS.size)) fail('invalid-schema', 'Equipment must be a bounded list.');
  const seenSlots = new Set();
  (snapshot.equipment || []).forEach((item, index) => {
    object(item, `Equipment item ${index + 1}`);
    if (!EQUIPMENT_SLOTS.has(item.slot) || seenSlots.has(item.slot)) fail('invalid-schema', 'Equipment slots must be known and unique.');
    seenSlots.add(item.slot);
    finiteNumber(item.itemID, `Equipment item ${index + 1} ID`, { integer: true, min: 1 });
    string(item.link, `Equipment item ${index + 1} link`, { maxLength: 2048 });
  });
  validateBagEquipment(snapshot.bagEquipment);

  if (snapshot.talents === undefined && requiresLegacySections) fail('invalid-schema', 'Talents must be an object.');
  if (snapshot.talents !== undefined) {
    const talents = object(snapshot.talents, 'Talents');
    if (talents.importString !== undefined && talents.importString !== null) string(talents.importString, 'Talent import', { maxLength: 2048 });
  }

  if (snapshot.vault === undefined && requiresLegacySections) fail('invalid-schema', 'Great Vault must be an object.');
  if (snapshot.vault !== undefined) {
    const vault = object(snapshot.vault, 'Great Vault');
    finiteNumber(vault.capturedAt, 'Great Vault capture time', { integer: true, min: 1 });
    if (!Array.isArray(vault.activities) || vault.activities.length > 64) fail('invalid-schema', 'Great Vault activities must be a bounded list.');
    vault.activities.forEach((activity, index) => {
    object(activity, `Great Vault activity ${index + 1}`);
    finiteNumber(activity.type, `Great Vault activity ${index + 1} type`, { integer: true, min: 0 });
    finiteNumber(activity.index, `Great Vault activity ${index + 1} index`, { integer: true, min: 1 });
    finiteNumber(activity.threshold, `Great Vault activity ${index + 1} threshold`, { integer: true, min: 0 });
    finiteNumber(activity.progress, `Great Vault activity ${index + 1} progress`, { integer: true, min: 0 });
    if (!Array.isArray(activity.rewards) || activity.rewards.length > 16) fail('invalid-schema', 'Great Vault rewards must be a bounded list.');
    });
  }
  validateCurrencyCaps(snapshot.currencyCaps);
  validateDecorInventory(snapshot.decorInventory);
  validateQuestLog(snapshot.questLog);
  return snapshot;
}

/**
 * Decodes an untrusted, paste-only HammerLink HL1 export. This is deliberately
 * pure: callers receive a validated snapshot and decide whether/how to render it.
 */
export function parseHammerLinkExport(input, options = {}) {
  const limits = { ...HAMMERLINK_LIMITS, ...options.limits };
  if (typeof input !== 'string') fail('invalid-input', 'Paste a HammerLink export.');
  const exportText = input.trim();
  if (!exportText.startsWith('HL1:')) fail('unsupported-envelope', 'This is not a HammerLink HL1 export.');
  const encoded = exportText.slice(4);
  if (encoded.length > limits.maxEncodedLength) fail('too-large', 'This HammerLink export is too large.');
  if (!/^[a-zA-Z0-9()]+$/.test(encoded)) fail('invalid-encoding', 'HammerLink export contains invalid printable data.');

  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(inflateRawSync(decodeForPrint(encoded), {
      maxOutputLength: limits.maxDecompressedBytes
    }));
  } catch (error) {
    if (error instanceof HammerLinkImportError) throw error;
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
      fail('too-large', 'This HammerLink export expands beyond the safe import limit. Exclude a large category and export again.');
    }
    fail('decompression-failed', 'HammerLink export data could not be decompressed.');
  }
  let snapshot;
  try {
    snapshot = JSON.parse(decoded);
  } catch {
    fail('invalid-json', 'HammerLink export does not contain valid snapshot data.');
  }
  return validateSnapshot(snapshot, options.now ?? Date.now(), limits);
}
