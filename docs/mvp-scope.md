# MVP Scope

## MVP definition

The MVP is a hosted GitHub App that posts advisory, non-blocking findings on pull requests, configured per-repository through a repo-local configuration file at `.github/review-bot.yml`, with a vendor-independent provider layer behind a single typed adapter. Every finding flows through a deterministic prefilter, a typed Provider call, a deterministic validator, a deterministic ranker, and a publication cap before any PR-visible artifact is created. The MVP optimizes for trust over volume: a small number of high-signal findings via the Checks API rather than a high-volume comment stream.

## In scope

### Integration surface

- GitHub App as the deployment shape (ADR-001).
- Hosted webhook receiver with HMAC-SHA-256 signature verification on every delivery via `X-Hub-Signature-256` (ADR-001).
- Checks API output as the primary publication surface for advisory findings (ADR-001).
- App manifest, installation flow, and managed key/secret storage (ADR-001).

### Pipeline

- Deterministic prefilter that scopes diff context (paths, globs, generated-file detection, size rules) before any provider call (ADR-003).
- Provider call via abstraction, producing a `ProviderReviewOutput` schema instance validated by Zod at the adapter boundary (ADR-002).
- Validator that consumes `ProviderReviewOutput` and applies schema, structural, and reference checks (ADR-003).
- Ranker that orders surviving findings by severity, category, and the model-reported confidence signal (ADR-003).
- Publication cap that enforces per-PR cap, per-file cap, and severity floor against the ranked list (ADR-003).
- Duplicate-suppression key applied at the publication-cap stage to prevent republication across pushes, force-pushes, and webhook redeliveries (ADR-003).

### Provider abstraction

- A single typed Provider interface; no vendor SDK is imported outside its adapter (ADR-002).
- Zod-validated `ProviderReviewInput` and `ProviderReviewOutput` schemas at the adapter boundary (ADR-002).
- One reference adapter shipped with the MVP; the choice of first reference provider is open (see Open Question OQ-1) (ADR-002).
- A fake provider used by tests so that no live provider key is required to run the test suite (ADR-002).

### Repo-local configuration

- The configuration file path is `.github/review-bot.yml`, decided by the originating brief (ADR-003).
- Knobs exposed: include/exclude paths and globs, severity floor, per-PR cap, per-file cap (ADR-003).
- Default values for the per-PR cap, per-file cap, and severity floor are pending — see Open Question OQ-2 (ADR-003).
- Generated-file patterns (lockfiles, vendored content, build outputs) are configurable through path/glob rules (ADR-003).

### Observability and logging

- Structured logs for webhook receipt, pipeline stage transitions, and provider calls, with credential-bearing fields excluded by default (ADR-001).
- Rejection-reason log capturing every finding dropped by the validator, ranker, or publication cap, with the originating stage and reason (ADR-003).
- Choice of structured-logging backend / observability sink is pending — see Open Question OQ-3 (ADR-001).

## Non-goals (verbatim)

- no auto-merge
- no autofix
- no Slack/ClickUp/Jira write-backs
- no org dashboards
- no full code-graph platform
- no multi-agent complexity beyond optional verifier/ranker
- no provider lock-in
- no comment-on-everything

## Success criteria

- **Given** the App is installed on a test repository, **when** a pull request is opened, **then** the App posts at most the configured per-PR cap of findings via the Checks API, every published finding conforms to the validated `ProviderReviewOutput` schema, and every dropped finding appears in the rejection-reason log with a stage and reason.
- **Given** a pull request whose diff contains only generated-file or lockfile changes, **when** the App processes it, **then** the prefilter short-circuits the pipeline before any provider call and no findings are published.
- **Given** a pull request that has already been reviewed once, **when** the same PR is re-delivered (force-push, rebase, or webhook redelivery), **then** the duplicate-suppression key prevents republication of any finding that has already been published for that PR.
- **Given** a webhook delivery whose `X-Hub-Signature-256` does not validate against the App's webhook secret, **when** the webhook receiver processes it, **then** the receiver rejects the delivery and the worker performs no further work for it.
- **Given** the test suite is run with no live provider credentials, **when** the suite executes, **then** it passes end-to-end using the fake provider, exercising the full prefilter → provider → validator → ranker → publication-cap pipeline.

## Phase boundaries

Phase 1 ends when all 7 Phase 1 documents (research summary, ADR-001, ADR-002, ADR-003, threat model, MVP scope, open questions) exist at their specified paths and pass the acceptance criteria and consistency checks defined in the Phase 1 specification. Phase 2 begins with package scaffolding and contract tests: project skeleton, Provider interface module with Zod schemas and a fake adapter, prefilter and validator modules with unit tests, the ranker and publication-cap modules with deterministic tests, and the webhook receiver with a signature-verification test harness. No PR-visible artifact is produced before that contract-test layer is green.
