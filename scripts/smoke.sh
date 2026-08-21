#!/usr/bin/env bash
# Production-image smoke launcher. Unlike dev.sh, this uses the built app.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER_NAME="${WOW_SITE_DEV_CONTAINER:-wow-site-app-dev-smoke}"
IMAGE_TAG="${WOW_SITE_APP_IMAGE:-wow-site-app:dev-smoke}"
BIND_HOST="${WOW_SITE_DEV_HOST:-192.168.2.200}"
PORT="${WOW_SITE_DEV_PORT:-18001}"
LIVE_DB="${WOW_SITE_TRACKER_DB:-/mnt/docker/state/app-data/wow-site-mcp/achievement_tracker.sqlite3}"
PRIMARY_NETWORK="${WOW_SITE_DEV_PRIMARY_NETWORK:-traefik_proxy}"
INTERNAL_NETWORK="${WOW_SITE_DEV_INTERNAL_NETWORK:-config_wow_site_mcp_internal}"

for network in "${PRIMARY_NETWORK}" "${INTERNAL_NETWORK}"; do docker network inspect "${network}" >/dev/null; done
test -r "${LIVE_DB}"
if docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then "${SCRIPT_DIR}/stop-dev.sh"; fi
"${SCRIPT_DIR}/build.sh"
snapshot_dir="$(mktemp -d /tmp/wow-site-app-smoke.XXXXXX)"
trap 'rm -rf -- "${snapshot_dir}"' ERR
python3 - "${LIVE_DB}" "${snapshot_dir}/achievement_tracker.sqlite3" <<'PY'
import sqlite3, sys
source = sqlite3.connect(sys.argv[1]); destination = sqlite3.connect(sys.argv[2])
source.backup(destination); destination.close(); source.close()
PY
docker run --detach --name "${CONTAINER_NAME}" --network "${PRIMARY_NETWORK}" --publish "${BIND_HOST}:${PORT}:8001" --volume "${snapshot_dir}:/data" --env WOW_BLIZZARD_UPSTREAM_URL=http://wow-site "${IMAGE_TAG}" >/dev/null
docker network connect "${INTERNAL_NETWORK}" "${CONTAINER_NAME}"
trap - ERR
printf 'Container smoke test: http://%s:%s/achievements\n' "${BIND_HOST}" "${PORT}"
