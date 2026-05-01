# Phase 7 — Developer Experience: SPECTRA Specification

Phase 7 is the final MVP phase. Outputs are: a top-level `README.md`,
a sample repo-local config at `.github/review-bot.yml.example`, a
TypeScript webhook replay script with a `make replay-webhook` target,
and a `make smoke` target (driven by `scripts/smoke.sh`). This document
is the binding contract for IDG (docs composition) and APIVR (code).
This document does NOT contain the doc bodies; it specifies their
shape and acceptance criteria.

---

## Phase 7 work plan

**Authoring order (gated):**

1. `README.md` — written first because it is the single source of
   onboarding truth and it cross-links every other Phase 7 artifact.
2. `.github/review-bot.yml.example` — written second because its
   shape is referenced by the README's "Local development" and "Trust
   model" sections.
3. `scripts/replay-webhook.ts` — written third because its CLI is
   referenced verbatim in the README's "Local webhook development"
   section and is invoked by `scripts/smoke.sh`.
4. `Makefile` additions (`replay-webhook`, `smoke`) — written
   alongside the script so the help text and command shape stay in
   sync.
5. `scripts/smoke.sh` — written last because it composes
   `make up`, `make replay-webhook`, and `make down`.

**Parallelism:**

- IDG works in parallel on `README.md` and `.github/review-bot.yml.example`.
- APIVR works in parallel on `scripts/replay-webhook.ts`,
  `Makefile` additions, and `scripts/smoke.sh`. The script and
  Makefile changes are co-located in one APIVR PR; the smoke
  script depends on the replay script being complete.
- IDG and APIVR run concurrently. Cross-file consistency is verified
  in the consistency-check pass below before either branch merges.

**Consistency-check pass before exit:**

1. Pipeline string `prefilter → provider → validator → ranker → publication cap` appears byte-equivalent in README architecture overview and in any other reference.
2. Schema chain `ProviderReviewInput → ProviderReviewOutput → NormalizedFinding → RankedFindings → PublicationResult` appears byte-equivalent.
3. Mode names `dry-run`, `summary-only`, `summary-plus-inline` are spelled identically across README, sample config, and replay-script docstrings.
4. Config path `.github/review-bot.yml` (production) and `.github/review-bot.yml.example` (template) are not confused.
5. Test count `227` and eval scenario count `9/9` match the verified-state baselines in the prompt.
6. OQ-2 defaults (per_pr=5, per_file=1, severity_floor.inline=medium, confidence_floor.inline=0.7, mode=dry-run) appear identically in sample config and README "Trust model" section.
7. Every env var listed in README "Environment variables" section maps 1:1 with `.env.example` and the `secret`/`config`/`tunable` classification matches `docs/deployment.md`.
8. Every `make` command referenced in README exists in `Makefile`; every `make` target in `Makefile` is documented in README.
9. Replay script CLI shape in README matches the script's `--help` output.
10. `make smoke` flow described in README matches the steps in `scripts/smoke.sh`.

**Phase 7 exit gate (testable form):**

GIVEN the four files above are merged on `main`,
WHEN `make typecheck && make lint && make test && make eval && make smoke` runs in a clean clone,
THEN all five commands exit 0, the README "Documentation map" links resolve, the sample config validates against `RepoConfigSchema`, and the replay script's CLI `--help` output matches the README's "Local webhook development" section. (≤ 250 words plan budget honored.)

---

## File 1 — `README.md`

### Purpose

Canonical onboarding doc for the project. Single Markdown file at
the repository root. No frontmatter. Audience: a new contributor
reading the project for the first time, plus an operator evaluating
the App for installation. Tone: technical, dense, neutral. No
marketing copy. No emojis.

### Required sections (exact heading list)

The following H1/H2 headings appear in this order, byte-equivalent:

1. `# <Project name and tagline>` — single line. The project name is
   sourced from `package.json` `name` (`@prisma-bot/*` workspace) or
   from `eidolons.yaml`; IDG picks the user-facing name. The tagline
   is one sentence describing the App at the level of `docs/product-spec.md` § Product summary.
2. `## Status`
3. `## Architecture overview`
4. `## Module map`
5. `## Setup`
6. `## Local development`
7. `## Local webhook development`
8. `## Environment variables`
9. `## Test commands`
10. `## Known limitations`
11. `## Trust model — why comments are capped`
12. `## Documentation map`
13. `## License`

No additional H2s. Subsections (H3) are permitted only where required
content guidance below names them.

### Required content per section

**`## Status`**

- Phase 7 / MVP-complete / not yet GA.
- Baseline metrics, listed verbatim:
  - `227 tests` across `33 test files` (Vitest, run via `make test`).
  - `9/9 evaluation scenarios PASS` (run via `make eval`; index at `evals/scenarios.yaml`).
- Cite ADR-001, ADR-002, ADR-003 by ID as the architectural anchors.

**`## Architecture overview`**

- One paragraph naming the deployment shape (GitHub App per ADR-001), the provider abstraction (ADR-002), and the deterministic pipeline (ADR-003).
- An ASCII diagram of the pipeline. Required minimum content (boxes and arrows; characters illustrative):
  ```
  GitHub webhook
       |
       v
  +-----------------+      +---------+      +----------+      +--------+      +-----------------+      +-----------+
  | webhook ingress | ---> | enqueue | ---> | worker   | ---> | runner | ---> | provider stage  | ---> | publisher |
  | (HMAC verify)   |      | BullMQ  |      | pickup   |      |        |      | (anthropic)     |      | Checks API|
  +-----------------+      +---------+      +----------+      +--------+      +-----------------+      +-----------+
                                                                  |
                                                                  v
                                                  prefilter -> provider -> validator -> ranker -> publication cap
  ```
  The pipeline string `prefilter -> provider -> validator -> ranker -> publication cap` (or its arrow-character variant `prefilter → provider → validator → ranker → publication cap`) appears as a labeled annotation under the worker box.
- Cite ADR-001, ADR-002, ADR-003 by ID inline.

**`## Module map`**

- A Markdown table with three columns: `package`, `purpose`, `system-design.md anchor`.
- One row per workspace package. Required rows (sourced from `pnpm-workspace.yaml` and `docs/system-design.md` § Component map):
  - `apps/github-app` — Fastify ingress + BullMQ worker entry points → `docs/system-design.md#appsgithub-appwebhook-ingress`
  - `packages/shared` — schemas, audit-log, redactor → `docs/system-design.md#packagessharedaudit-log`
  - `packages/config` — config-loader (`.github/review-bot.yml` resolution) → `docs/system-design.md#packagesconfigconfig-loader`
  - `packages/core` — snapshotter, prefilter, validator-ranker → `docs/system-design.md#packagescoresnapshotter`
  - `packages/github` — installation-auth, check-runs, review-comments → `docs/system-design.md#packagesgithubinstallation-auth`
  - `packages/providers` — Provider interface surface → `docs/system-design.md#packagesproviders-provider-abstraction-surface`
  - `packages/providers/anthropic` — Anthropic Claude reference adapter (per OQ-1) → `docs/system-design.md#packagesprovidersanthropic`
  - `evals/runner` — Phase 6 deterministic harness (`@prisma-bot/eval-runner`) → `evals/README.md`
