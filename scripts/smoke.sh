#!/usr/bin/env bash
# scripts/smoke.sh — end-to-end developer smoke check.
#
# Brings up the dev stack, polls /healthz/live, exercises the webhook
# ingress with both an unsigned and a signed delivery, asserts the worker
# emitted its boot-time `worker.started` log line, and tears the stack
# down. Composes `make` targets only — no raw pnpm/node/tsx invocation.
#
# Idempotent: running twice in a row works.

set -euo pipefail

LOG_PREFIX="[smoke]"
APP_HOST_PORT="${APP_HOST_PORT:-3030}"
HEALTH_URL="http://localhost:${APP_HOST_PORT}/healthz/live"
WEBHOOK_URL="http://localhost:${APP_HOST_PORT}/webhooks/github"
SIGNED_FIXTURE="security-bug"
HEALTH_TIMEOUT_SECONDS=30
WORKER_LOG_GRACE_SECONDS=5

log() {
  printf '%s %s\n' "${LOG_PREFIX}" "$*"
}

fail() {
  printf '%s ERROR: %s\n' "${LOG_PREFIX}" "$*" >&2
  exit 1
}

cleanup() {
  log "tearing down via 'make down'"
  make down >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_url() {
  local url="$1"
  local timeout="$2"
  local elapsed=0
  log "waiting for ${url} (timeout ${timeout}s)"
  while ! curl -fsS -o /dev/null "${url}"; do
    if [ "${elapsed}" -ge "${timeout}" ]; then
      fail "healthz timeout: ${url} did not return 200 within ${timeout}s"
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  log "healthy: ${url}"
}

# Step 1: bring stack up. `make up` runs `docker compose up -d` (detached).
log "make up"
make up

# Step 2: poll liveness.
wait_for_url "${HEALTH_URL}" "${HEALTH_TIMEOUT_SECONDS}"

# Step 3: unsigned POST -> expect 401 (signature_missing).
log "POST unsigned ${WEBHOOK_URL} (expect 401)"
unsigned_status=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "${WEBHOOK_URL}" \
  -H 'Content-Type: application/json' \
  -H 'X-GitHub-Event: pull_request' \
  -H "X-GitHub-Delivery: $(uuidgen 2>/dev/null || echo 00000000-0000-4000-8000-000000000000)" \
  --data '{}' \
  || true)
if [ "${unsigned_status}" != "401" ]; then
  fail "unsigned POST expected 401, got ${unsigned_status}"
fi
log "unsigned POST ok (401)"

# Step 4: signed POST via the replay script. Capture stdout to inspect
# the first line, which the script always writes as the HTTP status code.
log "make replay-webhook FIXTURE=${SIGNED_FIXTURE}"
replay_stdout_file=$(mktemp)
replay_stderr_file=$(mktemp)
set +e
# `-s --no-print-directory` silences make's recipe-echo and directory banners
# so the replay-webhook script's stdout (status code on the first line) is
# the only output we need to parse.
make -s --no-print-directory replay-webhook FIXTURE="${SIGNED_FIXTURE}" \
  >"${replay_stdout_file}" 2>"${replay_stderr_file}"
replay_exit=$?
set -e
# Pull the first numeric-only line out of stdout — that is the HTTP status
# the replay script printed. Defensive against any stray output above it.
replay_status_line=$(grep -m1 -E '^[0-9]+$' "${replay_stdout_file}" || true)
log "replay exit=${replay_exit} status=${replay_status_line}"
if [ "${replay_status_line}" != "202" ]; then
  printf '%s replay stdout:\n' "${LOG_PREFIX}" >&2
  cat "${replay_stdout_file}" >&2 || true
  printf '%s replay stderr:\n' "${LOG_PREFIX}" >&2
  cat "${replay_stderr_file}" >&2 || true
  rm -f "${replay_stdout_file}" "${replay_stderr_file}"
  fail "signed POST expected status 202, got '${replay_status_line}' (replay exit ${replay_exit})"
fi
rm -f "${replay_stdout_file}" "${replay_stderr_file}"
log "signed POST ok (202)"

# Step 5: grep worker logs for the boot-time `worker.started` line. Allow a
# brief grace period for the worker to flush logs after `make up`.
log "checking worker logs for 'worker.started' (grace ${WORKER_LOG_GRACE_SECONDS}s)"
sleep "${WORKER_LOG_GRACE_SECONDS}"
if ! docker compose logs worker --tail=40 2>&1 | grep -q 'worker.started'; then
  printf '%s worker log tail:\n' "${LOG_PREFIX}" >&2
  docker compose logs worker --tail=40 >&2 || true
  fail "did not find 'worker.started' in 'docker compose logs worker --tail=40'"
fi
log "worker.started found in worker logs"

log "SMOKE OK"
echo "SMOKE OK"
exit 0
