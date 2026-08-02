#!/usr/bin/env bash

set -euo pipefail

export OCR_SERVICE_TOKEN="${OCR_SERVICE_TOKEN:-restart-smoke-token-123}"
export JWT_SECRET="${JWT_SECRET:-restart-smoke-jwt-secret}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-restart-smoke-admin-password}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-resolve-weave-ocr-smoke-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}}"

compose=(
  docker compose
  -f docker-compose.yml
  -f ocr-worker/tests/docker-compose.restart-smoke.yml
)

cleanup() {
  local exit_code=$?
  if (( exit_code != 0 )); then
    "${compose[@]}" ps || true
    "${compose[@]}" logs --no-color ocr-worker || true
  fi
  "${compose[@]}" down --remove-orphans >/dev/null 2>&1 || true
  trap - EXIT
  exit "${exit_code}"
}
trap cleanup EXIT

health_status() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$1"
}

wait_for_initial_health() {
  local container_id=$1
  for _attempt in {1..90}; do
    if [[ "$(health_status "${container_id}")" == "healthy" ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

"${compose[@]}" up --build --detach ocr-worker
container_id=$("${compose[@]}" ps -q ocr-worker)
if [[ -z "${container_id}" ]]; then
  echo "OCR restart smoke did not create a container" >&2
  exit 1
fi

wait_for_initial_health "${container_id}"
restart_count_before=$(docker inspect --format '{{.RestartCount}}' "${container_id}")

http_status=$(curl --silent --show-error --output /tmp/ocr-restart-smoke-response.json --write-out '%{http_code}' --header "Authorization: Bearer ${OCR_SERVICE_TOKEN}" --header "Content-Type: application/json" --data-binary @ocr-worker/tests/restart-smoke-request.json http://127.0.0.1:8001/v1/extractions)

if [[ "${http_status}" != "504" ]]; then
  echo "Expected OCR timeout status 504, received ${http_status}" >&2
  exit 1
fi
if ! grep -Fq "OCR extraction timed out" /tmp/ocr-restart-smoke-response.json; then
  echo "OCR timeout response did not contain the expected detail" >&2
  exit 1
fi

for _attempt in {1..90}; do
  restart_count=$(docker inspect --format '{{.RestartCount}}' "${container_id}")
  if (( restart_count > restart_count_before )) && [[ "$(health_status "${container_id}")" == "healthy" ]]; then
    curl --silent --show-error --fail http://127.0.0.1:8001/health >/dev/null
    echo "OCR worker recovered after ${restart_count} Docker restart(s)"
    exit 0
  fi
  sleep 2
done

echo "OCR worker did not restart and recover within 180 seconds" >&2
exit 1
