#!/usr/bin/env bash
# deploy/install.sh — interactive production installer for prisma-review-bot.
#
# Bash 3.2-compatible (macOS default shell). No associative arrays, no mapfile,
# no ${var^^}/${var,,}, no &>>.
#
# Usage:
#   ./deploy/install.sh              # interactive
#   ./deploy/install.sh --yes        # non-interactive; reads values from env vars
#   ./deploy/install.sh --help
#
# stdout: ONLY the final webhook URL + secret summary block (machine-readable).
# stderr: ALL prompts, progress, warnings, and diagnostic output.
#
# House rules follow scripts/smoke.sh:
#   set -euo pipefail; log/fail helpers to stderr; explicit variable init.

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() {
  printf '[install] %s\n' "$*" >&2
}

warn() {
  printf '[install] WARNING: %s\n' "$*" >&2
}

fail() {
  printf '[install] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: deploy/install.sh [OPTIONS]

Interactive installer for prisma-review-bot production deployment.

Options:
  --yes     Non-interactive mode. Every prompt is fulfilled from its
            corresponding environment variable (see list below).
            Exits with an error listing any missing variables.
  --help    Show this message and exit.

Non-interactive environment variables (--yes mode):
  PRISMA_DOMAIN                 Public domain (no scheme, no slash)
  PRISMA_ACME_EMAIL             ACME/Let's Encrypt registration email
  GITHUB_APP_ID                 Numeric GitHub App ID
  GITHUB_APP_SLUG               GitHub App slug
  PRISMA_PEM_PATH               Path to the GitHub App .pem private key file
  PRISMA_PROVIDER_CHOICE        Provider: anthropic | copilot | openai
  ANTHROPIC_API_KEY             (when PRISMA_PROVIDER_CHOICE=anthropic)
  COPILOT_API_KEY               (when PRISMA_PROVIDER_CHOICE=copilot)
  OPENAI_API_KEY                (when PRISMA_PROVIDER_CHOICE=openai)
  OTEL_EXPORTER_OTLP_ENDPOINT  Optional; leave unset to disable export

Special:
  PRISMA_FORCE_ENV_OVERWRITE=1  Allow --yes to overwrite an existing deploy/.env
EOF
  exit 0
}

# ---------------------------------------------------------------------------
# Arg parse
# ---------------------------------------------------------------------------

YES_MODE=0

for arg in "$@"; do
  case "${arg}" in
    --yes)  YES_MODE=1 ;;
    --help) usage ;;
    *)      fail "Unknown argument: ${arg}. Use --help for usage." ;;
  esac
done

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

log "Running preflight checks..."

# Locate repo root robustly relative to this script's location.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"
log "Repo root: ${REPO_ROOT}"

# Verify we actually look like the expected repo root.
if [ ! -f "${REPO_ROOT}/deploy/.env.prod.example" ]; then
  fail "deploy/.env.prod.example not found in ${REPO_ROOT}. " \
       "Run this script from the repo root or from deploy/."
fi

# openssl is required (used to generate GITHUB_APP_WEBHOOK_SECRET).
if ! command -v openssl >/dev/null 2>&1; then
  fail "openssl is required but not found. Install OpenSSL and retry."
fi

# docker must be present.
if ! command -v docker >/dev/null 2>&1; then
  fail "docker is required but not found. Install Docker Desktop (https://docs.docker.com/get-docker/) and retry."
fi

# docker compose v2 (plugin form) must be available.
if ! docker compose version >/dev/null 2>&1; then
  fail "'docker compose' v2 plugin is required but not found. " \
       "Upgrade Docker Desktop or install the compose plugin: https://docs.docker.com/compose/install/"
fi

log "docker and docker compose v2 detected."

# Warn-only port checks (never fail the install).
_port_in_use() {
  local port="$1"
  if command -v nc >/dev/null 2>&1; then
    nc -z localhost "${port}" >/dev/null 2>&1
    return $?
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  return 1
}

if _port_in_use 80 2>/dev/null; then
  warn "Port 80 appears to be in use. Traefik may fail to bind. Check for conflicting services."
fi
if _port_in_use 443 2>/dev/null; then
  warn "Port 443 appears to be in use. Traefik may fail to bind. Check for conflicting services."
