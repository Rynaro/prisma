# Configuration Specification — `.github/review-bot.yml`

## File location and ownership

The repo-local configuration file is `.github/review-bot.yml`. The path is fixed and is not configurable. The file is checked into the target repository under the same access controls as the rest of the repository's source: anyone with write access to the repo can change it, and any PR can propose a change to it. The App reads the file from the head ref of the PR being processed.

The file is treated as untrusted-by-default input (per `threat-model.md` § Scope and assumptions). Read parsing must not execute arbitrary code, must not interpret tags that produce code or external references, and must not follow cross-file `!include`-style directives. Any unknown structure is rejected or ignored as specified in § Failure modes; the worker never trusts shape it has not validated.

## Resolution order

Configuration is resolved in this order; each layer overrides the previous on a per-key basis (deep merge for objects, replacement for scalars and arrays):

1. **Built-in defaults shipped with the App.** These are the values declared in this document. They apply to every installation without any repo-local file.
2. **Repo-local `.github/review-bot.yml`.** Values present in the file override built-in defaults for the keys they specify; absent keys fall through to the built-in default.
3. **Per-PR overrides.** Reserved slot. Phase 4 may or may not implement a mechanism for per-PR overrides; this layer is declared here so it has a defined precedence position when it lands. When implemented, per-PR overrides take precedence over the repo-local file for the keys they specify.

## Key reference

### enabled

- **Type.** Boolean.
- **Required.** Optional.
- **Default.** `true`.
- **Validation rule (plain English).** Must be a boolean. When `false`, the App does not run the pipeline for any PR in this repository; no Checks run is created and no inline comments are produced.
- **Example.** `enabled: true`

### mode

- **Type.** String enum.
- **Required.** Optional.
- **Default.** `dry-run` (per OQ-2 resolution).
- **Validation rule (plain English).** Value must be one of `dry-run`, `summary-only`, or `summary-plus-inline`, case-sensitive. Any other string rejects the file (see § Failure modes).
- **Example.** `mode: summary-plus-inline`

### provider

- **Type.** String.
- **Required.** Optional.
- **Default.** `anthropic` (per OQ-1 resolution).
- **Validation rule (plain English).** Must be a known adapter id registered with the App. Unknown adapter ids reject the file.
- **Example.** `provider: anthropic`
- **Deprecation note.** Setting `provider:` alongside a bare `model:` name is supported but deprecated. Prefer the `provider/name` slug form on `model:` instead (see below). When both are present and the slug's provider differs from `provider:`, the slug wins and a config note is emitted.

### model

- **Type.** String — either a bare model name or a `provider/name` slug.
- **Required.** Optional.
- **Default.** Unset; resolved from deployment configuration when absent.
- **Validation rule (plain English).** Two accepted forms:
  - **`provider/name` slug** (preferred): `openai/gpt-5.4-nano`. The part before the `/` is the provider slug (used for `provider_options` bag keying and config echo); the part after is the bare model name forwarded to the active adapter. The slug never switches the active adapter in this release — adapter selection remains env-key-driven.
  - **Bare name** (existing form): `gpt-4o`. Resolved using the active adapter's default. When a legacy `provider:` key is also set, a deprecation note is appended to the check-run summary.
- **Conflict rule.** If `provider: anthropic` and `model: openai/gpt-5.4-nano` are both set, the slug wins (`provider=openai, model=gpt-5.4-nano`) and a warning note is emitted. The file is never rejected on this conflict.
- **Malformed slugs.** `openai/` (empty name) → warning, no model override; `/gpt-4o` (empty provider) → treated as bare `gpt-4o`; `a/b/c` (multiple slashes) → warning, no model override. None of these reject the file.
- **Example.** `model: openai/gpt-5.4-nano`  (slug form, preferred)
- **Migration.** Replace `provider: openai` + `model: gpt-5.4-nano` with `model: openai/gpt-5.4-nano` and remove the `provider:` key.
- **Model compatibility.** Reasoning-family models (gpt-5+/o-series) use a different `tool_choice` mode than classic models. If a reasoning model returns an empty review, see [`docs/model-compatibility.md`](model-compatibility.md) for the compatibility matrix and remedies.

