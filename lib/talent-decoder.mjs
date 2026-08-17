/* Decode WoW talent loadout export strings.
 *
 * The bit-level algorithm is ported from the working proof of concept at
 * /mnt/docker/infra/scripts/wow_talent_decoder.js. What is deliberately NOT
 * ported is how that script obtained its tree data: it fetched Wowhead's
 * talent-calc page, regex-matched a nether.wowhead.com URL out of the HTML,
 * and `vm`-evalled the payload. That is fragile, unfriendly to Wowhead, and
 * impossible to cache sensibly.
 *
 * Here the tree data is an argument. The caller supplies a spec entry in the
 * raidbots `talents.json` shape, whose `fullNodeOrder` is the canonical node
 * ordering an export string is encoded against.
 *
 * A loadout string is: an 8-bit version, a 16-bit spec id, a 128-bit tree
 * hash, then one variable-length state per node in `fullNodeOrder`.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VERSION_BITS = 8;
const RANK_BITS = 6;
const SPEC_BITS = 16;
const TREE_HASH_BITS = 128;
const TREE_HASH_CHUNK_BITS = 8;
const CHAR_BITS = 6;

class BitReader {
  constructor(exportString) {
    this.values = [...exportString].map((character) => {
      const value = BASE64_ALPHABET.indexOf(character);
      if (value === -1) throw new TypeError(`Invalid character in talent string: ${character}`);
      return value;
    });
    this.currentIndex = 0;
    this.currentExtractedBits = 0;
    this.currentRemainingValue = this.values[0] ?? 0;
  }

  read(bitWidth) {
    if (this.currentIndex >= this.values.length) return null;

    let value = 0;
    let bitsLeft = bitWidth;
    let outOffset = 0;

    while (bitsLeft > 0) {
      const bitsAvailable = CHAR_BITS - this.currentExtractedBits;
      const bitsToRead = Math.min(bitsAvailable, bitsLeft);

      this.currentExtractedBits += bitsToRead;
      const extracted = this.currentRemainingValue % (1 << bitsToRead);
      this.currentRemainingValue >>= bitsToRead;

      value += extracted << outOffset;
      outOffset += bitsToRead;
      bitsLeft -= bitsToRead;

      if (bitsToRead < bitsAvailable) break;

      this.currentIndex += 1;
      this.currentExtractedBits = 0;
      this.currentRemainingValue = this.values[this.currentIndex] ?? 0;
    }

    return value;
  }
}

function decodeHeader(reader, exportString) {
  if (exportString.length * CHAR_BITS < VERSION_BITS + SPEC_BITS + TREE_HASH_BITS) {
    throw new TypeError('Talent string is too short to be valid.');
  }
  const version = reader.read(VERSION_BITS);
  const specId = reader.read(SPEC_BITS);
  const treeHash = [];
  for (let bits = TREE_HASH_BITS; bits > 0; bits -= TREE_HASH_CHUNK_BITS) {
    treeHash.push(reader.read(TREE_HASH_CHUNK_BITS));
  }
  return { version, specId, treeHash };
}

function decodeNodeStates(reader, version, nodeCount) {
  const states = [];
  for (let index = 0; index < nodeCount; index += 1) {
    if (reader.currentIndex >= reader.values.length) break;

    const isNodeSelected = reader.read(1) === 1;
    let isNodePurchased = isNodeSelected;
    let isPartiallyRanked = false;
    let partialRanksPurchased = 0;
    let isChoiceNode = false;
    let choiceNodeSelection = 0;

    if (version > 1 && isNodeSelected) {
      isNodePurchased = reader.read(1) === 1;
    }
    if (isNodePurchased) {
      isPartiallyRanked = reader.read(1) === 1;
      if (isPartiallyRanked) partialRanksPurchased = reader.read(RANK_BITS);
      isChoiceNode = reader.read(1) === 1;
      if (isChoiceNode) choiceNodeSelection = reader.read(2);
    }

    states.push({
      isNodeSelected,
      isNodePurchased,
      isPartiallyRanked,
      partialRanksPurchased,
      isChoiceNode,
      choiceNodeSelection
    });
  }
  return states;
}

/**
 * Decode a loadout string against one spec entry from raidbots `talents.json`.
 *
 * Returns the selected talents grouped by tree, with the ranks actually spent.
 * Throws when the string's spec id disagrees with the supplied tree, since
 * decoding against the wrong tree silently produces plausible nonsense.
 */