fi

# Preflight complete; domain DNS check is done after we collect the domain.

# ---------------------------------------------------------------------------
# Prompt helpers
# ---------------------------------------------------------------------------

# _prompt VAR QUESTION [DEFAULT]
# Reads a value from the user (via /dev/tty to survive piped stdin).
# In --yes mode the value is taken from the env var; aborts if not set.
# Sets the named variable in the caller's scope (eval).
# Pass a fourth argument "optional" to allow empty values in --yes mode.
_prompt() {
  local var_name="$1"
  local question="$2"
  local default_val="${3:-}"
  local optional="${4:-}"
  local value=""

  if [ "${YES_MODE}" -eq 1 ]; then
    # In --yes mode, value must come from env (unless optional).
    value="$(eval "printf '%s' \"\${${var_name}:-}\"")"
    if [ -z "${value}" ] && [ "${optional}" != "optional" ]; then
      fail "--yes mode: required variable ${var_name} is not set."
    fi
  else
    if [ -n "${default_val}" ]; then
      printf '[install] %s [%s]: ' "${question}" "${default_val}" >&2
    else
      printf '[install] %s: ' "${question}" >&2
    fi
    # Read from /dev/tty so piped invocations still get a tty prompt.
    if read -r value </dev/tty 2>/dev/null || true; then
      : # got a value (may be empty)
    else
      value=""
    fi
    if [ -z "${value}" ] && [ -n "${default_val}" ]; then
      value="${default_val}"
    fi
  fi

  # Export into caller scope. We use printf %q for quoting safety, then eval.
  # printf %q produces a shell-escaped string safe for eval even with special chars.
  local quoted_value
  quoted_value="$(printf '%q' "${value}")"
  eval "${var_name}=${quoted_value}"
}

# _prompt_secret VAR QUESTION
# Like _prompt but uses read -s (no echo) for tty; --yes still reads env.
_prompt_secret() {
  local var_name="$1"
  local question="$2"
  local value=""

  if [ "${YES_MODE}" -eq 1 ]; then
    value="$(eval "printf '%s' \"\${${var_name}:-}\"")"
    if [ -z "${value}" ]; then
      fail "--yes mode: required variable ${var_name} is not set."
    fi
  else
    printf '[install] %s: ' "${question}" >&2
    # read -s suppresses echo; fall back gracefully if not a tty.
    if read -rs value </dev/tty 2>/dev/null || true; then
      printf '\n' >&2
    else
      value=""
    fi
  fi

  local quoted_value
  quoted_value="$(printf '%q' "${value}")"
  eval "${var_name}=${quoted_value}"
}

# ---------------------------------------------------------------------------
# Collect inputs
# ---------------------------------------------------------------------------

log "Collecting deployment configuration..."

# 1. Domain
_prompt PRISMA_DOMAIN "Public domain name (e.g. prisma-bot.example.com, no https://)"
# Validate: non-empty, no scheme, no slash.
if [ -z "${PRISMA_DOMAIN}" ]; then
  fail "PRISMA_DOMAIN must not be empty."
fi
case "${PRISMA_DOMAIN}" in
  http://*|https://*)
    fail "PRISMA_DOMAIN must not include a scheme (https://). Got: ${PRISMA_DOMAIN}" ;;