### generation

- **Type.** Object.
- **Required.** Optional.
- **Default.** `{}` (empty — all sub-keys absent, deployment defaults apply).
- **Validation rule (plain English).** All sub-keys are optional and independently validated:
  - `max_output_tokens`: positive integer. Overrides the deployment-level `OPENAI_MAX_OUTPUT_TOKENS` for this repo's requests. The token parameter key (`max_tokens` vs `max_completion_tokens`) is chosen by the adapter per model family — the config need not specify which.
  - `temperature`: number in `[0, 2]`. Values outside this range reject the file.
  - `top_p`: number in `[0, 1]`. Values outside this range reject the file.
  - `seed`: integer (any sign). Forwarded to the adapter as a determinism hint.
  - Unknown sub-keys are warned and ignored (consistent with the outer warn-and-ignore policy).
- **Precedence.** `provider_options` (raw passthrough) overrides `generation` (normalized) which overrides deployment-level env defaults.
- **Vendor note.** `generation` fields are normalized and translated by each adapter to its wire dialect. In this release only the OpenAI adapter translates them. Anthropic and Copilot adapters ignore `generation`; use `provider_options` for vendor-specific knobs.
- **Example.**

  ```yaml
  generation:
    max_output_tokens: 8192
    temperature: 0.2
    top_p: 0.95
    seed: 42
  ```

### provider_options

- **Type.** Object (map of provider slug → open bag).
- **Required.** Optional.
- **Default.** `{}` (empty).
- **Validation rule (plain English).** Keys at the top level are provider slugs (e.g. `openai`, `anthropic`). Values are objects with arbitrary string keys. Only the sub-bag keyed by the **active provider** is applied; all other sub-bags are silently ignored (no cross-provider leakage).
- **Passthrough semantics.** All keys in the active provider's bag are forwarded verbatim to the provider request, **minus** the Prisma-managed denylist (see § Denylist below). This is the escape hatch for vendor-specific request fields (`reasoning_effort`, `service_tier`, etc.) not covered by `generation`.
- **Precedence.** `provider_options` wins last — it overrides any normalized field set by `generation`. For example, setting both `generation.max_output_tokens: 4096` and `provider_options.openai.max_tokens: 1000` on a classic model causes `max_tokens: 1000` on the wire.
- **Secret safety.** The `configuration` check-run reply echoes **keys only** (never values) per provider, e.g. `openai: [reasoning_effort, service_tier]`. Provider option values are never logged.
- **Example.**

  ```yaml
  provider_options:
    openai:
      reasoning_effort: low
      service_tier: flex
    anthropic:
      thinking:
        type: enabled
        budget_tokens: 1024
  ```

#### Denylist (OpenAI)

The following keys are **dropped** when present in `provider_options.openai`, and a config note is emitted naming each dropped key. They protect the review structured-output contract:

| Dropped key | Reason |
|---|---|
| `model` | Resolved from the `model:` slug; passthrough must not silently retarget it. |
| `messages` | Prisma-owned prompt; overriding it discards review instructions. |
| `tools` | Must remain the single `submit_review_findings` function tool. |
| `tool_choice` | Must remain forced to `submit_review_findings`; `"none"` or `"auto"` breaks structured output. |
| `stream` | Pipeline consumes a single JSON response; streaming breaks extraction. |
| `n` | Multiple choices break the `choices[0]` extraction contract. |
| `response_format` | Conflicts with the function-calling structured-output path. |

`max_tokens`, `max_completion_tokens`, `seed`, `temperature`, and `top_p` are **not** denylisted — overriding them via `provider_options` is the intended escape-hatch pattern.

### thresholds