- Anchors are link targets; IDG generates the slug per Markdown
  rendering convention.

**`## Setup`**

- Prerequisites listed prominently and exclusively as: **Docker (≥ 20)** and **GNU Make**.
- The README MUST state, verbatim or near-verbatim, "No Node, no pnpm, no other host runtime is required."
- Post-clone steps: clone, `cp .env.example .env`, `make install`. No host-runtime installs.

**`## Local development`**

- Walkthrough invoking, in order, with one sentence per step and a code block per command:
  1. `make install` — installs pnpm-managed workspace deps inside the `tools` container; produces `pnpm-lock.yaml` if absent.
  2. `make typecheck` — runs `pnpm typecheck` across all workspaces.
  3. `make lint` — runs Biome lint.
  4. `make test` — runs the Vitest suite (`227` tests, `33` files baseline).
  5. `make eval` — runs the Phase 6 harness (`9` scenarios; PASS gate).
  6. `make up` — starts `redis`, `app`, and `worker` containers in detached mode.
- Subsection or paragraph for `make up` MUST mention `APP_HOST_PORT` overriding the default `3030`. Reference the comment in `docker-compose.yml` (the container always listens on `3000` internally).
- Every command appears in a fenced code block. NEVER reference raw `pnpm`, `npm`, `node`, `tsc`, `vitest`, or `tsx` outside a Makefile-quoted context.

**`## Local webhook development`**

- Describe `make replay-webhook FIXTURE=<id>` with a worked
  example using the `security-bug` fixture:
  ```
  make replay-webhook FIXTURE=security-bug
  ```
- State that the replay script reads `evals/fixtures/<id>.yaml`,
  signs the body with the dev fallback secret (`dev-only-not-secure`)
  unless `GITHUB_APP_WEBHOOK_SECRET` is set, and POSTs to
  `http://localhost:3030/webhooks/github`.
- State that the URL is overridable via `URL=...`, e.g.
  `make replay-webhook FIXTURE=security-bug URL=http://localhost:4000/webhooks/github`.
- State that real GitHub deliveries require setting
  `GITHUB_APP_WEBHOOK_SECRET` to the App's actual secret (per
  `docs/deployment.md` § Secrets).
- Reference `make smoke` once: "An end-to-end smoke test is
  available via `make smoke`; see § Test commands."

**`## Environment variables`**

- A Markdown table with columns: `name`, `classification`, `description`.
- Rows grouped: secrets first, then config, then tunables. Each
  group preceded by a one-line bold marker (`**Secrets**`, `**Config**`, `**Tunables**`) so secrets are visually distinct.
- Variables, classification, and descriptions sourced byte-equivalent from `docs/deployment.md` § Environment variables and `.env.example`. The full list:
  - **Secrets:** `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`.
  - **Config:** `PORT`, `REDIS_URL`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `LOG_LEVEL`, `INSTALLATION_REPLAY_WINDOW_SECONDS`, `NODE_ENV`.
  - **Tunables:** `QUEUE_CONCURRENCY`, `JOB_TIMEOUT_SECONDS`, `RETRY_TRANSIENT_MAX_ATTEMPTS`, `RETRY_TRANSIENT_BACKOFF_BASE_MS`, `RETRY_TRANSIENT_BACKOFF_MAX_MS`, `RETRY_RATELIMIT_MAX_ATTEMPTS`, `MAX_TOKENS_PER_PR`, `MAX_TOKENS_PER_WINDOW_PER_INSTALLATION`, `MAX_TOKENS_WINDOW_SECONDS`, `OTEL_TRACES_SAMPLER_ARG`.
- Optionally include `APP_HOST_PORT` in the Config group with a note that it is a docker-compose host-port override (it is consumed by `docker-compose.yml`, not by application code).

**`## Test commands`**

- Two subsections or two paragraphs:
  1. `make test` — Vitest. Cite the baseline `227 tests / 33 files`.
  2. `make eval` — Phase 6 harness. Cite the `9` scenarios. Reference `evals/README.md` for adding new scenarios.

**`## Known limitations`**

- Bulleted list. Required bullets, in order:
  1. MVP runs single-tenant; multitenant boundaries are namespaced by `installation_id` (per `docs/system-design.md` § Multitenancy posture) but not validated under load.
  2. Anthropic is the only provider implemented (per OQ-1); the abstraction permits additional adapters but none ship in MVP.
  3. No live-API integration tests; Phase 6 evaluation is deterministic and offline (FakeProvider, OctokitLike).
  4. Cost-ceiling enforcement uses a character/4 token-proxy; precise tokenization is post-MVP (per OQ-4).
  5. Inline-comment dedupe across runs is correct in unit tests but unproven against real GitHub API quirks (per `docs/publication-policy.md` § Dedupe behavior).
  6. The Checks summary may be truncated to `60 KB` on very large finding sets.
- Final bullet: "See `docs/open-questions.md` for the open OQs (OQ-4, OQ-5, OQ-6, OQ-8, OQ-9)."

**`## Trust model — why comments are capped`**

- One paragraph (≤ 8 sentences) explaining the OQ-2 defaults verbatim:
  - `comment_cap.per_pr` = 5
  - `comment_cap.per_file` = 1
  - `severity_floor.inline` = `medium`
  - `confidence_floor.inline` = 0.7
  - default `mode` for newly installed repos = `dry-run`
- Cite operating principle 5 ("Trust preservation beats maximum coverage") — the README quotes the principle in a single inline phrase, not as a block.
- Link to `docs/publication-policy.md` for the full ruleset.

**`## Documentation map`**