esac
case "${PRISMA_DOMAIN}" in
  */*)
    fail "PRISMA_DOMAIN must not contain a slash. Got: ${PRISMA_DOMAIN}" ;;
esac
log "Domain: ${PRISMA_DOMAIN}"

# Warn-only DNS check (best-effort; never fail the install).
_dns_resolves_local() {
  local domain="$1"
  local result=""
  if command -v dig >/dev/null 2>&1; then
    result="$(dig +short "${domain}" 2>/dev/null | head -1 || true)"
  elif command -v nslookup >/dev/null 2>&1; then
    result="$(nslookup "${domain}" 2>/dev/null | awk '/^Address: / { print $2; exit }' || true)"
  fi
  # Check if it resolves to a loopback or private IP (best-effort heuristic).
  case "${result}" in
    127.*|10.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|192.168.*|::1)
      return 0 ;;
  esac
  # Non-empty but not local — just a warn situation.
  return 1
}

if ! _dns_resolves_local "${PRISMA_DOMAIN}" 2>/dev/null; then
  warn "Could not verify that ${PRISMA_DOMAIN} resolves to a local interface IP. " \
       "Ensure DNS is configured before the ACME challenge fires."
fi

# 2. ACME email
_prompt PRISMA_ACME_EMAIL "ACME/Let's Encrypt email address"
case "${PRISMA_ACME_EMAIL}" in
  *@*)
    : ;; # basic @ check passes
  *)
    fail "PRISMA_ACME_EMAIL does not look like an email address: ${PRISMA_ACME_EMAIL}" ;;
esac
log "ACME email: ${PRISMA_ACME_EMAIL}"

# 3. GitHub App ID (numeric)
_prompt GITHUB_APP_ID "GitHub App ID (numeric)"
case "${GITHUB_APP_ID}" in
  ''|*[!0-9]*)
    fail "GITHUB_APP_ID must be a non-empty numeric value. Got: ${GITHUB_APP_ID}" ;;
esac
log "GitHub App ID: ${GITHUB_APP_ID}"

# 4. GitHub App slug
_prompt GITHUB_APP_SLUG "GitHub App slug (e.g. prisma-review-bot)"
if [ -z "${GITHUB_APP_SLUG}" ]; then
  fail "GITHUB_APP_SLUG must not be empty."
fi
log "GitHub App slug: ${GITHUB_APP_SLUG}"

# 5. Private key PEM file path
_prompt PRISMA_PEM_PATH "Path to GitHub App private key (.pem file)"
if [ -z "${PRISMA_PEM_PATH}" ]; then
  fail "Private key path must not be empty."
fi
if [ ! -f "${PRISMA_PEM_PATH}" ]; then
  fail "Private key file not found: ${PRISMA_PEM_PATH}"
fi
PEM_CONTENTS="$(cat "${PRISMA_PEM_PATH}")"
# Validate it looks like a PEM (begins with -----BEGIN).
case "${PEM_CONTENTS}" in
  '-----BEGIN'*)
    : ;; # valid PEM header
  *)
    fail "File at ${PRISMA_PEM_PATH} does not appear to be a PEM file (must start with -----BEGIN)." ;;
esac
# Encode as single-line with literal \n so compose env_file can handle it.
# Replace actual newlines with the two-character sequence \n.
# The consuming SecretSource reads process env; the single-line encoding is
# a .env file format requirement (env_file does not support multi-line values).
GITHUB_APP_PRIVATE_KEY="$(printf '%s' "${PEM_CONTENTS}" | tr '\n' '\\' | sed 's/\\/\\n/g')"
# The above produces trailing \n; strip exactly one trailing literal \n pair.
GITHUB_APP_PRIVATE_KEY="${GITHUB_APP_PRIVATE_KEY%\\n}"
log "Private key loaded and encoded (single-line \\n escapes)."

# 6. Provider selection
if [ "${YES_MODE}" -eq 1 ]; then
  # In --yes mode: PRISMA_PROVIDER_CHOICE selects the provider.
  PRISMA_PROVIDER_CHOICE="${PRISMA_PROVIDER_CHOICE:-}"
  if [ -z "${PRISMA_PROVIDER_CHOICE}" ]; then
    fail "--yes mode: PRISMA_PROVIDER_CHOICE must be set to: anthropic | copilot | openai"
  fi
else
  printf '[install] Select AI provider:\n' >&2
  printf '  1) Anthropic\n' >&2
  printf '  2) GitHub Copilot\n' >&2
  printf '  3) OpenAI\n' >&2
  printf '[install] Choice [1/2/3]: ' >&2
  PRISMA_PROVIDER_CHOICE_NUM=""
  if read -r PRISMA_PROVIDER_CHOICE_NUM </dev/tty 2>/dev/null || true; then
    :
  fi
  case "${PRISMA_PROVIDER_CHOICE_NUM}" in
    1) PRISMA_PROVIDER_CHOICE="anthropic" ;;
    2) PRISMA_PROVIDER_CHOICE="copilot" ;;
    3) PRISMA_PROVIDER_CHOICE="openai" ;;
    *) fail "Invalid provider choice: '${PRISMA_PROVIDER_CHOICE_NUM}'. Choose 1, 2, or 3." ;;
  esac
fi

ANTHROPIC_API_KEY=""
COPILOT_API_KEY=""
OPENAI_API_KEY=""

case "${PRISMA_PROVIDER_CHOICE}" in
  anthropic)
    _prompt_secret ANTHROPIC_API_KEY "Anthropic API key (input hidden)"
    if [ -z "${ANTHROPIC_API_KEY}" ]; then
      fail "ANTHROPIC_API_KEY must not be empty."
    fi
    log "Provider: Anthropic."
    ;;
  copilot)
    _prompt_secret COPILOT_API_KEY "GitHub Copilot API key / PAT (input hidden)"
    if [ -z "${COPILOT_API_KEY}" ]; then
      fail "COPILOT_API_KEY must not be empty."
    fi
    log "Provider: GitHub Copilot."
    ;;
  openai)
    _prompt_secret OPENAI_API_KEY "OpenAI API key (input hidden)"
    if [ -z "${OPENAI_API_KEY}" ]; then
      fail "OPENAI_API_KEY must not be empty."
    fi
    log "Provider: OpenAI."
    ;;
  *)
    fail "Unknown provider choice: ${PRISMA_PROVIDER_CHOICE}. Must be: anthropic | copilot | openai"
    ;;
esac

# 7. Optional OTLP endpoint (empty is valid)
_prompt OTEL_EXPORTER_OTLP_ENDPOINT "OTLP endpoint URL (press Enter to skip / disable telemetry export)" "" "optional"
if [ -n "${OTEL_EXPORTER_OTLP_ENDPOINT}" ]; then
  log "OTLP endpoint: ${OTEL_EXPORTER_OTLP_ENDPOINT}"
else
  log "OTLP endpoint: (disabled)"
fi

# ---------------------------------------------------------------------------
# Generate webhook secret
# ---------------------------------------------------------------------------

log "Generating GITHUB_APP_WEBHOOK_SECRET via openssl..."
GITHUB_APP_WEBHOOK_SECRET="$(openssl rand -hex 32)"
log "Webhook secret generated (32 bytes, hex-encoded)."

# ---------------------------------------------------------------------------
# Write deploy/.env
# ---------------------------------------------------------------------------

ENV_FILE="${REPO_ROOT}/deploy/.env"

# No-clobber check.
if [ -f "${ENV_FILE}" ]; then
  if [ "${YES_MODE}" -eq 1 ]; then
    if [ "${PRISMA_FORCE_ENV_OVERWRITE:-0}" != "1" ]; then
      fail "deploy/.env already exists. In --yes mode, set PRISMA_FORCE_ENV_OVERWRITE=1 to overwrite."
    fi
    warn "PRISMA_FORCE_ENV_OVERWRITE=1 set; overwriting existing deploy/.env."
  else
    printf '[install] WARNING: deploy/.env already exists.\n' >&2
    printf '[install] Overwrite? [y/N]: ' >&2
    OVERWRITE_CONFIRM=""
    if read -r OVERWRITE_CONFIRM </dev/tty 2>/dev/null || true; then
      :
    fi
    case "${OVERWRITE_CONFIRM}" in
      y|Y|yes|YES)
        warn "Overwriting existing deploy/.env as requested." ;;
      *)
        fail "Aborted. Existing deploy/.env was not modified." ;;
    esac
  fi
fi

log "Writing deploy/.env from deploy/.env.prod.example..."

# Build the env file by substituting known values into the template,
# keeping defaults for everything else.
# We use a line-by-line replacement approach compatible with bash 3.2 and
# POSIX sed (no -i '' portability issues — we write to a temp file first).

TMP_ENV="$(mktemp)"

# sed expression list: substitute placeholder= lines with populated values.
# Each line in .env.prod.example has the form KEY= or KEY=default.
# We only replace lines that match exactly ^KEY= to avoid partial matches.
# Single-line values that may contain special characters are escaped for sed.
#
# We use Python-free approach: write the file line by line via a while loop
# reading from the template.

_escape_sed_replace() {
  # Escape & and \ in the replacement string for sed's s command.
  # Also escape / since we use / as delimiter.
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/&/\\&/g; s|/|\\/|g'
}

ESCAPED_DOMAIN="$(_escape_sed_replace "${PRISMA_DOMAIN}")"
ESCAPED_ACME_EMAIL="$(_escape_sed_replace "${PRISMA_ACME_EMAIL}")"
ESCAPED_GITHUB_APP_ID="$(_escape_sed_replace "${GITHUB_APP_ID}")"
ESCAPED_GITHUB_APP_SLUG="$(_escape_sed_replace "${GITHUB_APP_SLUG}")"
ESCAPED_PRIVATE_KEY="$(_escape_sed_replace "${GITHUB_APP_PRIVATE_KEY}")"
ESCAPED_WEBHOOK_SECRET="$(_escape_sed_replace "${GITHUB_APP_WEBHOOK_SECRET}")"
ESCAPED_ANTHROPIC="$(_escape_sed_replace "${ANTHROPIC_API_KEY}")"
ESCAPED_COPILOT="$(_escape_sed_replace "${COPILOT_API_KEY}")"
ESCAPED_OPENAI="$(_escape_sed_replace "${OPENAI_API_KEY}")"
ESCAPED_OTLP="$(_escape_sed_replace "${OTEL_EXPORTER_OTLP_ENDPOINT}")"

sed \
  -e "s/^PRISMA_DOMAIN=.*/PRISMA_DOMAIN=${ESCAPED_DOMAIN}/" \
  -e "s/^PRISMA_ACME_EMAIL=.*/PRISMA_ACME_EMAIL=${ESCAPED_ACME_EMAIL}/" \
  -e "s/^GITHUB_APP_ID=.*/GITHUB_APP_ID=${ESCAPED_GITHUB_APP_ID}/" \
  -e "s/^GITHUB_APP_SLUG=.*/GITHUB_APP_SLUG=${ESCAPED_GITHUB_APP_SLUG}/" \
  -e "s/^GITHUB_APP_PRIVATE_KEY=.*/GITHUB_APP_PRIVATE_KEY=${ESCAPED_PRIVATE_KEY}/" \
  -e "s/^GITHUB_APP_WEBHOOK_SECRET=.*/GITHUB_APP_WEBHOOK_SECRET=${ESCAPED_WEBHOOK_SECRET}/" \
  -e "s/^ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=${ESCAPED_ANTHROPIC}/" \
  -e "s/^COPILOT_API_KEY=.*/COPILOT_API_KEY=${ESCAPED_COPILOT}/" \
  -e "s/^OPENAI_API_KEY=.*/OPENAI_API_KEY=${ESCAPED_OPENAI}/" \
  -e "s/^OTEL_EXPORTER_OTLP_ENDPOINT=.*/OTEL_EXPORTER_OTLP_ENDPOINT=${ESCAPED_OTLP}/" \
  "${REPO_ROOT}/deploy/.env.prod.example" > "${TMP_ENV}"

