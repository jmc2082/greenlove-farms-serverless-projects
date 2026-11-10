#!/usr/bin/env bash
# Build and deploy stacks in dependency order.
#   ./deploy.sh dev                 # all app stacks to dev
#   ./deploy.sh prod catalog carts  # only the named stacks to prod
# domain-infra is shared by both environments and deployed only when named explicitly.
# AWS profile: samconfig.toml names jm_ubuntu_thinkpad_user. Set AWS_PROFILE to use another one:
#   AWS_PROFILE=jmplutouser2 ./deploy.sh prod catalog carts
set -euo pipefail

ENV="${1:-}"
if [[ "$ENV" != "dev" && "$ENV" != "prod" ]]; then
  echo "usage: $0 dev|prod [stack ...]" >&2
  exit 1
fi
shift

ORDER=(domain-infra shared-infra auth catalog carts)
REQUESTED=("$@")
[[ ${#REQUESTED[@]} -eq 0 ]] && REQUESTED=(shared-infra auth catalog carts)

for name in "${REQUESTED[@]}"; do
  [[ " ${ORDER[*]} " == *" $name "* ]] || { echo "unknown stack: $name" >&2; exit 1; }
done

PROFILE_ARGS=()
if [[ -n "${AWS_PROFILE:-}" ]]; then PROFILE_ARGS=(--profile "$AWS_PROFILE"); fi

cd "$(dirname "$0")"
for stack in "${ORDER[@]}"; do
  [[ " ${REQUESTED[*]} " == *" $stack "* ]] || continue
  echo "==> $stack ($ENV)"
  if [[ "$stack" == "domain-infra" ]]; then
    (cd "$stack" && sam build && sam deploy ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"})
  else
    (cd "$stack" && sam build && sam deploy --config-env "$ENV" ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"})
  fi
done
