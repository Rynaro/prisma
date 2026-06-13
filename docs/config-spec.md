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

### model

- **Type.** String.
- **Required.** Optional.
- **Default.** Unset; resolved from deployment configuration when absent.
- **Validation rule (plain English).** Provider-specific opaque identifier. The App does not interpret the string; the provider adapter validates it against its own capability surface.
- **Example.** `model: claude-4-class-model-id`

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
- **Default.** `60000`.
- **Validation rule.** Must be a positive integer.
- **Example.** `call_token_budget: 40000`

Per-call input token budget for greedy bin-packing. Files are accumulated into
a batch until the next file would push the batch's estimated token count over
this value, then a new batch is opened. A single file whose estimate exceeds
this value is sent in its own batch (the model's real context window may still
accept it). A file whose estimate exceeds the hard safety cap (≈110,000 tokens)
is excluded from all batches and surfaced in a notice.

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
provider: anthropic
model: claude-4-class-model-id
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
# Optional: set a nickname so both '@prisma-bot' and '@prbot' trigger commands.
nickname: prbot
# Optional: use '$' instead of '@' to avoid GitHub's @-autocomplete.
command_marker: "@"
# Optional: diff-chunking controls (see § chunking for cost implications).
chunking:
  enabled: true
  max_files: 200
  max_changed_lines: 12000
  max_provider_calls_per_pr: 6
  call_token_budget: 60000
```

## Failure modes

**File missing.** The repository does not contain `.github/review-bot.yml`. This is not an error. The worker uses built-in defaults for every key. No Checks run is created on account of the missing file; subsequent PR processing proceeds normally under defaults (which include `mode: dry-run`).

**File malformed.** The file is present but does not parse as YAML, or parses to a non-object root, or violates a structural rule of this specification (e.g., a list where an object is required). The worker rejects the file and falls back to built-in defaults for the entire configuration. A structured log entry is emitted with a `reason_code` identifying the parse failure category. The publisher emits a Checks run with `neutral` conclusion whose summary explains, in category terms, that the configuration was rejected and that built-in defaults were applied for the current PR.

**Unknown keys.** The file contains keys not listed in this document. Unknown top-level keys and unknown sub-keys are warned (a structured log entry is emitted) and ignored. They do not reject the file, and they do not fall back to defaults; the rest of the configuration is honored.

**Type mismatch on a known key.** The file contains a known key with a value of the wrong type or out of range (e.g., `comment_cap.per_pr: -1`, `mode: review`, `confidence_floor.inline: 1.5`). The worker rejects the entire file and falls back to built-in defaults — partial acceptance is not permitted. A structured log entry is emitted naming the offending key and its expected validation rule. The publisher emits a Checks run with `neutral` conclusion explaining the rejection in category terms.
