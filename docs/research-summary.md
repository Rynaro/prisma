# Research Summary — OSS Landscape and Integration Surface

## Scope and method

This is a desk review of four open-source projects in the AI code-review space — OpenReview, PR-Agent, ai-codereviewer, Kodus — supplemented by GitHub's public platform documentation (Apps, Actions, Webhooks, Checks API, REST/GraphQL). The review is comparative, not exhaustive: each project is characterized along the same dimensions so that later Phase 1 documents can reuse a single vocabulary.

Dimensions used throughout this document:

- Deployment model (GitHub App, GitHub Action, both, neither).
- Prefiltering posture (deterministic gating before any model call vs. send-the-whole-diff).
- Validation and ranking posture (raw model output vs. schema/structural validation vs. ranking before publication).
- Configuration surface (repo-local file presence and the knobs it exposes).
- Provider coupling (single hard-coded provider vs. abstracted adapter).
- Output surface (Checks runs, PR review comments, issue comments).

All project-specific claims below describe behavior at the architectural level. Implementation details (exact file names, version numbers, endpoint constants) are not asserted unless they are stable in GitHub's own platform docs. Project-level characterizations carry an inline `(unverified — Phase 1 desk review; confirm before relying on this in Phase 2)` qualifier where the claim could not be cross-checked against an authoritative public source within Phase 1's time budget.

## OSS landscape

### OpenReview

- Deployment model: research-oriented project; not packaged as a turnkey GitHub App or GitHub Action for PR review (unverified — Phase 1 desk review; confirm before relying on this in Phase 2).
- Prefilter behavior: project literature emphasizes structured review of full submissions rather than diff-aware prefiltering; therefore prefilter posture is best characterized as "not designed for diff-shaped inputs" (unverified — Phase 1 desk review; confirm before relying on this in Phase 2).
- Validation and ranking behavior: relies on structured review templates and human reviewer aggregation rather than deterministic post-model validation of LLM output (unverified — Phase 1 desk review; confirm before relying on this in Phase 2).
- Configuration surface: configuration is venue/conference-shaped, not repo-local; not directly comparable to a `.github/`-style file (unverified — Phase 1 desk review; confirm before relying on this in Phase 2).
- Provider coupling: research models and human reviewers; not a single LLM-vendor SDK pattern.
- Observed failure modes: relevant primarily as a reminder that review systems centered on humans-in-the-loop solve trust differently from automated reviewers; the failure modes that matter for our product are inherited from the next three projects.

### PR-Agent

- Deployment model: distributed both as a GitHub Action and as a hostable bot/App-style runner (unverified — Phase 1 desk review; confirm before relying on this in Phase 2).
- Prefilter behavior: applies diff-shaping and chunking heuristics before model calls, particularly to keep token usage bounded on large diffs (unverified — Phase 1 desk review; confirm before relying on this in Phase 2).
- Validation and ranking behavior: relies on prompt structure to constrain output and posts model output back to PRs; deterministic post-model validation appears limited (unverified — Phase 1 desk review; confirm before relying on this in Phase 2).
- Configuration surface: exposes repo-local configuration knobs covering models, prompt selection, and command behavior (unverified — Phase 1 desk review; confirm before relying on this in Phase 2).
- Provider coupling: pluggable across multiple LLM providers via internal adapters (unverified — Phase 1 desk review; confirm before relying on this in Phase 2).
- Observed failure modes (from public discussion): comment volume on large diffs, duplicate comments on re-runs, and provider-output schema variance under prompt drift.

### ai-codereviewer

- Deployment model: GitHub Action only (unverified — Phase 1 desk review; confirm before relying on this in Phase 2).
- Prefilter behavior: minimal — typically forwards the diff (or chunks of it) directly to the configured model without a deterministic gate beyond size truncation (unverified — Phase 1 desk review; confirm before relying on this in Phase 2).
- Validation and ranking behavior: posts model output as PR review comments without an independent deterministic validator or ranker stage (unverified — Phase 1 desk review; confirm before relying on this in Phase 2).
- Configuration surface: action inputs (model, exclude globs, etc.) declared in the consuming workflow file rather than a richer repo-local config schema (unverified — Phase 1 desk review; confirm before relying on this in Phase 2).
- Provider coupling: single hard-coded provider family in the canonical version (unverified — Phase 1 desk review; confirm before relying on this in Phase 2).
- Observed failure modes: noisy comments on large diffs, generated-file/lockfile commentary, provider lock-in.

