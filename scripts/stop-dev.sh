#!/usr/bin/env bash
# Stops the local smoke-test container and removes only its validated snapshot.
set -euo pipefail

CONTAINER_NAME="${WOW_SITE_DEV_CONTAINER:-wow-site-app-dev-smoke}"

if ! docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  printf 'No %s container is running.\n' "${CONTAINER_NAME}"
  exit 0
fi

snapshot_dir="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "${CONTAINER_NAME}")"
docker rm --force "${CONTAINER_NAME}" >/dev/null
if [[ "${snapshot_dir}" == /tmp/wow-site-app-smoke.* ]]; then
  rm -rf -- "${snapshot_dir}"
fi
printf 'Stopped %s.\n' "${CONTAINER_NAME}"
