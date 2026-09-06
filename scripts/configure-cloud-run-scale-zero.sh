#!/usr/bin/env bash
set -euo pipefail

project=""
region=""
service=""
apply="false"
confirm_target=""

usage() {
  cat <<'EOF'
Usage:
  scripts/configure-cloud-run-scale-zero.sh \
    --project PROJECT --region REGION --service SERVICE

Preview is the default and never changes Google Cloud. To apply, repeat the exact
project/region/service identity as a confirmation fence:

  scripts/configure-cloud-run-scale-zero.sh \
    --project PROJECT --region REGION --service SERVICE \
    --apply --confirm-target PROJECT/REGION/SERVICE
EOF
}

while (($# > 0)); do
  case "$1" in
    --project) project="${2:-}"; shift 2 ;;
    --region) region="${2:-}"; shift 2 ;;
    --service) service="${2:-}"; shift 2 ;;
    --confirm-target) confirm_target="${2:-}"; shift 2 ;;
    --apply) apply="true"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || { printf '%s\n' 'Invalid or missing --project.' >&2; exit 2; }
[[ "$region" =~ ^[a-z]+-[a-z]+[0-9]$ ]] || { printf '%s\n' 'Invalid or missing --region.' >&2; exit 2; }
[[ "$service" =~ ^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || { printf '%s\n' 'Invalid or missing --service.' >&2; exit 2; }

target="$project/$region/$service"
command=(
  gcloud run services update "$service"
  --project "$project"
  --region "$region"
  --platform managed
  --cpu-throttling
  --min 0
  --max 1
  --min-instances 0
  --max-instances 1
  --concurrency 256
  --timeout 3600s
  --cpu 1
  --memory 1Gi
  --cpu-boost
)

printf 'Target: %s\n' "$target"
printf 'Command:'
printf ' %q' "${command[@]}"
printf '\n'

if [[ "$apply" != "true" ]]; then
  printf '%s\n' 'PREVIEW ONLY: no Google Cloud settings were changed.'
  printf '%s\n' 'Add --apply and the exact --confirm-target value shown above to proceed.'
  exit 0
fi

if [[ "$confirm_target" != "$target" ]]; then
  printf 'Refusing mutation: --confirm-target must exactly equal %s\n' "$target" >&2
  exit 2
fi

"${command[@]}"
node "$(dirname "$0")/verify-cloud-run-scale-zero.mjs" \
  --project "$project" --region "$region" --service "$service"