### Kodus

- Deployment model: ships as a GitHub App-style integration with a hosted backend for review orchestration (unverified — Phase 1 desk review; confirm before relying on this in Phase 2).
- Prefilter behavior: performs path/scope filtering and review-shaping before invoking models (unverified — Phase 1 desk review; confirm before relying on this in Phase 2).
- Validation and ranking behavior: applies structural shaping and review-policy logic before posting (unverified — Phase 1 desk review; confirm before relying on this in Phase 2).
- Configuration surface: repo-local and/or org-level configuration covering review policies and model selection (unverified — Phase 1 desk review; confirm before relying on this in Phase 2).
- Provider coupling: provider-pluggable rather than single-vendor (unverified — Phase 1 desk review; confirm before relying on this in Phase 2).
- Observed failure modes (from public discussion): scope creep beyond pure code review, complexity of multi-agent compositions, operational cost of always-on review.

### Cross-project comparison matrix

| project | deployment | prefilter | validation/ranking | repo-local config | provider coupling | output surface |
| --- | --- | --- | --- | --- | --- | --- |
| OpenReview | not packaged for GitHub PR review | not diff-shaped | human/structured review aggregation | venue-shaped, not repo-local | research models / human reviewers | not applicable to GitHub PRs |
| PR-Agent | Action and hostable bot/App runner | chunking and size shaping | prompt-shaped, limited deterministic post-validation | repo-local config with model/prompt knobs | pluggable across providers | PR review comments and Checks/comments depending on mode |
| ai-codereviewer | GitHub Action only | minimal beyond size truncation | none independent of the prompt | action inputs in workflow file | single hard-coded provider family | PR review comments |
| Kodus | GitHub App-style hosted integration | path/scope filtering before model | structural and policy shaping pre-publish | repo-local and/or org-level config | provider-pluggable | PR comments via App-style integration |

(All project rows above are sourced from the per-project subsections; see the `(unverified — Phase 1 desk review; confirm before relying on this in Phase 2)` qualifiers attached there.)

## Integration surface findings

### GitHub App vs GitHub Action

GitHub Apps and GitHub Actions are different integration shapes for different problems. For an automated reviewer that posts findings on PRs across many repositories and installations, the App model differs from the Action model on at least:

- **Token model.** A GitHub App acts under an installation token minted per installation, with permissions declared in the App manifest. A GitHub Action runs inside a repository's workflow under `GITHUB_TOKEN`, scoped to that workflow run, with permissions defined per-job.
- **Checks API richness.** A GitHub App identity owns Checks runs it creates and can re-update them, surface annotations, and present status with App-level provenance. An Action can also create Checks under `GITHUB_TOKEN`, but the resulting Checks are attributed to the Actions identity in the consuming repo's workflow context rather than to a stable third-party App identity.
- **Rate-limit isolation.** GitHub Apps have App-level rate limits applied to their installation tokens, isolated from the repo's own usage and from Actions runner quotas. An Action shares limits with the repository's other Actions usage and `GITHUB_TOKEN` activity.
- **Multi-repo install UX.** A GitHub App can be installed once at an organization level and applied to many repositories; an Action must be added (or referenced) per repository workflow file, producing per-repo configuration sprawl.
- **Webhook ownership.** A GitHub App receives webhook events at an endpoint it owns and verifies, decoupled from any individual repo's CI configuration. An Action is triggered by repo-local workflow definitions and runs inside that repo's CI environment.

### Webhook lifecycle and signature handling

GitHub delivers events to an App's configured webhook endpoint over HTTPS. Each delivery carries a signature header derived from the App's webhook secret using HMAC-SHA-256, conventionally exposed as `X-Hub-Signature-256`. A receiver must:

1. Reject any request whose signature does not validate against the configured secret.
2. Treat each delivery as independently signed, but recognize that GitHub may retry deliveries; receivers must therefore be idempotent and resistant to replay (for example, by tracking delivery IDs and/or by ensuring downstream operations are keyed by event-derived identifiers rather than by re-execution).

Replay risk in plain terms: a bare signature check confirms the payload came from GitHub at some point; it does not by itself prevent the same legitimate delivery from being processed twice. Idempotency keying and short-window de-duplication are the standard mitigations.

### Checks API vs PR review comments vs issue comments

Three publication surfaces are commonly used for AI reviewer output:

- **Checks runs / Check annotations.** Best suited to advisory, non-blocking findings that should appear alongside other CI status. Findings are attached to a commit/PR via Checks runs, can carry annotations on specific files and lines, and are clearly attributed to the App identity.
- **PR review comments (line comments).** Tightly attached to a specific line and diff hunk; useful for actionable inline guidance, but inserts the bot directly into the human review thread, raising the cost of noise.
- **Issue comments on PRs.** Coarse-grained, not attached to a line; useful for summaries but easy to miss and easy to overflow into noise on long PR threads.

For an advisory, non-blocking reviewer, the Checks surface offers the best noise/visibility trade-off and the strongest App-identity attribution.

## Model and provider findings

### Output shape variance across providers

LLM providers diverge on output shape, JSON-mode guarantees, function-calling support, max-context windows, and error semantics. To remain vendor-independent, our pipeline must normalize provider output to a small, fixed set of fields. The minimum normalization fields are:

- `path` — file path the finding refers to.
- `line` — primary line (or line range) the finding refers to.
- `severity` — categorical severity level (e.g., `info`, `low`, `medium`, `high`).
- `category` — classification of the finding (e.g., correctness, security, style, performance).
- `message` — short human-readable statement.
- `rationale` — brief reasoning grounded in the diff context.
- `confidence` — model-reported confidence, used as a ranker signal, not a publication gate.

Providers diverge on whether they natively emit structured JSON, on how they signal refusals, on rate-limit and retry semantics, and on how they price input vs. output tokens. Any of these can change without notice; the abstraction's job is to absorb that change.

### Cost and latency observations

Token cost scales with prompt and completion size, and latency scales similarly. Sending whole diffs without prefiltering causes both to balloon on large PRs (vendored code, lockfiles, generated assets, mass renames). Prefiltering is therefore not just a quality control: it is the primary cost and latency control. A reviewer that does not prefilter cannot honor a per-PR cost budget under realistic PR-size distributions.

## Noise, trust, and developer experience findings

The four projects above and broader public discussion converge on a small set of recurring failure modes:

- **noisy comments / trust erosion** — when too many low-value findings are posted, developers stop reading the bot.
- **duplicate comments and reprocessing loops** — when the same finding is posted on every push, or when force-pushes/rebases trigger republication of identical findings.
- **large diff overload** — when the bot tries to review the entire PR including generated/vendored content, both quality and cost collapse.
- **generated files / lockfiles / vendored code** — automatically generated content draws disproportionate model attention and produces low-value commentary.

These four are the developer-experience failure modes; they recur in the threat model as risks with the same names.

## Implications for our design

Each bullet below is a seed for exactly one Phase 1 ADR; this section makes no decisions itself.

- The integration-surface findings (token model, Checks API richness, rate-limit isolation, multi-repo install UX, webhook ownership) seed ADR-001 (GitHub App as the chosen deployment shape).
- The provider-output variance findings (output shape divergence, capability variance, cost/latency variance, normalization field set) seed ADR-002 (a single typed provider abstraction that no vendor SDK escapes).
- The noise/trust findings (noisy comments / trust erosion, duplicate comments and reprocessing loops, large diff overload, generated files / lockfiles / vendored code) plus the cost-control role of prefiltering seed ADR-003 (prefilter, validator, ranker, publication cap as a single composed pipeline).
