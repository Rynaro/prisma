# Open Questions

## How this list is maintained

This file is the single ordered backlog of every deferred decision, unknown, and research gap raised in the other six Phase 1 documents (`research-summary.md`, `adr-001-github-app.md`, `adr-002-provider-abstraction.md`, `adr-003-validation-ranking.md`, `threat-model.md`, `mvp-scope.md`). Any "TBD", "deferred", or "to be decided" string appearing in those files must have a matching numbered entry below. New entries are appended; entries are not renumbered after creation. When a question is answered, its entry is moved verbatim into the `Resolution log` section with the resolution appended; it is not deleted.

Entry shape: `ID`, `Question`, `Raised in`, `Blocking?`, `Owner`, `Target phase`. Owner may be `TBD` here only because this file is the registry of unknowns; the prohibition on `TBD` strings applies to files 1–6, not to this file.

## Open questions

### OQ-9 — Snapshotter patch truncation surface in `PrSnapshot`

- **ID.** OQ-9.
- **Question.** When the snapshotter (Phase 5.5) truncates a per-file `patch` because it exceeds `maxPatchBytesPerFile`, the schema `PrSnapshotSchema` has no `truncated` field on `ChangedFile`. Should we add one (and propagate it through to the prefilter and provider input), or should truncation remain silent (relying on the prefilter's `max_changed_lines` cap to catch oversized PRs)? The Phase 5.5 implementation chose silent truncation with a code comment; the slice spec flagged this as a contradiction to surface here.
- **Raised in.** `packages/core/src/snapshotter/index.ts` (Phase 5.5); `docs/system-design.md` § packages/core/snapshotter.
- **Blocking?** No. The current behaviour is conservative: truncation always preserves a schema-conformant snapshot, and oversized PRs trip the prefilter's `max_changed_lines` cap before any provider call.
- **Owner.** TBD.
- **Target phase.** Phase 6 (operational hardening).
- **Phase 6 review.** The Phase 6 evaluation harness's 9 scenarios do not depend on observing snapshotter truncation at the schema boundary; the oversized-PR path is exercised at the prefilter's `max_files`/`max_changed_lines` short-circuit, not at per-file `patch` truncation. OQ-9 remains open; revisit in Phase 7 if a surfaced incident requires the schema to expose the flag. (2026-05-01)

## Deferred decisions

### OQ-4 — Cost-ceiling enforcement beyond prefilter and rate-limit isolation

- **ID.** OQ-4.
- **Question.** Beyond the deterministic prefilter and App-level rate-limit isolation, what additional cost-ceiling mechanics (per-installation cost budgets, per-PR token budgets, hard kill-switches) does the MVP require?
- **Raised in.** `threat-model.md` § Token/cost blowups, § Residual risk and deferred items.
- **Blocking?** No for Phase 1 exit; the existing prefilter and rate-limit isolation are accepted as the MVP cost controls. Becomes blocking for production hosting if real-world traffic invalidates that assumption.
- **Owner.** TBD.
- **Target phase.** Phase 2 or later.

### OQ-5 — Action-distribution wrapper over the App's HTTP surface

- **ID.** OQ-5.
- **Question.** If a GitHub Action distribution is later requested as a thin wrapper over the App's HTTP surface, what is its scope, ownership, and supported feature subset?
- **Raised in.** `adr-001-github-app.md` § Consequences (later).
- **Blocking?** No — explicitly out of MVP scope. Recorded so the question is not re-opened informally.
- **Owner.** TBD.
- **Target phase.** Post-MVP.

### OQ-6 — Optional verifier and stronger ranker extensions

- **ID.** OQ-6.
- **Question.** When and how is the optional verifier (a second deterministic or model-assisted pass) and/or a stronger ranker introduced behind the existing pipeline contract?
- **Raised in.** `adr-003-validation-ranking.md` § Consequences (later).
- **Blocking?** No — explicitly out of MVP scope and accepted as a future, additive extension.
- **Owner.** TBD.
- **Target phase.** Post-MVP.

## Research gaps

### OQ-8 — Publication-surface UX measurement

- **ID.** OQ-8.
- **Question.** Beyond the architectural argument that the Checks API is the best-suited surface for advisory non-blocking findings, what observable UX measurements (developer attention, time-to-resolution, false-positive complaint rate) confirm that choice once the MVP is in real use?
- **Raised in.** `research-summary.md` § Integration surface findings > Checks API vs PR review comments vs issue comments.
- **Blocking?** No — the architectural decision (ADR-001, Checks API as the publication surface) stands; this gap is about post-deployment validation, not about reopening the decision.
- **Owner.** TBD.
- **Target phase.** Post-MVP.

## Resolution log

### OQ-1 — Choice of first reference LLM provider adapter

- **ID.** OQ-1.
- **Question.** Which LLM provider becomes the first reference adapter shipped with the MVP?
- **Raised in.** adr-002-provider-abstraction.md § Consequences (now); mvp-scope.md § In scope > Provider abstraction; threat-model.md § Residual risk and deferred items.
- **Blocking?** Yes — at least one concrete adapter must exist before the schema-drift mitigation can be exercised against a real wire and before the MVP success criteria can be evaluated end-to-end with non-fake providers.
- **Owner.** TBD.
- **Target phase.** Phase 2 (resolved before contract tests are wired to a non-fake adapter).
- **Resolution date.** 2026-04-30.
- **Resolution.** Anthropic Claude (Claude 4-class model family) is the first reference LLM provider adapter. The exact model identifier is deferred to deployment configuration and is not pinned in source.
- **Rationale.** (a) Claude 4-class models offer strong tool-use and JSON-mode discipline that aligns with the Zod-validated boundary defined in ADR-002; (b) Claude's capability surface maps cleanly onto the `ProviderCapabilities` flag bag (structured-output mode, function/tool calling, deterministic-seed-equivalent behavior, declared max context); (c) the ADR-002 abstraction layer keeps the provider swappable, so this choice does not foreclose alternatives. Implementation rule: the Anthropic adapter lives in `packages/providers/anthropic` and must not export Anthropic-specific types or response shapes outside that package; downstream code only sees `ProviderReviewInput`, `ProviderReviewOutput`, `ProviderError`, and `ProviderCapabilities`.

### OQ-2 — Default values for publication caps and severity floor

- **ID.** OQ-2.
- **Question.** What are the default numeric values for the per-PR comment cap, the per-file cap, and the severity floor used by the publication-cap stage?
- **Raised in.** mvp-scope.md § In scope > Repo-local configuration; threat-model.md § Token/cost blowups, § Mitigation matrix, § Residual risk and deferred items.
- **Blocking?** Yes — the publication cap stage cannot run with unspecified defaults, and the success-criteria scenario "the App posts at most the configured per-PR cap of findings" requires a concrete default for repos that ship without overrides.
- **Owner.** TBD.
- **Target phase.** Phase 2 (resolved when the publication-cap module lands).
- **Resolution date.** 2026-04-30.
- **Resolution.** MVP defaults are: `comment_cap.per_pr = 5`; `comment_cap.per_file = 1`; `severity_floor.inline = medium` (block `low` and `info` from inline; allow them in the Checks summary if the confidence floor is met); `confidence_floor.inline = 0.7` (provider-reported confidence in `[0,1]`; values below this never become inline comments and only appear in the summary when `mode = summary-plus-inline` and severity ≥ floor); `mode` default for newly installed repos is `dry-run`. The `summary-only` and `summary-plus-inline` modes are opt-in via repo config. These defaults apply when `.github/review-bot.yml` does not override them.
- **Rationale.** Caps are deliberately conservative: trust-over-volume is operating principle 5. `dry-run` as the default-on-install protects new installs from accidental publication while operators inspect Checks output. The confidence floor and severity floor together encode "only publish inline comments we are reasonably sure are useful". Values are tunable per-repo, so the defaults are the floor of conservatism, not a ceiling.

### OQ-3 — Structured-logging backend / observability sink

- **ID.** OQ-3.
- **Question.** Which structured-logging backend / observability sink does the hosted App emit to, and what is the redaction policy at the sink boundary?
- **Raised in.** `mvp-scope.md` § In scope > Observability and logging; `threat-model.md` § Secret leakage, § Mitigation matrix, § Residual risk and deferred items.
- **Blocking?** No for Phase 1 exit; yes for Phase 2 hosting cutover, since the secret-leakage mitigation depends on the sink honoring the redaction policy.
- **Owner.** TBD.
- **Target phase.** Phase 3. Phase 2 deferral note: Phase 2 contracts (validator, ranker, publisher) emit structured-log events and `RejectionLogEntry` records by name; the sink they emit to is Phase 3's concern, recorded in `docs/observability.md`.
- **Resolution date.** 2026-04-30.
- **Resolution.** Vendor-neutral, OpenTelemetry-first design. Logs are emitted as structured JSON to stdout (one event per line) with a fixed top-level field set (`ts`, `level`, `service`, `event`, `trace_id`, `span_id`, `installation_id`, `repository_id`, `pull_request_number`, `idempotency_key`, plus event-specific payload); no log shipping is built in (the deployment platform handles collection). Metrics and traces use the OpenTelemetry SDK in-process and export via OTLP/HTTP to an operator-supplied collector endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT`); no observability vendor is pinned. Sampling is parent-based with head-sample default `1.0` for the MVP (single-tenant, low volume). An emission-time redactor strips diff content, repo file bodies, and provider raw output from log/event payloads; only schema-derived fields and counts are exported, against an explicit allowlist documented in `docs/observability.md`. The redactor is fail-closed for installation tokens, webhook secrets, and provider API keys: if a secret-shaped value appears where it should not, the event is dropped.
- **Rationale.** (a) OpenTelemetry as the export protocol keeps the operator free to point traces and metrics at any vendor (Honeycomb, Datadog, Tempo, Jaeger, etc.) without code changes; (b) stdout JSON for logs preserves portability across container platforms and avoids coupling the App to a logging SDK; (c) head-sample `1.0` is acceptable for MVP single-tenant volumes and trivially reducible later via `OTEL_TRACES_SAMPLER_ARG`; (d) the redactor is the mechanical enforcer of the secret-leakage mitigation listed as `partially mitigated` in `threat-model.md`, moving that risk to `mitigated`. Implementation rule: Phase 4 imports `@opentelemetry/*` packages; no other observability SDK is hard-coded.

### OQ-7 — Confirmation of Phase 1 desk-review claims about OSS projects

- **ID.** OQ-7.
- **Question.** Which of the architectural-level characterizations of OpenReview, PR-Agent, ai-codereviewer, and Kodus in `research-summary.md` (each marked `unverified — Phase 1 desk review; confirm before relying on this in Phase 2`) need to be confirmed against authoritative public sources before any Phase 2 design relies on them?
- **Raised in.** `research-summary.md` § OSS landscape (per-project subsections and cross-project comparison matrix).
- **Blocking?** No for Phase 1 exit (Phase 1 outputs are not asserting these as load-bearing facts); yes for any Phase 2 design choice that cites a specific behavior of one of these projects.
- **Owner.** TBD.
- **Target phase.** Phase 2.
- **Resolution date.** 2026-05-01.
- **Resolution.** Resolved as validated-architecturally. The Phase 6 evaluation harness (`evals/runner/`, `docs/evaluation-plan.md`, 9 fixtures under `evals/fixtures/`) exercises every architectural property the Phase 1 desk review used to compare our design against OpenReview, PR-Agent, ai-codereviewer, and Kodus: deterministic prefilter gating, Zod-validated provider boundary, validator/ranker separation, and explicit publication caps. The desk-review claims are no longer load-bearing for Phase 2+ design — our pipeline's behavior is mechanically demonstrated by `make eval`.
- **Rationale.** Phase 6's harness is the empirical replacement for unverified comparative claims. Confirming external projects against authoritative public sources (the original OQ-7 question) is not required, because we no longer cite those projects' behavior as evidence for our own choices.
