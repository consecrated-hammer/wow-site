import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const readSite = (name) => readFile(new URL(`../site/${name}`, import.meta.url), 'utf8');
const readFrontend = (name) => readFile(new URL(`../frontend/src/${name}`, import.meta.url), 'utf8');

test('home page links only to implemented player modules', async () => {
  const html = await readSite('index.html');
  assert.match(html, /href="\/gear-advisor\.html"/);
  assert.match(html, /href="\/mythic-planner\.html"/);
  assert.match(html, /href="\/upgrade-tracks\.html"/);
  assert.doesNotMatch(html, /coming soon|>soon</i);
});

test('player pages carry baseline accessible document furniture', async () => {
  for (const name of ['index.html', 'gear-advisor.html', 'mythic-planner.html', 'upgrade-tracks.html', 'mcp.html']) {
    const html = await readSite(name);
    assert.match(html, /<meta name="theme-color"/i, name);
    assert.match(html, /class="skip-link" href="#main-content"/i, name);
    assert.match(html, /<main id="main-content">/i, name);
  }
});

test('MCP page publishes the current read-only tool surface', async () => {
  const html = await readSite('mcp.html');
  const tools = [
    'get_character_profile', 'get_character_equipment', 'get_character_talents',
    'get_character_achievements', 'list_realms', 'get_gear_audit',
    'get_character_inventory', 'get_raid_progress', 'get_season_rewards',
    'get_class_guidance', 'get_meta_builds', 'get_mythic_planner'
  ];
  assert.match(html, /https:\/\/wow\.batserver\.au\/mcp/);
  assert.match(html, /12 current capabilities/);
  for (const tool of tools) assert.match(html, new RegExp(tool));
  assert.doesNotMatch(html, /get_great_vault_progress/);
});

test('React shell publishes the MCP guide and HammerLink CurseForge project', async () => {
  const app = await readFrontend('App.jsx');
  assert.match(app, /<NavLink to="\/mcp-guide">MCP<\/NavLink>/);
  assert.match(app, /<Route path="\/mcp-guide" element=\{<McpGuide \/>\} \/>/);
  assert.match(app, /https:\/\/www\.curseforge\.com\/wow\/addons\/hammerlink/);
  assert.match(app, /https:\/\/wow\.batserver\.au\/mcp/);
  assert.match(app, /Suggested prompts/);
  assert.match(app, /<details className="mcp-capabilities">/);
  assert.doesNotMatch(app, /<details className="mcp-capabilities" open/);
  for (const tool of [
    'get_character_inventory',
    'get_character_profile',
    'get_class_guidance',
    'achievement_dashboard',
    'achievement_build_session_plan',
    'achievement_update_state',
  ]) assert.match(app, new RegExp(tool));
  assert.doesNotMatch(app, /get_great_vault_progress/);
});

test('upgrade states have visible non-colour cues', async () => {
  const [html, script] = await Promise.all([
    readSite('upgrade-tracks.html'),
    readSite('gear-advisor.js')
  ]);
  for (const symbol of ['▲', '▬', '▼']) {
    assert.ok(html.includes(symbol), `legend includes ${symbol}`);
    assert.ok(script.includes(symbol), `rendered cells include ${symbol}`);
  }
});

test('character chooser starts neutral and remembers a visitor-selected realm', async () => {
  const [html, script] = await Promise.all([
    readSite('gear-advisor.html'),
    readSite('gear-advisor.js')
  ]);
  assert.match(html, /placeholder="Character name…"/);
  assert.doesNotMatch(html, /value="Bluehoof"/);
  assert.match(script, /realmSelect\.addEventListener\('change', function \(\) \{\s*rememberRealm\(regionSelect\.value, realmSelect\.value\);/);
});

test('gear-card launches upgrade details with a per-track planner', async () => {
  const script = await readSite('gear-advisor.js');
  assert.match(script, /'Upgrade details'/);
  assert.match(script, /function renderTrackPlanner/);
  assert.match(script, /'Track planner'/);
  assert.doesNotMatch(script, /'Season 2 upgrades'/);
});

test('character items link to Wowhead and load its supported tooltip renderer', async () => {
  const [html, script] = await Promise.all([
    readSite('gear-advisor.html'),
    readSite('gear-advisor.js')
  ]);
  assert.match(html, /wow\.zamimg\.com\/js\/tooltips\.js/);
  assert.match(script, /https:\/\/www\.wowhead\.com\/item=/);
  assert.match(script, /\$WowheadPower\?\.refreshLinks/);
});
