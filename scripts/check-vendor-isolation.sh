#!/usr/bin/env bash
# scripts/check-vendor-isolation.sh — mechanical enforcement of ADR-002
# § Decision: "no vendor SDK is imported outside its adapter; this is a
# hard project rule, enforceable by lint/dependency rules."
#
# This check is the lint/dependency rule. It runs as part of `make lint`
# (and standalone via `make check-vendor-isolation`) and fails non-zero
# on any violation, with a path:line citation per offending line.
#
# Rules are declarative — one per vendor primitive. Each rule pins:
#   - a `pattern` (extended regex matched against TypeScript source lines),
#   - an `allowed` path glob (paths permitted to contain the pattern).
#
# A new adapter adds one rule below. When all rules pass, the script
# prints a single summary line and exits 0.

set -euo pipefail

LOG_PREFIX="[check-vendor-isolation]"
violations=0

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "${ROOT}"

SEARCH_PATHS=(apps packages evals scripts)

# Filter active search paths to those that exist (defensive against repo
# layout drift).
EXISTING_PATHS=()
for path in "${SEARCH_PATHS[@]}"; do
  if [ -d "${path}" ]; then
    EXISTING_PATHS+=("${path}")
  fi
done

# check_rule <label> <pattern> <allowed-path-prefix-regex> [<search-path>...]
#
# `pattern` is a grep -E regex applied to *.ts files.
# `allowed-path-prefix-regex` is a grep -E regex matched against the
#   `path:line:` prefix of each hit. Hits whose path matches the regex
#   are filtered out; the remainder are violations.
# `search-path` (optional, repeatable) overrides the default search roots
#   when a rule should only fire within a sub-tree (e.g. fetch-isolation
#   applies to packages/providers/ only — dev-loop tooling under scripts/
#   may call fetch freely).
check_rule() {
  local label="$1"
  local pattern="$2"
  local allowed="$3"
  shift 3

  local search_paths=()
  if [ "$#" -gt 0 ]; then
    search_paths=("$@")
  else
    search_paths=("${EXISTING_PATHS[@]}")
  fi

  # Filter requested paths to those that exist.
  local active_paths=()
  for p in "${search_paths[@]}"; do
    if [ -d "${p}" ]; then
      active_paths+=("${p}")
    fi
  done
  if [ "${#active_paths[@]}" -eq 0 ]; then
    return 0
  fi

  local hits
  hits="$(
    grep -RnE \
      --include='*.ts' \
      --exclude-dir=node_modules \
      --exclude-dir=dist \
      --exclude-dir=build \
      --exclude-dir=coverage \
      "${pattern}" "${active_paths[@]}" 2>/dev/null || true
  )"

  if [ -z "${hits}" ]; then
    return 0
  fi

  local violators
  violators="$(printf '%s\n' "${hits}" | grep -vE "${allowed}" || true)"

  if [ -n "${violators}" ]; then
    printf '%s VIOLATION: %s\n' "${LOG_PREFIX}" "${label}"
    printf '%s\n' "${violators}" | sed 's/^/    /'
    violations=$((violations + 1))
  fi
}

# Rule 1 — Anthropic SDK.
# `@anthropic-ai/sdk` runtime imports are confined to the Anthropic
# adapter's network-call site. Per ADR-002 § Consequences-now and
# packages/providers/anthropic/src/client.ts:1-11.
check_rule \
  "@anthropic-ai/sdk import outside packages/providers/anthropic/src/client.ts" \
  "from '@anthropic-ai/sdk'" \
  "^packages/providers/anthropic/src/client\.ts:"

# Rule 2 — Octokit (GitHub) SDK.
# `@octokit/*` runtime imports are confined to the github
# installation-auth module. Per packages/github/src/installation-auth/auth.ts:13-18
# and the original commit's stated grep rule.
check_rule \
  "@octokit/* import outside packages/github/src/installation-auth/" \
  "from '@octokit/" \
  "^packages/github/src/installation-auth/"

# Rule 3 — Copilot network primitive.
# The Copilot adapter is fetch-based (no SDK dep), so the network primitive
# itself is the boundary. Within `packages/providers/`, `fetch(` is
# confined to `*/src/client.ts`. Outside `packages/providers/` the rule
# does not apply (dev-loop tooling under `scripts/`, tests, and apps may
# call fetch freely). Per ADR-004 § Trade-offs and
# packages/providers/copilot/src/client.ts.
check_rule \
  "fetch( call inside packages/providers/ outside an adapter client.ts" \
  "fetch\(" \
  "^packages/providers/[^/]+/src/client\.ts:" \
  "packages/providers"

if [ "${violations}" -gt 0 ]; then
  printf '%s %d rule(s) violated.\n' "${LOG_PREFIX}" "${violations}" >&2
  exit 1
fi

printf '%s All %d rules pass.\n' "${LOG_PREFIX}" 3