- Markdown table with columns: `document`, `purpose`. Required rows
  (one per Phase 1–6 doc):
  - `docs/research-summary.md` — OSS landscape and integration-surface findings.
  - `docs/mvp-scope.md` — what is in/out of MVP scope.
  - `docs/threat-model.md` — security and abuse risk register.
  - `docs/open-questions.md` — open and resolved decisions registry.
  - `docs/architecture-decision-records/adr-001-github-app.md` — App-first decision.
  - `docs/architecture-decision-records/adr-002-provider-abstraction.md` — Provider abstraction decision.
  - `docs/architecture-decision-records/adr-003-validation-ranking.md` — Pipeline shape decision.
  - `docs/product-spec.md` — personas, modes, core flows.
  - `docs/config-spec.md` — `.github/review-bot.yml` schema and resolution.
  - `docs/review-findings-schema.md` — `NormalizedFinding`, `dedupe_key`, `RejectionLogEntry`.
  - `docs/api-contracts.md` — internal pipeline contracts.
  - `docs/publication-policy.md` — publisher ruleset and OQ-2 defaults.
  - `docs/system-design.md` — components, schemas, end-to-end sequence.
  - `docs/data-flow.md` — five flows (happy, oversized, provider-fail, malformed, replay).
  - `docs/deployment.md` — topology, env vars, health surfaces.
  - `docs/observability.md` — logs, metrics, traces, redaction allowlist.
  - `docs/operational-runbooks.md` — runbooks and tunables.
  - `docs/evaluation-plan.md` — Phase 6 methodology.
  - `evals/README.md` — operator-facing eval harness guide.

**`## License`**

- Single line: `License: TBD.` plus a one-sentence note that
  licensing is a pre-GA decision and that the question is tracked
  alongside the open OQs (a pointer to `docs/open-questions.md` is
  acceptable; if no existing OQ covers licensing, IDG flags this for
  follow-up — do not invent a new OQ in Phase 7).

### Acceptance criteria (≥ 3 GIVEN/WHEN/THEN)

- **AC-README-1.** GIVEN the README at `/README.md`, WHEN it is rendered as Markdown, THEN it contains exactly the 13 H2 headings listed above in the listed order (no extra H2s, no missing H2s; the H1 line above `## Status` is the project name/tagline line).
- **AC-README-2.** GIVEN the README, WHEN scanned for the strings `prefilter → provider → validator → ranker → publication cap` (or the ASCII variant `prefilter -> provider -> validator -> ranker -> publication cap`) and `ProviderReviewInput → ProviderReviewOutput → NormalizedFinding → RankedFindings → PublicationResult`, THEN both pipeline-string and schema-chain strings appear at least once.
- **AC-README-3.** GIVEN the README "Setup" section, WHEN scanned for the literal tokens `pnpm`, `npm`, `node`, `tsc`, `vitest`, `tsx` outside a Makefile-quoted context (i.e., not appearing inside a `make ...` invocation), THEN none of those tokens appear (host-runtime tools must not leak into the developer instructions).
- **AC-README-4.** GIVEN the README "Environment variables" table, WHEN compared row-by-row with `.env.example`, THEN every variable in `.env.example` appears in the table and every non-`APP_HOST_PORT` row in the table appears in `.env.example`. Classifications match `docs/deployment.md` § Environment variables.
- **AC-README-5.** GIVEN the README "Status" section, WHEN scanned for the substrings `227` and `9/9`, THEN both appear (matching the verified-state baseline in the Phase 7 brief).
- **AC-README-6.** GIVEN the README "Known limitations" section, WHEN scanned, THEN it lists at least the six required bullets (single-tenant, single-provider, no live-API tests, char/4 token proxy, dedupe unproven, 60 KB summary truncation) and a final bullet referencing `docs/open-questions.md`.
- **AC-README-7.** GIVEN the README "Documentation map" table, WHEN every link is resolved relative to the repo root, THEN every link points to an existing file under `docs/` or `evals/`.
- **AC-README-8.** GIVEN the README "Trust model — why comments are capped" section, WHEN scanned, THEN it contains the five OQ-2 defaults (per_pr=5, per_file=1, severity_floor.inline=medium, confidence_floor.inline=0.7, default mode dry-run) and a link to `docs/publication-policy.md`.

### Cross-file consistency requirements

- Pipeline string and schema chain match the verbatim forms in
  `docs/mvp-scope.md`, `docs/api-contracts.md`, and ADR-003.
- Mode names match `docs/product-spec.md` § Operating modes.
- OQ-2 defaults match `docs/publication-policy.md` § Defaults and `packages/shared/src/schemas/config.ts`.
- Test count `227` and eval count `9` match the verified-state
  claim in the Phase 7 brief; if either count drifts before merge,
  IDG MUST update the README in the same commit.

### Out of scope

- Marketing copy, screenshots, badges (CI status, code coverage).
- Tutorial / "tour of the codebase" content beyond the module map.
- API reference generation.
- Contributor guide, code-of-conduct, governance — these are
  separate documents and are not Phase 7 deliverables.
- Build / publish instructions for the App's container image —
  those live in `docs/deployment.md`.

---

## File 2 — `.github/review-bot.yml.example`

### Purpose

A complete, copyable template of `.github/review-bot.yml` for repos
that install the App. The file at `.github/review-bot.yml.example`
in THIS project is a template only; the actual `.github/review-bot.yml`
of THIS project is not used by the App and is not authoritative.

### Required shape

- The file is a valid YAML document.
- The file parses cleanly through `loadRepoConfig` (the loader at
  `packages/config/src/config-loader/parse.ts`) which validates
  against `RepoConfigSchema` from `@prisma-bot/shared`.
- The file presents the OQ-2 defaults explicitly so the reader sees
  the defaults when they copy the template — no key is left implicit.
- A top-of-file comment block names the canonical path and links to
  the spec, in this exact form (verbatim, with the leading hash and
  space):
  ```
  # ============================================================================
  # .github/review-bot.yml — repo-local configuration for the AI Code Review App
  #
  # Canonical path: .github/review-bot.yml (in YOUR repo)
  # Schema: docs/config-spec.md  (in the App repo)
  # Defaults below match the OQ-2 resolutions documented in
  #   docs/open-questions.md § OQ-2 — Default values for publication caps and severity floor
  # ============================================================================
  ```
- Every top-level key declared in `docs/config-spec.md` § Key
  reference is present, even where the value equals the default.
- Each top-level key carries one comment line (ABOVE the key, not
  inline) explaining what the key does in ≤ 1 sentence.

### Required content per section (key-by-key)

The template MUST include the following keys at the top level, each
with the value shown. Inline comments naming defaults are permitted
but not required; pre-key explanatory comments ARE required.

