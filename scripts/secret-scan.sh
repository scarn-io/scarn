#!/usr/bin/env bash
# Scans a directory (no git history) for secrets with gitleaks, using the repo's
# .gitleaks.toml. Uses a local gitleaks binary when present, else the pinned
# docker image. Exits non-zero when anything is found.
#
#   bash scripts/secret-scan.sh <dir>
set -euo pipefail

GITLEAKS_VERSION="v8.30.1"

if [ $# -ne 1 ]; then
  echo "usage: $0 <dir>" >&2
  exit 2
fi

target="$(cd "$1" && pwd)"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config="$repo_root/.gitleaks.toml"

if command -v gitleaks >/dev/null 2>&1; then
  exec gitleaks dir "$target" \
    --config "$config" \
    --redact \
    --no-banner \
    --exit-code 1
fi

exec docker run --rm \
  -v "$target:/scan:ro" \
  -v "$config:/gitleaks.toml:ro" \
  "zricethezav/gitleaks:$GITLEAKS_VERSION" \
  dir /scan \
  --config /gitleaks.toml \
  --redact \
  --no-banner \
  --exit-code 1
