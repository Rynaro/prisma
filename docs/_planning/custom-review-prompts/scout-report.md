# Scout Report — User-Customizable Review Prompts

- MISSION-ID: atlas-custom-review-prompts-20260612
- GOAL: Map everything a planner needs to spec a strong immutable system prompt + repo-owner custom rules + repo-file context augmentation.
- DECISION_TARGET: Where prompts are built, how repo files/config can be fetched, how custom instructions thread through providers, pipeline constraints, eval/test/CI surface, token budgets.
- Confidence legend: H/M/L. All paths repo-relative to `/Users/henrique/workspace/oss/prisma`.

## Topology summary

- pnpm monorepo: `apps/github-app` (server + BullMQ worker + orchestrator), `packages/{shared,config,core,github,providers/*}`, `evals/runner` + fixtures.
- Flow: webhook → `apps/github-app/src/server.ts` → queue → `worker.ts` → `pipeline/orchestrator.ts#runPipeline` → snapshotter → prefilter → provider → validator → ranker → publisher.
- Providers: anthropic, copilot, openai, fake — each self-contained under `packages/providers/<vendor>/src/{index,client,prompt,error-mapping}.ts`. Vendor SDK/fetch confined to `client.ts` (ADR-002, enforced by `scripts/check-vendor-isolation.sh`).

## Findings

### FINDING-001 — Prompt is built per-adapter; system prompt is a hardcoded const in each provider
- evidence: `packages/providers/anthropic/src/prompt.ts:24-35` (SYSTEM_PROMPT), `:73-102` (renderUserMessage), `:104-119` (buildPrompt); `packages/providers/copilot/src/prompt.ts:31,114` (same prompt as `role:'system'` message); openai prompt.ts is a near-twin of copilot (diff shows doc-comment-only delta).
- confidence: H
- Current system prompt (anthropic, verbatim structure): "You are a precise code reviewer." / shown a normalized diff snapshot / "Return findings ONLY by calling the `submit_review_findings` tool." / rules: only verifiable issues from supplied hunks, real `path` + `line` inside a hunk, closed category enum (security, correctness, performance, tests, style, migration, dependency), closed severity enum, confidence 0–1, empty-findings tool call allowed.
- User message structure: `## Files` (per-file path + lang, per-hunk `hunk <id> L<start>-L<end>:` + indented content) then `## Repo heuristics` (boolean flags or `(none)`) then a closing instruction. `prompt.ts:73-102`.
- supports: SQ1, SQ4

### FINDING-002 — `ProviderReviewInput` is the ONLY data adapters receive; it is `.strict()` and has no instructions field
- evidence: `packages/shared/src/schemas/provider.ts:41-48` (files, optional `repo_heuristics: Record<string,boolean>`, optional `request_shaping {model, deterministic_seed, capability_hints}`), `:32-39`.
- confidence: H
- Implication: custom instructions/augmentation context must be added to this schema (e.g. optional `custom_instructions` / `context_files` keys); `.strict()` means old adapters reject unknown keys until schema lands — single shared schema change covers all 4 providers' inputs, but each `prompt.ts` must render the new field (3 copies + fake passthrough).
- supports: SQ4

### FINDING-003 — Orchestrator assembles provider input from config in one function
- evidence: `apps/github-app/src/pipeline/orchestrator.ts:164-195` (`buildProviderInput`: heuristics from `cfg.repo_heuristics`, `request_shaping.model` from `cfg.model`), `:346` (call site), `:124-140` (`OrchestratorDeps` takes a static `config: RepoConfig`).
- confidence: H
- This is the single injection point for threading custom rules/context into the provider call.
- supports: SQ1, SQ4

### FINDING-004 — Per-repo config schema + loader EXIST but are never wired in production (critical gap)
- evidence: `packages/shared/src/schemas/config.ts:104-131` (`RepoConfigSchema` for `.github/review-bot.yml`; defaults via `parse({})`); `packages/config/src/config-loader/load.ts:19-30` (`loadRepoConfig({yamlContents})`); `packages/config/src/config-loader/index.ts:1` (`REPO_LOCAL_CONFIG_PATH = '.github/review-bot.yml'`); `apps/github-app/src/worker.ts:217,228` (worker uses `RepoConfigSchema.parse({})` — pure defaults). Ruled out: `grep loadRepoConfig|getContent` shows zero production callers; only tests call the loader.
- confidence: H
- Implication: the feature cannot just add config keys — it must also build the fetch wire (get `.github/review-bot.yml` from the target repo at runtime) that the architecture documents but Phase 5 never implemented. Resolution-order comment reserves "Per-PR overrides" as a future layer (`load.ts:10-12`); unknown top-level keys are warn-and-ignore (`config.ts:98-103`), so adding `custom_rules`/`context_files` keys is backward-compatible.
- supports: SQ3