- `enabled: true`
- `mode: dry-run`
- `provider: anthropic`
- `model: ` — declared but commented out (`# model: claude-4-class-model-id`) so newcomers do not pin a model id by accident; loader treats absent `model` as `optional`.
- `thresholds:` — `severity_floor.inline: medium`, `confidence_floor.inline: 0.7`.
- `comment_cap:` — `per_pr: 5`, `per_file: 1`.
- `path_rules:` — `include: ["src/**"]`, `exclude: ["src/generated/**"]`. (Worked-example values from `docs/config-spec.md` § Worked example are acceptable; an empty `include: []` and `exclude: []` is also acceptable. Whichever shape APIVR/IDG choose, the file MUST validate.)
- `exclude_generated: true`
- `exclude_vendored: true`
- `max_files: 50`
- `max_changed_lines: 2000`
- `categories_enabled:` — list every member of the category vocabulary documented in `docs/config-spec.md` § `categories_enabled` (default: `security`, `correctness`, `performance`, `tests`, `style`, `migration`, `dependency`).
- `severity:` — empty mapping `{}` or omitted (loader default is `{}`); IDG picks. If included, MUST contain valid (category, severity) pairs.
- `language_overrides:` — empty mapping `{}` or omitted. If included, MUST contain at least one valid language override (e.g., the `typescript` example from `docs/config-spec.md` § Worked example).
- `repo_heuristics:` — `security: true`, `tests: true`, `migrations: true`, `layering: true`.

### Acceptance criteria (≥ 3 GIVEN/WHEN/THEN)

- **AC-EXAMPLE-1.** GIVEN the file `.github/review-bot.yml.example`, WHEN parsed by `loadRepoConfig` (the `RepoConfigSchema`-backed loader exported from `@prisma-bot/shared`), THEN parsing succeeds, no `ConfigParseError` is thrown, and every top-level key declared in `docs/config-spec.md` § Key reference is present in the parsed object.
- **AC-EXAMPLE-2.** GIVEN the file, WHEN the parsed `mode` field is read, THEN it equals `dry-run`. WHEN the parsed `comment_cap` is read, THEN `per_pr === 5` and `per_file === 1`. WHEN the parsed `thresholds` is read, THEN `severity_floor.inline === 'medium'` and `confidence_floor.inline === 0.7`. WHEN the parsed `provider` is read, THEN it equals `anthropic`.
- **AC-EXAMPLE-3.** GIVEN the file, WHEN scanned for the literal substrings `.github/review-bot.yml` and `docs/config-spec.md`, THEN both appear in the top-of-file comment block. The comment block also contains the substring `OQ-2`.
- **AC-EXAMPLE-4.** GIVEN the file, WHEN every top-level key from `RepoConfigSchema`'s key list is enumerated, THEN every such key is preceded by at least one comment line in the YAML source (a `# ...` line on the line immediately above the key); this is mechanically checkable by a Vitest test that walks the YAML AST or scans line-by-line.
- **AC-EXAMPLE-5.** GIVEN the file, WHEN the parsing test under `evals/runner` (or a co-located test at `packages/config/tests/example-config.test.ts`) runs, THEN it asserts deep equality between the parsed config and a hard-coded expectation matching the OQ-2 defaults. APIVR adds this test as part of Phase 7 deliverables.

### Cross-file consistency requirements

- Defaults match `packages/shared/src/schemas/config.ts` `RepoConfigSchema` defaults byte-equivalent.
- The OQ-2 default values match `docs/open-questions.md` § OQ-2 resolution byte-equivalent.
- The path string `.github/review-bot.yml` (no `.example` suffix) appears in the top-of-file comment block (not in the on-disk filename); the on-disk filename is `.github/review-bot.yml.example`.
- The category list under `categories_enabled` matches the default in `RepoConfigSchema` (currently `['security', 'correctness', 'performance', 'tests', 'style', 'migration', 'dependency']`).

### Out of scope

- Provider-specific advanced flags beyond what `RepoConfigSchema` exposes.
- Comment text describing future / post-MVP keys (per-PR overrides slot, etc.).
- Multi-environment templates (staging vs. production); this is a single canonical template.

---

## File 3 — `scripts/replay-webhook.ts`

### Purpose

A developer-only TypeScript CLI that takes an evaluation fixture id,
reconstructs a `pull_request` webhook delivery from the fixture's
`pr_payload`, signs it with the dev fallback (or an operator-provided)
secret, and POSTs it to a configurable URL. It is invoked through the
`tools` container via `make replay-webhook FIXTURE=<id>`. It is not
a production utility; do NOT use it to drive a hosted environment.

### Required shape

CLI invocation (as documented in the Phase 7 brief; reproduce
verbatim in `--help` output):

```
tsx scripts/replay-webhook.ts \
  --fixture <fixture-id> \
  [--url http://localhost:3030/webhooks/github] \
  [--secret-env GITHUB_APP_WEBHOOK_SECRET] \
  [--delivery-id <uuid>]
```

Behavior, in order:

1. Parse argv. Flags accepted: `--fixture` (required), `--url` (default `http://localhost:3030/webhooks/github`), `--secret-env` (default `GITHUB_APP_WEBHOOK_SECRET`), `--delivery-id` (optional; if absent, generate a UUID via `node:crypto.randomUUID`), `--help`/`-h` (print usage and exit 0).
2. Read `evals/fixtures/<fixture-id>.yaml` from disk. Path is relative to the repo root, resolved by `process.cwd()` (the `tools` container mounts the repo at `/app` and runs with `cwd=/app`).
3. Parse the YAML and extract the `pr_payload` field. If the field is missing, exit 2 with a clear error message naming the fixture id.
4. Serialize `pr_payload` to JSON (the request body). The serialization MUST be stable: use `JSON.stringify(prPayload)` with no `replacer` and no `space`.
5. Resolve the secret: read `process.env[<secret-env>]`. If unset, fall back to the literal string `dev-only-not-secure` AND emit a `warn`-level log line to `stderr` stating that the dev fallback is in use (matching the dev fallback in `apps/github-app/src/main.ts` — IDG/APIVR confirm the constant before merge).
6. Compute `X-Hub-Signature-256: sha256=<HMAC-SHA-256(rawBody, secret)>` using `node:crypto.createHmac('sha256', secret).update(rawBody).digest('hex')`. The header value MUST be prefixed with `sha256=`.
7. Resolve `X-GitHub-Delivery`: use `--delivery-id` if passed, else generate via `crypto.randomUUID()`.
8. Set `X-GitHub-Event: pull_request`.
9. Set `Content-Type: application/json`.
10. POST via the global `fetch` API. No external HTTP client library.
11. Print the response status (e.g., `HTTP 202`) to `stdout`, then the response body (truncated to `4 KB` if larger) to `stdout`. Print headers `X-GitHub-Delivery` and `X-Hub-Signature-256` (the signature value, prefixed `sha256=`) to `stderr` so they are not piped into JSON consumers but are visible to humans.
12. Exit 0 on `2xx`; exit 1 on `4xx`/`5xx`; exit 2 on local errors (missing fixture, malformed YAML, no `pr_payload`).

### Required content per section

- Top-of-file docstring (`/** ... */`) summarizing purpose, the
  `make replay-webhook` invocation, and stating "Developer tool —
  not for production use." Cite `docs/api-contracts.md` § Webhook
  ingress contract for the header and signing requirements.
