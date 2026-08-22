# wow-site

`wow-site` is a personal World of Warcraft fan site served at
`https://wow.batserver.au`. The current application uses React/Vite with a
FastAPI persistence layer, plus a dependency-free private Node adapter for
Blizzard data and HammerLink decoding.

## Contents

- `site/index.html` — landing page and tool index
- `site/gear-advisor.html` — Blizzard-backed character gear tool
- `site/upgrade-tracks.html` — manual item-level and upgrade-track comparison
- `site/styles.css` — shared site theme
- `site/gear-advisor.css` / `site/gear-advisor.js` — gear advisor only
- `site/season-data.js` — shared season tracks and Blizzard bonus-ID mapping
- `site/assets/` — favicon and images
- `server.mjs` — static delivery, Blizzard API adapter and in-memory caches
- `frontend/` — the current React/Vite player application
- `backend/app/main.py` — authenticated browser API and static app host
- `achievement_tracker.py` — SQLite-backed user and character state
- `mcp_server.py` — official SDK v2 MCP surface backed by the same character API
- `Dockerfile.mcp` / `requirements-mcp.txt` — isolated MCP sidecar image
- `test/` — Node's built-in test suite

## Tools

### Character gear

Looks up a character's current equipment from Blizzard, sorts low item-level
slots first, shows each item's real current-season path, and labels guide-listed
BiS coverage separately as dated community advice.

### Upgrade tracks

Compares every rank on the season's upgrade tracks against a manually selected
item level. Each cell uses a symbol as well as colour, and each track reports
the first rank that beats the selected level and its crest cost.

Season numbers and Blizzard upgrade bonus IDs are patch-specific and live in
one place: `site/season-data.js`.

### HammerLink imports

The authenticated `/hammerlink` page validates an addon's `HL1:` export and
stores the latest snapshot per account and character. It shows equipped gear,
all occupied bag items with rich metadata and stats where the client provides
them, Great Vault activity, the current quest log and objective progress,
timestamps, and the active talent import. The browser API derives its user key from the trusted
Authelia/OAuth identity header; callers cannot supply or query another user ID.

The character lookup uses Blizzard's server-to-server client credentials flow.
Character equipment is cached in memory for five minutes. Simultaneous requests
for the same character are coalesced, and **Refresh now** can bypass the normal
cache after a one-minute cooldown. Blizzard media responses and the OAuth token
have their own longer-lived caches. Region-specific realm dropdowns come from
Blizzard's Realm Index API and are cached for one day. The selector starts with
a safe placeholder and a short useful option list, fills in during browser idle
time, and keeps the fetched list plus the visitor's last regional selection in
browser storage for immediate subsequent visits.

Current Season 2 tracks are resolved from Blizzard's item `bonus_list`, not
inferred from item level. Items without a known current-season bonus are shown
as legacy/unknown, while special Ascendant items get an explicit special state.
Independently of that provenance, every equipped slot compares its item level
with each Season 2 track and shows the first rank on that track that would be a
strict item-level upgrade. This detailed comparison is collapsed independently
on each item card so the current-path summary remains the primary view.

### MCP v2

The Streamable HTTP endpoint at `/mcp` uses the official Python SDK v2 and
exposes 26 canonical structured tools. Read-only tools cover character
equipment, profile, talents, achievements, realms, season rewards, class
guidance, gear audits, raid progress, observed meta builds, achievement
planning, and the authenticated user's private HammerLink inventory. Explicitly
labelled tracker tools can update only Consecrated Hammer's local private state;
they do not change Blizzard or in-game data. The legacy `hammerlink_import_list`
and `hammerlink_import_get` names remain compatibility aliases.

The authenticated React app documents setup at `/mcp-guide`, including current
ChatGPT and Claude connection steps, suggested prompts, and a collapsed tool
catalogue. Both clients use the public OAuth client ID `wow-mcp-shared` with no
client secret. Exact Great Vault state comes from `get_character_inventory`; the
older inferred `get_great_vault_progress` tool is not advertised.

The MCP sidecar forwards to the same guarded internal JSON routes used by the
site so player and agent traffic share caches, rate limits, validation, and
audit handling.

All tools call the existing internal JSON API, so they share its 60-request
per-minute caller limit, five-minute character cache, one-day realm cache,
request coalescing, and forced-refresh cooldown. Every tool call, including
validation, upstream, and rate-limit errors, is written as structured JSON to
container logs and `/data/queries.jsonl`. Audit records include the query,
outcome, duration, cache status, protocol/client metadata, and caller address;
they never contain Blizzard credentials or access tokens. The persistent file
is created with mode `0640` inside a `0750` state directory.

## Run locally

```bash
npm test
docker build -t wow-site .
docker run --rm --env-file /path/to/wow-site.env -p 8080:80 wow-site
```

Then open <http://localhost:8080>.

## Deployment

Production is defined in the infrastructure repository's canonical Compose file
at `/mnt/docker/infra/config/dockerconfigs/docker-compose.yml`, as the
`wow-site` and `wow-site-mcp` services. Both build from this directory, so a
full deploy is:

```bash
./scripts/deploy.sh
```

This rebuilds the private Blizzard adapter, the authenticated browser app, and
the MCP sidecar after validating the Compose configuration.

Traefik routes `wow.${DOMAIN_PRIMARY}` to the site on port 80 and gives the
path-specific `/mcp` route to the MCP sidecar on port 8767.

Production loads `${MOUNT_STATE}/secrets/wow-site.env`, containing:

```dotenv
BLIZZARD_CLIENT_ID=...
BLIZZARD_CLIENT_SECRET=...
```

Optional tuning variables are `CHARACTER_CACHE_TTL_SECONDS` (default `300`),
`REFRESH_COOLDOWN_SECONDS` (default `60`), `MEDIA_CACHE_TTL_SECONDS` (default
`86400`), `REALM_CACHE_TTL_SECONDS` (default `86400`), and
`BLIZZARD_TIMEOUT_MS` (default `10000`).

## Notes

- The browser application is protected by Authelia. The MCP endpoint uses its
  OAuth gateway; both paths hash the authenticated subject into the same
  account key before accessing private rows.
- Character definitions and Blizzard-confirmed facts may be shared, but user
  overlays, recent-character associations, labels, and HammerLink snapshots
  are scoped by that account key.
- `robots.txt` disallows crawling.
