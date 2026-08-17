# wow-site

`wow-site` is a personal World of Warcraft fan site served at
`https://wow.batserver.au`. It uses hand-authored HTML, CSS and JavaScript with
no framework or build step, plus a small dependency-free Node server for the
Blizzard character equipment API.

## Contents

- `site/index.html` — landing page and tool index
- `site/gear-advisor.html` — Blizzard-backed character gear tool
- `site/upgrade-tracks.html` — manual item-level and upgrade-track comparison
- `site/styles.css` — shared site theme
- `site/gear-advisor.css` / `site/gear-advisor.js` — gear advisor only
- `site/season-data.js` — shared season tracks and Blizzard bonus-ID mapping
- `site/assets/` — favicon and images
- `server.mjs` — static delivery, Blizzard API adapter and in-memory caches
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

The public Streamable HTTP endpoint at `/mcp` uses the official Python SDK v2
and exposes eleven read-only structured tools, covering character equipment,
profile, talents, achievements, realms, season rewards, class guidance, gear
audits, Great Vault progress, raid progress, and observed meta builds.

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
docker compose -p config -f /mnt/docker/infra/config/dockerconfigs/docker-compose.yml \
  up -d --build wow-site wow-site-mcp
```

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

- The site is currently **public** — no authentication. `*.batserver.au`
  resolves to the WAN address, so anything served here is internet-reachable.
- The public lookup neither saves nor presets a personal character. Persistent
  personal character state belongs under the reserved `/my/` URL prefix, which
  remains empty and can be put behind auth later.
- `robots.txt` disallows crawling.