- Argv parsing: a hand-rolled parser is acceptable; no new dependency
  is permitted. Use the same minimal style already present in
  `scripts/` if any precedent exists.
- Logging: use `console.log` (stdout) for response status/body and
  `console.warn`/`console.error` (stderr) for warnings and errors.
  No structured logger import.
- Imports allowed: `node:crypto`, `node:fs/promises` (or `node:fs`),
  `node:path`, `node:process`, `js-yaml` OR `yaml` (whichever is
  already in the lockfile — APIVR confirms before merge), and types
  from `@prisma-bot/shared` if helpful for the fixture shape (not
  required).
- No imports from `@anthropic-ai/sdk`, `octokit`, or any HTTP client.
- The constant `'dev-only-not-secure'` MUST be sourced from a
  shared module if one exists; otherwise inline with a code comment
  pointing to the source-of-truth in `apps/github-app/src/main.ts`.

### Acceptance criteria (≥ 3 GIVEN/WHEN/THEN)

- **AC-REPLAY-1.** GIVEN the script, WHEN invoked as `tsx scripts/replay-webhook.ts --help` (inside the `tools` container), THEN it prints a usage block matching the CLI shape verbatim and exits 0.
- **AC-REPLAY-2.** GIVEN the script and a running app (`make up` complete; `app` container listening on `localhost:3030`), WHEN invoked as `tsx scripts/replay-webhook.ts --fixture security-bug`, THEN the script reads `evals/fixtures/security-bug.yaml`, signs the body with the dev fallback secret, POSTs to `http://localhost:3030/webhooks/github`, the receiver's HMAC verification succeeds, the response status is `2xx`, and the script exits 0.
- **AC-REPLAY-3.** GIVEN the script, WHEN invoked with a `--secret-env` whose env var is set to a value that does NOT match the running app's `GITHUB_APP_WEBHOOK_SECRET`, THEN the receiver returns `4xx` with code `signature_invalid` (per `docs/api-contracts.md` § Webhook ingress contract) and the script exits 1.
- **AC-REPLAY-4.** GIVEN the script, WHEN invoked with `--fixture nonexistent-fixture-id`, THEN the script exits 2 with an error message containing the literal string `nonexistent-fixture-id` and the path `evals/fixtures/nonexistent-fixture-id.yaml`.
- **AC-REPLAY-5.** GIVEN the script, WHEN invoked without `--secret-env` set in the environment AND no env var named `GITHUB_APP_WEBHOOK_SECRET` is set, THEN the script writes a `warn`-level line to `stderr` containing the substring `dev-only-not-secure` and proceeds to sign the request with that fallback.
- **AC-REPLAY-6.** GIVEN the script source, WHEN scanned for imports, THEN no import matches the regex `from ['"](?:@anthropic-ai/sdk|octokit|axios|node-fetch|undici)['"]`. The signed-request mechanics use `node:crypto` and the global `fetch` only.

### Cross-file consistency requirements

- Default URL `http://localhost:3030/webhooks/github` matches the docker-compose `app` service host port (`APP_HOST_PORT:-3030` in `docker-compose.yml`) and the path `/webhooks/github` in `docs/api-contracts.md` § Webhook ingress contract.
- Header names match `docs/api-contracts.md` § Webhook ingress contract byte-equivalent: `X-Hub-Signature-256`, `X-GitHub-Event`, `X-GitHub-Delivery`, `Content-Type: application/json`.
- The signature scheme `sha256=<hex>` matches GitHub's documented webhook signature format and `apps/github-app` ingress's verification routine.
- The dev-only fallback `dev-only-not-secure` matches the constant in `apps/github-app/src/main.ts`; APIVR confirms the value at implementation time and updates this spec section if it has drifted.

### Out of scope

- Simulating worker behavior or asserting on response shape beyond status code.
- Signing with the GitHub App private key (the `.pem`); this is webhook signature only, not App auth.
- Generating fixture YAML files; the script consumes existing fixtures.
- Driving a hosted (non-localhost) environment; `--url` permits it but the script does NOT add CSRF protections, retry logic, or rate-limit awareness.
- Pretty-printing or JSON-schema-validating the fixture content.

---

## File 4 — `Makefile` updates

### Purpose

Add two new targets to the existing `Makefile` (do NOT replace
existing targets) and update the `help` text. Container-first:
both new targets run their work inside containers, never on the
host.

### Required shape

- `replay-webhook` target:
  - Usage: `make replay-webhook FIXTURE=<id> [URL=...]`
  - Runs `scripts/replay-webhook.ts` inside the `tools` container.
  - The recipe MUST validate that `FIXTURE` is non-empty; if empty, print a usage line and exit non-zero.
  - The `URL` env var is forwarded to the script as the `--url` flag when set.
- `smoke` target:
  - Usage: `make smoke`
  - Runs `scripts/smoke.sh`. The script orchestrates `make up`, polling, signed/unsigned POSTs, log inspection, and `make down`. The script runs on the host shell (because it composes `docker compose` calls); the `replay-webhook` invocation INSIDE the script goes through the `tools` container as above.
- `help` target:
  - Add two lines describing the new commands, formatted to match the existing help output style.

### Required content per section

- The `.PHONY` line MUST list `replay-webhook` and `smoke`.
- Recipe for `replay-webhook` (illustrative; APIVR may adjust quoting):
  ```
  replay-webhook:
  	@if [ -z "$(FIXTURE)" ]; then \
  		echo "usage: make replay-webhook FIXTURE=<id> [URL=<override>]"; \
  		exit 2; \
  	fi
  	$(TOOLS) tsx scripts/replay-webhook.ts --fixture $(FIXTURE) $(if $(URL),--url $(URL),)
  ```
- Recipe for `smoke` (illustrative):
  ```
  smoke:
  	./scripts/smoke.sh
  ```
- Help additions (placed in the same alphabetical group as `eval`):
  ```
  @echo "  make replay-webhook FIXTURE=id  Replay an eval fixture as a signed webhook delivery"
  @echo "  make smoke                      Bring stack up, run e2e webhook check, tear down"
  ```

### Acceptance criteria (≥ 3 GIVEN/WHEN/THEN)

