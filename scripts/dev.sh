#!/usr/bin/env bash
# Immediate-feedback development server: Vite on 5173 and FastAPI on 8001.
# It always uses a local SQLite snapshot, never the live tracker database.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
FRONTEND_DIR="${APP_DIR}/frontend"
BACKEND_DIR="${APP_DIR}/backend"
VENV_DIR="${BACKEND_DIR}/.venv"
DEV_DATA_DIR="${APP_DIR}/.data/dev"
LIVE_DB="${WOW_SITE_TRACKER_DB:-/mnt/docker/state/app-data/wow-site-mcp/achievement_tracker.sqlite3}"
BIND_HOST="${DEV_BIND_HOST:-0.0.0.0}"
PUBLIC_HOST="${DEV_PUBLIC_HOST:-192.168.2.200}"
BACKEND_PORT="${DEV_BACKEND_PORT:-8001}"
FRONTEND_PORT="${DEV_FRONTEND_PORT:-5173}"

port_in_use() {
  ss -ltn "( sport = :$1 )" | grep -q LISTEN
}

next_free_port() {
  local candidate="$1"
  while port_in_use "${candidate}"; do
    candidate=$((candidate + 1))
  done
  printf '%s' "${candidate}"
}

test -r "${LIVE_DB}"
mkdir -p "${DEV_DATA_DIR}"
BACKEND_PORT="$(next_free_port "${BACKEND_PORT}")"
FRONTEND_PORT="$(next_free_port "${FRONTEND_PORT}")"

if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  python3 -m venv "${VENV_DIR}"
fi
if [[ ! -f "${VENV_DIR}/.deps-installed" || "${BACKEND_DIR}/requirements.txt" -nt "${VENV_DIR}/.deps-installed" ]]; then
  "${VENV_DIR}/bin/pip" install -r "${BACKEND_DIR}/requirements.txt"
  touch "${VENV_DIR}/.deps-installed"
fi
if [[ ! -d "${FRONTEND_DIR}/node_modules" ]]; then
  (cd "${FRONTEND_DIR}" && npm ci)
fi

echo "Running frontend lint and production build checks..."
(cd "${FRONTEND_DIR}" && npm run lint && npm run build)

# SQLite's backup API gives a consistent read while the MCP is writing.
python3 - "${LIVE_DB}" "${DEV_DATA_DIR}/achievement_tracker.sqlite3" <<'PY'
import sqlite3
import sys

source = sqlite3.connect(sys.argv[1])
destination = sqlite3.connect(sys.argv[2])
source.backup(destination)
destination.close()
source.close()
PY

export WOW_MCP_TRACKER_DB_PATH="${DEV_DATA_DIR}/achievement_tracker.sqlite3"
if [[ -z "${WOW_BLIZZARD_UPSTREAM_URL:-}" ]]; then
  adapter_ip="$(docker inspect --format '{{with index .NetworkSettings.Networks "config_wow_site_mcp_internal"}}{{.IPAddress}}{{end}}' wow-site 2>/dev/null || true)"
  export WOW_BLIZZARD_UPSTREAM_URL="${adapter_ip:+http://${adapter_ip}}"
else
  export WOW_BLIZZARD_UPSTREAM_URL
fi
if [[ -z "${WOW_BLIZZARD_UPSTREAM_URL}" ]]; then
  echo "Could not find the private wow-site adapter. Set WOW_BLIZZARD_UPSTREAM_URL to enable realm and Blizzard lookups." >&2
  export WOW_BLIZZARD_UPSTREAM_URL="http://127.0.0.1:9"
fi
export VITE_DEV_API_URL="http://127.0.0.1:${BACKEND_PORT}"

echo "Starting local API at http://${PUBLIC_HOST}:${BACKEND_PORT}"
(
  cd "${BACKEND_DIR}"
  PYTHONPATH="${APP_DIR}:${BACKEND_DIR}" "${VENV_DIR}/bin/uvicorn" app.main:app --reload --host "${BIND_HOST}" --port "${BACKEND_PORT}"
) >/tmp/wow-site-api.log 2>&1 &
backend_pid=$!
cleanup() {
  kill "${backend_pid}" >/dev/null 2>&1 || true
  wait "${backend_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Tracker: http://${PUBLIC_HOST}:${FRONTEND_PORT}/achievements"
echo "Upgrade tracks: http://${PUBLIC_HOST}:${FRONTEND_PORT}/tracks"
echo "API log: /tmp/wow-site-api.log"
echo "Tracker data: ${DEV_DATA_DIR}/achievement_tracker.sqlite3 (snapshot; refresh needs the private adapter)"
echo "Press Ctrl+C to stop."
(cd "${FRONTEND_DIR}" && npm run dev -- --host "${BIND_HOST}" --port "${FRONTEND_PORT}" --strictPort)