### FINDING-005 — GitHub client seam (`OctokitLike`) has NO file-content method; extension required
- evidence: `packages/github/src/installation-auth/client.ts:4-33` (mapping comment: only `pulls.{get,listFiles}`, `checks.{create,update,listForRef}`, `pulls_reviews.{createReviewComment,listReviewComments}`), `:103` (interface), `:147-155` (`createDefaultOctokit` — the single cast site to extend).
- confidence: H
- To fetch `review-bot.yml` or user-referenced context files at the PR head SHA, add `rest.repos.getContent({owner, repo, path, ref})` to `OctokitLike` + the factory + (if fetched during snapshot) `SnapshotterOctokitLike` (`packages/core/src/snapshotter/index.ts:33-63`). Auth is already solved: `InstallationAuth.getOctokit(installation_id)` at `orchestrator.ts:272`.
- supports: SQ2

### FINDING-006 — Snapshotter is the fetch-pattern to mirror; head SHA is captured
- evidence: `packages/core/src/snapshotter/index.ts:297-334` (`fetchPrSnapshot` via `pulls.get` + paginated `listFiles`; `head_sha: pr.head.sha` at `:327`), caps at `:80-82` (maxFiles=300, 64 KiB/file patch budget, perPage=100), truncation at `:200-215`.
- confidence: H
- supports: SQ2, SQ8

### FINDING-007 — Repo identity resolved from webhook payload with env override
- evidence: `apps/github-app/src/repo-identity.ts:41` (`resolveRepoIdentity`, source `'env' | 'payload'`); `apps/github-app/src/worker.ts:168-215` (`buildRepoLookup`: env `GITHUB_DEFAULT_OWNER/REPO` > payload owner/repo > throw); `packages/shared/src/schemas/job.ts:35-36` (JobPayload optional `owner`/`repo` carried from webhook).
- confidence: H
- owner/repo needed for a `getContent` call are available in `runPipeline` after `repoLookup` (`orchestrator.ts:265-270`).
- supports: SQ3

### FINDING-008 — Provider contract: one method, capabilities bag, typed errors; FakeProvider records inputs
- evidence: `packages/shared/src/schemas/provider-interface.ts:27-31` (`Provider {name, capabilities, review(input)}`); `provider.ts:91-126` (error union transport|auth|rate_limit|capability|schema_validation), `:133-141` (capabilities incl. `max_context_tokens`); `packages/providers/fake/src/index.ts:23-26` (scripted steps incl. `output_lazy(input)`), `:58-67` (`calls` getter records every `ProviderReviewInput`).
- confidence: H
- FakeProvider's recorded `calls` lets evals/tests assert that custom instructions actually reached the provider input.
- supports: SQ4, SQ6

### FINDING-009 — Validator/output schema constrain custom-rule findings to closed vocabularies and touched hunks
- evidence: `packages/shared/src/schemas/provider.ts:56-75` (output finding `.strict()`: path, line, severity, category, message, rationale, confidence, optional suggested_fix); `packages/core/src/validator-ranker/validator/index.ts:48-70` (line must fall inside a hunk of a non-removed snapshot file; rejections logged). Category JSON-schema enums duplicated in each adapter's prompt (`anthropic/src/prompt.ts:42-71`).
- confidence: H
- Implication: custom-rule-derived findings flow through the existing pipeline unchanged ONLY if they map to the 7 existing categories and anchor to diff hunks. A new category (e.g. `business_rule`) ripples to: finding.ts enums, 3 prompt.ts JSON schemas, config `categories_enabled`, docs.
- supports: SQ5

### FINDING-010 — Publication caps are config-driven and applied in the planner
- evidence: `packages/github/src/publisher/planner.ts:216-220,346-347,435-439` (per-file then per-PR caps, drops logged); defaults per_pr=5/per_file=1, severity floor medium, confidence floor 0.7 (`config.ts:21-44`); prefilter oversized caps max_files=50 / max_changed_lines=2000 (`config.ts:115-116`).
- confidence: H
- supports: SQ5

### FINDING-011 — Evals: YAML scenario index + fixtures driving FakeProvider through the real orchestrator
- evidence: `evals/scenarios.yaml:1-39` (9 scenarios, id+fixture+tags); fixture shape `config_overrides | pr_payload | octokit_responses | provider_script | expectations` (`evals/runner/src/schema.ts:260-264`; example `evals/fixtures/security-bug.yaml:10-40`); `evals/runner/src/pipeline-runner.ts:1-40` (wires `runPipeline` with `buildFakeOctokit` + `FakeProvider`).
- confidence: H
- Adding custom-prompt scenarios = new fixture YAML + scenarios.yaml entry; if config is fetched via `getContent`, `evals/runner/src/octokit-fake.ts` needs a `repos.getContent` response key and the fixture schema a new `octokit_responses` entry.
- supports: SQ6

