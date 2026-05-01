# Operational Runbooks

## How to read these runbooks

Each runbook is structured `Symptom`, `Detection`, `Diagnosis`, `Mitigation`, `Recovery`, `Postmortem template pointer`, in that order. Detection signals are named events from `observability.md` § Event taxonomy or named metrics from `observability.md` § Metric inventory; both are referenced byte-equivalent. Mitigations name environment variables from `deployment.md` § Environment variables and components from `system-design.md` § Component map. The postmortem template lives at `## Postmortem template` at the end of this file. MVP tunable starting values live at `## Numeric tunables`; runbooks reference tunables by name, not by numeric value.

## Runbooks

### Webhook signatures are failing

- **Symptom.** GitHub webhook deliveries return `4xx` from the App; PRs are not reviewed. The most likely cause is that the webhook secret was rotated in GitHub but not in the App, or vice versa.
- **Detection.** Spike in `prisma_webhooks_received_total{outcome="signature_failed"}`; spike in `webhook.signature_failed` events. A correlated rise in `prisma_redactor_dropped_total{event="webhook.received"}` may indicate the redactor is also dropping malformed inbound payloads, but this is a secondary signal — `prisma_webhooks_received_total{outcome="signature_failed"}` is the primary one.
- **Diagnosis.** Confirm that `GITHUB_APP_WEBHOOK_SECRET` (read via `SecretSource`) matches the value configured in the GitHub App settings. Inspect the deployment's most recent secret rotation. Verify that all replicas of `apps/github-app/webhook-ingress` were rolled after the rotation (an unrolled replica still holds the previous secret in memory).
- **Mitigation.** Re-sync the secret following the procedure in `### Rotating webhook secret`. While rotation is in flight, GitHub's "Recent Deliveries" UI surfaces `4xx`; this is expected for the brief window where one side has been updated and the other has not.
- **Recovery.** Trigger a redelivery from GitHub's "Recent Deliveries" UI for one of the failed deliveries; verify a `webhook.received` event with `outcome=accepted` and a corresponding decrement in the `signature_failed` outcome count rate.
- **Postmortem template pointer.** `## Postmortem template`.

### Queue is backing up

- **Symptom.** PR reviews lag; users see no Checks output for newly opened PRs for many minutes after open or push. Likely cause: provider slowness, stuck jobs, or insufficient `QUEUE_CONCURRENCY`.
- **Detection.** Rising `prisma_jobs_inflight`; rising `prisma_queue_lag_seconds`; absence of corresponding rise in `prisma_jobs_terminal_total`. Job-to-publish latency degradation is visible as a rightward shift in `prisma_job_duration_seconds{state="succeeded"}` p95.
- **Diagnosis.** Inspect span durations for `pipeline.provider` (the provider call is the most expensive step). Check the `prisma_provider_call_seconds` p95 by `provider_id`. Inspect the BullMQ queue for stuck jobs (jobs whose visibility window has not been re-acquired). Cross-reference with `job.started` and `job.terminal` event rates per worker.
- **Mitigation.** Temporarily increase `QUEUE_CONCURRENCY` (more in-flight jobs per worker, capped by Redis throughput). Reduce `JOB_TIMEOUT_SECONDS` to fail stuck jobs faster — they will be re-enqueued or marked `failed_terminal` per the retry classes in `system-design.md` § Error taxonomy mapping. If a single repo is producing oversized PRs, tighten `MAX_TOKENS_PER_PR` (the prefilter and provider stages use this as the cost ceiling proxy) or rely on the prefilter oversized fast-path triggered by `max_files` and `max_changed_lines` in `.github/review-bot.yml`.
- **Recovery.** `prisma_queue_lag_seconds` returns to baseline; `prisma_jobs_inflight` falls back into its normal range; `prisma_jobs_terminal_total{state="succeeded"}` rate matches `job.enqueued` rate; `prisma_job_duration_seconds{state="succeeded"}` p95 recovers.
- **Postmortem template pointer.** `## Postmortem template`.

### Provider errors are climbing