- **Type.** Object.
- **Required.** Optional.
- **Default.** `{ severity_floor: { inline: medium }, confidence_floor: { inline: 0.7 } }` (per OQ-2 resolution).
- **Validation rule (plain English).** Sub-key `severity_floor.inline` must be one of `info`, `low`, `medium`, `high`, `critical`. Sub-key `confidence_floor.inline` must be a finite number in `[0,1]`. Unknown sub-keys are warned and ignored.
- **Example.**

  ```yaml
  thresholds:
    severity_floor:
      inline: medium
    confidence_floor:
      inline: 0.7
  ```

### comment_cap

- **Type.** Object.
- **Required.** Optional.
- **Default.** `{ per_pr: 5, per_file: 1 }` (per OQ-2 resolution).
- **Validation rule (plain English).** Sub-keys `per_pr` and `per_file` must each be a non-negative integer. A value of `0` for either means "publish nothing inline at this scope" but does not disable the Checks summary. Negative values reject the file.
- **Example.**

  ```yaml
  comment_cap:
    per_pr: 5
    per_file: 1
  ```

### path_rules

- **Type.** Object.
- **Required.** Optional.
- **Default.** `{ include: [], exclude: [] }`.
- **Validation rule (plain English).** Sub-keys `include` and `exclude` are arrays of glob strings. Each entry is a non-empty string. `exclude` is applied after `include`: a path matched by both is excluded.
- **Example.**

  ```yaml
  path_rules:
    include:
      - "src/**"
    exclude:
      - "src/generated/**"
  ```

### exclude_generated

- **Type.** Boolean.
- **Required.** Optional.
- **Default.** `true`.
- **Validation rule (plain English).** Must be a boolean. When `true`, the prefilter applies built-in generated-file detection (lockfiles, build outputs, vendored markers) before any provider call.
- **Example.** `exclude_generated: true`

### exclude_vendored

- **Type.** Boolean.
- **Required.** Optional.
- **Default.** `true`.
- **Validation rule (plain English).** Must be a boolean. When `true`, the prefilter excludes vendored directories matching built-in patterns before any provider call.
- **Example.** `exclude_vendored: true`

### max_files

- **Type.** Integer.
- **Required.** Optional.
- **Default.** Set by built-in defaults; tunable per repo.
- **Validation rule (plain English).** Positive integer. The prefilter short-circuits the pipeline when the number of touched files in the diff exceeds this value; the publisher emits summary-only output regardless of the configured `mode` (see `publication-policy.md` § Diff too large).
- **Example.** `max_files: 50`

### max_changed_lines

- **Type.** Integer.
- **Required.** Optional.
- **Default.** Set by built-in defaults; tunable per repo.
- **Validation rule (plain English).** Positive integer. The prefilter short-circuits the pipeline when the total number of changed lines in the diff exceeds this value; the publisher emits summary-only output regardless of the configured `mode` (see `publication-policy.md` § Diff too large).
- **Example.** `max_changed_lines: 2000`

### categories_enabled

- **Type.** Array of strings.
- **Required.** Optional.
- **Default.** The full category vocabulary defined in `review-findings-schema.md` § Category vocabulary.
- **Validation rule (plain English).** Every entry must be a member of the category vocabulary defined in `review-findings-schema.md`. Unknown categories reject the file.
- **Example.**

  ```yaml
  categories_enabled:
    - security
    - correctness
    - performance
    - tests
    - migration
    - dependency
  ```

### severity

- **Type.** Object (mapping).
- **Required.** Optional.
- **Default.** Empty (no per-category overrides).
- **Validation rule (plain English).** Keys must be members of the category vocabulary defined in `review-findings-schema.md`; values must be members of the severity vocabulary `info`, `low`, `medium`, `high`, `critical`. The mapping declares per-category severity overrides applied by the validator and the ranker.
- **Example.**

  ```yaml
  severity:
    tests: low
    style: info
  ```

### language_overrides

