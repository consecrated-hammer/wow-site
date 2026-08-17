import { SEASON } from './season-data.js';

/* Gear advisor — manual track comparison and Blizzard character equipment. */
(function () {
  'use strict';

  function initTrackAdvisor() {
    var slider = document.getElementById('ga-ilvl');
    var output = document.getElementById('ga-out');
    var rows = document.getElementById('ga-rows');
    var heads = document.getElementById('ga-heads');
    if (!slider || !output || !rows || !heads) return;

    var ranks = SEASON.ranksPerTrack;
    var cells = [];
    var summaries = [];
    heads.style.setProperty('--rank-count', ranks);
    rows.style.setProperty('--rank-count', ranks);
    heads.appendChild(document.createElement('div'));
    for (var r = 0; r < ranks; r++) {
      var head = document.createElement('div');
      head.className = 'ga-colhead';
      head.textContent = (r + 1) + '/' + ranks;
      heads.appendChild(head);
    }

    SEASON.tracks.forEach(function (track) {
      var label = document.createElement('div');
      label.className = 'ga-lab';
      label.style.setProperty('--track-colour', track.colour);
      var name = document.createElement('strong');
      name.textContent = track.name;
      var summary = document.createElement('span');
      label.appendChild(name);
      label.appendChild(summary);
      rows.appendChild(label);
      summaries.push(summary);

      track.ilvls.forEach(function (ilvl) {
        var cell = document.createElement('div');
        cell.className = 'ga-cell';
        var symbol = document.createElement('span');
        symbol.className = 'ga-cell-symbol';
        symbol.setAttribute('aria-hidden', 'true');
        var value = document.createElement('span');
        value.className = 'ga-cell-value';
        value.textContent = ilvl;
        cell.appendChild(symbol);
        cell.appendChild(value);
        rows.appendChild(cell);
        cells.push({ cell: cell, symbol: symbol });
      });
    });

    function describe(firstUpgrade) {
      if (firstUpgrade < 0) return 'Never beats yours';
      if (firstUpgrade === 0) return 'Beats on drop, 0 crests';
      return 'Beats at ' + (firstUpgrade + 1) + '/' + ranks + ', ' +
        (firstUpgrade * SEASON.crestPerRank) + ' crests';
    }

    function update() {
      var current = parseInt(slider.value, 10);
      output.textContent = current;
      SEASON.tracks.forEach(function (track, trackIndex) {
        var firstUpgrade = -1;
        track.ilvls.forEach(function (ilvl, rankIndex) {
          var entry = cells[trackIndex * ranks + rankIndex];
          var state = ilvl > current ? 'ga-up' : (ilvl === current ? 'ga-eq' : 'ga-dn');
          var stateLabel = ilvl > current ? 'upgrade' : (ilvl === current ? 'sidegrade' : 'downgrade');
          var delta = ilvl - current;
          if (ilvl > current && firstUpgrade < 0) firstUpgrade = rankIndex;
          entry.cell.className = 'ga-cell ' + state + (firstUpgrade === rankIndex ? ' ga-first' : '');
          entry.symbol.textContent = ilvl > current ? '▲' : (ilvl === current ? '▬' : '▼');
          entry.cell.setAttribute('aria-label', track.name + ' ' + (rankIndex + 1) + ' of ' + ranks +
            ', item level ' + ilvl + ', ' + stateLabel +
            (delta ? ', ' + (delta > 0 ? 'plus ' : 'minus ') + Math.abs(delta) : ''));
        });
        summaries[trackIndex].textContent = describe(firstUpgrade);
      });
    }

    slider.addEventListener('input', update);
    update();
  }

  initTrackAdvisor();

  var form = document.getElementById('character-form');
  var status = document.getElementById('character-status');
  var results = document.getElementById('character-results');
  var characterEmpty = document.getElementById('character-empty');
  var resultTitle = document.getElementById('character-result-title');
  var resultMeta = document.getElementById('character-result-meta');
  var characterSummary = document.getElementById('character-summary');
  var guidanceNote = document.getElementById('character-guidance');
  var filterStatus = document.getElementById('gear-filter-status');
  var paperDoll = document.getElementById('character-paper-doll');
  var equipmentLeft = document.getElementById('character-equipment-left');
  var equipmentRight = document.getElementById('character-equipment-right');
  var equipmentWeapons = document.getElementById('character-equipment-weapons');
  var characterRender = document.getElementById('character-render');
  var characterRenderImage = document.getElementById('character-render-image');
  var gearModal = document.getElementById('gear-modal');
  var gearModalContent = document.getElementById('gear-modal-content');
  var gearModalClose = document.getElementById('gear-modal-close');
  var characterPicker = document.getElementById('character-picker');
  var characterPickerOpen = document.getElementById('character-picker-open');
  var characterEmptyOpen = document.getElementById('character-empty-open');
  var characterPickerClose = document.getElementById('character-picker-close');
  var hammerLinkImport = document.getElementById('hammerlink-import');
  var hammerLinkImportOpen = document.getElementById('hammerlink-import-open');
  var hammerLinkImportClose = document.getElementById('hammerlink-import-close');
  var hammerLinkImportForm = document.getElementById('hammerlink-import-form');
  var hammerLinkImportStatus = document.getElementById('hammerlink-import-status');
  var hammerLinkCapture = document.getElementById('hammerlink-capture');
  var characterGuide = document.getElementById('character-guide');
  var mythicPlannerOpen = document.getElementById('mythic-planner-open');
  var mythicPlannerModal = document.getElementById('mythic-planner-modal');
  var mythicPlannerContent = document.getElementById('mythic-planner-content');
  var mythicPlannerClose = document.getElementById('mythic-planner-close');
  var refreshButton = document.getElementById('character-refresh');
  var refreshNote = document.getElementById('character-refresh-note');
  var submitButton = document.getElementById('character-submit');
  var regionSelect = form?.elements.region;
  var realmSelect = form?.elements.realm;
  var realmRequestId = 0;
  var realmLoad = null;
  var latestQuery = null;
  var refreshTimer = null;
  var activeGearFilter = 'all';
  var latestHammerLink = null;
  var currentGuide = null;
  var demoMode = new URLSearchParams(window.location.search).get('demo') === '1';
  var realmBrowserTtlMs = 24 * 60 * 60 * 1000;

  if (!form || !status || !results || !equipmentLeft || !equipmentRight || !equipmentWeapons) return;

  function realmLabel(slug) {
    if (slug === 'dathremar') return "Dath'Remar";
    return String(slug || '').split('-').map(function (word) {
      return word ? word.charAt(0).toLocaleUpperCase() + word.slice(1) : '';
    }).join(' ');
  }

  function preferredRealm(region) {
    try {
      return window.localStorage.getItem('wow-realm-choice-v1-' + region) || '';
    } catch {
      return '';
    }
  }

  function rememberRealm(region, realm) {
    if (!realm) return;
    try {
      window.localStorage.setItem('wow-realm-choice-v1-' + region, realm);
    } catch {
      // Remembering the selection is an optional convenience.
    }
  }

  function savedCharacter() {
    try {
      var value = JSON.parse(window.localStorage.getItem('wow-last-character-v1'));
      if (!value || typeof value !== 'object' || !value.region || !value.realm || !value.name) return null;
      return {
        region: String(value.region).toLocaleLowerCase('en-US'),
        realm: String(value.realm).toLocaleLowerCase('en-US'),
        name: String(value.name).trim()
      };
    } catch {
      return null;
    }
  }

  function rememberCharacter(query) {
    if (!query?.region || !query.realm || !query.name) return;
    try {
      window.localStorage.setItem('wow-last-character-v1', JSON.stringify({
        region: query.region,
        realm: query.realm,
        name: query.name
      }));
    } catch {
      // The selected character is still available in this page URL when storage is unavailable.
    }
  }

  function prepopulateRealm(region, selectedRealm) {
    realmRequestId += 1;
    var canonical = String(selectedRealm || preferredRealm(region)).toLocaleLowerCase('en-US');
    var fragment = document.createDocumentFragment();
    fragment.appendChild(new Option('Choose a realm', '', !canonical, !canonical));
    if (canonical) fragment.appendChild(new Option(realmLabel(canonical), canonical, true, true));
    if (region === 'us' && canonical !== 'dathremar') fragment.appendChild(new Option("Dath'Remar", 'dathremar'));
    fragment.appendChild(new Option('Loading more realms…', '', false, false));
    fragment.lastChild.disabled = true;
    realmSelect.replaceChildren(fragment);
    realmSelect.disabled = false;
  }

  function cachedRealms(region) {
    try {
      var cached = JSON.parse(window.localStorage.getItem('wow-realms-v1-' + region));
      if (cached && Array.isArray(cached.realms) && Date.now() - cached.savedAt < realmBrowserTtlMs) return cached.realms;
    } catch {
      // Storage can be unavailable in privacy modes; the server cache still applies.
    }
    return null;
  }

  function cacheRealms(region, realms) {
    try {
      window.localStorage.setItem('wow-realms-v1-' + region, JSON.stringify({ savedAt: Date.now(), realms: realms }));
    } catch {
      // A browser cache is an optional speed-up.
    }
  }

  function renderRealms(realms, selectedRealm) {
    var canonical = String(selectedRealm || '').toLocaleLowerCase('en-US');
    var fragment = document.createDocumentFragment();
    fragment.appendChild(new Option('Choose a realm', ''));
    realms.forEach(function (realm) {
      fragment.appendChild(new Option(realm.name, realm.slug));
    });
    if (canonical && !realms.some(function (realm) { return realm.slug === canonical; })) {
      fragment.appendChild(new Option(realmLabel(canonical), canonical));
    }
    realmSelect.replaceChildren(fragment);
    if (canonical) realmSelect.value = canonical;
    realmSelect.disabled = false;
  }

  function loadRealms(region, selectedRealm) {
    var fromBrowser = cachedRealms(region);
    if (fromBrowser) {
      renderRealms(fromBrowser, realmSelect.value || selectedRealm);
      return Promise.resolve();
    }
    if (realmLoad && realmLoad.region === region) return realmLoad.promise;

    var requestId = ++realmRequestId;
    var promise = (async function () {
      try {
      var response = await fetch('/api/realms?region=' + encodeURIComponent(region), {
        headers: { accept: 'application/json' }
      });
      var data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Could not load realms.');
      cacheRealms(region, data.realms);
      if (requestId !== realmRequestId) return;
      renderRealms(data.realms, realmSelect.value || selectedRealm);
      status.textContent = data.warning || '';
      } catch (error) {
        if (requestId !== realmRequestId) return;
        status.textContent = 'Full realm list unavailable; the current selection still works.';
      }
    })();
    realmLoad = { region: region, promise: promise };
    function clearLoad() {
      if (realmLoad && realmLoad.promise === promise) realmLoad = null;
    }
    promise.then(clearLoad, clearLoad);
    return promise;
  }

  function setBusy(busy, refreshing) {
    submitButton.disabled = busy;
    refreshButton.disabled = busy || refreshButton.dataset.cooldown === 'true';
    submitButton.textContent = busy && !refreshing ? 'Looking up…' : 'View gear';
    if (busy && refreshing) refreshButton.textContent = 'Refreshing…';
    else if (refreshButton.dataset.cooldown !== 'true') refreshButton.textContent = 'Refresh now';
  }

  function qualityClass(quality) {
    return quality ? ' quality-' + quality.toLowerCase() : '';
  }

  function wowheadUrl(item) {
    return 'https://www.wowhead.com/item=' + encodeURIComponent(item.itemId);
  }

  function createWowheadItemLink(item, className, disableTooltip) {
    var link = document.createElement('a');
    link.className = className || '';
    link.href = wowheadUrl(item);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    if (!disableTooltip) link.dataset.wowhead = 'item=' + item.itemId;
    link.setAttribute('aria-label', item.name + ' on Wowhead (opens in a new tab)');
    link.append(item.name);
    var externalIcon = document.createElement('img');
    externalIcon.className = 'item-external';
    externalIcon.src = 'https://wow.zamimg.com/images/logos/favicon-live.png';
    externalIcon.alt = '';
    externalIcon.width = 12;
    externalIcon.height = 12;
    externalIcon.setAttribute('aria-hidden', 'true');
    link.appendChild(externalIcon);
    return link;
  }

  function refreshWowheadTooltips() {
    window.$WowheadPower?.refreshLinks?.();
  }

  function appendText(parent, tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    parent.appendChild(node);
    return node;
  }

  function renderUpgrade(parent, upgrade) {
    var box = document.createElement('div');
    box.className = 'character-upgrade character-upgrade-' + upgrade.kind;

    if (upgrade.kind === 'season-track') {
      appendText(box, 'strong', '', upgrade.track + ' ' + upgrade.rank + '/' + upgrade.ranks);
      var segments = document.createElement('div');
      segments.className = 'upgrade-progress';
      segments.style.setProperty('--rank-count', upgrade.ranks);
      segments.setAttribute('aria-label', upgrade.rank + ' of ' + upgrade.ranks + ' ranks');
      for (var i = 1; i <= upgrade.ranks; i++) {
        var segment = document.createElement('span');
        if (i <= upgrade.rank) segment.className = 'filled';
        segments.appendChild(segment);
      }
      box.appendChild(segments);
      if (upgrade.upgradesRemaining === 0) {
        appendText(box, 'span', 'upgrade-detail', 'Maxed at ' + upgrade.maximumItemLevel);
      } else {
        appendText(
          box,
          'span',
          'upgrade-detail',
          upgrade.upgradesRemaining + ' upgrade' + (upgrade.upgradesRemaining === 1 ? '' : 's') +
            ' remaining · ' + upgrade.crestCostRemaining + ' ' + upgrade.crestName +
            ' · max ' + upgrade.maximumItemLevel
        );
      }
    } else if (upgrade.kind === 'special') {
      appendText(box, 'strong', '', 'Special upgrade path');
      appendText(box, 'span', 'upgrade-detail', upgrade.label);
    } else {
      appendText(box, 'strong', '', 'Pre-Season 2 or special gear');
      appendText(box, 'span', 'upgrade-detail', upgrade.label || 'Not on a current Season 2 track');
    }
    parent.appendChild(box);
  }

  function renderTrackPlanner(parent, item) {
    var planner = document.createElement('div');
    planner.className = 'track-planner';
    var availableTracks = SEASON.tracks.filter(function (track) {
      return track.ilvls[track.ilvls.length - 1] > item.itemLevel;
    });
    if (availableTracks.length === 0) {
      appendText(planner, 'p', 'track-planner-note', 'No standard track can improve this item level.');
      parent.appendChild(planner);
      return;
    }
    appendText(planner, 'p', 'track-planner-note', 'Choose a target rank. Crest cost is exact for the current track and shown from 1/6 for a different track.');

    availableTracks.forEach(function (track) {
      var minimum = track.ilvls[0];
      var maximum = track.ilvls[track.ilvls.length - 1];
      var firstUpgradeIndex = track.ilvls.findIndex(function (level) { return level > item.itemLevel; });
      var initialRank = firstUpgradeIndex >= 0 ? firstUpgradeIndex + 1 : SEASON.ranksPerTrack;
      var row = document.createElement('div');
      row.className = 'track-plan';
      row.style.setProperty('--track-colour', track.colour);
      var head = document.createElement('div');
      head.className = 'track-plan-head';
      appendText(head, 'strong', 'track-plan-name', track.name);
      appendText(head, 'span', 'track-plan-range', minimum + '–' + maximum + ' (+' + (maximum - minimum) + ' ilvl)');
      row.appendChild(head);

      var sliderId = 'track-rank-' + track.name.toLowerCase();
      var sliderLabel = document.createElement('label');
      sliderLabel.className = 'sr';
      sliderLabel.htmlFor = sliderId;
      sliderLabel.textContent = track.name + ' target rank';
      row.appendChild(sliderLabel);
      var slider = document.createElement('input');
      slider.id = sliderId;
      slider.className = 'track-slider';
      slider.type = 'range';
      slider.min = '1';
      slider.max = String(SEASON.ranksPerTrack);
      slider.step = '1';
      slider.value = String(initialRank);
      row.appendChild(slider);

      var result = document.createElement('div');
      result.className = 'track-plan-result';
      var rankReadout = appendText(result, 'strong', 'track-plan-rank', '');
      var gainReadout = appendText(result, 'span', 'track-plan-gain', '');
      var crestReadout = appendText(result, 'span', 'track-plan-crest', '');
      row.appendChild(result);

      function updatePlan() {
        var rank = Number(slider.value);
        var targetLevel = track.ilvls[rank - 1];
        var gain = targetLevel - item.itemLevel;
        var currentRank = item.upgrade.kind === 'season-track' && item.upgrade.track === track.name
          ? item.upgrade.rank
          : null;
        rankReadout.textContent = 'Rank ' + rank + '/' + SEASON.ranksPerTrack + ' · ilvl ' + targetLevel;
        gainReadout.textContent = gain > 0 ? '+' + gain + ' ilvl' : (gain === 0 ? '—' : '−' + Math.abs(gain) + ' ilvl');
        if (currentRank !== null && rank <= currentRank) {
          crestReadout.textContent = 'Already at ' + currentRank + '/' + SEASON.ranksPerTrack;
        } else {
          var crestCost = currentRank !== null
            ? (rank - currentRank) * SEASON.crestPerRank
            : (rank - 1) * SEASON.crestPerRank;
          crestReadout.textContent = crestCost === 0
            ? '0 crests · at 1/6'
            : crestCost + ' crests · ' + (currentRank !== null ? 'from current rank' : 'from 1/6');
        }
      }

      slider.addEventListener('input', updatePlan);
      updatePlan();
      planner.appendChild(row);
    });
    parent.appendChild(planner);
  }

  function renderQuickSummary(parent, upgrade) {
    var box = document.createElement('p');
    box.className = 'equipment-quick';
    if (upgrade.kind === 'season-track') {
      appendText(box, 'strong', '', upgrade.track + ' ' + upgrade.rank + '/' + upgrade.ranks);
      box.append(' · ' + upgrade.upgradesRemaining + ' left · max ' + upgrade.maximumItemLevel);
    } else if (upgrade.kind === 'special') {
      appendText(box, 'strong', '', 'Special upgrade path');
    } else {
      appendText(box, 'strong', '', 'Pre-Season 2 or special gear');
    }
    parent.appendChild(box);
  }

  function renderGuideDetail(parent, auditSlot) {
    if (!auditSlot?.recommendation) {
      appendText(parent, 'p', '', 'No matching item appears in the available guide lists.');
    } else {
      var matches = auditSlot.recommendation.listedIn || [];
      var sources = matches.map(function (match) {
        return (match.listLabel || match.list) + (match.isBis ? ' (BiS)' : '');
      });
      appendText(parent, 'p', '', auditSlot.recommendation.isBisSomewhere
        ? 'Listed as BiS in ' + sources.join(', ') + '.'
        : 'Listed in ' + sources.join(', ') + ', but not marked BiS.');
    }
  }

  function openGearModal(item, auditSlot) {
    if (!gearModal || !gearModalContent) return;
    gearModalContent.replaceChildren();
    var head = document.createElement('div');
    head.className = 'modal-item-head';
    if (item.icon) {
      var image = document.createElement('img');
      image.src = item.icon;
      image.alt = '';
      image.width = 54;
      image.height = 54;
      head.appendChild(image);
    }
    var heading = document.createElement('div');
    var title = document.createElement('h2');
    title.id = 'gear-modal-title';
    title.appendChild(createWowheadItemLink(item, 'equipment-name' + qualityClass(item.quality), true));
    heading.appendChild(title);
    appendText(heading, 'p', '', (item.slotName || item.slot) + ' · Item level ' + item.itemLevel + ' · Blizzard data');
    head.appendChild(heading);
    gearModalContent.appendChild(head);

    var statusSection = document.createElement('section');
    statusSection.className = 'modal-section modal-status-section';
    appendText(statusSection, 'h3', '', 'Item status');
    var statusGrid = document.createElement('div');
    statusGrid.className = 'modal-status-grid';
    var guideStatus = document.createElement('div');
    guideStatus.className = 'modal-status';
    appendText(guideStatus, 'strong', '', 'Guide match');
    renderGuideDetail(guideStatus, auditSlot);
    statusGrid.appendChild(guideStatus);
    var enhancementStatus = document.createElement('div');
    enhancementStatus.className = 'modal-status';
    appendText(enhancementStatus, 'strong', '', 'Enhancements');
    var enhancement = enhancementState(item, currentGuide);
    appendText(enhancementStatus, 'p', '', enhancement.missingGem ? 'Missing socket gem.' : enhancement.missingEnchant ? 'Missing enchant' + (enhancement.recommendation ? ': ' + enhancement.recommendation : '.') : 'No detected enhancement gap.');
    statusGrid.appendChild(enhancementStatus);
    var pathStatus = document.createElement('div');
    pathStatus.className = 'modal-status';
    appendText(pathStatus, 'strong', '', 'Current path');
    renderUpgrade(pathStatus, item.upgrade);
    statusGrid.appendChild(pathStatus);
    statusSection.appendChild(statusGrid);
    gearModalContent.appendChild(statusSection);

    var comparisonSection = document.createElement('section');
    comparisonSection.className = 'modal-section';
    appendText(comparisonSection, 'h3', '', 'Track planner');
    renderTrackPlanner(comparisonSection, item);
    gearModalContent.appendChild(comparisonSection);

    gearModal.showModal();
    gearModalClose.focus();
    refreshWowheadTooltips();
  }

  function filterMatches(card, filter) {
    if (filter === 'all') return true;
    if (filter === 'season-track') return card.dataset.seasonTrack === 'true';
    if (filter === 'off-track') return card.dataset.offTrack === 'true';
    return card.dataset.guideBis === 'true';
  }

  function applyGearFilter(filter) {
    activeGearFilter = filter;
    var cards = Array.from(paperDoll.querySelectorAll('.equipment-card'));
    var matched = cards.filter(function (card) { return filterMatches(card, filter); }).length;
    cards.forEach(function (card) {
      card.classList.toggle('is-muted', !filterMatches(card, filter));
    });
    characterSummary.querySelectorAll('.summary-stat').forEach(function (button) {
      var selected = button.dataset.filter === filter;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    var label = {
      all: 'all equipped items',
      'season-track': 'items on standard Season 2 tracks',
      'off-track': 'Pre-Season 2 or special items',
      'guide-bis': 'guide-listed BiS items'
    }[filter];
    filterStatus.textContent = filter === 'all' ? 'Showing all ' + matched + ' equipped items.' : 'Highlighting ' + matched + ' ' + label + '.';
  }

  function renderSummary(items, profile, audit) {
    var onTrack = items.filter(function (item) { return item.upgrade.kind === 'season-track'; }).length;
    var offTrack = items.filter(function (item) { return item.upgrade.kind !== 'season-track'; }).length;
    var hasGuidance = Boolean(audit?.guidance);
    var stats = [
      [profile?.equippedItemLevel ?? '—', 'Equipped ilvl', 'all', 'Show all equipped items.'],
      [onTrack + ' items', 'On Season 2 tracks', 'season-track', 'Items with a recognized standard Season 2 upgrade path.'],
      [offTrack + ' items', 'Pre-Season 2 / special', 'off-track', 'Items from before Season 2, items without a recognized current-season path, and special-path gear.'],
      [hasGuidance ? audit.summary.slotsAlreadyBis + ' items' : '—', 'Guide-listed BiS', 'guide-bis', 'Items listed as BiS by at least one guide source. This is guide data, not a replacement verdict.']
    ];
    characterSummary.replaceChildren();
    stats.forEach(function (stat) {
      var box = document.createElement('button');
      box.className = 'summary-stat';
      box.type = 'button';
      box.dataset.filter = stat[2];
      box.title = stat[3];
      box.setAttribute('aria-label', stat[1] + '. ' + stat[3]);
      appendText(box, 'strong', '', String(stat[0]));
      appendText(box, 'span', '', stat[1]);
      box.addEventListener('click', function () {
        applyGearFilter(activeGearFilter === stat[2] ? 'all' : stat[2]);
      });
      characterSummary.appendChild(box);
    });

    if (hasGuidance) {
      var guidanceDate = audit.guidance.lastScrape
        ? new Intl.DateTimeFormat([], { dateStyle: 'medium' }).format(new Date(audit.guidance.lastScrape + 'T00:00:00Z'))
        : 'Date unknown';
      guidanceNote.hidden = false;
      guidanceNote.textContent = 'Community guide data · ClassCodex ' + (audit.guidance.addonVersion || '') +
        ' · Updated ' + guidanceDate + ' · ' + audit.summary.slotsWithGuidance + ' slots matched';
    } else {
      guidanceNote.hidden = true;
      guidanceNote.textContent = '';
    }
  }

  function renderHammerLinkCapture(capture) {
    hammerLinkCapture.replaceChildren();
    if (!capture) { hammerLinkCapture.hidden = true; return; }
    var heading = appendText(hammerLinkCapture, 'strong', '', 'Live in-game capture');
    heading.title = 'HammerLink data is a local player export, separate from Blizzard profile data.';
    appendText(hammerLinkCapture, 'span', '', 'Captured ' + new Date(capture.capturedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) + ' · ' + capture.equipmentCount + ' equipped items · Great Vault');
    var groups = { 3: 'Raids', 1: 'Dungeons', 6: 'World' };
    Object.entries(groups).forEach(function (entry) {
      var values = capture.vault.activities.filter(function (activity) { return activity.type === Number(entry[0]); })
        .map(function (activity) { return activity.progress + '/' + activity.threshold; });
      if (values.length) appendText(hammerLinkCapture, 'span', 'hammerlink-vault-row', entry[1] + ' ' + values.join(' · '));
    });
    hammerLinkCapture.hidden = false;
  }

  function guideCard(title, content) {
    var card = document.createElement('section'); card.className = 'guide-card'; appendText(card, 'h4', '', title); content(card); return card;
  }
  function demoGuidance() {
    return { available: true, lastScrape: '2026-08-18', addonVersion: 'Season 2 preview',
      statPriorities: [{ stats: [['Haste'], ['Mastery'], ['Crit'], ['Versatility']] }],
      statTargets: { 'Mythic+': { targets: { Haste: '~20%', Mastery: '~30%' } } },
      talentBuilds: [{ context: 'Mythic+', heroTalent: 'Lightsmith' }],
      rotation: [{ steps: ['Keep Beacon coverage active; spend Holy Power before capping.'] }],
      enchants: [{ slot: 'Weapon', best: { name: "Enchant Weapon — Acuity of the Ren'dorei" } }, { slot: 'Ring', best: { name: "Enchant Ring — Zul'jin's Mastery" } }, { slot: 'Boots', best: { name: "Enchant Boots — Shaladrassil's Roots" } }],
      bisGear: {}, trinkets: [] };
  }
  function demoPlanner(planner) {
    var samples = {
      'Altar of Fangs': ['Coiled Fangstone', 'TRINKET', "Rav'i"], 'Murder Row': ['Signet of Snarling Servitude', 'FINGER', 'Xathuux the Annihilator'], 'Den of Nalorakk': ['Mycolic Medicine', 'TRINKET', 'The Hoardmonger'], 'The Blinding Vale': ["Teldrassil's Sacrifice", 'OFF_HAND', 'Ziekket'], 'Voidscar Arena': ["Mindpiercer's Sigil", 'TRINKET', 'Charonus'], "King's Rest": ['Loa-Blessed Chestguard', 'CHEST', 'Mchimba the Embalmer'], 'Ruby Life Pools': ["Kyrakka's Searing Embers", 'TRINKET', 'Kyrakka and Erkhart Stormvein'], 'Temple of Sethraliss': ["Desert Guardian's Breastplate", 'CHEST', 'Avatar of Sethraliss']
    };
    planner.demo = true; planner.rating = 2468;
    planner.dungeons = planner.dungeons.map(function (dungeon, index) { var sample = samples[dungeon.name]; if (!sample) return dungeon; dungeon.coverage = 'demo'; dungeon.bestRun = index === 1 ? { keystoneLevel: 7, completedWithinTime: false } : index === 4 ? null : { keystoneLevel: 10 + (index % 3), completedWithinTime: true }; dungeon.needsPractice = !dungeon.bestRun || !dungeon.bestRun.completedWithinTime; if (!dungeon.guideTargets.length && !dungeon.eligibleUpgrades.length) dungeon.guideTargets = [{ name: sample[0], slot: sample[1], boss: sample[2], guideTarget: true, itemLevelGain: 21 }]; return dungeon; }); return planner;
  }
  function guideSlotMatches(item, guideSlot) {
    var slot = String(item.slot || '').toUpperCase(); var guide = String(guideSlot || '').toUpperCase();
    if (guide === 'WEAPON') return slot === 'MAIN_HAND' || slot === 'OFF_HAND';
    return (guide === 'HELMET' && slot === 'HEAD') || (guide === 'BOOTS' && slot === 'FEET') || (guide === 'SHOULDERS' && slot === 'SHOULDER') || (guide === 'RING' && slot.indexOf('FINGER') === 0) || guide === slot;
  }
  function enhancementState(item, guide) {
    var missingGem = (item.sockets || []).some(function (socket) { return !socket.itemName; });
    var recommendation = (guide?.enchants || []).find(function (entry) { return guideSlotMatches(item, entry.slot); });
    return { missingGem: missingGem, missingEnchant: Boolean(recommendation && !(item.enchantments || []).length), recommendation: recommendation?.best?.name || null };
  }
  function renderReadyCheck(items, audit, guide) {
    var ready = document.createElement('section'); ready.className = 'ready-check'; appendText(ready, 'h4', '', 'Ready check');
    var entries = document.createElement('div'); entries.className = 'ready-check-items';
    var missingGems = items.filter(function (item) { return enhancementState(item, guide).missingGem; });
    var missingEnchants = items.filter(function (item) { return enhancementState(item, guide).missingEnchant; });
    var upgrades = (audit?.slots || []).filter(function (slot) { return slot.recommendation && !slot.recommendation.isBisSomewhere; });
    [[missingGems.length, 'gems missing'], [missingEnchants.length, 'enchants missing'], [upgrades.length, 'guide upgrades'], [audit?.summary?.slotsAlreadyBis || 0, 'BiS listed']].forEach(function (entry) { var stat = document.createElement('span'); appendText(stat, 'strong', '', String(entry[0])); stat.append(' ' + entry[1]); entries.appendChild(stat); });
    ready.appendChild(entries); return ready;
  }
  function applyEnhancementCues(items, guide) {
    items.forEach(function (item) { var card = paperDoll.querySelector('.equipment-card[data-slot="' + item.slot + '"]'); if (!card) return; var state = enhancementState(item, guide); card.classList.toggle('has-missing-gem', state.missingGem); card.classList.toggle('has-missing-enchant', state.missingEnchant); var cue = card.querySelector('.equipment-cues'); if (!cue) return; cue.replaceChildren(); if (state.missingGem) appendText(cue, 'span', 'equipment-glyph', '◇'); if (state.missingEnchant) appendText(cue, 'span', 'equipment-glyph', '✦'); if (card.dataset.guideBis === 'true') appendText(cue, 'span', 'equipment-glyph equipment-glyph-bis', '★'); });
  }
  async function renderGuide(profile, items, audit) {
    if (!characterGuide || !profile?.characterClass?.name || !profile?.activeSpecialization?.name) return;
    characterGuide.hidden = false; characterGuide.textContent = 'Loading class guidance…';
    try {
      var guide;
      if (demoMode) guide = demoGuidance();
      else { var params = new URLSearchParams({ class: profile.characterClass.name, spec: profile.activeSpecialization.name, specId: String(profile.activeSpecialization.id || '') }); var response = await fetch('/api/class-guidance?' + params, { headers: { accept: 'application/json' } }); guide = await response.json(); if (!response.ok || !guide.available) throw new Error(guide.reason || 'Guidance unavailable.'); }
      characterGuide.replaceChildren(); appendText(characterGuide, 'h3', '', 'Before tonight');
      appendText(characterGuide, 'p', 'guidance-note', demoMode ? 'DEV DEMO · illustrative Season 2 guidance and planner data; not live advice.' : 'Community guidance from ClassCodex · scraped ' + (guide.lastScrape || 'unknown date') + '. Treat as dated advice.');
      characterGuide.appendChild(renderReadyCheck(items || [], audit, guide));
      var grid = document.createElement('div'); grid.className = 'guide-grid';
      grid.appendChild(guideCard('Build', function (card) { var build = (guide.talentBuilds || []).find(function (entry) { return entry.context === 'Mythic+'; }) || guide.talentBuilds?.[0]; appendText(card, 'p', '', (build?.heroTalent || profile.activeHeroTalentTree?.name || 'Current hero tree') + ' · ' + (build?.context || 'No recommended build')); }));
      grid.appendChild(guideCard('Stats to watch', function (card) { var p = guide.statPriorities?.[0]; appendText(card, 'p', '', p ? p.stats.map(function (tier) { return tier.join(' / '); }).join(' › ') : 'No stat priority available.'); var targets = guide.statTargets?.['Mythic+']?.targets; if (targets) appendText(card, 'p', 'guide-detail', Object.entries(targets).map(function (entry) { return entry[0] + ' ' + entry[1]; }).join(' · ')); }));
      grid.appendChild(guideCard('Rotation focus', function (card) { var step = guide.rotation?.[0]?.steps?.[0]; appendText(card, 'p', '', step || 'No rotation priority available.'); }));
      grid.appendChild(guideCard('Enhancements', function (card) { appendText(card, 'p', '', (guide.enchants || []).map(function (item) { return item.slot + ': ' + item.best?.name; }).join(' · ') || 'No enhancement guidance available.'); }));
      characterGuide.appendChild(grid);
      currentGuide = guide;
      applyEnhancementCues(items || [], guide);
    } catch (error) { characterGuide.textContent = error.message; }
  }

  async function openMythicPlanner() {
    if (!latestQuery || !mythicPlannerModal || !mythicPlannerContent) return;
    mythicPlannerContent.textContent = 'Loading Mythic+ planner…'; mythicPlannerModal.showModal();
    try {
      var response = await fetch('/api/mythic-planner?' + new URLSearchParams(Object.assign({}, latestQuery, { key: '+10' })), { headers: { accept: 'application/json' } });
      var planner = await response.json(); if (!response.ok || !planner.available) throw new Error(planner.reason || 'Planner unavailable.'); if (demoMode) planner = demoPlanner(planner);
      mythicPlannerContent.replaceChildren(); appendText(mythicPlannerContent, 'h2', 'mythic-planner-title', 'Mythic+ planner');
      appendText(mythicPlannerContent, 'p', 'planner-note', '+' + String(planner.key).replace(/^\+/, '') + ' rewards · ' + (planner.rating == null ? 'No rating yet' : Math.round(planner.rating) + ' rating') + ' · gear rewards cap here; higher keys are progression, score, and timing practice.');
      appendText(mythicPlannerContent, 'p', 'planner-note', (planner.demo ? 'DEV DEMO · ' : '') + planner.warning);
      var list = document.createElement('div'); list.className = 'planner-dungeon-list';
      planner.dungeons.forEach(function (dungeon) { var card = document.createElement('section'); card.className = 'planner-dungeon' + (dungeon.needsPractice ? ' needs-practice' : ''); var heading = document.createElement('div'); appendText(heading, 'h3', '', dungeon.name); appendText(heading, 'span', '', dungeon.bestRun ? '+' + dungeon.bestRun.keystoneLevel + (dungeon.bestRun.completedWithinTime ? ' timed' : ' over time') : 'Not recorded'); card.appendChild(heading); var targets = dungeon.guideTargets.concat(dungeon.eligibleUpgrades); if (targets.length) { var ul = document.createElement('ul'); targets.slice(0, 6).forEach(function (target) { appendText(ul, 'li', target.name + ' · ' + target.slot + ' · ' + target.boss + (target.guideTarget ? ' · guide target' : '') + (target.itemLevelGain != null ? ' · +' + target.itemLevelGain + ' ilvl' : '')); }); card.appendChild(ul); } else appendText(card, 'p', '', dungeon.coverage === 'catalogue_pending' ? 'Verified loot targets are being added for this dungeon.' : 'No eligible upgrade target at this reward level.'); var link = document.createElement('a'); link.href = dungeon.sourceUrl; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = 'Loot source'; card.appendChild(link); list.appendChild(card); }); mythicPlannerContent.appendChild(list);
    } catch (error) { mythicPlannerContent.textContent = error.message; }
  }

  function renderCharacter(data, profile, audit) {
    currentGuide = null;
    resultTitle.textContent = data.character.name + ' — ' + data.character.realm;
    var fetched = new Date(data.fetchedAt);
    var cacheLabel = {
      hit: 'served from server cache',
      miss: 'fetched from Blizzard',
      refreshed: 'refreshed from Blizzard',
      revalidated: 'updated from Blizzard',
      stale: 'cached result; Blizzard refresh failed',
      'refresh-cooldown': 'recent result; refresh cooling down'
    }[data.cache.status] || data.cache.status;
    resultMeta.textContent = data.character.region + (profile?.activeSpecialization?.name ? ' · ' + profile.activeSpecialization.name : '') +
      ' · ' + cacheLabel + ' · ' +
      fetched.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    equipmentLeft.replaceChildren();
    equipmentRight.replaceChildren();
    equipmentWeapons.replaceChildren();
    var classBackgrounds = {
      1: 'warrior', 2: 'paladin', 3: 'hunter', 4: 'rogue', 5: 'priest', 6: 'death_knight',
      7: 'shaman', 8: 'mage', 9: 'warlock', 10: 'monk', 11: 'druid', 12: 'demon_hunter', 13: 'evoker'
    };
    var classBackground = classBackgrounds[profile?.characterClass?.id] || 'paladin';
    paperDoll.style.setProperty('--character-background', 'url("https://render.worldofwarcraft.com/profile-backgrounds/v2/armory_bg_class_' + classBackground + '.jpg")');
    if (data.render) {
      characterRenderImage.src = data.render;
      characterRenderImage.alt = data.character.name + ', ' + (profile?.activeSpecialization?.name || 'World of Warcraft character');
      characterRender.hidden = false;
    } else {
      characterRenderImage.removeAttribute('src');
      characterRender.hidden = true;
    }
    // Shirt and tabard are cosmetic; keep them in the Blizzard response but out
    // of the actionable paper-doll and its counts.
    var displayItems = data.items.filter(function (item) {
      return item.slot !== 'SHIRT' && item.slot !== 'TABARD';
    });
    renderSummary(displayItems, profile, audit);
    renderHammerLinkCapture(latestHammerLink);
    renderGuide(profile, displayItems, audit);
    if (mythicPlannerOpen) mythicPlannerOpen.disabled = !latestQuery;

    var auditBySlot = new Map((audit?.slots || []).map(function (slot) { return [slot.slot, slot]; }));
    var leftSlots = ['HEAD', 'NECK', 'SHOULDER', 'BACK', 'CHEST', 'WRIST'];
    var weaponSlots = ['MAIN_HAND', 'OFF_HAND'];
    var slotOrder = ['HEAD', 'NECK', 'SHOULDER', 'BACK', 'CHEST', 'WRIST', 'MAIN_HAND', 'OFF_HAND', 'HANDS', 'WAIST', 'LEGS', 'FEET', 'FINGER_1', 'FINGER_2', 'TRINKET_1', 'TRINKET_2'];
    var sortedItems = displayItems.slice().sort(function (left, right) {
      var leftIndex = slotOrder.indexOf(left.slot);
      var rightIndex = slotOrder.indexOf(right.slot);
      if (leftIndex === -1 && rightIndex === -1) return String(left.slot).localeCompare(String(right.slot));
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    });

    sortedItems.forEach(function (item) {
      var card = document.createElement('article');
      card.className = 'equipment-card';
      var slotName = item.slotName || item.slot;
      var auditSlot = auditBySlot.get(slotName);
      var priority = Boolean(auditSlot?.recommendation && !auditSlot.recommendation.isBisSomewhere);
      card.dataset.priority = String(priority);
      card.dataset.seasonTrack = String(item.upgrade.kind === 'season-track');
      card.dataset.offTrack = String(item.upgrade.kind !== 'season-track');
      card.dataset.guideBis = String(Boolean(auditSlot?.recommendation?.isBisSomewhere));
      card.dataset.slot = item.slot;
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', 'Open ' + slotName + ' details');

      var itemRow = document.createElement('div');
      itemRow.className = 'equipment-item';
      if (item.icon) {
        var image = document.createElement('img');
        image.src = item.icon;
        image.alt = '';
        image.width = 48;
        image.height = 48;
        image.loading = 'lazy';
        itemRow.appendChild(image);
      }
      var details = document.createElement('div');
      details.appendChild(createWowheadItemLink(item, 'equipment-name' + qualityClass(item.quality)));
      appendText(details, 'span', 'equipment-level', 'ilvl ' + item.itemLevel);
      itemRow.appendChild(details);
      var cues = document.createElement('span'); cues.className = 'equipment-cues'; itemRow.appendChild(cues);
      card.appendChild(itemRow);
      var detailsButton = document.createElement('button');
      detailsButton.className = 'equipment-details-button';
      detailsButton.type = 'button';
      detailsButton.textContent = 'Upgrade details';
      detailsButton.addEventListener('click', function () { openGearModal(item, auditSlot); });
      card.appendChild(detailsButton);
      card.addEventListener('click', function (event) { if (event.target !== detailsButton) openGearModal(item, auditSlot); });
      card.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openGearModal(item, auditSlot); } });
      (weaponSlots.includes(item.slot) ? equipmentWeapons : (leftSlots.includes(item.slot) ? equipmentLeft : equipmentRight)).appendChild(card);
    });

    applyGearFilter(activeGearFilter);
    refreshWowheadTooltips();

    results.hidden = false;
    if (characterEmpty) characterEmpty.hidden = true;
    status.textContent = data.warning || '';
    startRefreshCooldown(data.cache.refreshAvailableAt);
  }

  function startRefreshCooldown(availableAt) {
    if (refreshTimer) window.clearInterval(refreshTimer);
    function updateRefresh() {
      var seconds = Math.ceil((new Date(availableAt).getTime() - Date.now()) / 1000);
      if (seconds > 0) {
        refreshButton.dataset.cooldown = 'true';
        refreshButton.disabled = true;
        refreshButton.textContent = 'Refresh now';
        refreshNote.textContent = 'Available in ' + seconds + ' seconds';
        refreshButton.title = refreshNote.textContent;
      } else {
        refreshButton.dataset.cooldown = 'false';
        refreshButton.disabled = false;
        refreshButton.textContent = 'Refresh now';
        refreshNote.textContent = '';
        refreshButton.removeAttribute('title');
        window.clearInterval(refreshTimer);
      }
    }
    updateRefresh();
    refreshTimer = window.setInterval(updateRefresh, 1000);
  }

  async function lookup(query, forceRefresh) {
    setBusy(true, forceRefresh);
    status.textContent = forceRefresh ? 'Refreshing equipment from Blizzard…' : 'Fetching equipment from Blizzard…';
    try {
      var params = new URLSearchParams(query);
      if (forceRefresh) params.set('refresh', '1');
      var sharedParams = new URLSearchParams(query);
      var requests = await Promise.all([
        fetch('/api/character?' + params.toString(), { headers: { accept: 'application/json' } }),
        fetch('/api/profile?' + sharedParams.toString(), { headers: { accept: 'application/json' } }).catch(function () { return null; }),
        fetch('/api/gear-audit?' + sharedParams.toString(), { headers: { accept: 'application/json' } }).catch(function () { return null; })
      ]);
      var response = requests[0];
      var data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Character lookup failed. Check the region, realm, and character name.');
      async function optionalJson(optionalResponse) {
        if (!optionalResponse?.ok) return null;
        try {
          return await optionalResponse.json();
        } catch {
          return null;
        }
      }
      var profile = await optionalJson(requests[1]);
      var audit = await optionalJson(requests[2]);
      rememberCharacter(query);
      renderCharacter(data, profile, audit);
      if (characterPicker?.open) characterPicker.close();
      var shareParams = new URLSearchParams(query);
      if (demoMode) shareParams.set('demo', '1');
      window.history.replaceState(null, '', '/gear-advisor.html?' + shareParams.toString());
    } catch (error) {
      status.textContent = error.message;
    } finally {
      setBusy(false, forceRefresh);
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var formData = new FormData(form);
    latestQuery = {
      region: String(formData.get('region') || ''),
      realm: String(formData.get('realm') || '').trim(),
      name: String(formData.get('name') || '').trim()
    };
    rememberRealm(latestQuery.region, latestQuery.realm);
    latestHammerLink = null;
    lookup(latestQuery, false);
  });

  refreshButton.addEventListener('click', function () {
    if (latestQuery) lookup(latestQuery, true);
  });

  gearModalClose?.addEventListener('click', function () { gearModal.close(); });
  gearModal?.addEventListener('click', function (event) {
    if (event.target === gearModal) gearModal.close();
  });
  mythicPlannerOpen?.addEventListener('click', openMythicPlanner);
  mythicPlannerClose?.addEventListener('click', function () { mythicPlannerModal?.close(); });
  mythicPlannerModal?.addEventListener('click', function (event) { if (event.target === mythicPlannerModal) mythicPlannerModal.close(); });
  function openCharacterPicker() { characterPicker?.showModal(); }
  characterPickerOpen?.addEventListener('click', openCharacterPicker);
  characterEmptyOpen?.addEventListener('click', openCharacterPicker);
  characterPickerClose?.addEventListener('click', function () { characterPicker?.close(); });
  characterPicker?.addEventListener('click', function (event) {
    if (event.target === characterPicker) characterPicker.close();
  });
  hammerLinkImportOpen?.addEventListener('click', function () { hammerLinkImport?.showModal(); });
  hammerLinkImportClose?.addEventListener('click', function () { hammerLinkImport?.close(); });
  hammerLinkImport?.addEventListener('click', function (event) { if (event.target === hammerLinkImport) hammerLinkImport.close(); });
  hammerLinkImportForm?.addEventListener('submit', async function (event) {
    event.preventDefault();
    var textarea = hammerLinkImportForm.elements.export;
    hammerLinkImportStatus.textContent = 'Validating live capture…';
    try {
      var response = await fetch('/api/hammerlink-import', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ export: textarea.value }) });
      var capture = await response.json();
      if (!response.ok) throw new Error(capture.message || 'Could not read that HammerLink export.');
      latestHammerLink = capture;
      latestQuery = capture.lookup;
      hammerLinkImport.close();
      lookup(latestQuery, false);
    } catch (error) { hammerLinkImportStatus.textContent = error.message; }
  });

  regionSelect.addEventListener('change', function () {
    prepopulateRealm(regionSelect.value, '');
    loadRealms(regionSelect.value, '');
  });

  realmSelect.addEventListener('focus', function () {
    loadRealms(regionSelect.value, realmSelect.value);
  });

  realmSelect.addEventListener('change', function () {
    rememberRealm(regionSelect.value, realmSelect.value);
  });

  var initial = new URLSearchParams(window.location.search);
  var storedCharacter = savedCharacter();
  var initialRegion = initial.get('region') || storedCharacter?.region || 'us';
  var initialRealm = (initial.get('realm') || storedCharacter?.realm || '').toLocaleLowerCase('en-US');
  regionSelect.value = initialRegion;
  form.elements.name.value = initial.get('name') || storedCharacter?.name || '';
  prepopulateRealm(initialRegion, initialRealm);
  if (initialRealm && form.elements.name.value) form.requestSubmit();
  var loadInitialRealms = function () { loadRealms(initialRegion, realmSelect.value); };
  if ('requestIdleCallback' in window) window.requestIdleCallback(loadInitialRealms, { timeout: 500 });
  else window.setTimeout(loadInitialRealms, 0);
})();
