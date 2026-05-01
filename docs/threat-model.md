# Threat Model — AI Code Review GitHub App

## Scope and assumptions

This document enumerates security, abuse, and trust risks for the AI code review product and binds each risk to a named mitigation defined in ADR-001, ADR-002, or ADR-003. Risks without an ADR-anchored mitigation are flagged as residual or deferred and routed to `open-questions.md`.

Operating assumptions:

- The product runs as a hosted GitHub App with a webhook receiver and one or more workers; `GITHUB_TOKEN`-only Action execution is not in scope (per ADR-001).
- App private keys, webhook secrets, and provider credentials are stored in a managed secret store and rotated. Long-lived plaintext secrets in code or config are not in scope.
- LLM providers are treated as external untrusted-output sources: any data returned over the wire from a provider is unvalidated until the adapter's Zod schema accepts it (per ADR-002).
- Repo-local configuration is read from `.github/review-bot.yml` in the target repository and is treated as untrusted-by-default input (it ships with PRs and can be changed by anyone with write access to the repo).
- Findings are advisory and non-blocking; the App never auto-merges, never opens follow-up PRs, and never writes back to external systems (per the brief's non-goals).

## Trust boundaries

- **GitHub → our webhook receiver.** Inbound webhook deliveries cross the network boundary from GitHub to our hosted endpoint. The receiver authenticates each delivery via HMAC-SHA-256 (`X-Hub-Signature-256`) against the App's webhook secret.
- **Our worker → LLM provider.** Outbound calls from our worker to an external LLM provider over HTTPS. The provider's response is treated as untrusted input until validated.
- **Our worker → GitHub API.** Outbound calls from our worker to the GitHub API using installation tokens. Token scope is constrained by the App manifest's declared permissions.
- **Repo-local config → our worker.** The `.github/review-bot.yml` file is read from the target repository. It crosses a trust boundary: we control the schema, but we do not control the contents.

Not enumerated as separate boundaries but implicit: secret store → worker (for credential retrieval) and observability sink ← worker (for log/metric emission).

## Risk register

### Hallucinated findings

- **Description.** The model emits findings that look plausible but reference paths, lines, or symbols that do not exist in the diff.
- **Attack/failure scenario.** A PR is opened; the model returns a finding citing `src/foo.ts:42` for behavior that is not in the diff (or in the file at all). Without checks, this finding becomes a PR comment that wastes reviewer time and erodes trust.
- **Impact.** Trust erosion; reviewer fatigue; in repeated cases, the bot is muted or uninstalled.
- **Likelihood.** High in the absence of deterministic checks; intrinsic to current model behavior.
- **Mitigation.** Validator stage with structural and reference checks (path exists in the diff, line is within a touched hunk, cited symbols appear in context); rejection-reason log captures drops (ADR-003).
- **Status.** Mitigated.

### Noisy comments / trust erosion

- **Description.** Even when individually valid, an excess of findings produces signal-to-noise collapse and developers stop reading the bot.
- **Attack/failure scenario.** A large refactor PR yields dozens of low-severity findings; the bot publishes all of them; the team learns to ignore the bot.
- **Impact.** Direct trust erosion; degrades the product's core value proposition.
- **Likelihood.** High by default on real-world PR-size distributions.
- **Mitigation.** Ranker plus publication cap (per-PR cap, per-file cap, severity floor); duplicate-suppression key (ADR-003).
- **Status.** Mitigated.

### Large diff overload

- **Description.** Sending whole large diffs to the model degrades quality, latency, and cost simultaneously.
- **Attack/failure scenario.** A PR includes a vendored dependency update or generated assets; the unprefiltered diff balloons to tens of thousands of lines; the model produces low-quality output and the cost spikes.
- **Impact.** Quality collapse; cost overrun; latency that breaks the advisory experience.
- **Likelihood.** High on real PR-size distributions without prefiltering.
- **Mitigation.** Deterministic prefilter that scopes diff context (paths, globs, generated-file detection, size rules) before any provider call (ADR-003).
- **Status.** Mitigated.

### Schema drift from provider output

- **Description.** A provider changes its output shape, JSON-mode behavior, or refusal semantics without notice; downstream stages receive shape-incompatible data.
- **Attack/failure scenario.** A provider rolls out a model update that changes the structure of its JSON responses; with direct SDK calls scattered through the pipeline, validators or rankers crash mid-PR; with no central seam, the failure manifests at multiple sites.
- **Impact.** Pipeline breakage; partial publication of malformed findings if not caught; on-call burden.
- **Likelihood.** Medium and recurring; provider output shapes are not stable contracts.
- **Mitigation.** Single Provider adapter as the only place a vendor SDK is imported; `ProviderReviewOutput` schema validated by Zod at the adapter boundary; downstream stages depend on the validated schema, not on raw provider responses (ADR-002).
- **Status.** Mitigated.

### Webhook replay or signature failures

- **Description.** Webhook deliveries are accepted without signature verification, or a legitimate delivery is processed more than once.
- **Attack/failure scenario.** An attacker forges or replays a webhook delivery to trigger spurious reviews, or a benign GitHub retry causes the same delivery to be processed twice and produce duplicate work.
- **Impact.** Spurious reviews, duplicate publications, cost burn, possible exposure of unrelated PRs.
- **Likelihood.** Without signature verification: high. With signature verification but no idempotency: medium for duplicates.
- **Mitigation.** HMAC-SHA-256 signature verification on every delivery via `X-Hub-Signature-256` and the App's webhook secret; delivery-ID-based idempotency keying so a replayed delivery is a no-op (ADR-001).
- **Status.** Mitigated.

### Secret leakage

- **Description.** App private keys, webhook secrets, installation tokens, or provider credentials are exposed in logs, error messages, or downstream artifacts.
- **Attack/failure scenario.** A worker logs the full HTTP request headers including `Authorization`, or includes provider response bodies that contain echoed credentials, in a structured log shipped to an observability sink.
- **Impact.** Credential compromise; potential takeover of the App or the provider account.
- **Likelihood.** Medium if logging is unconstrained; low with explicit log-redaction discipline.
- **Mitigation.** Managed secret store for keys, secrets, and tokens (consequence of ADR-001's hosting requirement); structured-logging discipline that excludes credential-bearing fields by default (observability sink choice is open — see Open Question OQ-3).
- **Status.** Partially mitigated.

### Token/cost blowups

- **Description.** Provider token usage grows unbounded under unusual PR shapes or feedback loops, producing cost overruns.
- **Attack/failure scenario.** A repository attaches the App and submits a series of large auto-generated PRs (e.g., a rebase storm or a vendored-dependency upgrade), each of which is reviewed in full; cost grows linearly with PR size and PR count.
- **Impact.** Cost overrun; budget exhaustion; potential service degradation if rate-limit headroom is consumed.
- **Likelihood.** Medium; both adversarial and accidental triggers exist.
- **Mitigation.** Deterministic prefilter as the primary cost control, scoping diff context before any provider call (ADR-003); App-level rate-limit isolation reduces collateral damage to GitHub API call budgets (ADR-001). Per-installation cost ceilings and per-PR token budgets are deferred (see Open Question OQ-2 for cap defaults; broader cost-ceiling mechanics are routed to the open-questions backlog).
- **Status.** Partially mitigated.

### Privacy exposure from over-shared code context

- **Description.** More repository content than necessary is sent to the LLM provider.
- **Attack/failure scenario.** A worker, in an attempt to "give the model more context", includes whole files or unrelated repo content alongside the diff hunks; that content leaves our trust boundary on its way to the provider.
- **Impact.** Data leaving the worker → provider boundary unnecessarily; potential exposure of secrets-in-source, proprietary code, or content excluded by repo policy.
- **Likelihood.** Medium without explicit scoping discipline.
- **Mitigation.** Deterministic prefilter scopes the diff context to the minimum needed for review (selected files, selected hunks); `ProviderReviewInput` schema makes the over-the-wire payload explicit and bounded (ADR-002, ADR-003).
- **Status.** Partially mitigated.

### Generated files / lockfiles / vendored code

- **Description.** Auto-generated content (lockfiles, build outputs, vendored dependencies) draws disproportionate model attention, producing low-value commentary and inflating cost.
- **Attack/failure scenario.** A routine `package-lock.json` or `vendor/` change in a PR is forwarded to the model; the model dutifully comments on the lockfile, producing noise.
- **Impact.** Noise, cost burn, trust erosion.
- **Likelihood.** High by default — generated content appears in most non-trivial PRs.
- **Mitigation.** Deterministic prefilter rules excluding generated-file patterns (paths, globs, generated-file detection) before any provider call; configurable in `.github/review-bot.yml` (ADR-003).
- **Status.** Mitigated.

### Duplicate comments and reprocessing loops

- **Description.** The same finding is published multiple times across pushes, force-pushes, rebases, or webhook redeliveries.
- **Attack/failure scenario.** A developer force-pushes a branch; the App reprocesses the PR and republishes the same finding under a new comment, multiplying noise on every push.
- **Impact.** Noise, trust erosion, cost burn from re-reviewing unchanged content.
- **Likelihood.** High by default given GitHub's redelivery behavior and normal developer workflows.
- **Mitigation.** Duplicate-suppression key in the publication-cap stage, keyed on finding identity for the PR; webhook-delivery idempotency keying upstream (ADR-001, ADR-003).
- **Status.** Mitigated.

## Mitigation matrix

| risk | mechanism | source ADR | status |
| --- | --- | --- | --- |
| Hallucinated findings | validator with structural and reference checks; rejection-reason log | ADR-003 | mitigated |
| Noisy comments / trust erosion | ranker; publication cap (per-PR, per-file, severity floor); duplicate-suppression key | ADR-003 | mitigated |
| Large diff overload | deterministic prefilter (paths, globs, generated-file detection, size rules) | ADR-003 | mitigated |
| Schema drift from provider output | single Provider adapter; Zod-validated `ProviderReviewOutput` at the adapter boundary | ADR-002 | mitigated |
| Webhook replay or signature failures | HMAC-SHA-256 webhook signature verification (`X-Hub-Signature-256`); delivery-ID idempotency keying | ADR-001 | mitigated |
| Secret leakage | managed secret store for App key, webhook secret, provider credentials; observability-sink choice deferred (see Open Question OQ-3) | ADR-001 | partially mitigated |
| Token/cost blowups | deterministic prefilter as cost gate; App-level rate-limit isolation; per-PR caps deferred (see Open Question OQ-2) | ADR-001, ADR-003 | partially mitigated |
| Privacy exposure from over-shared code context | deterministic prefilter scopes diff context; `ProviderReviewInput` schema bounds payload | ADR-002, ADR-003 | partially mitigated |
| Generated files / lockfiles / vendored code | deterministic prefilter excludes generated-file patterns | ADR-003 | mitigated |
| Duplicate comments and reprocessing loops | duplicate-suppression key in publication cap; webhook-delivery idempotency keying | ADR-001, ADR-003 | mitigated |

## Residual risk and deferred items

- **Cost-ceiling enforcement beyond prefilter and rate-limit isolation.** Per-installation cost budgets, per-PR token budgets, and the choice of cap defaults are not yet decided. See Open Question OQ-2 (cap defaults). Status: partially mitigated.
- **Observability-sink and log-redaction posture.** A specific structured-logging backend has not been chosen; the discipline ("no credentials in logs") is decided, the sink is not. See Open Question OQ-3. Status: partially mitigated.
- **First reference provider adapter.** The choice of which LLM provider becomes the first adapter is not yet made; until it is, the schema-drift mitigation is contractually defined but not exercised against a real wire. See Open Question OQ-1. Status: mitigated by design, pending first concrete adapter.
