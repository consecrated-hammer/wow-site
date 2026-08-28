#!/usr/bin/env bash
# Build and release the WoW browser app, private Blizzard adapter, and MCP sidecar.
set -euo pipefail

INFRA_COMPOSE="/mnt/docker/infra/config/dockerconfigs/docker-compose.yml"

docker compose -p config -f "${INFRA_COMPOSE}" config --quiet
docker compose -p config -f "${INFRA_COMPOSE}" up -d --build wow-site wow-site-app wow-site-mcp

# Release patch facts are global and cached once. Populate missing entries
# gently inside the app container so the worker survives this deploy shell and
# stops automatically when that container is replaced.
docker exec -d wow-site-app python /app/scripts/sync-wowhead-achievement-releases.py \
  --db /data/achievement_tracker.sqlite3
echo "Achievement release metadata cache started in wow-site-app"