mv "${TMP_ENV}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
log "deploy/.env written and chmod 600 applied."

# ---------------------------------------------------------------------------
# ACME email substitution in traefik.yml (idempotent)
# ---------------------------------------------------------------------------

TRAEFIK_YML="${REPO_ROOT}/deploy/traefik/traefik.yml"

if [ -f "${TRAEFIK_YML}" ]; then
  # Idempotent: detect if already substituted (no ACME_EMAIL_PLACEHOLDER present).
  if grep -q 'ACME_EMAIL_PLACEHOLDER' "${TRAEFIK_YML}" 2>/dev/null; then
    log "Substituting ACME_EMAIL_PLACEHOLDER in deploy/traefik/traefik.yml..."
    TMP_TRAEFIK="$(mktemp)"
    ESCAPED_ACME_EMAIL_TRAEFIK="$(_escape_sed_replace "${PRISMA_ACME_EMAIL}")"
    sed "s/ACME_EMAIL_PLACEHOLDER/${ESCAPED_ACME_EMAIL_TRAEFIK}/g" "${TRAEFIK_YML}" > "${TMP_TRAEFIK}"
    mv "${TMP_TRAEFIK}" "${TRAEFIK_YML}"
    log "ACME email substituted in traefik.yml."
  else
    log "traefik.yml: ACME_EMAIL_PLACEHOLDER already substituted (idempotent, skipping)."
  fi
