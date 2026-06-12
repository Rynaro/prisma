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
```

## Failure modes

**File missing.** The repository does not contain `.github/review-bot.yml`. This is not an error. The worker uses built-in defaults for every key. No Checks run is created on account of the missing file; subsequent PR processing proceeds normally under defaults (which include `mode: dry-run`).

**File malformed.** The file is present but does not parse as YAML, or parses to a non-object root, or violates a structural rule of this specification (e.g., a list where an object is required). The worker rejects the file and falls back to built-in defaults for the entire configuration. A structured log entry is emitted with a `reason_code` identifying the parse failure category. The publisher emits a Checks run with `neutral` conclusion whose summary explains, in category terms, that the configuration was rejected and that built-in defaults were applied for the current PR.

**Unknown keys.** The file contains keys not listed in this document. Unknown top-level keys and unknown sub-keys are warned (a structured log entry is emitted) and ignored. They do not reject the file, and they do not fall back to defaults; the rest of the configuration is honored.

**Type mismatch on a known key.** The file contains a known key with a value of the wrong type or out of range (e.g., `comment_cap.per_pr: -1`, `mode: review`, `confidence_floor.inline: 1.5`). The worker rejects the entire file and falls back to built-in defaults — partial acceptance is not permitted. A structured log entry is emitted naming the offending key and its expected validation rule. The publisher emits a Checks run with `neutral` conclusion explaining the rejection in category terms.