- **AC-MAKE-1.** GIVEN the updated `Makefile`, WHEN `make help` runs, THEN both `replay-webhook` and `smoke` appear in the output, each with a one-line description.
- **AC-MAKE-2.** GIVEN the updated `Makefile`, WHEN `make replay-webhook` runs without `FIXTURE` set, THEN the recipe exits non-zero (≥ 1) and prints a usage line containing `make replay-webhook FIXTURE=<id>`.
- **AC-MAKE-3.** GIVEN the updated `Makefile` and a running stack (`make up` complete), WHEN `make replay-webhook FIXTURE=security-bug` runs, THEN the recipe invokes `tsx scripts/replay-webhook.ts --fixture security-bug` inside the `tools` container and exits 0.
- **AC-MAKE-4.** GIVEN the updated `Makefile`, WHEN `make smoke` runs in a clean environment (no app running), THEN the recipe shells out to `./scripts/smoke.sh` and exits with the script's exit code.
- **AC-MAKE-5.** GIVEN the existing `Makefile` targets, WHEN the diff is reviewed, THEN no existing target's recipe has been modified except `help` (which gains two echoed lines).

### Cross-file consistency requirements

- The `tools` container invocation pattern `$(TOOLS) ...` matches the existing `Makefile` style.
- The recipe forwards `URL=...` only when set (no empty `--url ""` argument).
- The `smoke` recipe does NOT run inside the `tools` container; it runs on the host so it can `docker compose up`/`down`.

### Out of scope

- Adding new container profiles to `docker-compose.yml`.
- Re-organizing existing Makefile targets.
- Adding a CI target wrapping `make smoke` (CI integration is post-MVP).

---

## File 5 — `scripts/smoke.sh`

### Purpose

End-to-end smoke check of the dev stack. Brings the stack up, polls
the liveness endpoint, exercises the webhook ingress with both an
unsigned and a signed delivery, verifies the worker received a job
event, and tears the stack down. Exits 0 on all-pass, non-zero on
any miss.

### Required shape

- Bash script (`#!/usr/bin/env bash`).
- `set -euo pipefail` at the top.
- A `trap` on `EXIT` that calls `make down` regardless of exit code (so a failure mid-run still tears the stack down).
- Idempotent: running `make smoke` twice in a row works, even if a
  prior run crashed mid-way.
- All `make` invocations are quoted; no raw `pnpm`/`node`/`tsx`
  outside `make`-mediated calls.

### Required content per section (steps in order)

1. **Bring stack up.** `make up` (NOT in background; `make up` already runs in detached mode via `docker compose up -d`).
2. **Poll liveness.** Loop with a 30-second timeout: `curl -fsS http://localhost:${APP_HOST_PORT:-3030}/healthz/live` until 200 or timeout. On timeout: print a clear error and exit 1.
3. **Unsigned POST.** `curl` an empty (or arbitrary) JSON body to `http://localhost:${APP_HOST_PORT:-3030}/webhooks/github` with `X-GitHub-Event: pull_request` and `X-GitHub-Delivery: <uuid>` but WITHOUT `X-Hub-Signature-256`. Expected: HTTP 401 (or 4xx — APIVR confirms against `apps/github-app` ingress; whichever the ingress returns, the spec accepts the documented signature-failure code from `docs/api-contracts.md` § Webhook ingress contract). If the response is anything other than 4xx, exit 1 with a clear message.
4. **Signed POST via replay script.** Invoke `make replay-webhook FIXTURE=security-bug`. Expected: 2xx response from the ingress. If exit code != 0, exit 1 with a clear message naming the failed step.
5. **Tail worker logs and grep for `worker.started`.** `docker compose logs worker --tail=20 | grep -q 'worker.started'`. If grep does not match within ~5 s of the signed POST (the script may sleep briefly to let the worker pick up the job), exit 1 with a clear message.
6. **Tear down.** Already handled by the EXIT trap — `make down` runs whether or not the script reached this point.
7. **Exit 0.** On all-pass.

### Required content per section (helpers)

- A small helper function `fail()` that prints to stderr and exits 1.
- A small helper function `wait_for_url <url> <timeout-seconds>` for the liveness poll.
- All `echo` lines describing progress prefix the message with `[smoke]` so the output is greppable.

### Acceptance criteria (≥ 3 GIVEN/WHEN/THEN)

- **AC-SMOKE-1.** GIVEN a clean repo with no running containers, WHEN `make smoke` runs to completion, THEN: (a) `make up` is invoked, (b) `/healthz/live` returns 200 within 30 s, (c) an unsigned POST returns 4xx, (d) a signed POST via `make replay-webhook FIXTURE=security-bug` returns 2xx, (e) `worker.started` appears in `docker compose logs worker`, (f) `make down` runs in the trap, (g) the script exits 0.
- **AC-SMOKE-2.** GIVEN a smoke run that fails at the unsigned-POST step (e.g., the receiver wrongly accepts an unsigned request), WHEN the script catches the unexpected 2xx, THEN it exits non-zero AND `make down` still runs (verified by `docker compose ps` showing no `app`/`worker` containers after the failure).
- **AC-SMOKE-3.** GIVEN a smoke run on a host where `APP_HOST_PORT=4040` is exported, WHEN the script polls the liveness endpoint, THEN it polls `http://localhost:4040/healthz/live` (i.e., honors the env override).
- **AC-SMOKE-4.** GIVEN the script source, WHEN scanned for `set -euo pipefail` and a `trap ... EXIT` line invoking `make down`, THEN both are present.
- **AC-SMOKE-5.** GIVEN the script source, WHEN scanned for raw invocations of `pnpm`, `node`, `tsx`, or `npm`, THEN none are present (the only runtime invocations go through `make` or `docker compose`).

### Cross-file consistency requirements

- The signed-POST step uses the same fixture id (`security-bug`) referenced by the README's "Local webhook development" section and by `evals/scenarios.yaml`.
- The unsigned-POST step's expected status (4xx with a non-2xx code) matches `docs/api-contracts.md` § Webhook ingress contract — Failure semantics — Signature verification failure.
- The `worker.started` log line matches the event name in `docs/observability.md` § Event taxonomy. (`worker.started` is the closest match; the actual event in the taxonomy is `job.started`. APIVR MUST confirm which event the worker emits at startup vs. job pickup; if the worker emits `worker.started` only at process startup, the script greps for it; if the worker emits `job.started` per job, the script greps for that. The Phase 7 brief says `worker.started`; if implementation drift requires a different string, APIVR updates the script and notes the drift in the smoke-check output. This is flagged as a contradiction below.)
- `make down` matches the existing `Makefile` target.

### Out of scope

- Asserting on the response BODY of the signed POST (status code only).
- Asserting on the count or content of logs beyond a single `grep -q` match.
- CI integration (running `make smoke` in GitHub Actions); post-MVP.
- Bringing up an OTLP collector; smoke does not exercise telemetry.
- Verifying that a Checks run was created on a fake GitHub API; the script does not stand up a fake GitHub.

---

## Machine-readable acceptance criteria