else
  warn "deploy/traefik/traefik.yml not found — ACME email substitution skipped. " \
       "Ensure the traefik track has committed its files before the ACME challenge fires."
fi

# Create acme.json if absent (Let's Encrypt certificate storage).
ACME_JSON="${REPO_ROOT}/deploy/acme.json"
if [ ! -f "${ACME_JSON}" ]; then
  touch "${ACME_JSON}"
  chmod 600 "${ACME_JSON}"
  log "deploy/acme.json created and chmod 600 applied."
else
  log "deploy/acme.json already exists (skipping creation)."
fi

# ---------------------------------------------------------------------------
# Bring the stack up
# ---------------------------------------------------------------------------

log "Starting production stack via docker compose..."
docker compose \
  -f "${REPO_ROOT}/deploy/docker-compose.prod.yml" \
  --env-file "${ENV_FILE}" \
  up -d
log "docker compose up -d completed."

# ---------------------------------------------------------------------------
# Poll /healthz/live (S6 contract)
# ---------------------------------------------------------------------------

HEALTH_URL="https://${PRISMA_DOMAIN}/healthz/live"
HEALTH_DEADLINE=120
HEALTH_ELAPSED=0
HEALTH_SLEEP=5
HEALTH_OK=0

log "Polling ${HEALTH_URL} (deadline ${HEALTH_DEADLINE}s)..."