- **Symptom.** Many PRs end with `failed_terminal`; reviewers see the "review unavailable" Checks summary on PRs.
- **Detection.** Rising `prisma_provider_call_seconds{outcome="error.transport"}` or `outcome="error.rate_limit"`; spike in `provider.error` events with `variant=auth` (key revoked), `variant=rate_limit`, or `variant=transport` (outage). A sympathetic decline in `prisma_findings_published_total{surface="inline"}` and `prisma_findings_published_total{surface="summary"}` confirms PRs are reaching the failure path rather than the publish path.
- **Diagnosis.** Check the provider's status page. Confirm `ANTHROPIC_API_KEY` is valid (it may have been revoked or expired). Check whether `prisma_provider_retry_total{retry_class="rate_limited"}` is dominating, which suggests cost pressure rather than outage.
- **Mitigation.**
  - For `variant=auth`: rotate the key via `### Rotating provider API key`.
  - For `variant=rate_limit`: raise `RETRY_RATELIMIT_MAX_ATTEMPTS` cautiously; consider tightening `MAX_TOKENS_PER_PR` and `MAX_TOKENS_PER_WINDOW_PER_INSTALLATION` (over `MAX_TOKENS_WINDOW_SECONDS`) to reduce the App's call volume against the provider.
  - For `variant=transport`: wait for the provider to recover; the App will retry per the **Transient** retry class with backoff bounded by `RETRY_TRANSIENT_MAX_ATTEMPTS`, `RETRY_TRANSIENT_BACKOFF_BASE_MS`, and `RETRY_TRANSIENT_BACKOFF_MAX_MS` (per `system-design.md` § Error taxonomy mapping).
- **Recovery.** Provider error rate (the SLI in `observability.md` § SLI / SLO posture) returns below baseline; `prisma_jobs_terminal_total{state="failed_terminal"}` rate normalizes; `prisma_findings_published_total` rate recovers.
- **Postmortem template pointer.** `## Postmortem template`.

### Findings rejected by validator at high rate

