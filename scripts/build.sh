#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
IMAGE_TAG="${WOW_SITE_APP_IMAGE:-wow-site-app:dev-smoke}"

docker build --file "${APP_DIR}/Dockerfile.app" --tag "${IMAGE_TAG}" "${APP_DIR}"
printf 'Built %s\n' "${IMAGE_TAG}"