while [ "${HEALTH_ELAPSED}" -lt "${HEALTH_DEADLINE}" ]; do
  # Primary check via normal HTTPS.
  HTTP_STATUS="$(curl -fsS --max-time 5 -o /dev/null -w '%{http_code}' "${HEALTH_URL}" 2>/dev/null || true)"
  if [ "${HTTP_STATUS}" = "200" ]; then
    HEALTH_OK=1
    break
  fi

  # Fallback: --resolve override for pre-DNS / split-horizon setups.
  HTTP_STATUS_RESOLVE="$(curl -fsS --max-time 5 \
    --resolve "${PRISMA_DOMAIN}:443:127.0.0.1" \
    -o /dev/null -w '%{http_code}' \
    "${HEALTH_URL}" 2>/dev/null || true)"
  if [ "${HTTP_STATUS_RESOLVE}" = "200" ]; then
    HEALTH_OK=1
    break
  fi

  log "Not healthy yet (${HEALTH_ELAPSED}s elapsed, HTTP=${HTTP_STATUS:-none}). Retrying in ${HEALTH_SLEEP}s..."
  sleep "${HEALTH_SLEEP}"
  HEALTH_ELAPSED=$((HEALTH_ELAPSED + HEALTH_SLEEP))
done

if [ "${HEALTH_OK}" -eq 0 ]; then
  printf '[install] ERROR: %s did not return 200 within %ss.\n' \
    "${HEALTH_URL}" "${HEALTH_DEADLINE}" >&2
  printf '[install] Last 40 lines from app and traefik:\n' >&2
  docker compose \
    -f "${REPO_ROOT}/deploy/docker-compose.prod.yml" \
    --env-file "${ENV_FILE}" \
    logs app traefik --tail=40 >&2 || true
  exit 1
fi

log "Service is live at ${HEALTH_URL}."

# ---------------------------------------------------------------------------
# Success — emit machine-readable summary to stdout ONLY
# ---------------------------------------------------------------------------

WEBHOOK_URL="https://${PRISMA_DOMAIN}/webhooks/github"

printf '\n'
printf '=== DEPLOYMENT SUCCESS ===\n'
printf '\n'
printf 'Webhook URL (paste into GitHub App registration):\n'
printf '%s\n' "${WEBHOOK_URL}"
printf '\n'
printf 'Webhook Secret (paste into GitHub App registration → Webhook secret field):\n'
printf '%s\n' "${GITHUB_APP_WEBHOOK_SECRET}"
printf '\n'
printf 'GitHub App settings reminder:\n'
printf '  - Webhook URL:    %s\n' "${WEBHOOK_URL}"
printf '  - Webhook secret: (shown above — store it; it will not be displayed again)\n'
printf '  - App slug:       %s\n' "${GITHUB_APP_SLUG}"
printf '  - App ID:         %s\n' "${GITHUB_APP_ID}"
printf '\n'
printf '=========================\n'