- **Type.** Object.
- **Required.** Optional.
- **Default.** Empty.
- **Validation rule (plain English).** A map from a language tag (e.g., `typescript`, `python`, `go`) to an object whose shape is a subset of this top-level configuration. Every override must satisfy the same per-key validation rules as the top level. Precedence: language override > top-level repo config > built-in defaults.
- **Example.**

  ```yaml
  language_overrides:
    typescript:
      thresholds:
        confidence_floor:
          inline: 0.8
  ```

### repo_heuristics

- **Type.** Object.
- **Required.** Optional.
- **Default.** `{ security: true, tests: true, migrations: true, layering: true }`.
- **Validation rule (plain English).** Sub-keys `security`, `tests`, `migrations`, and `layering` are each booleans. Toggles influence the validator and the ranker (not the prefilter): they up-weight or down-weight findings in the relevant categories. Additional sub-keys are warned and ignored.
- **Example.**

  ```yaml
  repo_heuristics:
    security: true
    tests: true
    migrations: true
    layering: true
  ```

### review_guidance

- **Type.** Object.
- **Required.** Optional.
- **Default.** Empty (no custom guidance).
- **Validation rule (plain English).** All sub-fields are optional. The object contains up to three sub-keys:
  - `instructions`: a free-text string (1–2,048 bytes) applied globally to every PR review.
  - `path_instructions`: an array of up to 20 objects, each with `path` (minimatch glob) and `instructions` (1–2,048 bytes). Only path-scoped instructions matching changed files are sent to the model.
  - `context_files`: an array of up to 5 objects, each with `path` (repo-relative file path). Files are fetched and injected as reference material (max 64 KiB each, truncated on UTF-8 boundary).
- **Example.**

  ```yaml
  review_guidance:
    instructions: "Always check for proper error handling and logging."
    path_instructions:
      - path: "src/api/**"
        instructions: "Enforce strict TypeScript types; no implicit any."
      - path: "tests/**"
        instructions: "Each test must assert one clear behavior."
    context_files:
      - path: "docs/architecture.md"
      - path: "docs/BUSINESS_RULES.md"
  ```

- **Full reference:** [docs/custom-review-prompts.md](./custom-review-prompts.md) — how custom guidance works, token budgets, degradation rules, and security considerations.

### nickname

- **Type.** String.
- **Required.** Optional.
- **Default.** Unset (real bot login only).
- **Validation rule (plain English).** Must be login-shaped: starts with alphanumeric, may contain hyphens, 1–39 characters. Any other shape rejects the file.
- **Example.** `nickname: prbot`

When set, both the real bot login and the nickname are accepted as valid command targets.

### command_marker

- **Type.** String enum.
- **Required.** Optional.
- **Default.** `@`.
- **Validation rule (plain English).** Value must be exactly one of `@`, `$`, `!`, `/`, case-sensitive. Any other value rejects the file.
- **Example.** `command_marker: "$"`

Controls which prefix character must appear before the bot login in PR comments for the command to be recognised. Operators who want to avoid GitHub's `@`-autocomplete — which can accidentally ping real users who share a name prefix with the bot slug — can set this to `$`, `!`, or `/`.

**Mention matching is case-insensitive.** Whether the configured marker is `@` or any of the alternatives, the candidate login after the marker is compared case-insensitively against the bot slug and configured nickname. `@Josie` and `@josie` are treated as the same candidate.

**Note on `$`.** GitHub renders `$...$` pairs as inline math (LaTeX) in Markdown. A lone `$josie` at the start of a line (no closing `$` on the same line) is rendered as plain text — this is the common usage pattern and is safe. Operators choosing `$` should ensure command comments do not accidentally form a closed `$...$` pair on the first line.

### chunking

Controls the diff-chunking subsystem. When a PR is too large for a single
provider call but within the chunkable ceiling, the pipeline batches
prefiltered files across multiple provider calls, merges the findings, then
runs the existing validator→ranker→publisher chain once.

