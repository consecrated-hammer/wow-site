import { inflateRawSync } from 'node:zlib';

const PRINT_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()';
const PRINT_VALUES = new Map([...PRINT_ALPHABET].map((character, value) => [character, value]));
const EQUIPMENT_SLOTS = new Set([
  'HEAD', 'NECK', 'SHOULDER', 'BACK', 'CHEST', 'WRIST', 'HANDS', 'WAIST',
  'LEGS', 'FEET', 'FINGER_1', 'FINGER_2', 'TRINKET_1', 'TRINKET_2', 'MAIN_HAND', 'OFF_HAND'
]);

export const HAMMERLINK_LIMITS = Object.freeze({
  maxEncodedLength: 65_536,
  maxDecompressedBytes: 262_144,
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

function finiteNumber(value, path, { integer = false, min = -Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min) {
    fail('invalid-schema', `${path} must be a valid number.`);
  }
}

function optionalNumber(value, path, options) {
  if (value === undefined || value === null) return;
  finiteNumber(value, path, options);
}

function validateSnapshot(snapshot, now, limits) {
  object(snapshot, 'Export');
  if (snapshot.format !== 1) fail('unsupported-format', 'This HammerLink export version is not supported.');
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

  if (!Array.isArray(snapshot.equipment) || snapshot.equipment.length > EQUIPMENT_SLOTS.size) fail('invalid-schema', 'Equipment must be a bounded list.');
  const seenSlots = new Set();
  snapshot.equipment.forEach((item, index) => {
    object(item, `Equipment item ${index + 1}`);
    if (!EQUIPMENT_SLOTS.has(item.slot) || seenSlots.has(item.slot)) fail('invalid-schema', 'Equipment slots must be known and unique.');
    seenSlots.add(item.slot);
    finiteNumber(item.itemID, `Equipment item ${index + 1} ID`, { integer: true, min: 1 });
    string(item.link, `Equipment item ${index + 1} link`, { maxLength: 2048 });
  });

  const talents = object(snapshot.talents, 'Talents');
  if (talents.importString !== undefined && talents.importString !== null) string(talents.importString, 'Talent import', { maxLength: 2048 });

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
