# Phase 2 Specification — Product Specification

> **Audience:** IDG (the agent that will compose the Phase 2 documents).
> **Status:** Contract only. IDG fills the bodies; SPECTRA defines structure, content requirements, and acceptance gates.
> **Source of truth for prior decisions:** Phase 1 docs (`docs/_planning/phase-1-spec.md`, `docs/research-summary.md`, ADRs 001/002/003, `docs/threat-model.md`, `docs/mvp-scope.md`, `docs/open-questions.md`). Phase 2 must not contradict any of them.

---

## Phase 2 Work Plan (≤ 300 words)

**Authoring order (strict):**

1. `docs/product-spec.md` — establishes personas, user-visible flows, and the canonical definitions of the three operating modes (`dry-run`, `summary-only`, `summary-plus-inline`). Every later Phase 2 doc references those mode names.
2. `docs/config-spec.md` — depends on `product-spec.md` for the mode vocabulary; locks `.github/review-bot.yml` key tree, defaults (OQ-2), validation rules in plain English, resolution order, and the worked example.
3. `docs/review-findings-schema.md` — depends on Phase 1's `ProviderReviewOutput` (the validator's input) and on `config-spec.md`'s severity vocabulary. Defines the **NormalizedFinding** schema produced by the validator and consumed by the ranker and publisher.
4. `docs/api-contracts.md` — depends on the NormalizedFinding name from #3 and the mode names from #1. Defines webhook ingress, async-job, provider-adapter, validator, ranker, and publisher contracts as TypeScript-style sketches with named input/output schemas, error shapes, and invariants.
5. `docs/publication-policy.md` — depends on #1 (modes), #2 (caps + thresholds), #3 (`dedupe_key`, `render_target`, severity/confidence fields), and #4 (publisher contract). Specifies, per mode, what is published, where, with which thresholds and caps, plus dedupe and fallback behavior.

**File dependencies (claim flow):**
product-spec → config-spec → review-findings-schema → api-contracts → publication-policy.

**Consistency-check pass before exit:** A name-level diff confirms (a) every schema identifier introduced (`NormalizedFinding`, `RankedFindings`, `PublicationResult`, `JobPayload`, `RejectionLogEntry`) appears identically in every doc that references it; (b) the three mode names are spelled identically across all five docs and Phase 1; (c) every OQ-2 default (`5`, `1`, `medium`, `0.7`, `dry-run`) appears in `config-spec.md` and is reused without re-declaration in `publication-policy.md`; (d) every Phase 1 identifier (`ProviderReviewInput`, `ProviderReviewOutput`, `ProviderError`, `ProviderCapabilities`, `.github/review-bot.yml`, pipeline stage names) is reused verbatim; (e) `docs/open-questions.md` § Resolution log contains the OQ-1 and OQ-2 entries below.

**Phase 2 exit gate (testable):** All 5 files exist at their specified paths; every acceptance criterion in the YAML block at the end of this spec evaluates true; every consistency check produces zero violations; OQ-1 and OQ-2 are recorded in the Resolution log of `docs/open-questions.md`; OQ-3 remains unresolved and is explicitly deferred to Phase 3.

---

## Resolution log entries for Phase 1 OQ-1 and OQ-2

IDG must append the two blocks below verbatim to `docs/open-questions.md` § Resolution log. The `## Open questions` section must also be updated so that OQ-1 and OQ-2 are moved (verbatim, with their original entry shape preserved) into the resolution log with the resolution appended; OQ-3 remains in `## Open questions` unchanged.

### Resolution log entry for OQ-1

```
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
```

### Resolution log entry for OQ-2

```
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
```

### Update to OQ-3