**Cost implication.** Chunking can multiply provider API costs by up to
`max_provider_calls_per_pr` for very large PRs. Set `enabled: false` or reduce
`max_provider_calls_per_pr` if cost is a concern.

The existing top-level `max_files` (default 50) / `max_changed_lines` (default
2000) remain the **single-call** threshold. A PR between those limits and the
chunking ceiling gets a chunked review. Above the chunking ceiling →
`oversized` skip.

#### chunking.enabled

- **Type.** Boolean.
- **Required.** Optional.
- **Default.** `true`.
- **Validation rule.** Must be a boolean.
- **Example.** `enabled: false`

When `false`, the chunked-review path is disabled. PRs above `max_files` /
`max_changed_lines` are hard-skipped as `oversized` (today's behavior).

#### chunking.max_files

- **Type.** Integer, positive.
- **Required.** Optional.
- **Default.** `200`.
- **Validation rule.** Must be a positive integer.
- **Example.** `max_files: 150`

The chunkable ceiling for kept-file count. A PR with more files than this value
is hard-skipped as `oversized` even if chunking is enabled.

#### chunking.max_changed_lines

- **Type.** Integer, positive.
- **Required.** Optional.
- **Default.** `12000`.
- **Validation rule.** Must be a positive integer.
- **Example.** `max_changed_lines: 8000`

The chunkable ceiling for total changed lines. A PR with more changed lines
than this value is hard-skipped as `oversized` even if chunking is enabled.

#### chunking.max_provider_calls_per_pr

- **Type.** Integer, positive.
- **Required.** Optional.
- **Default.** `6`.
- **Validation rule.** Must be a positive integer.
- **Example.** `max_provider_calls_per_pr: 3`

Cost guard: the maximum number of provider API calls allowed for a single PR
review. If greedy bin-packing would need more batches than this cap, the PR is
skipped as `oversized` with a notice explaining the batch count. Reduce this
value to bound cost; raise it to enable review of very large PRs.

#### chunking.call_token_budget

- **Type.** Integer, positive.
- **Required.** Optional.
- **Default.** `1000000` (high sentinel; effectively unused by default).
- **Validation rule.** Must be a positive integer.
- **Example.** `call_token_budget: 100000`

Per-call input token budget ceiling (back-compat knob). In v0.12.0+, the effective
input budget is **derived** from the provider's context window using the reservation
formula: `hard_cap_in = window − reserved_output_tokens − prompt_overhead_tokens − ceil(safety_fraction × window)`.

The `call_token_budget` acts as an optional ceiling layered on top: 
`effective_budget = min(call_token_budget, hard_cap_in)`. To make the derived `hard_cap_in`
dominate by default (v0.12.0+ behavior), the default is raised to a high sentinel
(`1000000`). Operators who set a lower value preserve the old behavior: that value
caps the budget regardless of the provider's window. See § Phase 2 reservation formula
below for details.

#### chunking.reserved_output_tokens

- **Type.** Integer, positive.
- **Required.** Optional.
- **Default.** `4096`.
- **Validation rule.** Must be a positive integer.
- **Example.** `reserved_output_tokens: 8192`

Output token budget reserved per provider call. The adapter sets `max_tokens` /
`max_completion_tokens` on the wire to this value. When the model's output reaches
this limit, the batch is split and retried (never dropped). Also used in the
`hard_cap_in` reservation formula.

Operators raise this for finding-dense repositories where the review findings
exceed the default output window and cause truncation. See § Phase 1 output truncation
fix below.

#### chunking.max_truncation_retries

- **Type.** Integer, non-negative.
- **Required.** Optional.
- **Default.** `2`.
- **Validation rule.** Must be a non-negative integer.
- **Example.** `max_truncation_retries: 1`

Maximum number of split-and-retry attempts when a batch's output is truncated. Each
truncated batch is split in half (by estimated token count) and retried. After this
many retries are exhausted, the files are recorded as "not fully reviewed" in the
check-run notice; the PR is never aborted.

Default `2` means an initial batch plus up to 2 retry generations (3 total attempts).
Set to `0` to disable retries and fall back to the old behavior (record and skip).

#### chunking.prompt_overhead_tokens

- **Type.** Integer, positive.
- **Required.** Optional.
- **Default.** `9000`.
- **Validation rule.** Must be a positive integer.
- **Example.** `prompt_overhead_tokens: 10000`

Token reserve for the prompt's fixed overhead: system prompt (~250 tokens) + tool/JSON
schema (~500) + guidance ceiling (`MAX_AUGMENTATION_TOKENS=7500`) + render scaffolding
(~750) = ~9000 total. Used in the `hard_cap_in` reservation formula.

Operators should keep `prompt_overhead_tokens >= 1000 + MAX_AUGMENTATION_TOKENS`
(i.e., >= 8500) to ensure the guidance budget is not evicted.

#### chunking.safety_fraction

- **Type.** Number, in range [0, 1].
- **Required.** Optional.
- **Default.** `0.07`.
- **Validation rule.** Must be a number in [0, 1].
- **Example.** `safety_fraction: 0.1`

Fraction of the provider's context window reserved as a safety margin. The reservation
formula computes `safety = ceil(safety_fraction × window)` and deducts it from the
input budget. Default `0.07` = 7% (within the consensus 5–10% band from research
literature on token estimator accuracy).

Operators raise this if tokenizer estimates consistently under-count and cause
actual overflow; lower it if the budget feels artificially constrained.

#### chunking.hunk_context_lines

- **Type.** Integer, non-negative.
- **Required.** Optional.
- **Default.** `10`.
- **Validation rule.** Must be a non-negative integer.
- **Example.** `hunk_context_lines: 15`

Context lines surrounding a hunk boundary (forward-compat knob). In v0.12.0 this is
recorded but **not used** — the splitter operates on existing hunk boundaries produced
by the prefilter and does not re-diff or re-trim hunk content (the core lacks the raw
patch; re-diffing belongs to a future prefilter change). This value is kept so a
future prefilter change can use it without a breaking schema bump.

Default `10` matches the Qodo-style "~10 lines surrounding context" guidance.

#### chunking.min_hunk_split_tokens

- **Type.** Integer, non-negative.
- **Required.** Optional.
- **Default.** `0`.
- **Validation rule.** Must be a non-negative integer.
- **Example.** `min_hunk_split_tokens: 50000`

Minimum estimated token count for a file to be eligible for hunk-level splitting.
A file whose estimate is below this threshold is never split — the splitter only
fires when the file's estimate exceeds `hard_cap_in`. Default `0` (always split
when over budget) is conservative; operators can raise this to suppress pathological
1-line splits for files that are only marginally over budget.

