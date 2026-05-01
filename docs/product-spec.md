# Product Specification — AI Code Review GitHub App

## Product summary

This product is a hosted GitHub App that posts advisory, non-blocking findings on pull requests across many installations and repositories. Configuration is repo-local at `.github/review-bot.yml`. The model layer is vendor-independent behind a single typed Provider abstraction; the first reference adapter is Anthropic Claude (Claude 4-class), located in `packages/providers/anthropic`. Every PR is processed by the deterministic pipeline `prefilter → provider → validator → ranker → publication cap` before any PR-visible artifact is created. The Checks API is the primary publication surface; inline review comments are an opt-in second surface enabled by mode. The product optimizes for trust over volume: a small number of high-signal findings rather than a high-volume comment stream.

## Personas

### Repo admin

- **Role.** Owns the App installation on a repository or organization, owns `.github/review-bot.yml`, and is responsible for choosing the operating mode and override values.
- **Primary need.** A single, auditable file that controls bot behavior, and predictable defaults that protect the repo on day one.
- **Frustration the App removes.** No more bot-config sprawl in workflow files; no surprise PR-visible output on first install.
- **What the App must never do to this persona.** Silently override admin-set values; produce PR-visible artifacts before the admin opts in beyond `dry-run`; require live provider credentials at install time.

### Reviewer

- **Role.** Reads the Checks summary and any inline comments produced by the App alongside a human review.
- **Primary need.** A short, ranked list of high-signal findings traceable to specific lines, with reasons for any drops they might want to inspect.
- **Frustration the App removes.** Comment-on-everything noise; duplicate comments on every push; commentary on lockfiles and vendored content.
- **What the App must never do to this persona.** Block the merge; publish findings without provenance to a touched hunk; speak in marketing language.

### PR author

- **Role.** Reads inline comments to revise the PR; reads the Checks summary to triage.
- **Primary need.** Inline comments anchored to the right line, with a concrete explanation and (optionally) a suggested fix that does not pretend to be an autofix.
- **Frustration the App removes.** Inline comments on lines they did not change; comments that re-appear on every force-push; multiple comments on the same line.
- **What the App must never do to this persona.** Open a follow-up PR; auto-merge; rewrite their code; post comments that are not anchored to a touched hunk.

## Operating modes

### dry-run

- **What is published.** Nothing PR-visible. The pipeline runs end-to-end and emits `RankedFindings` and rejection log entries to the structured log; no findings are surfaced to reviewers or PR authors.
- **Where it is published (Checks summary / inline review comment / both / neither).** Neither. A single Checks run with `neutral` conclusion and a "dry-run; no findings published" body is acceptable; inline comments are never created.
- **Default applicability (default for new installs? opt-in?).** Default for newly installed repos. Selected automatically when `.github/review-bot.yml` is missing or does not override `mode`.
- **Risk posture (why a repo would choose this).** Maximally conservative. Lets a repo admin observe pipeline behavior and tune configuration before any reviewer or PR author sees output.

### summary-only

- **What is published.** A Checks run with a Markdown summary listing findings whose `severity` meets the inline severity floor and whose `confidence` meets the inline confidence floor.
- **Where it is published (Checks summary / inline review comment / both / neither).** Checks summary only. No inline review comments are created regardless of cap state.
- **Default applicability (default for new installs? opt-in?).** Opt-in via `.github/review-bot.yml`.
- **Risk posture (why a repo would choose this).** Trust-building. Findings are visible in a single attributed surface owned by the App identity; the human review thread is left untouched.

### summary-plus-inline

- **What is published.** A Checks run summary listing all eligible findings, plus inline review comments for findings that pass thresholds and survive caps.
- **Where it is published (Checks summary / inline review comment / both / neither).** Both. Inline candidates are findings whose `severity` meets the inline severity floor and whose `confidence` meets the inline confidence floor; per-file and per-PR caps are then applied.
- **Default applicability (default for new installs? opt-in?).** Opt-in via `.github/review-bot.yml`.
- **Risk posture (why a repo would choose this).** Highest signal-to-action: actionable inline guidance is delivered where authors revise, with strict caps and floors to keep volume low.

## Core flows

### Install the App

- **Trigger.** A repo admin installs the App on a repository or organization.
- **Actors.** Repo admin; GitHub; the App installation flow.
- **Preconditions.** The repo admin has permission to install GitHub Apps on the target organization or repository.
- **Steps.**
  1. The admin selects the App from the GitHub Marketplace or App page and grants the App's declared permissions.
  2. GitHub mints an installation and notifies the App via an installation event.
  3. The App records the installation. No webhook for `pull_request` is acted on until the next eligible PR event arrives.
  4. Mode resolves to `dry-run` for any repository under this installation that does not provide a `.github/review-bot.yml` overriding it.