OQ-3 (observability sink) **remains open**. Phase 2 does not invent a backend; it only specifies that structured-logging emission and rejection-reason logging are called out by the relevant contracts (the publisher and the validator each emit a rejection log; the sink they emit to is Phase 3's concern, recorded in `docs/observability.md`). IDG must leave OQ-3 in `## Open questions` with a one-line note referencing this Phase 2 deferral.

---

## File 1 — `docs/product-spec.md`

### 1. Purpose

The user-facing product reference: who uses the App, what they do, what each user-visible flow looks like, and the canonical definitions of the three operating modes referenced by every other Phase 2 doc. Consumed by reviewers, repo admins, PR authors, and by all four other Phase 2 documents that need to spell mode names identically.

### 2. Required sections (exact H2/H3 in order)

- `## Product summary`
- `## Personas`
  - `### Repo admin`
  - `### Reviewer`
  - `### PR author`
- `## Operating modes`
  - `### dry-run`
  - `### summary-only`
  - `### summary-plus-inline`
- `## Core flows`
  - `### Install the App`
  - `### Configure the provider`
  - `### Open a PR (auto-review)`
  - `### Dry-run review`
  - `### Re-run a review`
  - `### Inspect the Checks summary`
  - `### Inspect inline comments`
- `## Out-of-scope behaviors (non-goals reference)`
- `## Glossary`

### 3. Research questions answered (concrete, falsifiable)

- Who are the three personas the product is built for and what does each one need from a single PR review?
- What is the canonical definition of each operating mode (`dry-run`, `summary-only`, `summary-plus-inline`), and which mode is the default for newly installed repos?
- For each core flow, what is the trigger, who are the actors, what are the preconditions, what are the steps in order, what is the success state, what is the failure state, and what is the rollback?
- Which behaviors are explicitly NOT product features (must point to the verbatim non-goals in `mvp-scope.md`)?

### 4. Required content per section

- **Product summary:** one paragraph, no marketing language. Must mention: GitHub App, advisory non-blocking findings, repo-local config at `.github/review-bot.yml`, vendor-independent provider layer (reference adapter is Anthropic Claude per OQ-1 resolution), the `prefilter → provider → validator → ranker → publication cap` pipeline, Checks API as the primary publication surface.
- **Personas:** one subsection per persona. Each must list `Role`, `Primary need`, `Frustration the App removes`, `What the App must never do to this persona`. Repo admin owns config and install; Reviewer reads Checks output and inline comments; PR author reads inline comments to revise.
- **Operating modes:** one subsection per mode. Each must define, in this order: `What is published`, `Where it is published (Checks summary / inline review comment / both / neither)`, `Default applicability (default for new installs? opt-in?)`, `Risk posture (why a repo would choose this)`. The three names `dry-run`, `summary-only`, `summary-plus-inline` are the canonical strings; do not introduce synonyms. `dry-run` is the default for newly installed repos (per OQ-2 resolution).
- **Core flows:** seven subsections, each describing the flow as a numbered step list with the following sub-headings, in this order: `Trigger`, `Actors`, `Preconditions`, `Steps`, `Success state`, `Failure state`, `Rollback`. Every flow's steps must reference the pipeline stages (`prefilter`, `provider`, `validator`, `ranker`, `publication cap`) by name where they apply. The "Open a PR (auto-review)" flow must enumerate all three modes' branching behavior explicitly. The "Re-run a review" flow must explicitly call out dedupe-on-`synchronize` and reference the `dedupe_key` field defined in `review-findings-schema.md`.
- **Out-of-scope behaviors (non-goals reference):** must list the eight non-goals from `mvp-scope.md` verbatim, in the same order, with a one-line explanation of how each non-goal is upheld in product UX (e.g., "no autofix" → the App posts findings only; it never opens follow-up PRs).
- **Glossary:** must define at least: `Finding`, `NormalizedFinding`, `inline comment`, `Checks summary`, `mode`, `cap`, `severity floor`, `confidence floor`, `dedupe_key`. Each glossary entry must be one or two sentences.

### 5. Acceptance criteria (GIVEN/WHEN/THEN)

See YAML block (IDs `PS-1` … `PS-6`).

### 6. Cross-file consistency requirements

- The three mode names (`dry-run`, `summary-only`, `summary-plus-inline`) appear in `config-spec.md` (as `mode` enum values), `api-contracts.md` (referenced by the publisher contract), and `publication-policy.md` (one section per mode), spelled identically.
- The non-goals list is byte-equivalent to the list in `mvp-scope.md` § Non-goals (verbatim), in the same order.
- The pipeline stage names (`prefilter`, `provider`, `validator`, `ranker`, `publication cap`) match ADR-003 § Pipeline shape verbatim.
- Reference adapter name (Anthropic Claude / `packages/providers/anthropic`) matches the OQ-1 resolution log entry.
- `dedupe_key` is referenced here only by name; its full definition lives in `review-findings-schema.md`.

### 7. Out of scope for this file

- No YAML config keys (those live in `config-spec.md`).
- No schema field types or validation rules (those live in `review-findings-schema.md`).
- No HTTP method/path or contract sketch (those live in `api-contracts.md`).
- No cap math or worked dedupe example (those live in `publication-policy.md`).
- No new architectural decisions; flows describe behavior consistent with ADRs 001–003.

---

## File 2 — `docs/config-spec.md`

### 1. Purpose

The single source of truth for the `.github/review-bot.yml` repo-local configuration: every key, its type, default, validation rule (in plain English), and resolution order. Consumed by repo admins (who write the file) and by the implementer (Phase 4) who will write the Zod schema for it.

### 2. Required sections (exact H2/H3 in order)

- `## File location and ownership`
- `## Resolution order`
- `## Key reference`
  - `### enabled`
  - `### mode`
  - `### provider`
  - `### model`
  - `### thresholds`
  - `### comment_cap`
  - `### path_rules`
  - `### exclude_generated`
  - `### exclude_vendored`
  - `### max_files`
  - `### max_changed_lines`
  - `### categories_enabled`
  - `### severity`
  - `### language_overrides`
  - `### repo_heuristics`
- `## Precedence matrix`
- `## Worked example (verbatim block)`
- `## Failure modes`

### 3. Research questions answered

- Where is the config file located, who owns it, and what is the trust posture (it ships with PRs)?
- What is the resolution order between built-in defaults, the repo-local file, and any per-PR overrides?
- For every key in the tree: what is its type, is it required or optional, what is its default, what does its validation rule say in plain English, and what is a representative example?
- When two filtering keys conflict (e.g., `path_rules` includes a path that `exclude_generated` would exclude), which one wins?
- What are the OQ-2-resolved default values for `mode`, `comment_cap.per_pr`, `comment_cap.per_file`, `thresholds.severity_floor.inline`, and `thresholds.confidence_floor.inline`?

### 4. Required content per section

- **File location and ownership:** must state the path is `.github/review-bot.yml` (decided in the brief, locked in `mvp-scope.md`), that the file is checked into the target repository, and that it is treated as untrusted-by-default input (per `threat-model.md` § Scope and assumptions).
- **Resolution order:** an ordered list — (1) built-in defaults shipped with the App, (2) repo-local `.github/review-bot.yml`, (3) per-PR overrides if any (Phase 4 may or may not implement #3; Phase 2 declares the order so #3 has a defined slot). Each layer overrides the previous on a per-key basis (deep merge for objects, replacement for scalars and arrays).
- **Key reference:** one subsection per key. Each subsection must contain, in this exact order: `Type`, `Required`, `Default`, `Validation rule (plain English)`, `Example`. Defaults must reflect the OQ-2 resolution where applicable (see below). Concrete content per key:
  - `enabled` — boolean; optional; default `true`; validation: must be a boolean; example: `enabled: true`.
  - `mode` — string enum; optional; default `dry-run` (per OQ-2); allowed values `dry-run` | `summary-only` | `summary-plus-inline`; validation: value must be one of the three strings, case-sensitive; example: `mode: summary-plus-inline`.
  - `provider` — string; optional; default `anthropic` (per OQ-1); validation: must be a known adapter id; example: `provider: anthropic`.
  - `model` — string; optional; default unset (resolved from deployment config); validation: provider-specific opaque id; example: `model: claude-4-class-model-id`.
  - `thresholds` — object; optional; sub-keys `severity_floor.inline` (default `medium`) and `confidence_floor.inline` (default `0.7`); validation: `severity_floor.inline` must be one of `info`/`low`/`medium`/`high`/`critical`; `confidence_floor.inline` must be a number in `[0,1]`.
  - `comment_cap` — object; optional; sub-keys `per_pr` (default `5`) and `per_file` (default `1`); validation: each must be a non-negative integer; `0` means "publish nothing inline" but does not disable the summary.
  - `path_rules` — object; optional; sub-keys `include` (array of glob strings) and `exclude` (array of glob strings); validation: each entry is a glob string; `exclude` is applied after `include`.
  - `exclude_generated` — boolean; optional; default `true`; validation: boolean; when `true`, the prefilter applies built-in generated-file detection (lockfiles, build outputs, vendored markers).
  - `exclude_vendored` — boolean; optional; default `true`; validation: boolean; when `true`, the prefilter excludes vendored directories matching built-in patterns.
  - `max_files` — integer; optional; default Phase 4 (declared here as "set by built-in defaults; tunable per repo"); validation: positive integer; the prefilter short-circuits when exceeded and the publisher emits summary-only output regardless of `mode`.
  - `max_changed_lines` — integer; optional; same shape as `max_files`; validation: positive integer; same short-circuit behavior.
  - `categories_enabled` — array of strings; optional; default the full category vocabulary defined in `review-findings-schema.md`; validation: every entry must be a member of that vocabulary.
  - `severity` — object (mapping); optional; allows per-category severity overrides (e.g., `severity: { tests: low }`); validation: keys must be members of the category vocabulary; values must be members of the severity vocabulary.
  - `language_overrides` — object; optional; map from language tag to an object whose shape matches the top-level config (subset); validation: every override must satisfy the same per-key rules as the top level; precedence: language override > top-level repo config > defaults.
  - `repo_heuristics` — object; optional; sub-keys at minimum `security` (boolean), `tests` (boolean), `migrations` (boolean), `layering` (boolean); validation: each is a boolean; toggles influence the validator and the ranker (not the prefilter).
- **Precedence matrix:** a table whose rows are the filtering keys (`path_rules.include`, `path_rules.exclude`, `exclude_generated`, `exclude_vendored`, `max_files`, `max_changed_lines`) and whose columns are `applies before / after` the others, with the resolution rule as a cell (e.g., `path_rules.exclude` overrides `path_rules.include`; `exclude_generated` and `exclude_vendored` are ORed with `path_rules.exclude`; `max_files` and `max_changed_lines` are evaluated last and trigger summary-only fallback regardless of mode).
- **Worked example (verbatim block):** a complete YAML block that IDG must include verbatim, using the OQ-2 defaults explicitly so a reader can see the defaults in concrete form. The block must include every top-level key listed above, even when the value equals the default. It must parse as valid YAML and must validate against the rules in this document. (IDG composes the YAML; SPECTRA mandates that the OQ-2 defaults appear as literal values: `mode: dry-run`, `comment_cap: { per_pr: 5, per_file: 1 }`, `thresholds: { severity_floor: { inline: medium }, confidence_floor: { inline: 0.7 } }`, `provider: anthropic`.)
- **Failure modes:** one paragraph each for: file missing (use built-in defaults; not an error), file malformed (reject the file with a structured log entry; fall back to built-in defaults; emit a Checks summary that explains the rejection); unknown keys (warn, ignore, do not fail); type mismatch on a known key (reject the whole file; same fallback as malformed).

### 5. Acceptance criteria (GIVEN/WHEN/THEN)

See YAML block (IDs `CS-1` … `CS-6`).

### 6. Cross-file consistency requirements

- The `mode` enum values match `product-spec.md` § Operating modes verbatim.
- The default values (`5`, `1`, `medium`, `0.7`, `dry-run`, `anthropic`) match the OQ-1 and OQ-2 resolution log entries.
- The severity vocabulary (`info`/`low`/`medium`/`high`/`critical`) matches `review-findings-schema.md`.
- The category vocabulary referenced by `categories_enabled` and `severity` matches `review-findings-schema.md`.
- `max_files` and `max_changed_lines` short-circuit behavior matches the "diff too large" fallback in `publication-policy.md`.
- `path_rules` / `exclude_generated` / `exclude_vendored` interact with the prefilter described in ADR-003 § Pipeline shape; this file does not redefine prefilter semantics, only the keys that drive it.

### 7. Out of scope for this file

- No Zod implementation (Phase 4).
- No persona-level explanation of why a repo admin would choose a value (those live in `product-spec.md`).
- No publication math (that lives in `publication-policy.md`).
- No HTTP/contract sketches.
- No new modes; if a key implies a new mode, that is a contradiction and must be flagged, not introduced.

---

## File 3 — `docs/review-findings-schema.md`

### 1. Purpose

Defines the **NormalizedFinding** schema produced by the validator, ordered by the ranker, and consumed by the publisher. Carries the audit fields that `ProviderReviewOutput` does not. Consumed by every implementer who touches the post-provider pipeline and by the publisher contract in `api-contracts.md`.

### 2. Required sections (exact H2/H3 in order)

- `## Purpose and position in the pipeline`
- `## Schema name and identity`
- `## Field reference`
  - `### id`
  - `### path`
  - `### line_start`
  - `### line_end`
  - `### category`
  - `### severity`
  - `### confidence`
  - `### title`
  - `### explanation`
  - `### suggested_fix`
  - `### evidence`
  - `### render_target`
  - `### source_artifacts_used`
  - `### dedupe_key`
  - `### validator_notes`
- `## Vocabularies`
  - `### Severity vocabulary`
  - `### Category vocabulary`
  - `### Render target vocabulary`
- `## Mapping from ProviderReviewOutput to NormalizedFinding`
- `## Rejection log entry shape`
- `## Examples`

### 3. Research questions answered

- What is the schema name, where in the pipeline is it produced, and where is it consumed?
- For each field: what is its type, what are its allowed values or range, is it required or optional, what is its validation rule, and what is its audit purpose?
- What is the canonical severity vocabulary, the category vocabulary, and the render-target vocabulary?
- How does each field of `NormalizedFinding` map back to (or augment) `ProviderReviewOutput`? Which fields are added by the validator and have no provider source?
- What does a rejection log entry look like when a `ProviderReviewOutput` finding is dropped by the validator?

### 4. Required content per section

- **Purpose and position in the pipeline:** must state that `NormalizedFinding` is the output of the validator stage (per ADR-003) and the input of the ranker and publisher; it is **richer** than `ProviderReviewOutput` because it carries audit fields the provider does not produce (`dedupe_key`, `render_target`, `source_artifacts_used`, `validator_notes`). The pipeline order `prefilter → provider → validator → ranker → publication cap` is named verbatim.
- **Schema name and identity:** the schema is named `NormalizedFinding`. Other types named here and reused across Phase 2: `RankedFindings` (the ranker's output, an ordered list of `NormalizedFinding`), `PublicationResult` (the publisher's output, defined in `api-contracts.md`), and `RejectionLogEntry` (defined here).
- **Field reference:** one subsection per field, with the exact order below. Each subsection must contain, in this exact order: `Type`, `Allowed values / range`, `Required`, `Validation rule (plain English)`, `Audit purpose`. Required content per field:
  - `id` — string (UUID or content-addressed hash); required; unique within the PR; validation: non-empty, stable across re-runs for the same content; audit: ties a finding to its rejection-log entry and to inline-comment dedupe.
  - `path` — string; required; relative to repo root; validation: must reference a path present in the prefiltered diff context (validator enforces); audit: anchor for inline placement.
  - `line_start` — integer; required; 1-indexed; validation: must fall within a touched hunk in the prefiltered diff; audit: structural-soundness check.
  - `line_end` — integer; required; ≥ `line_start`; validation: same as `line_start`; equal to `line_start` when the finding is single-line; audit: same as `line_start`.
  - `category` — string enum; required; member of the category vocabulary defined below; validation: must be in the vocabulary; audit: drives ranking and per-category configuration.
  - `severity` — string enum; required; member of the severity vocabulary defined below; validation: must be in the vocabulary; audit: drives `severity_floor.inline` enforcement.
  - `confidence` — number; required; in `[0,1]`; validation: must be a finite number in range; provider-reported, ranker signal not a publication gate at the validator step; the publisher applies `confidence_floor.inline`; audit: ranking input and inline-eligibility input.
  - `title` — string; required; ≤ a length cap declared by Phase 4 (Phase 2 marks "length cap declared by Phase 4"); validation: non-empty; audit: short rendered headline.
  - `explanation` — string; required; non-empty; validation: non-empty; the model's narrative, post-validation; audit: rendered body.
  - `suggested_fix` — string; optional; validation: when present, non-empty; audit: improves actionability without claiming autofix (non-goal).
  - `evidence` — array of strings (file:line snippets or symbol references); required; validation: every entry must reference content in the prefiltered diff context; audit: traceability — proves the finding is grounded in the diff.
  - `render_target` — string enum; required; one of `inline` | `summary` | `dropped`; assigned by the ranker (or by the publisher when caps push items out); validation: must be in the vocabulary; audit: explicit publication intent.
  - `source_artifacts_used` — array of strings; required; ids/identifiers of which prefiltered hunks, files, or repo_heuristics signals contributed to this finding; validation: non-empty; audit: provenance.
  - `dedupe_key` — string; required; deterministic hash derived from `path`, `line_start`, `line_end`, `category`, and a normalized form of `title` or a content fingerprint; validation: non-empty; equal across runs for findings the publisher considers "the same"; audit: the key the publisher consults to suppress duplicates across runs and webhook redeliveries.
  - `validator_notes` — array of strings; optional; validator-emitted commentary (e.g., "evidence references hunk H3"); validation: when present, every entry is a non-empty string; audit: explains validator decisions in the structured log.
- **Vocabularies:** three subsections.
  - **Severity vocabulary:** the ordered list `info`, `low`, `medium`, `high`, `critical` (ascending severity). The list is closed.
  - **Category vocabulary:** the initial closed list `security`, `correctness`, `performance`, `tests`, `style`, `migration`, `dependency`. IDG may extend this list within Phase 2 with explicit additions; any addition must appear in `config-spec.md` § `categories_enabled` validation rule. Removals are not permitted in Phase 2.
  - **Render target vocabulary:** the closed list `inline`, `summary`, `dropped`. `dropped` means the finding survived validation but did not reach publication.
- **Mapping from `ProviderReviewOutput` to `NormalizedFinding`:** a table or list mapping each `NormalizedFinding` field to its source. Required mapping notes:
  - Fields directly carried from `ProviderReviewOutput` (per ADR-002): `path`, `line_start`/`line_end` (from provider `line` or line range), `severity`, `category`, `title` (from provider `message`), `explanation` (from provider `rationale`), `confidence`, `suggested_fix` if provider returned one.
  - Fields **added by the validator** (no provider source): `id`, `evidence` (validator extracts from prefiltered diff), `render_target` (initially `summary`; ranker/publisher revise), `source_artifacts_used`, `dedupe_key`, `validator_notes`.
- **Rejection log entry shape:** define `RejectionLogEntry` with fields: `finding_id` (string or null when the finding had no `id` yet), `stage` (one of `validator` | `ranker` | `publisher`), `reason_code` (short stable string), `reason_message` (human-readable), `provider_output_excerpt` (string, redacted of any credential-bearing content), `timestamp` (ISO-8601). The shape is consumed by `api-contracts.md` (validator/ranker/publisher contracts emit it).
- **Examples:** at least two non-normative examples must be required: (a) a `NormalizedFinding` with `render_target = inline` that survives all gates; (b) a `NormalizedFinding` with `render_target = dropped` and a paired `RejectionLogEntry` with `stage = publisher` and `reason_code = per_pr_cap_exhausted`.

### 5. Acceptance criteria (GIVEN/WHEN/THEN)

See YAML block (IDs `RFS-1` … `RFS-6`).

### 6. Cross-file consistency requirements

- The schema name `NormalizedFinding` is reused unchanged in `api-contracts.md` and `publication-policy.md`.
- The severity vocabulary matches `config-spec.md` § `thresholds.severity_floor.inline` allowed values.
- The category vocabulary matches `config-spec.md` § `categories_enabled` and § `severity` validation rules.
- `dedupe_key` is referenced from `product-spec.md` § Glossary and § Re-run a review, and from `publication-policy.md` § Dedupe behavior.
- `RejectionLogEntry` is the shape emitted by validator/ranker/publisher contracts in `api-contracts.md`.
- Mapping section must show that `NormalizedFinding` is strictly richer than `ProviderReviewOutput`; no provider field is required-only-on-the-provider-side.

### 7. Out of scope for this file

- No Zod implementation.
- No publication thresholds (severity/confidence floors): they live in `config-spec.md` and are applied in `publication-policy.md`.
- No HTTP contract sketches.
- No prompt engineering.
- No new pipeline stages.

---

## File 4 — `docs/api-contracts.md`

### 1. Purpose

Defines the internal contracts between pipeline modules (webhook ingress, async job, provider adapter, validator, ranker, publisher) as TypeScript-style sketches. Each contract names its input schema, output schema, error shape, and at least one invariant. Consumed by Phase 4 implementers; full Zod schemas land in Phase 4.

### 2. Required sections (exact H2/H3 in order)

- `## Conventions`
- `## Webhook ingress contract`
- `## Async job contract`
- `## Provider adapter contract`
- `## Validator contract`
- `## Ranker contract`
- `## Publisher contract`
- `## GitHub interactions (named, no curl)`
- `## Invariants and error semantics`

### 3. Research questions answered

- What is the HTTP method, path, and required headers for the webhook ingress, including signature and delivery-id headers?
- How is the idempotency key derived from a webhook delivery?
- Which webhook events are accepted and what is the response policy (2xx-on-accept)?
- What is the shape of an async job payload, what are its terminal states, and what is the retry policy class?
- What is the provider adapter's function signature, error union, and capability surface, reusing Phase 1 identifiers verbatim?
- What is the validator's signature and what does its rejection log look like?
- What is the ranker's signature and what does it produce?
- What is the publisher's signature, what does `PublicationResult` contain, and which GitHub endpoints are touched (named in plain language, no curl)?

### 4. Required content per section

- **Conventions:** state that signatures are TypeScript-style sketches (`Promise<T>` for async); type identifiers reused from Phase 1 are spelled exactly: `ProviderReviewInput`, `ProviderReviewOutput`, `ProviderError`, `ProviderCapabilities`. Schema identifiers introduced in Phase 2 are: `WebhookIngressRequest`, `WebhookIngressResponse`, `JobPayload`, `JobResult`, `NormalizedFinding`, `RankedFindings`, `PublicationResult`, `PublishContext`, `RejectionLogEntry`. No vendor SDK types appear in any signature.
- **Webhook ingress contract:** must specify, in this order:
  - HTTP method `POST` and path (path is declared as `/webhooks/github`; if a different value is preferred, IDG flags it and SPECTRA approves before changing).
  - Required headers: `X-Hub-Signature-256` (HMAC-SHA-256 over the raw body using the App webhook secret), `X-GitHub-Event` (event name), `X-GitHub-Delivery` (delivery UUID), `Content-Type: application/json`.
  - Idempotency key derivation: a deterministic function of `X-GitHub-Delivery` (and, for resilience to repeated deliveries, the `(installation_id, repository_id, pull_request.number, head_sha)` tuple parsed from the body when the event is one of the accepted ones). The function must be named `deriveIdempotencyKey` and its inputs and outputs declared by name.
  - Accepted events (closed list for MVP): `pull_request.opened`, `pull_request.synchronize`, `pull_request.reopened`. Any other event returns 2xx and is otherwise discarded with a structured log entry.
  - Response semantics: 2xx-on-accept (the receiver returns 2xx after signature verification, idempotency-key derivation, and successful enqueue; pipeline work is asynchronous). On signature failure: 4xx with no body content beyond a generic error code; no echo of header content. On enqueue failure: 5xx (the delivery will be retried by GitHub).
  - Schemas: input `WebhookIngressRequest` (headers + body); output `WebhookIngressResponse`.
  - Invariant: no PR-visible artifact may be produced before the async job runs to completion.
- **Async job contract:** must specify:
  - `JobPayload` shape: `idempotency_key`, `installation_id`, `repository_id`, `pull_request_number`, `head_sha`, `event_type`, `received_at`. No raw provider credentials or webhook secret material is permitted in the payload.
  - Idempotency key: equal to `deriveIdempotencyKey` output from the ingress.
  - Retry policy class: declared as a category, **not as numbers** ("transient errors are retried with bounded exponential backoff"; "non-transient errors fail terminally"; specific counts and intervals are Phase 3). `ProviderError` variants are classified into transient (`rate_limit`, `transport`) and non-transient (`auth`, `capability`, `schema_validation`).
  - Terminal states: closed list `succeeded`, `failed_terminal`, `discarded_idempotent`. `succeeded` produces a `JobResult` whose `PublicationResult` field is non-null when the run published anything.
  - Schema: input `JobPayload`, output `JobResult` with `RejectionLogEntry[]` for any drops.
  - Invariant: a job with a previously seen `idempotency_key` and identical `head_sha` resolves to `discarded_idempotent` without performing any provider call.
- **Provider adapter contract:** must specify:
  - Signature: `review(input: ProviderReviewInput): Promise<ProviderReviewOutput>`. (Reuse Phase 1 identifiers exactly.)
  - Error union: `ProviderError` (Phase 1 identifier) covering `transport`, `auth`, `rate_limit`, `capability`, `schema_validation` variants.
  - Capability flags: `ProviderCapabilities` (Phase 1 identifier).
  - Invariant: no vendor SDK type leaks into or out of `review`. The Anthropic adapter (per OQ-1) lives at `packages/providers/anthropic` and exports only the Provider interface and its Zod schemas.
- **Validator contract:** must specify:
  - Signature: `validate(output: ProviderReviewOutput, ctx: ValidatorContext): { findings: NormalizedFinding[]; rejections: RejectionLogEntry[] }`.
  - `ValidatorContext` carries the prefiltered diff context (paths, hunks, language tags, repo_heuristics flags from config). It is named here only; the field-by-field shape is declared in Phase 4.
  - Rejection log shape: `RejectionLogEntry` (defined in `review-findings-schema.md`) with `stage = validator`.
  - Invariant: every emitted `NormalizedFinding` has `path` in the diff and `[line_start, line_end]` within a touched hunk; otherwise the finding is rejected.
- **Ranker contract:** must specify:
  - Signature: `rank(findings: NormalizedFinding[], policy: RankerPolicy): RankedFindings`.
  - `RankerPolicy` declares the ordering signal (severity weight, category weight, confidence weight) and is sourced from config. Specific weight values are Phase 4; the shape is named here.
  - Invariant: `rank` does not drop findings; it orders them and may set `render_target` to `summary` for findings unlikely to be inline-publishable, but never to `dropped`.
- **Publisher contract:** must specify:
  - Signature: `publish(ranked: RankedFindings, ctx: PublishContext, policy: PublicationPolicy): Promise<PublicationResult>`.
  - `PublicationPolicy` is the resolved-config view of `mode`, `comment_cap`, `thresholds`, and dedupe state for the PR. Its shape is declared here; the rules it enforces live in `publication-policy.md`.
  - `PublicationResult` contains: `published_inline: NormalizedFinding[]`, `published_summary: NormalizedFinding[]`, `dropped: NormalizedFinding[]`, `rejections: RejectionLogEntry[]`, `checks_run_id: string` (when a Checks run is created), `summary_artifact: string` (Markdown body sent to the Checks run).
  - Invariant: the count of `published_inline` is ≤ `comment_cap.per_pr` and ≤ `comment_cap.per_file` per file; every dropped item has at least one matching `RejectionLogEntry`.
- **GitHub interactions (named, no curl):** must list, in plain language, which public GitHub endpoints/APIs are touched and why. At minimum: `Checks API` (create a Check run, update its conclusion, attach summary Markdown and per-line annotations); `Pull Request Review Comments API` (create line-anchored review comments when `mode = summary-plus-inline`); `Pull Requests API` (read diffs and head_sha when needed); `Installations API` (mint installation tokens). Reference public docs by name only ("GitHub Checks API", "GitHub Pull Request Review Comments API"); no `curl` or example URLs.
- **Invariants and error semantics:** a single section that aggregates the per-contract invariants into a numbered list and adds:
  - "No vendor SDK type appears outside `packages/providers/<adapter>`."
  - "Webhook signature verification precedes idempotency-key derivation, which precedes enqueue, which precedes the 2xx response."
  - "Every dropped `NormalizedFinding` is accompanied by exactly one `RejectionLogEntry` with a `stage` and a `reason_code`."
  - "If `ProviderReviewOutput` fails Zod validation at the adapter boundary, no `NormalizedFinding` is emitted for that PR; the job terminates with `failed_terminal` and an audit entry."

### 5. Acceptance criteria (GIVEN/WHEN/THEN)

See YAML block (IDs `AC-1` … `AC-7`).

### 6. Cross-file consistency requirements

- Phase 1 identifiers (`ProviderReviewInput`, `ProviderReviewOutput`, `ProviderError`, `ProviderCapabilities`) are reused verbatim and never aliased.
- `NormalizedFinding`, `RankedFindings`, `RejectionLogEntry` match the names defined in `review-findings-schema.md`.
- `mode`, `comment_cap`, `thresholds` references in `PublicationPolicy` match the keys defined in `config-spec.md`.
- The accepted events list (`pull_request.opened`, `pull_request.synchronize`, `pull_request.reopened`) appears identically in `publication-policy.md` § Re-run behavior on `synchronize`.
- The Checks API choice as the primary publication surface is consistent with `mvp-scope.md` § Integration surface.
- Anthropic adapter location (`packages/providers/anthropic`) matches the OQ-1 resolution log entry.

### 7. Out of scope for this file

- No retry counts, backoff intervals, queue technology choices, or hosting topology (Phase 3).
- No Zod implementation (Phase 4).
- No `curl` examples or specific URLs.
- No publication math (lives in `publication-policy.md`).
- No mode definitions (live in `product-spec.md`).
- No new pipeline stages or providers.

---

## File 5 — `docs/publication-policy.md`

### 1. Purpose

The deterministic ruleset the publisher applies for each `mode` value: what is published, where, with which thresholds and caps, and how dedupe and fallbacks behave. Consumed by reviewers (so they can predict bot output), by the implementer of the publisher contract, and by anyone debugging "why did this finding not appear inline?".

### 2. Required sections (exact H2/H3 in order)

- `## Inputs and outputs`
- `## Defaults (per OQ-2)`
- `## Mode behavior`
  - `### dry-run`
  - `### summary-only`
  - `### summary-plus-inline`
- `## Threshold and cap application order`
- `## Dedupe behavior`
- `## Fallbacks`
  - `### Malformed ProviderReviewOutput`
  - `### Diff too large`
  - `### Provider error (non-transient)`
- `## Re-run behavior on synchronize`
- `## Worked example`

### 3. Research questions answered

- For each mode, what is published, where, and under which thresholds and caps?
- In what order are `severity_floor.inline`, `confidence_floor.inline`, `comment_cap.per_file`, and `comment_cap.per_pr` applied?
- How does dedupe work using `dedupe_key`, both within a single run and across runs (re-deliveries, force-pushes)?
- What does the publisher do when `ProviderReviewOutput` is malformed?
- What does the pipeline do when the diff exceeds `max_files` or `max_changed_lines`?
- What happens on `pull_request.synchronize` re-runs to avoid duplicate inline comments?

### 4. Required content per section

- **Inputs and outputs:** must state the publisher consumes `RankedFindings` plus `PublicationPolicy` plus `PublishContext` (per `api-contracts.md`) and emits `PublicationResult`. Reuse the schema names verbatim.
- **Defaults (per OQ-2):** restate the OQ-2 defaults verbatim: `comment_cap.per_pr = 5`, `comment_cap.per_file = 1`, `severity_floor.inline = medium`, `confidence_floor.inline = 0.7`, default `mode = dry-run` for newly installed repos. Cross-link to `config-spec.md` for override semantics. Do not redefine the values; reuse them.
- **Mode behavior:** one subsection per mode. Each must state, in this order:
  - `What is published`
  - `Where (Checks summary / inline review comment / both / neither)`
  - `Severity floor applied`
  - `Confidence floor applied`
  - `Per-PR cap applied`
  - `Per-file cap applied`
  - `Dedupe behavior reference (links to § Dedupe behavior)`
  - Required content per mode:
    - `dry-run`: nothing PR-visible is published; `RankedFindings` plus `RejectionLogEntry[]` are emitted to the structured log only; the Checks summary is **not** rendered (a single Checks run with `neutral` conclusion and a "dry-run; no findings published" body is acceptable; if IDG includes that, it must be consistent across the doc). No inline comments. Caps and floors are computed (for audit) but not enforced because nothing is published.
    - `summary-only`: a Checks run with a Markdown summary listing findings whose `severity ≥ severity_floor.inline` (the floor still gates summary inclusion when `confidence ≥ confidence_floor.inline`); no inline review comments are created regardless of cap state. The full `RankedFindings` (including findings under the floors) appears in the structured log.
    - `summary-plus-inline`: both a Checks run summary and inline review comments. Inline candidates are findings whose `severity ≥ severity_floor.inline` AND `confidence ≥ confidence_floor.inline`. The publisher applies `comment_cap.per_file` first (at most one inline comment per file), then `comment_cap.per_pr` (at most five inline comments total, by default). Findings excluded by caps remain in the summary with a reason annotation referencing their `RejectionLogEntry`.
- **Threshold and cap application order:** an ordered list, applied in this exact order:
  1. Compute eligibility: `severity ≥ severity_floor.inline` AND `confidence ≥ confidence_floor.inline` for inline; `severity ≥ severity_floor.inline` AND `confidence ≥ confidence_floor.inline` for summary inclusion in `summary-only`; the union of both for `summary-plus-inline`.
  2. Apply dedupe (see § Dedupe behavior) — drop any finding whose `dedupe_key` was already published on this PR or appears more than once in the current ranked list (collapse to highest-confidence representative).
  3. Apply `comment_cap.per_file` to the inline-eligible set, in ranker order.
  4. Apply `comment_cap.per_pr` to the inline-eligible set, in ranker order.
  5. Move overflow into the summary list with `render_target = summary` and produce `RejectionLogEntry` records with `stage = publisher` and a `reason_code` of `per_file_cap_exhausted` or `per_pr_cap_exhausted`.
  6. Render the Checks summary; for each summary entry, indicate whether it is published inline, dropped from inline due to caps, or below floors.
- **Dedupe behavior:** specify exactly:
  - `dedupe_key` is computed by the validator (per `review-findings-schema.md`) and is stable across runs for findings the publisher should consider "the same".
  - Dedupe is applied at two scopes: (a) within the current run's ranked list (collapse same-`dedupe_key` findings, keep the highest `confidence`); (b) across runs (any `dedupe_key` already published as an inline comment on this PR is not re-published; the prior comment is considered authoritative).
  - The publisher consults a per-PR "already published" set whose source is the GitHub Checks/Review-Comments history of this App on this PR. Implementation is Phase 4; Phase 2 names the source.
  - On `pull_request.synchronize`, dedupe across runs ensures that a finding still valid on the new head is not duplicated; a finding no longer valid (e.g., the line is no longer in the diff) is dropped at the validator stage, not here.
- **Fallbacks:** three subsections.
  - **Malformed `ProviderReviewOutput`:** when Zod validation fails at the adapter boundary, no `NormalizedFinding` is emitted; the job terminates with `failed_terminal`; the publisher emits a Checks run with conclusion `neutral` and a Markdown summary explaining the failure category (no provider error detail beyond the category and a redacted excerpt). A `RejectionLogEntry` with `stage = validator` (or `provider`, when the failure is at the adapter boundary) is written. **Downgrade vs drop:** the policy is **drop with audit log**, never downgrade — partially valid provider output is not silently kept.
  - **Diff too large:** when `max_files` or `max_changed_lines` (from `config-spec.md`) is exceeded, the prefilter short-circuits before any provider call. The publisher emits **summary-only** output regardless of the configured `mode`; the summary states which limit was hit and lists the affected paths in aggregate (no per-finding inline comments). No `ProviderReviewOutput` is requested.
  - **Provider error (non-transient):** for `auth`, `capability`, `schema_validation` errors from `ProviderError`, the job ends `failed_terminal`; the publisher emits a Checks run with conclusion `neutral` and a brief category-only failure message. No inline comments.
- **Re-run behavior on synchronize:** must specify:
  - On `pull_request.synchronize`, the pipeline re-runs prefilter → provider → validator → ranker → publication cap with the new `head_sha`.
  - The publisher consults the per-PR "already published" dedupe set; any inline comment whose `dedupe_key` already exists on this PR is not re-posted.
  - Findings that disappear from the new diff are not edited or deleted by the publisher in MVP (Phase 2 declares this explicitly so reviewers know stale comments may persist; cleanup is post-MVP).
  - The Checks summary is updated (or replaced) for the latest run; prior summaries are not retroactively edited.
- **Worked example:** a normative example IDG must include. Required scenario, byte-equivalent acceptance: "Given 12 valid `NormalizedFinding` entries surfaced by the ranker on a PR with `mode = summary-plus-inline` and the OQ-2 defaults, and assuming all 12 findings have `severity ≥ medium` and `confidence ≥ 0.7`, and assuming the ranker order yields a per-file distribution of more than one finding for some files, then the publisher publishes exactly 5 findings inline (top of ranker order, one per file until `per_file = 1` is met, then the highest-ranking unpublished from a different file until `per_pr = 5` is met). The Checks summary lists all 12 findings, marks 5 as `published inline`, and marks the other 7 with their `RejectionLogEntry` reason codes (`per_file_cap_exhausted` or `per_pr_cap_exhausted`)." The example must be expressed in plain text (no real code), and the count `5` must appear as a literal `5` and `12` as a literal `12`.

### 5. Acceptance criteria (GIVEN/WHEN/THEN)

See YAML block (IDs `PP-1` … `PP-7`).

### 6. Cross-file consistency requirements

- Mode names (`dry-run`, `summary-only`, `summary-plus-inline`) match `product-spec.md` § Operating modes and `config-spec.md` § `mode`.
- Defaults (`5`, `1`, `medium`, `0.7`, `dry-run`) match `config-spec.md` § Key reference and the OQ-2 resolution log entry.
- `dedupe_key` references `review-findings-schema.md` § `dedupe_key` and is not redefined here.
- `RejectionLogEntry` shape matches `review-findings-schema.md` § Rejection log entry shape.
- `PublicationPolicy`, `PublicationResult`, `RankedFindings`, `PublishContext` references match `api-contracts.md` § Publisher contract.
- The diff-too-large fallback maps to `max_files` and `max_changed_lines` from `config-spec.md` and to the prefilter short-circuit declared in ADR-003 § Pipeline shape.
- The accepted webhook events on which re-runs occur match `api-contracts.md` § Webhook ingress contract.

### 7. Out of scope for this file

- No new mode definitions (live in `product-spec.md`).
- No new config keys (live in `config-spec.md`).
- No schema changes to `NormalizedFinding` (lives in `review-findings-schema.md`).
- No HTTP/curl examples.
- No retry counts, queue technology, or observability sink choice (deferred to Phase 3).
- No autofix, auto-merge, or write-backs to external systems (Phase 1 non-goals).

---

## Cross-cutting consistency-check pass (must pass before Phase 2 exit)

1. **Mode-name uniformity.** The strings `dry-run`, `summary-only`, `summary-plus-inline` appear with identical casing in `product-spec.md`, `config-spec.md`, `api-contracts.md`, and `publication-policy.md`. No synonyms.
2. **OQ-2 default reuse.** The literal values `5`, `1`, `medium`, `0.7`, and `dry-run` appear as defaults in `config-spec.md` and are referenced (not redeclared) in `publication-policy.md`. The OQ-1 default `anthropic` (provider) appears identically in `config-spec.md` and `api-contracts.md` (in the example/notes), and the path `packages/providers/anthropic` appears in `api-contracts.md` § Provider adapter contract and in the OQ-1 resolution log.
3. **Phase 1 identifier reuse.** `ProviderReviewInput`, `ProviderReviewOutput`, `ProviderError`, `ProviderCapabilities` appear verbatim in `api-contracts.md` (and where referenced elsewhere). No alias.
4. **Pipeline-stage uniformity.** The five stages `prefilter`, `provider`, `validator`, `ranker`, `publication cap` appear in this order in any place that lists the pipeline (`product-spec.md` and `review-findings-schema.md` at minimum).
5. **Schema-chain integrity.** `ProviderReviewOutput` (Phase 1) → `NormalizedFinding` (validator output) → `RankedFindings` (ranker output) → `PublicationResult` (publisher output). Each link is named identically in every doc that touches it.
6. **Vocabulary closure.** Severity vocabulary `info`/`low`/`medium`/`high`/`critical` and category vocabulary as listed in `review-findings-schema.md` are referenced (not extended in conflicting ways) by `config-spec.md` and `publication-policy.md`.
7. **Non-goals byte equivalence.** `product-spec.md` § Out-of-scope behaviors lists the eight non-goals byte-equivalent to `mvp-scope.md` § Non-goals (verbatim), in the same order.
8. **`.github/review-bot.yml` path.** The path is referenced verbatim in `product-spec.md`, `config-spec.md`, and `publication-policy.md` (where the resolution chain is named).
9. **Worked-example numerals.** `publication-policy.md` § Worked example contains the literals `12` (input findings) and `5` (published inline).
10. **Resolution log presence.** `docs/open-questions.md` § Resolution log contains the OQ-1 and OQ-2 entries reproduced in this spec (date `2026-04-30`); OQ-3 remains in `## Open questions`.
11. **No vendor SDK leakage.** `api-contracts.md` and `review-findings-schema.md` contain no Anthropic-specific type names; only Phase 1 / Phase 2 schema identifiers.
12. **Idempotency wording.** The phrase "2xx-on-accept" and the named function `deriveIdempotencyKey` appear in `api-contracts.md` § Webhook ingress contract; the accepted events list is the closed set `{pull_request.opened, pull_request.synchronize, pull_request.reopened}`.

---

## Machine-readable acceptance criteria (YAML)

```yaml
files:
  docs/product-spec.md:
    acceptance:
      - id: PS-1
        given: docs/product-spec.md exists
        when: a reader inspects the personas section
        then: subsections exist for Repo admin, Reviewer, and PR author, each listing Role, Primary need, Frustration the App removes, and What the App must never do to this persona
      - id: PS-2
        given: docs/product-spec.md exists
        when: a reader inspects the operating modes section
        then: subsections exist for dry-run, summary-only, and summary-plus-inline in that order, each defining What is published, Where, Default applicability, and Risk posture
      - id: PS-3
        given: docs/product-spec.md exists
        when: a reader inspects the operating modes section
        then: dry-run is identified as the default for newly installed repos
      - id: PS-4
        given: docs/product-spec.md exists
        when: a reader inspects the core flows section
        then: subsections exist for Install the App, Configure the provider, Open a PR (auto-review), Dry-run review, Re-run a review, Inspect the Checks summary, and Inspect inline comments, and each contains Trigger, Actors, Preconditions, Steps, Success state, Failure state, and Rollback in that order
      - id: PS-5
        given: docs/product-spec.md and docs/mvp-scope.md both exist
        when: a reader compares the out-of-scope behaviors section to mvp-scope.md non-goals
        then: the eight non-goals appear in the same order and byte-equivalent to mvp-scope.md
      - id: PS-6
        given: docs/product-spec.md exists
        when: a reader inspects the glossary
        then: entries exist for Finding, NormalizedFinding, inline comment, Checks summary, mode, cap, severity floor, confidence floor, and dedupe_key
  docs/config-spec.md:
    acceptance:
      - id: CS-1
        given: docs/config-spec.md exists
        when: a reader inspects the key reference section
        then: subsections exist for enabled, mode, provider, model, thresholds, comment_cap, path_rules, exclude_generated, exclude_vendored, max_files, max_changed_lines, categories_enabled, severity, language_overrides, and repo_heuristics, each containing Type, Required, Default, Validation rule (plain English), and Example in that order
      - id: CS-2
        given: docs/config-spec.md exists
        when: a reader inspects the defaults
        then: mode default is dry-run, comment_cap.per_pr default is 5, comment_cap.per_file default is 1, thresholds.severity_floor.inline default is medium, thresholds.confidence_floor.inline default is 0.7, and provider default is anthropic
      - id: CS-3
        given: docs/config-spec.md exists
        when: a reader inspects the resolution order section
        then: the order is built-in defaults, then repo-local .github/review-bot.yml, then per-PR overrides, with deep-merge for objects and replacement for scalars and arrays
      - id: CS-4
        given: docs/config-spec.md exists
        when: a reader inspects the worked example
        then: a single YAML block is present that includes every top-level key, parses as valid YAML, and contains the literal values mode dry-run, comment_cap per_pr 5, comment_cap per_file 1, severity_floor inline medium, confidence_floor inline 0.7, and provider anthropic
      - id: CS-5
        given: docs/config-spec.md exists
        when: a reader inspects the precedence matrix
        then: it is a table whose rows include path_rules.include, path_rules.exclude, exclude_generated, exclude_vendored, max_files, and max_changed_lines, and whose cells declare the resolution rule for every pair
      - id: CS-6
        given: docs/config-spec.md exists
        when: a reader inspects the failure modes section
        then: paragraphs exist for file missing, file malformed, unknown keys, and type mismatch on a known key, each declaring the publisher behavior (use defaults vs reject and fall back)
  docs/review-findings-schema.md:
    acceptance:
      - id: RFS-1
        given: docs/review-findings-schema.md exists
        when: a reader inspects the field reference section
        then: subsections exist for id, path, line_start, line_end, category, severity, confidence, title, explanation, suggested_fix, evidence, render_target, source_artifacts_used, dedupe_key, and validator_notes, each containing Type, Allowed values / range, Required, Validation rule (plain English), and Audit purpose in that order
      - id: RFS-2
        given: docs/review-findings-schema.md exists
        when: a reader inspects the vocabularies section
        then: severity vocabulary is exactly info, low, medium, high, critical in ascending order; category vocabulary contains at minimum security, correctness, performance, tests, style, migration, dependency; render target vocabulary is exactly inline, summary, dropped
      - id: RFS-3
        given: docs/review-findings-schema.md exists
        when: a reader inspects the mapping section
        then: the table or list shows that id, evidence, render_target, source_artifacts_used, dedupe_key, and validator_notes are added by the validator and have no ProviderReviewOutput source, while path, severity, category, title, explanation, confidence, line_start, line_end, and optional suggested_fix are derived from ProviderReviewOutput
      - id: RFS-4
        given: docs/review-findings-schema.md exists
        when: a reader inspects the rejection log entry shape section
        then: RejectionLogEntry contains finding_id, stage, reason_code, reason_message, provider_output_excerpt, and timestamp, with stage limited to validator, ranker, or publisher
      - id: RFS-5
        given: docs/review-findings-schema.md exists
        when: a reader inspects the examples section
        then: at least two examples are present, one with render_target inline and one with render_target dropped paired with a RejectionLogEntry whose stage is publisher and reason_code is per_pr_cap_exhausted
      - id: RFS-6
        given: docs/review-findings-schema.md and the Phase 1 ADR-002 both exist
        when: a reader cross-checks the schema name and the mapping section
        then: NormalizedFinding is declared strictly richer than ProviderReviewOutput (carries audit fields the provider does not produce) and ProviderReviewOutput is referenced by the exact identifier from ADR-002
  docs/api-contracts.md:
    acceptance:
      - id: AC-1
        given: docs/api-contracts.md exists
        when: a reader inspects the webhook ingress contract section
        then: HTTP method POST is declared, the path is named, headers X-Hub-Signature-256, X-GitHub-Event, X-GitHub-Delivery, and Content-Type application/json are required, accepted events are exactly pull_request.opened, pull_request.synchronize, and pull_request.reopened, and 2xx-on-accept semantics are stated
      - id: AC-2
        given: docs/api-contracts.md exists
        when: a reader inspects the webhook ingress contract section
        then: idempotency key derivation is named via a deriveIdempotencyKey function whose inputs include X-GitHub-Delivery and the (installation_id, repository_id, pull_request.number, head_sha) tuple
      - id: AC-3
        given: docs/api-contracts.md exists
        when: a reader inspects the async job contract section
        then: JobPayload fields include idempotency_key, installation_id, repository_id, pull_request_number, head_sha, event_type, and received_at; terminal states are exactly succeeded, failed_terminal, and discarded_idempotent; retry policy is described as a class (transient vs non-transient) without numeric counts or intervals
      - id: AC-4
        given: docs/api-contracts.md exists
        when: a reader inspects the provider adapter contract section
        then: the signature review(input ProviderReviewInput) returns Promise of ProviderReviewOutput, the error union is ProviderError, capability flags are ProviderCapabilities, and an invariant states that no vendor SDK type leaks outside packages/providers/<adapter>
      - id: AC-5
        given: docs/api-contracts.md exists
        when: a reader inspects the validator, ranker, and publisher contracts
        then: validator returns NormalizedFinding[] plus RejectionLogEntry[], ranker returns RankedFindings without dropping items, publisher returns PublicationResult containing published_inline, published_summary, dropped, rejections, checks_run_id, and summary_artifact
      - id: AC-6
        given: docs/api-contracts.md exists
        when: a reader inspects the GitHub interactions section
        then: the Checks API, Pull Request Review Comments API, Pull Requests API, and Installations API are named in plain language and no curl example or specific URL appears
      - id: AC-7
        given: docs/api-contracts.md exists
        when: a reader inspects the invariants and error semantics section
        then: every per-contract invariant is restated in a numbered list, including no vendor SDK type outside the adapter, signature verification before idempotency before enqueue before 2xx, every dropped finding paired with a RejectionLogEntry, and Zod failure terminating the job with failed_terminal
  docs/publication-policy.md:
    acceptance:
      - id: PP-1
        given: docs/publication-policy.md exists
        when: a reader inspects the defaults section
        then: comment_cap.per_pr is 5, comment_cap.per_file is 1, severity_floor.inline is medium, confidence_floor.inline is 0.7, and the default mode for newly installed repos is dry-run
      - id: PP-2
        given: docs/publication-policy.md exists
        when: a reader inspects the mode behavior section
        then: subsections exist for dry-run, summary-only, and summary-plus-inline in that order, each declaring What is published, Where, Severity floor applied, Confidence floor applied, Per-PR cap applied, Per-file cap applied, and Dedupe behavior reference
      - id: PP-3
        given: docs/publication-policy.md exists
        when: a reader inspects the threshold and cap application order section
        then: the order is exactly compute eligibility, apply dedupe, apply per_file cap, apply per_pr cap, move overflow to summary, and render Checks summary, in that order
      - id: PP-4
        given: docs/publication-policy.md exists
        when: a reader inspects the dedupe behavior section
        then: dedupe_key is referenced (not redefined), within-run and across-run dedupe scopes are both specified, and the per-PR already-published source is named as the GitHub Checks/Review-Comments history of this App on this PR
      - id: PP-5
        given: docs/publication-policy.md exists
        when: a reader inspects the fallbacks section
        then: subsections exist for Malformed ProviderReviewOutput, Diff too large, and Provider error (non-transient); malformed-output policy is drop with audit log (never downgrade); diff-too-large policy is summary-only output regardless of mode
      - id: PP-6
        given: docs/publication-policy.md exists
        when: a reader inspects the re-run behavior on synchronize section
        then: it states that the pipeline re-runs end-to-end, the publisher consults the per-PR already-published dedupe set, and stale inline comments are not edited or deleted in MVP
      - id: PP-7
        given: docs/publication-policy.md exists
        when: a reader inspects the worked example section
        then: the example uses 12 valid findings, mode summary-plus-inline, the OQ-2 defaults, publishes exactly 5 inline, lists all 12 in the summary, and labels the 7 non-published with reason codes per_file_cap_exhausted or per_pr_cap_exhausted
consistency_checks:
  - id: CC-1
    description: Mode names dry-run, summary-only, summary-plus-inline are byte-identical across product-spec.md, config-spec.md, api-contracts.md, and publication-policy.md
  - id: CC-2
    description: OQ-2 default literals 5, 1, medium, 0.7, dry-run appear in config-spec.md as defaults and are reused without redeclaration in publication-policy.md
  - id: CC-3
    description: Phase 1 identifiers ProviderReviewInput, ProviderReviewOutput, ProviderError, ProviderCapabilities appear verbatim in api-contracts.md and are not aliased anywhere in Phase 2 docs
  - id: CC-4
    description: Pipeline stages prefilter, provider, validator, ranker, publication cap appear in this order in product-spec.md and review-findings-schema.md
  - id: CC-5
    description: Schema chain ProviderReviewOutput -> NormalizedFinding -> RankedFindings -> PublicationResult is named identically in every doc that touches a link
  - id: CC-6
    description: Severity vocabulary (info, low, medium, high, critical) and category vocabulary (security, correctness, performance, tests, style, migration, dependency at minimum) are referenced consistently across config-spec.md, review-findings-schema.md, and publication-policy.md
  - id: CC-7
    description: product-spec.md out-of-scope behaviors list the eight non-goals byte-equivalent to mvp-scope.md, in the same order
  - id: CC-8
    description: The path .github/review-bot.yml appears verbatim in product-spec.md, config-spec.md, and publication-policy.md
  - id: CC-9
    description: publication-policy.md worked example contains the literals 12 (input findings) and 5 (published inline)
  - id: CC-10
    description: docs/open-questions.md Resolution log contains the OQ-1 and OQ-2 entries dated 2026-04-30; OQ-3 remains in Open questions
  - id: CC-11
    description: api-contracts.md and review-findings-schema.md contain no Anthropic-specific type names; only Phase 1 and Phase 2 schema identifiers
  - id: CC-12
    description: api-contracts.md webhook ingress contract contains the phrase 2xx-on-accept, names the deriveIdempotencyKey function, and lists exactly the accepted events pull_request.opened, pull_request.synchronize, pull_request.reopened
exit_gate:
  description: All 5 Phase 2 files exist at their specified paths, all acceptance criteria above evaluate true, all consistency_checks pass with zero violations, and docs/open-questions.md Resolution log records OQ-1 and OQ-2 with resolution date 2026-04-30 while OQ-3 remains open and is explicitly deferred to Phase 3.
```