#### The Token Budget Derivation Formula (v0.12.0+)

In v0.12.0 the per-call input token budget is **derived** from the provider's
context window. The batcher and per-call guard both use the same unified token
estimator to count the exact serialized prompt (system + diff + tool schema +
guidance), and the budget is computed as:

```
window                 = provider.capabilities.max_context_tokens      # e.g., 200_000 (Anthropic), 128_000 (OpenAI)
reserved_output        = chunking.reserved_output_tokens               # default 4096
prompt_overhead        = chunking.prompt_overhead_tokens               # default 9000
safety                 = ceil(chunking.safety_fraction × window)       # default: ceil(0.07 × window)

hard_cap_in            = window − reserved_output − prompt_overhead − safety

effective_budget       = min(chunking.call_token_budget, hard_cap_in)
```

**Plain-English summary:** The provider's context window is split into four reserves:
(1) the output budget (`reserved_output_tokens`), (2) a fixed overhead for the prompt
template and tool schema (`prompt_overhead_tokens`), (3) a safety margin as a
percentage of the window, and (4) the remaining space is available for input (diff
hunks + guidance). The derived `hard_cap_in` is the effective per-call input budget
unless `call_token_budget` is set lower.

**Why derive it?** Token estimators (even the best) have a small error margin (5–10%).
Deriving the budget from the provider's *actual* context window ensures the input
stays well under the window's ceiling, leaving headroom for estimator error.

