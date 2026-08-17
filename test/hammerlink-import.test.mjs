import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { HammerLinkImportError, parseHammerLinkExport } from '../lib/hammerlink-import.mjs';

const now = Date.UTC(2026, 7, 17, 6, 0, 0);
const fixturePath = new URL('./fixtures/hammerlink-valid.hl1', import.meta.url);

async function fixture() {
  return (await readFile(fixturePath, 'utf8')).trim();
}

test('decodes and validates a controlled HammerLink HL1 export', async () => {
  const snapshot = parseHammerLinkExport(await fixture(), { now });
  assert.equal(snapshot.format, 1);
  assert.equal(snapshot.character.name, 'Bluehoof');
  assert.equal(snapshot.character.realm, "Dath'Remar");
  assert.equal(snapshot.equipment[0].slot, 'HEAD');
  assert.equal(snapshot.vault.activities[0].progress, 4);
});

for (const [name, mutate, code] of [
  ['wrong envelope', (value) => value.replace('HL1:', 'HL2:'), 'unsupported-envelope'],
  ['invalid printable character', (value) => `${value.slice(0, -1)}!`, 'invalid-encoding'],
  ['truncated compressed data', (value) => value.slice(0, -8), 'decompression-failed'],
  ['stale capture time', (value) => value, 'stale-export']
]) {
  test(`rejects ${name}`, async () => {
    const options = name === 'stale capture time'
      ? { now: now + 32 * 24 * 60 * 60 * 1000 }
      : { now };
    const input = mutate(await fixture());
    assert.throws(() => parseHammerLinkExport(input, options), (error) => {
      assert.ok(error instanceof HammerLinkImportError);
      assert.equal(error.code, code);
      return true;
    });
  });
}

test('never retains an imported snapshot', async () => {
  const first = parseHammerLinkExport(await fixture(), { now });
  first.character.name = 'Changed only in this test';
  const second = parseHammerLinkExport(await fixture(), { now });
  assert.equal(second.character.name, 'Bluehoof');
});