- **Success state.** The App is installed; no PR-visible artifact has been produced; the next PR event will be processed end-to-end through the `prefilter → provider → validator → ranker → publication cap` pipeline in `dry-run` by default.
- **Failure state.** Installation declined or permissions revoked mid-flow; the App records nothing further and processes no events for that installation.
- **Rollback.** The admin uninstalls the App; the App stops receiving webhook deliveries for that installation. Already-published Checks runs and inline comments are not retracted by uninstall (cleanup is post-MVP).

### Configure the provider

- **Trigger.** A repo admin commits or updates `.github/review-bot.yml`.
- **Actors.** Repo admin; the App's config resolution path.
- **Preconditions.** The App is installed on the repository.
- **Steps.**
  1. The admin commits a YAML file at `.github/review-bot.yml` with a chosen `mode`, optional thresholds, optional caps, and optional `provider` and `model` keys.
  2. The next accepted PR webhook delivery causes the worker to read the file from the head ref and resolve effective configuration: built-in defaults, then repo-local file, then per-PR overrides.
  3. The provider adapter id (default `anthropic`) and any `model` value are passed to the provider stage as part of `ProviderReviewInput`'s request-shaping section.
- **Success state.** Subsequent PR events run under the new configuration. No prior runs are retroactively re-evaluated.
- **Failure state.** The file is malformed or contains type-mismatched values for known keys: the worker rejects the file, falls back to built-in defaults, and emits a Checks summary explaining the rejection.
- **Rollback.** The admin reverts the file in a new commit; the next webhook delivery picks up the prior configuration.

### Open a PR (auto-review)

- **Trigger.** `pull_request.opened` event delivered to the App's webhook endpoint.
- **Actors.** PR author; GitHub; the App's webhook receiver and worker; the configured provider; reviewer.
- **Preconditions.** App installed; signature on the delivery validates against the App's webhook secret.
- **Steps.**
  1. The webhook receiver verifies the signature, derives an idempotency key, and enqueues a job; it returns a 2xx response.
  2. The worker resolves configuration from `.github/review-bot.yml` and runs the `prefilter` stage to scope the diff.
  3. If the prefilter has anything to review, the `provider` stage produces a `ProviderReviewOutput`; the `validator` stage produces `NormalizedFinding[]`; the `ranker` stage produces `RankedFindings`; the `publication cap` stage applies thresholds and caps.
  4. The publisher branches by mode:
     - `dry-run`: nothing PR-visible is published; `RankedFindings` and rejection log entries are emitted to the structured log only.
     - `summary-only`: a Checks run with a Markdown summary is created; no inline comments are created.
     - `summary-plus-inline`: a Checks run summary is created and inline review comments are created for findings that pass thresholds and survive `comment_cap.per_file` then `comment_cap.per_pr`.
- **Success state.** The job terminates with a `succeeded` state. Any PR-visible artifact has been created exactly once.
- **Failure state.** The provider stage returns a non-transient error, or `ProviderReviewOutput` fails Zod validation at the adapter boundary: the job terminates `failed_terminal`; the publisher emits a Checks run with `neutral` conclusion and a category-only failure body.
- **Rollback.** None. PR-visible artifacts are not retroactively edited or deleted by MVP.

### Dry-run review

- **Trigger.** Any accepted PR event when effective `mode` is `dry-run`.
- **Actors.** The App's worker; structured-logging surface.
- **Preconditions.** Effective configuration resolves `mode = dry-run`.
- **Steps.**
  1. The webhook receiver verifies the signature and enqueues the job.
  2. The worker runs `prefilter → provider → validator → ranker → publication cap` end-to-end as in any other mode.
  3. The `publication cap` stage computes thresholds and caps for audit but the publisher does not create inline comments and does not render a findings-bearing Checks summary.
- **Success state.** `RankedFindings` and any rejection log entries appear in the structured log; no PR-visible findings are surfaced.
- **Failure state.** Same as for any other mode (provider error, malformed output): a Checks run with `neutral` conclusion and a category-only failure body may be emitted.
- **Rollback.** None required; no PR-visible artifact was created.

### Re-run a review

- **Trigger.** `pull_request.synchronize` or `pull_request.reopened` event for a PR the App has already reviewed.
- **Actors.** PR author or GitHub redelivery mechanism; the App's webhook receiver and worker; the publisher's per-PR dedupe set.
- **Preconditions.** The App has previously processed this PR; an accepted webhook event arrives with a new `head_sha` (for `synchronize`) or with the prior head (for redeliveries).
- **Steps.**
  1. The webhook receiver verifies the signature, derives the idempotency key, and enqueues the job. If the idempotency key has already been processed for the same `head_sha`, the job resolves as `discarded_idempotent`.
  2. Otherwise, `prefilter → provider → validator → ranker → publication cap` runs end-to-end against the new diff.
  3. The publisher consults a per-PR dedupe set sourced from the App's prior Checks runs and inline review comments on this PR. Any candidate inline finding whose `dedupe_key` (defined in `review-findings-schema.md`) is already present is not re-published.
  4. Findings whose lines no longer appear in the diff are dropped at the validator stage; the publisher does not edit or delete prior inline comments in MVP.