**Back-compat:** The `call_token_budget` key is kept for existing configurations.
If you set it explicitly, it acts as a ceiling: `effective_budget = min(call_token_budget, hard_cap_in)`.
To restore pre-v0.12.0 behavior (e.g., `call_token_budget: 60000` was the old default),
set it in your config — the effective budget will cap at that value regardless of
the provider's window.

## Precedence matrix

The following table declares how filtering keys interact. Rows are the filtering key in question; the cell describes its resolution rule against the named other key. "Applies first" means evaluated before; "applies last" means evaluated after.

| key | vs `path_rules.include` | vs `path_rules.exclude` | vs `exclude_generated` | vs `exclude_vendored` | vs `max_files` | vs `max_changed_lines` |
| --- | --- | --- | --- | --- | --- | --- |
| `path_rules.include` | self | applies first; `exclude` overrides | applies first; `exclude_generated` is OR-ed with `path_rules.exclude` | applies first; `exclude_vendored` is OR-ed with `path_rules.exclude` | applies first; size limits evaluated last | applies first; size limits evaluated last |
| `path_rules.exclude` | overrides `include` | self | OR-ed; whichever excludes wins | OR-ed; whichever excludes wins | applies first; size limits evaluated last | applies first; size limits evaluated last |
| `exclude_generated` | overrides `include` for generated paths | OR-ed with `path_rules.exclude` | self | independent; both flags OR-ed | applies first; size limits evaluated last | applies first; size limits evaluated last |
| `exclude_vendored` | overrides `include` for vendored paths | OR-ed with `path_rules.exclude` | independent; both flags OR-ed | self | applies first; size limits evaluated last | applies first; size limits evaluated last |
| `max_files` | applies last; triggers summary-only fallback regardless of `mode` | applies last | applies last | applies last | self | independent; either limit being exceeded triggers fallback |
| `max_changed_lines` | applies last; triggers summary-only fallback regardless of `mode` | applies last | applies last | applies last | independent; either limit being exceeded triggers fallback | self |

In summary: `path_rules.exclude`, `exclude_generated`, and `exclude_vendored` are OR-ed; any one of them can drop a path. `path_rules.include` defines the candidate set and is overridden by any of the exclusion rules. `max_files` and `max_changed_lines` are evaluated last and short-circuit to summary-only fallback.

## Worked example (verbatim block)

The following YAML block is a complete, valid `.github/review-bot.yml` that uses the OQ-2 defaults explicitly. Every top-level key declared in this document is present, even where the value equals the default.