- **Symptom.** Most PRs produce a `neutral` Checks run with the body "no findings produced" (the wording from `data-flow.md` § Flow 4 — Malformed provider output). Likely cause: provider schema drift; the provider is returning a shape that fails the Zod schema at the `packages/providers/anthropic` adapter boundary.
- **Detection.** Rising `prisma_findings_dropped_total{stage="validator", reason="provider_output_zod_failed"}`; spike in `validator.rejected` events; a correlated drop in `prisma_findings_published_total` (because rejected findings never reach the publisher's surfaces).
- **Diagnosis.** Inspect a few `validator.rejected` events for the `provider_output_excerpt` (already redacted at the source per `review-findings-schema.md` § Rejection log entry shape) to see the offending shape. Compare against the `ProviderReviewOutput` Zod schema. Cross-reference with the most recent provider model id (configured per repo via `model` in `.github/review-bot.yml` or via deployment defaults).
- **Mitigation.** Triage the schema delta. If the change is benign, update the adapter at `packages/providers/anthropic` to map the new shape into `ProviderReviewOutput`. If the change is a bug on the provider side, contact the provider; in the meantime, the App's drop-with-audit-log policy keeps existing PR comments unaffected. If the schema drift is repo-specific (a particular `model` setting is the cause), advise affected repos to revert their `model` override in `.github/review-bot.yml`.
- **Recovery.** `prisma_findings_dropped_total{stage="validator", reason="provider_output_zod_failed"}` rate returns to baseline; `prisma_findings_published_total` recovers.
- **Postmortem template pointer.** `## Postmortem template`.

### Replay or duplicate deliveries

- **Symptom.** A single PR appears to be processed multiple times; users wonder if the bot is duplicating findings. Likely cause: GitHub redelivery (normal — GitHub retries on `5xx`); idempotency window not honoring; across-run dedupe set failing to match.
- **Detection.** Spike in `prisma_jobs_terminal_total{state="discarded_idempotent"}` with no user-visible duplication (good — idempotency is working). Or: spike in user reports of duplicate inline comments (bad — across-run dedupe failed). A `prisma_job_duration_seconds{state="discarded_idempotent"}` distribution shifted toward zero is the expected fingerprint of a healthy idempotent short-circuit.
- **Diagnosis.** Confirm `INSTALLATION_REPLAY_WINDOW_SECONDS` is set to a sane value (the replay-protection window for `X-GitHub-Delivery` per installation, per `system-design.md` § Queue and async model § Replay protection). Confirm the per-PR already-published dedupe set source (the GitHub Checks/Review-Comments history of this App on this PR, per `publication-policy.md` § Dedupe behavior) is reachable and returning results. Inspect a sample of `publisher.dropped` events with `reason_code = 'dedupe_collapsed'` to confirm across-run dedupe is firing.
- **Mitigation.** If duplicates are reaching PRs, verify the GitHub Checks / Review Comments history query is returning the expected set. Check the `dedupe_key` derivation in `packages/core/validator-ranker` (the `dedupe_key` field is defined in `review-findings-schema.md`). If the replay-protection cache is cold (e.g., after a Redis restart — see `### Disaster recovery — Redis loss`), the across-run dedupe set sourced from GitHub remains the canonical signal.
- **Recovery.** Duplicate publication ceases; user reports drop to zero.
- **Postmortem template pointer.** `## Postmortem template`.

### Oversized PRs starving the queue

- **Symptom.** Large PRs starve the worker; small PRs lag. Likely cause: prefilter caps too lax for the affected repo; oversized PRs are reaching the provider instead of being short-circuited.
- **Detection.** Many `prefilter.accepted` events with high `total_changed_lines`; rising `prisma_provider_call_seconds` p95; few `prisma_prefilter_skipped_total{reason="oversized"}` increments and few `prefilter.skipped` events with `reason=oversized`. The `prisma_redactor_dropped_total` counter should stay flat — a rise here would indicate the redactor is having to drop oversized payloads at emission time, an additional symptom of upstream cap drift.
- **Diagnosis.** Inspect typical PR sizes for the affected repo (via the `prefilter.accepted` event payloads, redacted of file contents). Compare against `max_files` and `max_changed_lines` from `config-spec.md`.
- **Mitigation.** Tighten `max_files` and `max_changed_lines` defaults at the App level (operator-side override applied to the repo's resolved configuration), or instruct repo admins to tighten these in their `.github/review-bot.yml`. The oversized fast-path (per `data-flow.md` § Flow 2 — Oversized-diff fast-path) will then trigger for large PRs and emit a summary-only Checks run without invoking the provider.
- **Recovery.** `prisma_prefilter_skipped_total{reason="oversized"}` increments correlate with large PRs; `prisma_provider_call_seconds` p95 returns to baseline; queue lag recovers.
- **Postmortem template pointer.** `## Postmortem template`.

### Stuck failed_terminal rate spike

- **Symptom.** `prisma_jobs_terminal_total{state="failed_terminal"}` rises broadly across all installations and repositories. Likely cause: a dependency or upstream change affecting the entire fleet (provider auth issue, GitHub API change, snapshotter bug introduced in the most recent App deployment).
- **Detection.** Broad-fleet rise in `prisma_jobs_terminal_total{state="failed_terminal"}`; correlated event taxonomy spikes in `provider.error`, `validator.rejected`, `ranker.dropped`, or `job.terminal` with non-null `failure_reason_code`. `prisma_job_duration_seconds{state="failed_terminal"}` distribution shape may indicate whether jobs are failing fast (auth) or after retry exhaustion (transport / rate-limit).
- **Diagnosis.** Identify which `failure_reason_code` is dominant by inspecting the `prisma_jobs_terminal_total{state="failed_terminal", failure_reason_code=...}` partition. Cross-reference with the provider's status page, GitHub's status page, and the most recent App deployment timestamp.
- **Mitigation.** Roll back the most recent App deployment if the spike correlates in time. If the cause is upstream (provider or GitHub), raise the relevant retry class's max-attempts cautiously (`RETRY_TRANSIENT_MAX_ATTEMPTS` or `RETRY_RATELIMIT_MAX_ATTEMPTS`) and wait for upstream recovery; the `JobQueue` interface's retry loop will re-process transient failures.
- **Recovery.** `prisma_jobs_terminal_total{state="failed_terminal"}` rate returns to baseline.
- **Postmortem template pointer.** `## Postmortem template`.

### Rotating webhook secret

A zero-downtime procedure for rotating `GITHUB_APP_WEBHOOK_SECRET`.

- **Symptom.** Operator-initiated; not a fault response.
- **Detection.** Not applicable — this is a planned procedure. A brief, expected spike in `prisma_webhooks_received_total{outcome="signature_failed"}` and `webhook.signature_failed` events is the signal that step 2 and step 4 are not yet synchronized.
- **Diagnosis.** Not applicable.
- **Mitigation.** Procedure (steps):
  1. Generate a new webhook secret value.
  2. In GitHub App settings, update the webhook secret to the new value (verify against current GitHub docs in Phase 4 — GitHub supports a single secret at a time; this step replaces the prior value).
  3. Update the App's deployment to read the new secret via `SecretSource`. For the MVP env-var implementation, set the new value into `GITHUB_APP_WEBHOOK_SECRET`.
  4. Roll the App processes (rolling restart) so each `apps/github-app/webhook-ingress` replica picks up the new secret.
  5. Trigger a test webhook from GitHub's "Recent Deliveries" UI; confirm a `webhook.received` event with `outcome=accepted`.
  Mitigation note for the brief window between step 2 and step 4: deliveries fail with `signature_failed` until both sides match. Expect a transient spike in `prisma_webhooks_received_total{outcome="signature_failed"}`; this is acceptable for a planned rotation.
- **Recovery.** Signature failures return to zero; `prisma_webhooks_received_total{outcome="accepted"}` resumes at the prior rate.
- **Postmortem template pointer.** `## Postmortem template`.

### Rotating provider API key

A procedure for rotating `ANTHROPIC_API_KEY`.

- **Symptom.** Operator-initiated; not a fault response.
- **Detection.** Not applicable. After step 5, expect `prisma_findings_published_total` to resume at the prior rate; a sentinel `provider.called` event followed by a successful return is the affirmative health signal.
- **Diagnosis.** Not applicable.
- **Mitigation.** Procedure (steps):
  1. Mint a new provider API key in the provider's dashboard (verify against current vendor docs in Phase 4).
  2. Stage the new key in `SecretSource` under `ANTHROPIC_API_KEY` (or the equivalent `provider.api_key` slot for non-Anthropic adapters when shipped — none in MVP).
  3. Roll the App processes (rolling restart) so each worker picks up the new key on startup.
  4. Verify with a sentinel call: a `provider.called` event followed by a successful response (no `provider.error` event) for the next inbound PR.
  5. Revoke the old key in the provider's dashboard.
- **Recovery.** `provider.error` events with `variant=auth` cease.
- **Postmortem template pointer.** `## Postmortem template`.

### Revoking and reinstalling the App on a repo

A procedure when an operator or repo admin needs to remove the App from a repository or organization.

- **Symptom.** Operator- or repo-admin-initiated; not a fault response.
- **Detection.** Not applicable for a planned action. For an unintentional revoke, look for a sudden absence of webhooks from a previously active installation.
- **Diagnosis.** Not applicable for a planned action.
- **Mitigation.** Procedure (steps):
  1. The repo admin uninstalls the App from the repository or organization in GitHub.
  2. The App stops receiving webhook deliveries for that installation. In-flight jobs run to completion (no graceful eviction in MVP — they may fail with `auth` errors when `packages/github/installation-auth` cannot mint an installation token).
  3. Existing Checks runs and inline comments authored by the App on prior PRs are not retracted (cleanup is post-MVP, per `product-spec.md` § Install the App).
  4. To reinstall, the admin re-installs the App; a new `installation_id` is minted by GitHub. The App routes the new installation through the same code path; per `system-design.md` § Multitenancy posture, every persistence and routing key is namespaced by `installation_id`, so the new installation is logically distinct from any prior one.
- **Recovery.** New PRs in the reinstalled repo flow through the pipeline as usual; `webhook.received` events for the new `installation_id` resume.
- **Postmortem template pointer.** `## Postmortem template` (only when the revoke was unintentional).

### Disaster recovery — Redis loss

- **Symptom.** Redis becomes unreachable or its data is lost. Likely cause: Redis instance failure, accidental flush, infrastructure incident.
- **Detection.** Dependency check `/healthz/deps` fails; spike in `prisma_jobs_terminal_total{state="failed_terminal"}` (because in-flight workers cannot ack); spike in webhook `5xx` responses (because enqueue fails — the ingress returns `5xx` so GitHub retries the delivery, per `api-contracts.md` § Webhook ingress contract).
- **Diagnosis.** Confirm Redis is reachable from both the ingress and the worker (TCP probe on `REDIS_URL`). Confirm BullMQ connection is established (via the `JobQueue` interface health). Confirm the replay-protection cache state.
- **Mitigation.** Restore Redis (from a snapshot if one is available; from a cold start otherwise). Roll the App processes once Redis is reachable so they reconnect cleanly.
- **Recovery.** State lost on cold-start: the in-flight idempotency window and the replay-protection cache. The App accepts this loss because the **across-run dedupe set sourced from the GitHub Checks/Review-Comments history of this App on this PR** (per `publication-policy.md` § Dedupe behavior) remains the canonical signal — duplicate inline publication on a PR is still prevented after a cold start. What is lost is short-window replay protection (GitHub may redeliver webhooks during the outage and the App may accept some replays after restart), not finding-level idempotency. `/healthz/deps` returns `200`; webhook 5xx responses cease; `prisma_jobs_terminal_total{state="succeeded"}` resumes.
- **Postmortem template pointer.** `## Postmortem template`.

## Numeric tunables

These are MVP starting values, not ADR commitments. Operators are expected to revise based on real traffic.

| name | starting value | classification | rationale (one line) |
| --- | --- | --- | --- |
| `QUEUE_CONCURRENCY` | `4` | `tunable` | Bounds in-flight provider calls per worker; 4 is conservative for small-instance class. |
| `JOB_TIMEOUT_SECONDS` | `120` | `tunable` | Bounds wall time per PR; matches typical provider p95 plus headroom. |
| `RETRY_TRANSIENT_MAX_ATTEMPTS` | `3` | `tunable` | Bounds retries on `transport` and similar transient errors; exponential backoff caps total wait. |
| `RETRY_TRANSIENT_BACKOFF_BASE_MS` | `500` | `tunable` | Initial backoff for transient retries; jittered. |
| `RETRY_TRANSIENT_BACKOFF_MAX_MS` | `8000` | `tunable` | Cap on backoff growth so a single PR never waits absurdly long. |
| `RETRY_RATELIMIT_MAX_ATTEMPTS` | `5` | `tunable` | Bounds retries on `rate_limit`; honors `Retry-After` headers when provided. |
| `MAX_TOKENS_PER_PR` | `60000` | `tunable` | Cost ceiling proxy per PR; the prefilter shed-load fast-path triggers before this is hit on oversized diffs. |
| `MAX_TOKENS_PER_WINDOW_PER_INSTALLATION` | `2000000` | `tunable` | Cost ceiling proxy per installation per window; protects against PR-storm cost blowups. |
| `MAX_TOKENS_WINDOW_SECONDS` | `3600` | `tunable` | Sliding window for the per-installation cost ceiling. |
| `OTEL_TRACES_SAMPLER_ARG` | `1.0` | `tunable` | Head-sample rate for traces; 1.0 is fine for MVP single-tenant volume. |
| `INSTALLATION_REPLAY_WINDOW_SECONDS` | `300` | `config` | How long `X-GitHub-Delivery` is cached per installation for replay protection. |
| `LOG_LEVEL` | `info` | `config` | Default log verbosity; raise to `debug` only during incident triage. |

## Postmortem template

A short template for any runbook to point to. Each heading takes one line in a real incident write-up.

- **Incident summary.** One sentence describing what happened and the user-visible impact.
- **Timeline (UTC).** Time-stamped events: detection, escalation, mitigation, recovery.
- **Detection signal(s).** The metric or event name(s) that first indicated the incident (referenced from `observability.md` § Metric inventory or § Event taxonomy).
- **Mitigation taken.** The runbook step(s) executed and any deviations from the runbook.
- **Recovery confirmation.** The metric or event signal that confirmed the incident was resolved.
- **Root cause.** A one- or two-line statement of the underlying cause.
- **Action items.** Numbered list of follow-ups (code, configuration, runbook, alert).
