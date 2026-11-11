#!/usr/bin/env bash
# Copy Stripe keys from .env into SSM, where the checkout stack reads them:
#   STRIPE_<ENV>_SECRET_KEY     → /greenlove/<env>/stripe-secret-key
#   STRIPE_<ENV>_WEBHOOK_SECRET → /greenlove/<env>/stripe-webhook-secret   (skipped while blank)
#
#   ./scripts/put-stripe-secrets.sh dev
#   ./scripts/put-stripe-secrets.sh prod     # asks you to type "prod" first
#
# Values are never printed. Stored as SecureString. AWS profile: $AWS_PROFILE if set, otherwise jmplutouser2.
set -euo pipefail

ENV="${1:-}"
if [[ "$ENV" != "dev" && "$ENV" != "prod" ]]; then
  echo "usage: $0 dev|prod" >&2
  exit 1
fi
if [[ "$ENV" == "prod" ]]; then
  read -r -p "This writes the LIVE Stripe keys to prod SSM. Type 'prod' to continue: " answer
  [[ "$answer" == "prod" ]] || { echo "Cancelled." >&2; exit 1; }
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${AWS_PROFILE:-jmplutouser2}"
UPPER="$(echo "$ENV" | tr '[:lower:]' '[:upper:]')"

# Read one key from .env without sourcing it.
env_value() {
  { grep -E "^\s*$1=" "$ROOT/.env" || true; } | tail -1 | cut -d= -f2- | sed -E 's/^["'\'']|["'\'']\s*$//g' | tr -d '\r'
}

put() {
  local name="$1" value="$2" expect="$3"
  if [[ -z "$value" ]]; then
    echo "skip   $name (blank in .env)"
    return
  fi
  if [[ "$value" != "$expect"* ]]; then
    echo "error  $name: value should start with $expect" >&2
    exit 1
  fi
  aws ssm put-parameter --name "$name" --type SecureString --value "$value" --overwrite \
    --profile "$PROFILE" --region us-east-2 --query Version --output text >/dev/null
  echo "saved  $name"
}

if [[ "$ENV" == "dev" ]]; then KEY_PREFIX=sk_test_; else KEY_PREFIX=sk_live_; fi
put "/greenlove/$ENV/stripe-secret-key" "$(env_value "STRIPE_${UPPER}_SECRET_KEY")" "$KEY_PREFIX"
put "/greenlove/$ENV/stripe-webhook-secret" "$(env_value "STRIPE_${UPPER}_WEBHOOK_SECRET")" whsec_