```yaml
enabled: true
mode: dry-run
# Preferred form: provider/name slug. The 'provider:' key is deprecated when used
# alongside a slug; remove it and encode the provider in the model slug instead.
model: openai/gpt-5.4-nano
thresholds:
  severity_floor:
    inline: medium
  confidence_floor:
    inline: 0.7
comment_cap:
  per_pr: 5
  per_file: 1
path_rules:
  include:
    - "src/**"
  exclude:
    - "src/generated/**"
exclude_generated: true
exclude_vendored: true
max_files: 50
max_changed_lines: 2000
categories_enabled:
  - security
  - correctness
  - performance
  - tests
  - style
  - migration
  - dependency
severity:
  tests: low
  style: info
language_overrides:
  typescript:
    thresholds:
      confidence_floor:
        inline: 0.8
repo_heuristics:
  security: true
  tests: true
  migrations: true
  layering: true
# Optional: vendor-neutral generation parameters. All sub-keys are optional.
# Absent fields fall through to deployment-level env defaults.
generation:
  max_output_tokens: 8192
  temperature: 0.2
  # top_p: 0.95   # uncomment to set
  # seed: 42       # uncomment for deterministic sampling
# Optional: raw passthrough to the active provider's API request.
# Only the sub-bag keyed by the active provider is forwarded; values are never logged.
# provider_options:
#   openai:
#     reasoning_effort: low
#     service_tier: flex
# Optional: set a nickname so both '@prisma-bot' and '@prbot' trigger commands.
nickname: prbot
# Optional: use '$' instead of '@' to avoid GitHub's @-autocomplete.
command_marker: "@"
# Optional: diff-chunking controls (see § chunking for cost implications).
# In v0.12.0+, the per-call input budget is derived from the provider's context
# window using the reservation formula. The knobs below are optional; absent =
# defaults apply.
chunking:
  enabled: true
  max_files: 200
  max_changed_lines: 12000
  max_provider_calls_per_pr: 6
  # call_token_budget: 1000000        # optional ceiling on derived budget (default: high sentinel)
  # reserved_output_tokens: 4096      # output reserve (default: 4096)
  # max_truncation_retries: 2         # split-and-retry cap on output truncation (default: 2)
  # prompt_overhead_tokens: 9000      # system + tool + guidance reserve (default: 9000)
  # safety_fraction: 0.07             # window safety margin as fraction (default: 0.07)
  # hunk_context_lines: 10            # forward-compat: context lines per hunk (default: 10, unused)
  # min_hunk_split_tokens: 0          # min estimate before hunk-split is attempted (default: 0)
```

### Migration from legacy `provider:` + `model:` form

**Before (deprecated but still accepted):**
```yaml
provider: openai
model: gpt-5.4-nano
```

**After (preferred):**
```yaml
model: openai/gpt-5.4-nano
```

Remove the `provider:` key and encode the provider in the `model:` slug. The schema continues to accept the legacy form and emits a deprecation note in the check-run summary. If `provider:` and a conflicting slug are both present, the slug wins.

## Failure modes

**File missing.** The repository does not contain `.github/review-bot.yml`. This is not an error. The worker uses built-in defaults for every key. No Checks run is created on account of the missing file; subsequent PR processing proceeds normally under defaults (which include `mode: dry-run`).

**File malformed.** The file is present but does not parse as YAML, or parses to a non-object root, or violates a structural rule of this specification (e.g., a list where an object is required). The worker rejects the file and falls back to built-in defaults for the entire configuration. A structured log entry is emitted with a `reason_code` identifying the parse failure category. The publisher emits a Checks run with `neutral` conclusion whose summary explains, in category terms, that the configuration was rejected and that built-in defaults were applied for the current PR.

**Unknown keys.** The file contains keys not listed in this document. Unknown top-level keys and unknown sub-keys are warned (a structured log entry is emitted) and ignored. They do not reject the file, and they do not fall back to defaults; the rest of the configuration is honored.

**Type mismatch on a known key.** The file contains a known key with a value of the wrong type or out of range (e.g., `comment_cap.per_pr: -1`, `mode: review`, `confidence_floor.inline: 1.5`). The worker rejects the entire file and falls back to built-in defaults — partial acceptance is not permitted. A structured log entry is emitted naming the offending key and its expected validation rule. The publisher emits a Checks run with `neutral` conclusion explaining the rejection in category terms.

**`review_guidance`-only violation.** As a single exception to whole-file rejection: when *every* validation error is confined to `review_guidance.*` (e.g., `instructions` exceeds its 2,048-byte cap, or `context_files` has more than 5 entries, or a `path_instructions[]` block is over-long), the worker drops **only** the guidance block — it is reset to its empty default (`has_guidance` becomes false) — and honors every other key in the file (`model`, `max_files`, `comment_cap`, `path_rules.exclude`, `nickname`, `command_marker`, floors, etc.). This prevents a small guidance mistake from silently reverting the entire configuration to defaults. Degradation is never silent: a `worker.config.parse_error` log entry (with `salvaged: true`) is emitted and a note is added to the check-run summary naming the dropped field. If even one validation error falls outside `review_guidance` (or the YAML is malformed), the whole-file rejection above still applies.