```yaml
spec_id: phase-7-developer-experience
phase: 7
target_files:
  - path: README.md
    role: idg
    purpose: canonical onboarding documentation
    required_h2_headings_in_order:
      - Status
      - Architecture overview
      - Module map
      - Setup
      - Local development
      - Local webhook development
      - Environment variables
      - Test commands
      - Known limitations
      - Trust model — why comments are capped
      - Documentation map
      - License
    required_strings:
      - "prefilter → provider → validator → ranker → publication cap"
      - "ProviderReviewInput → ProviderReviewOutput → NormalizedFinding → RankedFindings → PublicationResult"
      - "227"
      - "9/9"
      - "dry-run"
      - "summary-only"
      - "summary-plus-inline"
      - ".github/review-bot.yml"
      - "ADR-001"
      - "ADR-002"
      - "ADR-003"
      - "OQ-2"
      - "Trust preservation beats maximum coverage"
    forbidden_strings_outside_make_context:
      - "pnpm install"
      - "npm install"
      - "node scripts/"
      - "tsc "
      - "vitest run"
      - "tsx scripts/"
    setup_prerequisites_exact:
      - "Docker (≥ 20)"
      - "GNU Make"
    env_var_groups:
      secrets:
        - GITHUB_APP_PRIVATE_KEY
        - GITHUB_APP_WEBHOOK_SECRET
        - ANTHROPIC_API_KEY
      config:
        - PORT
        - REDIS_URL
        - GITHUB_APP_ID
        - GITHUB_APP_SLUG
        - OTEL_SERVICE_NAME
        - OTEL_EXPORTER_OTLP_ENDPOINT
        - LOG_LEVEL
        - INSTALLATION_REPLAY_WINDOW_SECONDS
        - NODE_ENV
        - APP_HOST_PORT
      tunables:
        - QUEUE_CONCURRENCY
        - JOB_TIMEOUT_SECONDS
        - RETRY_TRANSIENT_MAX_ATTEMPTS
        - RETRY_TRANSIENT_BACKOFF_BASE_MS
        - RETRY_TRANSIENT_BACKOFF_MAX_MS
        - RETRY_RATELIMIT_MAX_ATTEMPTS
        - MAX_TOKENS_PER_PR
        - MAX_TOKENS_PER_WINDOW_PER_INSTALLATION
        - MAX_TOKENS_WINDOW_SECONDS
        - OTEL_TRACES_SAMPLER_ARG
    known_limitations_required_bullets:
      - "single-tenant; namespaced by installation_id"
      - "Anthropic is the only provider implemented"
      - "no live-API integration tests"
      - "character/4 token proxy"
      - "inline comment dedupe across runs unproven"
      - "summary truncated to 60 KB"
      - "see docs/open-questions.md"
    trust_model_required_values:
      comment_cap.per_pr: 5
      comment_cap.per_file: 1
      severity_floor.inline: medium
      confidence_floor.inline: 0.7
      default_mode_for_new_installs: dry-run
    documentation_map_links_must_exist:
      - docs/research-summary.md
      - docs/mvp-scope.md
      - docs/threat-model.md
      - docs/open-questions.md
      - docs/architecture-decision-records/adr-001-github-app.md
      - docs/architecture-decision-records/adr-002-provider-abstraction.md
      - docs/architecture-decision-records/adr-003-validation-ranking.md
      - docs/product-spec.md
      - docs/config-spec.md
      - docs/review-findings-schema.md
      - docs/api-contracts.md
      - docs/publication-policy.md
      - docs/system-design.md
      - docs/data-flow.md
      - docs/deployment.md
      - docs/observability.md
      - docs/operational-runbooks.md
      - docs/evaluation-plan.md
      - evals/README.md
    acceptance_criteria_ids:
      - AC-README-1
      - AC-README-2
      - AC-README-3
      - AC-README-4
      - AC-README-5
      - AC-README-6
      - AC-README-7
      - AC-README-8

  - path: .github/review-bot.yml.example
    role: idg
    purpose: copyable repo-local config template using OQ-2 defaults
    required_top_level_keys:
      - enabled
      - mode
      - provider
      - thresholds
      - comment_cap
      - path_rules
      - exclude_generated
      - exclude_vendored
      - max_files
      - max_changed_lines
      - categories_enabled
      - severity
      - language_overrides
      - repo_heuristics
    optional_keys_commented_out:
      - model
    required_default_values:
      enabled: true
      mode: dry-run
      provider: anthropic
      thresholds.severity_floor.inline: medium
      thresholds.confidence_floor.inline: 0.7
      comment_cap.per_pr: 5
      comment_cap.per_file: 1
      exclude_generated: true
      exclude_vendored: true
      max_files: 50
      max_changed_lines: 2000
      repo_heuristics.security: true
      repo_heuristics.tests: true
      repo_heuristics.migrations: true
      repo_heuristics.layering: true
    top_of_file_comment_must_contain:
      - ".github/review-bot.yml"
      - "docs/config-spec.md"
      - "OQ-2"
    schema_validation:
      schema_module: "@prisma-bot/shared"
      schema_export: RepoConfigSchema
      loader_export: loadRepoConfig
      validator_test_path_options:
        - packages/config/tests/example-config.test.ts
        - evals/runner/tests/example-config.test.ts
    acceptance_criteria_ids:
      - AC-EXAMPLE-1
      - AC-EXAMPLE-2
      - AC-EXAMPLE-3
      - AC-EXAMPLE-4
      - AC-EXAMPLE-5

  - path: scripts/replay-webhook.ts
    role: apivr
    purpose: developer-only signed webhook replay CLI
    cli_flags:
      required:
        - "--fixture"
      optional:
        - "--url"
        - "--secret-env"
        - "--delivery-id"
        - "--help"
        - "-h"
    cli_defaults:
      url: "http://localhost:3030/webhooks/github"
      secret-env: "GITHUB_APP_WEBHOOK_SECRET"
      dev_fallback_secret: "dev-only-not-secure"
    request_headers_emitted:
      - "X-Hub-Signature-256"
      - "X-GitHub-Event"
      - "X-GitHub-Delivery"
      - "Content-Type: application/json"
    signature_format: "sha256=<HMAC-SHA-256-hex>"
    fixture_path_pattern: "evals/fixtures/<fixture-id>.yaml"
    fixture_field_consumed: "pr_payload"
    exit_codes:
      0: "2xx response"
      1: "4xx or 5xx response"
      2: "local error (missing fixture, malformed YAML, no pr_payload)"
    forbidden_imports_regex: "^(@anthropic-ai/sdk|octokit|axios|node-fetch|undici)$"
    allowed_imports:
      - "node:crypto"
      - "node:fs"
      - "node:fs/promises"
      - "node:path"
      - "node:process"
      - "js-yaml"
      - "yaml"
      - "@prisma-bot/shared"
    runs_via: "tools container (tsx)"
    acceptance_criteria_ids:
      - AC-REPLAY-1
      - AC-REPLAY-2
      - AC-REPLAY-3
      - AC-REPLAY-4
      - AC-REPLAY-5
      - AC-REPLAY-6

  - path: Makefile
    role: apivr
    purpose: add replay-webhook and smoke targets, update help
    new_targets:
      - name: replay-webhook
        invocation: "make replay-webhook FIXTURE=<id> [URL=<override>]"
        runs_in: "tools container"
        required_validation: "FIXTURE non-empty; usage on missing"
      - name: smoke
        invocation: "make smoke"
        runs_in: "host shell (composes docker compose calls)"
        wraps: "scripts/smoke.sh"
    help_text_additions:
      - "  make replay-webhook FIXTURE=id  Replay an eval fixture as a signed webhook delivery"
      - "  make smoke                      Bring stack up, run e2e webhook check, tear down"
    phony_must_include:
      - replay-webhook
      - smoke
    constraint_no_existing_target_modified_except: help
    acceptance_criteria_ids:
      - AC-MAKE-1
      - AC-MAKE-2
      - AC-MAKE-3
      - AC-MAKE-4
      - AC-MAKE-5

  - path: scripts/smoke.sh
    role: apivr
    purpose: end-to-end dev-stack smoke check
    required_steps_in_order:
      - "make up"
      - "poll http://localhost:${APP_HOST_PORT:-3030}/healthz/live until 200 (30s timeout)"
      - "POST unsigned webhook -> expect 4xx"
      - "make replay-webhook FIXTURE=security-bug -> expect 2xx"
      - "docker compose logs worker --tail=20 | grep -q 'worker.started' (or 'job.started' per APIVR confirmation)"
      - "make down (in trap EXIT)"
    required_shell_options:
      - "set -euo pipefail"
      - "trap 'make down' EXIT"
    forbidden_invocations_outside_make:
      - pnpm
      - npm
      - node
      - tsx
    honors_env:
      - APP_HOST_PORT
    log_prefix: "[smoke]"
    acceptance_criteria_ids:
      - AC-SMOKE-1
      - AC-SMOKE-2
      - AC-SMOKE-3
      - AC-SMOKE-4
      - AC-SMOKE-5

cross_file_consistency:
  - description: pipeline string byte-equivalent across README, ADR-003, mvp-scope, api-contracts
    pattern: "prefilter → provider → validator → ranker → publication cap"
  - description: schema chain byte-equivalent across README, system-design
    pattern: "ProviderReviewInput → ProviderReviewOutput → NormalizedFinding → RankedFindings → PublicationResult"
  - description: OQ-2 defaults byte-equivalent across .github/review-bot.yml.example, README trust model section, docs/publication-policy.md, packages/shared/src/schemas/config.ts
    values:
      comment_cap.per_pr: 5
      comment_cap.per_file: 1
      severity_floor.inline: medium
      confidence_floor.inline: 0.7
      default_mode: dry-run
  - description: env vars table in README matches .env.example and docs/deployment.md classifications
  - description: every make target referenced in README exists in Makefile
  - description: every make target in Makefile has a corresponding line in README "Local development" or "Local webhook development" or "Test commands"
  - description: replay-webhook CLI shape in README matches scripts/replay-webhook.ts --help output
  - description: scripts/smoke.sh fixture id matches an entry in evals/scenarios.yaml (security-bug)

phase_exit_gate:
  description: Phase 7 exit
  testable_form: |
    GIVEN files merged on main: README.md, .github/review-bot.yml.example, scripts/replay-webhook.ts, Makefile (with new targets), scripts/smoke.sh,
    WHEN `make typecheck && make lint && make test && make eval && make smoke` runs in a clean clone with .env populated for dev,
    THEN all five commands exit 0;
    AND the Documentation map links in README all resolve to existing files;
    AND .github/review-bot.yml.example parses through loadRepoConfig with no errors;
    AND `tsx scripts/replay-webhook.ts --help` (in the tools container) prints a usage block matching the README "Local webhook development" section.

oq_disposition:
  resolves: []
  remains_open:
    - OQ-4
    - OQ-5
    - OQ-6
    - OQ-8
    - OQ-9
  README_must_reference: docs/open-questions.md

flagged_contradictions_to_user:
  - id: smoke-grep-event-name
    description: |
      The Phase 7 brief says `scripts/smoke.sh` greps worker logs for `worker.started`, but `docs/observability.md` § Event taxonomy
      defines no `worker.started` event — the closest match is `job.started`, emitted when the BullMQ worker picks up a job.
      APIVR must either: (a) confirm the worker also emits a `worker.started` lifecycle log at process boot (outside the
      observability event taxonomy), and grep for that; or (b) substitute `job.started` and update the smoke script accordingly.
      Flagged for user confirmation before APIVR implements File 5.
  - id: app-host-port-default
    description: |
      `docker-compose.yml` documents `APP_HOST_PORT:-3030` as the default host port, but `.env.example` sets `PORT=3000` (the
      container-internal port). The README must explain the distinction (host port vs. container port). No fix needed; flagged so
      IDG knows to write this clearly.
```