export function decodeLoadout(exportString, specTree) {
  if (typeof exportString !== 'string' || exportString.length === 0) {
    throw new TypeError('exportString must be a non-empty string');
  }
  if (!specTree?.fullNodeOrder) {
    throw new TypeError('specTree must be a raidbots spec entry with fullNodeOrder');
  }

  const reader = new BitReader(exportString);
  const header = decodeHeader(reader, exportString);

  if (header.specId !== specTree.specId) {
    throw new TypeError(
      `Talent string is for spec ${header.specId}, but the supplied tree is ${specTree.specId}.`
    );
  }

  const nodesById = new Map();
  for (const group of ['classNodes', 'specNodes', 'heroNodes', 'subTreeNodes']) {
    for (const node of specTree[group] || []) nodesById.set(node.id, { ...node, group });
  }

  const states = decodeNodeStates(reader, header.version, specTree.fullNodeOrder.length);
  const selected = [];

  states.forEach((state, index) => {
    if (!state.isNodePurchased) return;
    const node = nodesById.get(specTree.fullNodeOrder[index]);
    if (!node) return;

    const entries = node.entries || [];
    const entry = entries[state.choiceNodeSelection] || entries[0];
    if (!entry) return;

    selected.push({
      nodeId: node.id,
      group: node.group,
      name: entry.name || node.name,
      spellId: entry.spellId ?? null,
      icon: entry.icon ?? null,
      rank: state.isPartiallyRanked ? state.partialRanksPurchased : (node.maxRanks ?? 1),
      maxRanks: node.maxRanks ?? 1,
      isChoiceNode: state.isChoiceNode,
      choiceIndex: state.choiceNodeSelection
    });
  });

  const byGroup = (group) => selected.filter((talent) => talent.group === group);

  return {
    version: header.version,
    specId: header.specId,
    className: specTree.className,
    specName: specTree.specName,
    exportString,
    counts: {
      class: byGroup('classNodes').length,
      spec: byGroup('specNodes').length,
      hero: byGroup('heroNodes').length
    },
    talents: {
      class: byGroup('classNodes'),
      spec: byGroup('specNodes'),
      hero: byGroup('heroNodes'),
      subTree: byGroup('subTreeNodes')
    }
  };
}

/**
 * Which talents differ between two loadouts for the same spec.
 *
 * This is the actionable output: "here is what to change to match the
 * recommended build", rather than two opaque strings to eyeball.
 */
export function diffLoadouts(current, recommended) {
  if (current.specId !== recommended.specId) {
    throw new TypeError('Cannot diff loadouts from different specs.');
  }
  const index = (decoded) => new Map(
    [...decoded.talents.class, ...decoded.talents.spec, ...decoded.talents.hero]
      .map((talent) => [`${talent.nodeId}:${talent.choiceIndex}`, talent])
  );
  const currentByKey = index(current);
  const recommendedByKey = index(recommended);

  const added = [...recommendedByKey].filter(([key]) => !currentByKey.has(key)).map(([, t]) => t);
  const removed = [...currentByKey].filter(([key]) => !recommendedByKey.has(key)).map(([, t]) => t);
  const rankChanged = [...recommendedByKey]
    .filter(([key, talent]) => currentByKey.has(key) && currentByKey.get(key).rank !== talent.rank)
    .map(([key, talent]) => ({ ...talent, fromRank: currentByKey.get(key).rank, toRank: talent.rank }));

  return {
    specId: current.specId,
    identical: added.length === 0 && removed.length === 0 && rankChanged.length === 0,
    take: added,
    drop: removed,
    rankChanged
  };
}
