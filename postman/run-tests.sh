#!/usr/bin/env bash
# Runs the GreenLove Farms Postman collection against an environment with Newman.
#
#   postman/run-tests.sh            # dev (default)
#   postman/run-tests.sh prod       # prod: GET requests only, writes are skipped
#   postman/run-tests.sh dev Carts  # only one folder (Auth runs first so tokens exist)
#
# Credentials come from the project .env (never committed):
#   POSTMAN_TEST_EMAIL / POSTMAN_TEST_PASSWORD    a confirmed customer account (required)
#   POSTMAN_ADMIN_EMAIL / POSTMAN_ADMIN_PASSWORD  a Staff/Admins account (optional; enables Catalog → Admin)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
ENV_NAME="${1:-dev}"
FOLDER="${2:-}"

# Read one key from .env without sourcing it (values may contain shell characters).
env_value() {
  [ -f "$ROOT/.env" ] || return 0
  { grep -E "^\s*$1=" "$ROOT/.env" || true; } | tail -1 | cut -d= -f2- | sed -E 's/^["'\'']|["'\'']\s*$//g' | tr -d '\r'
}

EMAIL="${POSTMAN_TEST_EMAIL:-$(env_value POSTMAN_TEST_EMAIL)}"
PASSWORD="${POSTMAN_TEST_PASSWORD:-$(env_value POSTMAN_TEST_PASSWORD)}"
ADMIN_EMAIL="${POSTMAN_ADMIN_EMAIL:-$(env_value POSTMAN_ADMIN_EMAIL)}"
ADMIN_PASSWORD="${POSTMAN_ADMIN_PASSWORD:-$(env_value POSTMAN_ADMIN_PASSWORD)}"

if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ]; then
  echo "Set POSTMAN_TEST_EMAIL and POSTMAN_TEST_PASSWORD in .env (a confirmed customer account)." >&2
  exit 1
fi
[ -n "$ADMIN_EMAIL" ] || echo "POSTMAN_ADMIN_EMAIL not set: skipping Catalog → Admin; cart tests use an existing live product."

FOLDER_ARGS=()
if [ -n "$FOLDER" ]; then
  FOLDER_ARGS=(--folder Auth --folder "$FOLDER")
  [ "$FOLDER" = Catalog ] && FOLDER_ARGS+=(--folder Teardown)
fi

mkdir -p "$HERE/reports"
npx --yes newman@6 run "$HERE/greenlove-farms.postman_collection.json" \
  --environment "$HERE/$ENV_NAME.postman_environment.json" \
  --env-var "automated=true" \
  --env-var "email=$EMAIL" \
  --env-var "password=$PASSWORD" \
  --env-var "adminEmail=$ADMIN_EMAIL" \
  --env-var "adminPassword=$ADMIN_PASSWORD" \
  ${FOLDER_ARGS[@]+"${FOLDER_ARGS[@]}"} \
  --reporters cli,junit \
  --reporter-junit-export "$HERE/reports/$ENV_NAME-$(date +%Y%m%d-%H%M%S).xml"
