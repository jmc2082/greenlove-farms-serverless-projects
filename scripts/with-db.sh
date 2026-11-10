#!/usr/bin/env bash
# Run a command against the dev or prod database.
# The connection string comes from SSM (/greenlove/<env>/mongodb-uri), the same place the
# deployed functions read it, so local tools and the API always agree on which database is which.
#
#   ./scripts/with-db.sh dev  -- npm --prefix auth run indexes
#   ./scripts/with-db.sh prod -- npm --prefix catalog run indexes   # asks you to type "prod" first
#
# Sets MONGODB_URI and MONGODB_DB_NAME (greenlove_dev or greenlove_prod) for the command only.
# AWS profile: $AWS_PROFILE if set, otherwise jmplutouser2.
set -euo pipefail

ENV="${1:-}"
if [[ "$ENV" != "dev" && "$ENV" != "prod" ]]; then
  echo "usage: $0 dev|prod -- <command ...>" >&2
  exit 1
fi
shift
[[ "${1:-}" == "--" ]] && shift
if [[ $# -eq 0 ]]; then
  echo "usage: $0 dev|prod -- <command ...>" >&2
  exit 1
fi

if [[ "$ENV" == "prod" && "${CONFIRM_PROD:-}" != "yes" ]]; then
  read -r -p "This runs against PRODUCTION (greenlove_prod). Type 'prod' to continue: " answer
  [[ "$answer" == "prod" ]] || { echo "Cancelled." >&2; exit 1; }
fi

PROFILE="${AWS_PROFILE:-jmplutouser2}"
MONGODB_URI="$(aws ssm get-parameter --profile "$PROFILE" --region us-east-2 \
  --name "/greenlove/$ENV/mongodb-uri" --with-decryption \
  --query Parameter.Value --output text)"
export MONGODB_URI
export MONGODB_DB_NAME="greenlove_$ENV"

echo "==> $MONGODB_DB_NAME" >&2
exec "$@"