- **Success state.** New findings (whose `dedupe_key` is not already published) are surfaced according to the current mode; previously published findings are not duplicated.
- **Failure state.** Same as for the open-a-PR flow: provider errors or malformed output produce a `neutral` Checks summary; no inline comments are created.
- **Rollback.** None. Stale inline comments persist until a future MVP+ cleanup capability is added.

### Inspect the Checks summary

- **Trigger.** A reviewer or PR author opens the Checks tab on a PR the App has reviewed.
- **Actors.** Reviewer or PR author; GitHub UI; the App's prior Checks run output.
- **Preconditions.** The App has produced a Checks run for the PR (in `summary-only` or `summary-plus-inline` modes, or a `neutral` `dry-run`/failure run).
- **Steps.**
  1. The reader navigates to the Checks tab.
  2. The reader reads the App-attributed Check run's summary Markdown, which lists findings with their `severity`, `category`, and rendered headline; per finding, the summary indicates whether it is `published inline`, dropped from inline due to caps, or below the inline floors.
  3. The reader follows annotations or inline comment links from the summary into the diff view.
- **Success state.** The reader has a single ranked view of all findings produced for the current `head_sha`.
- **Failure state.** The Checks run is missing (e.g., no run was created for `dry-run` or the run failed to publish). The reader sees no App output.
- **Rollback.** None.

### Inspect inline comments

- **Trigger.** A reviewer or PR author opens the Files Changed tab on a PR processed in `summary-plus-inline` mode.
- **Actors.** Reviewer or PR author; GitHub UI; the App's prior inline review comments.
- **Preconditions.** The PR was processed in `summary-plus-inline` and at least one finding survived caps.
- **Steps.**
  1. The reader navigates to the Files Changed tab.
  2. Inline review comments authored by the App appear anchored to the line ranges declared in each `NormalizedFinding`.
  3. The reader reads the rendered title, explanation, and (when present) the suggested fix.
- **Success state.** The reader sees at most one inline comment per file from the App, and at most the configured per-PR cap of inline comments across the PR.
- **Failure state.** No inline comments are present (mode is not `summary-plus-inline`, or no findings survived thresholds and caps). The reader sees no inline App output.
- **Rollback.** None. The App does not edit or delete its own inline comments in MVP.

## Out-of-scope behaviors (non-goals reference)

The following behaviors are explicitly NOT product features and are upheld in product UX as described:

- **no auto-merge** — the App is advisory and non-blocking; it never approves or merges a PR.
- **no autofix** — the App posts findings only; it never opens follow-up PRs and never rewrites code.
- **no Slack/ClickUp/Jira write-backs** — output never leaves GitHub; the only publication surfaces are Checks runs and inline review comments.
- **no org dashboards** — there is no separate UI surface; reviewers see output in the PR's Checks and Files Changed tabs only.
- **no full code-graph platform** — the App reasons about a PR's diff, not about the repository as a whole; no symbol index or cross-repo graph is built.
- **no multi-agent complexity beyond optional verifier/ranker** — the pipeline is `prefilter → provider → validator → ranker → publication cap`; only an optional verifier and a stronger ranker are accepted as future additive extensions.
- **no provider lock-in** — the model layer is vendor-independent behind the Provider abstraction; the first reference adapter is Anthropic Claude, but no vendor SDK type leaks outside `packages/providers/anthropic`.
- **no comment-on-everything** — caps and floors are first-class; even valid findings beyond the cap are deliberately dropped to protect signal-to-noise.

## Glossary

- **Finding.** A single piece of advisory feedback about a specific location in a PR's diff. The validated, audit-bearing form of a finding is `NormalizedFinding`.
- **NormalizedFinding.** The schema produced by the validator stage and consumed by the ranker and publisher. Strictly richer than `ProviderReviewOutput`: carries audit fields the provider does not produce (`dedupe_key`, `render_target`, `source_artifacts_used`, `validator_notes`). Defined in `review-findings-schema.md`.
- **Inline comment.** A line-anchored review comment authored by the App, created only in `summary-plus-inline` mode.
- **Checks summary.** The Markdown body of an App-owned Checks run, attached to a PR's `head_sha` and listing findings produced for that head.
- **Mode.** The deterministic ruleset that selects what is published and where. Allowed values: `dry-run`, `summary-only`, `summary-plus-inline`. Defined in this document and re-used verbatim in `config-spec.md`, `api-contracts.md`, and `publication-policy.md`.
- **Cap.** A non-negative integer maximum on the number of inline comments. The App enforces a per-file cap and a per-PR cap, in that order, against the ranked finding list.
- **Severity floor.** The minimum `severity` (in the closed vocabulary `info`/`low`/`medium`/`high`/`critical`) at which a finding becomes eligible for inline publication.
- **Confidence floor.** The minimum provider-reported `confidence` (a number in `[0,1]`) at which a finding becomes eligible for inline publication.
- **dedupe_key.** A deterministic string derived from a finding's location and content, used by the publisher to suppress duplicate publication within a run and across runs. Full definition in `review-findings-schema.md`.