### FINDING-012 — Validation surface: container-first make targets mirrored in CI
- evidence: `Makefile` (typecheck/lint[+check-vendor-isolation]/format/test/eval, all via `docker compose --profile tools`); root `package.json:12-18` (`biome check .`, `vitest run`); `.github/workflows/ci.yml:21-36` (build tools → make install → typecheck → lint → test → eval).
- confidence: H
- Must pass: `make typecheck`, `make lint` (biome 1.9.4 + ADR-002 vendor-isolation script), `make test` (vitest), `make eval` (all 9+ scenarios).
- supports: SQ7

### FINDING-013 — Token budgets: env-derived per-call ceiling enforced by char/4 estimate on the full provider input
- evidence: `apps/github-app/src/worker.ts:56` (`MAX_TOKENS_PER_PR` default 60000), `:91,100,117` (`maxTokensPerCall = MAX_TOKENS_PER_PR/2`); `packages/providers/anthropic/src/index.ts:140-148` (`Math.ceil(JSON.stringify(input).length/4)` > cap → capability error `cost_ceiling`), `:157` (`max_tokens: 4096` response cap); snapshotter 64 KiB/file patch cap (FINDING-006).
- confidence: H
- Implication: user-supplied augmentation files riding inside `ProviderReviewInput` are automatically counted by the existing estimate, but a dedicated byte/token cap per augmentation file (mirroring `maxPatchBytesPerFile`) is needed to avoid one large doc evicting the diff or hard-failing the job with `cost_ceiling`.
- supports: SQ8

### FINDING-014 — Shared-prompt extraction is already a flagged open question (N=3 threshold reached)
- evidence: `docs/open-questions.md:78,96` (prompt strategy per-adapter; "re-evaluation now due" at N=3 adapters, flagged in ADR-005 § Consequences). Ruled out: no `prompt|custom|instruction` keys exist in `docs/config-spec.md` (grep returned zero matches).
- confidence: H
- This feature is the natural trigger to extract a shared prompt module (immutable system core + injected custom-rules section) instead of editing 3 byte-similar `prompt.ts` files.
- supports: SQ1, SQ4

## Gaps & risks

- GAP-001 (H): No production config-fetch wire exists at all (FINDING-004). The feature's scope includes building it, not just extending it.
- GAP-002 (M): `packages/config/src/config-loader/parse.ts` warn-surface behavior (unknown-key warnings) read only via doc comments, not line-verified.
- GAP-003 (M): `evals/runner/src/octokit-fake.ts` internals not read; assumed keyed-response pattern from fixture `octokit_responses` shape.
- RISK-001 (H): Prompt injection — user-supplied rules/files enter the model context. The "strong immutable system prompt" requirement implies ordering/delimiting custom content below the system core and never letting it alter the tool contract; deterministic validator (FINDING-009) is the backstop. Needs an explicit threat-model decision (docs/threat-model.md exists, unread).
- RISK-002 (M): Fetching context files at head SHA reads attacker-controlled PR content (fork PRs); decide head vs base/default-branch as the trust anchor for rules files.

## Recommended next actions

1. → SPECTRA: Spec the config-fetch wire: extend `OctokitLike` with `repos.getContent`, fetch `.github/review-bot.yml` (decide ref: default branch vs head SHA) in `runPipeline` before prefilter, route through `loadRepoConfig`, replace worker's static `defaultRepoConfig()`.
2. → SPECTRA: Spec schema deltas: `RepoConfigSchema` keys (`custom_rules: string[]`, `context_files: [{path, max_bytes?}]`-style), `ProviderReviewInput` optional `custom_instructions`/`context_files` sections, per-file byte caps + total augmentation budget vs `maxTokensPerCall`.
3. → SPECTRA: Spec shared prompt module (resolves OQ N=3): immutable system core + delimited, clearly-subordinated custom-rules block + context-files block in the user message; identical across anthropic/copilot/openai.
4. → human: Decide trust anchor (default-branch vs PR-head for rules/context files) and prompt-injection posture (RISK-001/002).
5. → SPECTRA: Eval additions: fixture(s) with `octokit_responses.repos_getContent` + custom rules in `config_overrides`, FakeProvider `output_lazy` asserting instructions present in recorded input; new scenario ids in `evals/scenarios.yaml`.
6. → APIVR-Δ (after spec): validation gates = `make typecheck && make lint && make test && make eval` (FINDING-012).

## Telemetry

phase: S | tool_calls: 14 | probes: bounded reads + rg | fold_ratio: ~0.15 | all 8 sub-questions answered at confidence H (2 sub-areas at M, recorded as GAP-002/003)
