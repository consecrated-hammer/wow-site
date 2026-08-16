import { SEASON } from './season-data.js';

/* Gear advisor — manual track comparison and Blizzard character equipment. */
(function () {
  'use strict';

  var slider = document.getElementById('ga-ilvl');
  var output = document.getElementById('ga-out');
  var rows = document.getElementById('ga-rows');
  var heads = document.getElementById('ga-heads');
  if (!slider || !output || !rows || !heads) return;

  var ranks = SEASON.ranksPerTrack;
  heads.style.setProperty('--rank-count', ranks);
  rows.style.setProperty('--rank-count', ranks);

  // Column headings: 1/6 .. 6/6.
  heads.appendChild(document.createElement('div'));
  for (var r = 0; r < ranks; r++) {
    var head = document.createElement('div');
    head.className = 'ga-colhead';
    head.textContent = (r + 1) + '/' + ranks;
    heads.appendChild(head);
  }

  // Body: one label cell plus one ilvl cell per rank, per track.
  var cells = [];
  var summaries = [];

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
      cell.textContent = ilvl;
      rows.appendChild(cell);
      cells.push(cell);
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

    SEASON.tracks.forEach(function (track, t) {
      var firstUpgrade = -1;

      track.ilvls.forEach(function (ilvl, r) {
        var cell = cells[t * ranks + r];
        var state = ilvl > current ? 'ga-up' : (ilvl === current ? 'ga-eq' : 'ga-dn');
        if (ilvl > current && firstUpgrade < 0) firstUpgrade = r;
        cell.className = 'ga-cell ' + state + (firstUpgrade === r ? ' ga-first' : '');
      });

      summaries[t].textContent = describe(firstUpgrade);
    });
  }

  slider.addEventListener('input', update);
  update();

  var form = document.getElementById('character-form');
  var status = document.getElementById('character-status');
  var results = document.getElementById('character-results');
  var resultTitle = document.getElementById('character-result-title');
  var resultMeta = document.getElementById('character-result-meta');
  var equipment = document.getElementById('character-equipment');
  var refreshButton = document.getElementById('character-refresh');
  var submitButton = document.getElementById('character-submit');
  var regionSelect = form?.elements.region;
  var realmSelect = form?.elements.realm;
  var realmRequestId = 0;
  var realmLoad = null;
  var latestQuery = null;
  var refreshTimer = null;
  var realmBrowserTtlMs = 24 * 60 * 60 * 1000;

  if (!form || !status || !results || !equipment) return;

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
    submitButton.textContent = busy && !refreshing ? 'Looking up…' : 'Look up character';
    if (busy && refreshing) refreshButton.textContent = 'Refreshing…';
    else if (refreshButton.dataset.cooldown !== 'true') refreshButton.textContent = 'Refresh now';
  }

  function qualityClass(quality) {
    return quality ? ' quality-' + quality.toLowerCase() : '';
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
      appendText(box, 'strong', '', 'Current path · ' + upgrade.track + ' ' + upgrade.rank + '/' + upgrade.ranks);
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
      appendText(box, 'strong', '', 'Current item · Special upgrade');
      appendText(box, 'span', 'upgrade-detail', upgrade.label);
    } else {
      appendText(box, 'strong', '', 'Current item · Previous season or untracked');
      appendText(box, 'span', 'upgrade-detail', upgrade.label || 'Not on a current Season 2 track');
    }
    parent.appendChild(box);
  }

  function renderSeasonUpgrades(parent, upgrades, currentItemLevel) {
    var box = document.createElement('details');
    box.className = 'season-upgrades';
    var summary = document.createElement('summary');
    appendText(summary, 'strong', 'season-upgrades-title', 'Season 2 upgrades');
    appendText(
      summary,
      'span',
      'season-upgrades-count',
      upgrades.length + ' track' + (upgrades.length === 1 ? '' : 's')
    );
    box.appendChild(summary);

    var content = document.createElement('div');
    content.className = 'season-upgrades-content';

    if (!upgrades.length) {
      var levelLabel = currentItemLevel === null || currentItemLevel === undefined ? 'the unknown item level' : 'item level ' + currentItemLevel;
      appendText(content, 'span', 'upgrade-detail', 'No standard Season 2 track exceeds ' + levelLabel + '.');
      box.appendChild(content);
      parent.appendChild(box);
      return;
    }

    var list = document.createElement('div');
    list.className = 'season-upgrade-list';
    upgrades.forEach(function (upgrade) {
      var row = document.createElement('div');
      row.className = 'season-upgrade-row';
      var track = appendText(row, 'strong', 'season-upgrade-track', upgrade.track);
      var trackData = SEASON.tracks.find(function (candidate) { return candidate.name === upgrade.track; });
      if (trackData) track.style.setProperty('--track-colour', trackData.colour);
      appendText(row, 'span', 'season-upgrade-rank', upgrade.rank + '/' + upgrade.ranks + ' · ilvl ' + upgrade.itemLevel);
      appendText(
        row,
        'span',
        'season-upgrade-cost',
        upgrade.crestCostFromRankOne ? upgrade.crestCostFromRankOne + ' crests from 1/6' : 'Beats yours on drop'
      );
      list.appendChild(row);
    });
    content.appendChild(list);
    box.appendChild(content);
    parent.appendChild(box);
  }

  function renderCharacter(data) {
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
    resultMeta.textContent = data.character.region + ' · ' + cacheLabel + ' · ' +
      fetched.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    equipment.replaceChildren();

    data.items.forEach(function (item) {
      var card = document.createElement('article');
      card.className = 'equipment-card';
      appendText(card, 'span', 'equipment-slot', item.slotName || item.slot);

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
      appendText(details, 'strong', 'equipment-name' + qualityClass(item.quality), item.name);
      appendText(details, 'span', 'equipment-level', 'Item level ' + item.itemLevel);
      itemRow.appendChild(details);
      card.appendChild(itemRow);
      renderUpgrade(card, item.upgrade);
      renderSeasonUpgrades(card, item.seasonUpgrades || [], item.itemLevel);
      equipment.appendChild(card);
    });

    results.hidden = false;
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
        refreshButton.textContent = 'Refresh in ' + seconds + 's';
      } else {
        refreshButton.dataset.cooldown = 'false';
        refreshButton.disabled = false;
        refreshButton.textContent = 'Refresh now';
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
      var response = await fetch('/api/character?' + params.toString(), { headers: { accept: 'application/json' } });
      var data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Character lookup failed.');
      renderCharacter(data);
      var shareParams = new URLSearchParams(query);
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
    lookup(latestQuery, false);
  });

  refreshButton.addEventListener('click', function () {
    if (latestQuery) lookup(latestQuery, true);
  });

  regionSelect.addEventListener('change', function () {
    prepopulateRealm(regionSelect.value, '');
    loadRealms(regionSelect.value, '');
  });

  realmSelect.addEventListener('focus', function () {
    loadRealms(regionSelect.value, realmSelect.value);
  });

  var initial = new URLSearchParams(window.location.search);
  var initialRegion = initial.get('region') || 'us';
  var initialRealm = (initial.get('realm') || '').toLocaleLowerCase('en-US');
  regionSelect.value = initialRegion;
  form.elements.name.value = initial.get('name') || '';
  prepopulateRealm(initialRegion, initialRealm);
  if (initialRealm && form.elements.name.value) form.requestSubmit();
  var loadInitialRealms = function () { loadRealms(initialRegion, realmSelect.value); };
  if ('requestIdleCallback' in window) window.requestIdleCallback(loadInitialRealms, { timeout: 500 });
  else window.setTimeout(loadInitialRealms, 0);
})();