---

## Reporting (≤ 200 words)

**File written:** `/home/rynaro/workspace/electionbuddy/prisma/docs/_planning/phase-7-spec.md`.

**Total acceptance-criteria count:** 31 GIVEN/WHEN/THEN clauses across 5 files (README: 8, sample config: 5, replay script: 6, Makefile: 5, smoke script: 5) plus 2 cross-file gates and the Phase 7 exit gate.

**Contradictions flagged in Phase 1–6 docs (not fixed):**

1. **`worker.started` vs `job.started`.** Phase 7 brief mandates greppingfor `worker.started` in `scripts/smoke.sh`, but `docs/observability.md` § Event taxonomy defines `job.started` (worker picks up a job) — there is no `worker.started` event in the closed taxonomy. APIVR must confirm whether the worker emits a `worker.started` boot-time log outside the structured-event taxonomy, or substitute `job.started`.
2. **`APP_HOST_PORT` vs `PORT`.** `docker-compose.yml` defaults `APP_HOST_PORT` to `3030` (host); `.env.example` sets `PORT=3000` (container-internal). README must explain both; not a fix needed.

**Open questions for the user before composition:**

- Confirm the smoke-script grep target (`worker.started` vs `job.started`).
- Confirm where the `dev-only-not-secure` constant lives (`apps/github-app/src/main.ts` is referenced but not yet read by SPECTRA).
- Confirm the validator test for `.github/review-bot.yml.example` lives at `packages/config/tests/example-config.test.ts` or under `evals/runner/`.
