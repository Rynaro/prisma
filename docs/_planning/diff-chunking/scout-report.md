# Scout Report — Diff Chunking Feature Foundation

> ATLAS read-only scout. Maps the seams for a future "diff chunking" feature:
> when a PR exceeds a single `provider.review()` context window, split the
> prefiltered diff into N batches, call the provider once per batch, merge +
> dedupe findings, and publish ONCE with a per-PR provider-call cost guard.
>
> **No code was modified.** Every load-bearing claim is anchored `path:line`
> with confidence `H|M|L`. Target scale: ~12,000 changed lines / ~200 files as
> an exceptional edge case.

---

## Mission recap

- **GOAL** — Map the integration seams so a future agent can implement diff
  chunking without re-discovering the pipeline.
- **DECISION_TARGET** — For each of 8 named seams: file:line, what it does, the
  chunking integration point or risk. Plus analysis (a)–(d) and an integration
  plan sketch + open questions.
- **Scope** — `packages/core`, `packages/shared`, `packages/github`,
  `packages/providers`, `apps/github-app`.

## Topology summary (the single-call pipeline today)

1. Entry: `runPipeline` in `apps/github-app/src/pipeline/orchestrator.ts:357`.
2. Stages, in order: `repoLookup` → `fetchSnapshot` → **prefilter**
   (`orchestrator.ts:388`) → augmentation (`:491`) → **single provider.review**
   (`orchestrator.ts:533`) → validator (`:628`) → ranker (`:651`) → publisher
   (`:657`).
3. Oversized PRs never reach the provider: prefilter returns `oversized`
   (`prefilter/index.ts:276-293`), orchestrator short-circuits to a summary-only
   publication with an explanatory `notice` (`orchestrator.ts:389-440`).
4. There is **exactly one** `deps.provider.review(...)` call per run
   (`orchestrator.ts:533`). [H]
5. The provider input unit is `files: PrefilteredFile[]`, each file carrying
   `hunks: Hunk[]` (`provider.ts:42-56`, `:24-31`). [H]
6. No batching / token-budget / chunking code exists anywhere in the repo
   (seam 6, confirmed below). [H]

---

## Seam-by-seam map

### Seam 1 — Prefilter oversized decision + config limits

**`packages/core/src/prefilter/index.ts`**

- `runPrefilter` (`:239-297`) is a **pure** function: returns `accepted`
  (`:296`) or `oversized` (`:277-283`, `:286-292`). [H]
- The two limit checks: `kept.length > config.max_files` →
  `too_many_files` (`:276-284`); `lines_considered > config.max_changed_lines`
  → `too_many_changed_lines` (`:285-293`). `lines_considered` is the sum of
  `additions + deletions` over kept files (`:274`). [H]
- `PrefilterOutcome` union (`:45-57`); `oversized` carries `reason`,
  `files_considered`, `lines_considered`, `skipped` — but **NOT** the
  `PrefilteredFile[]` (the `files` array is only built on the `accepted` path at
  `:295`). [H]
- Each kept file becomes a `PrefilteredFile` via `toPrefilteredFile`
  (`:177-205`); hunk `id` is `${path}#${new_start}-${new_start+new_lines}`
  (`buildHunkId`, `:169-175`). This id is the join key the validator re-derives
  (see Seam 4). [H]

**`packages/shared/src/schemas/config.ts`**

- Limit defaults: `max_files` default **50** (`:116`), `max_changed_lines`
  default **2000** (`:117`). Both `z.number().int().positive()`. [H]
- Same keys are overridable per-language in `LanguageOverrideSchema`
  (`:88-89`). [H]

**Chunking integration point / risk.** This is the **primary branch site**.
Today `oversized` is terminal-by-policy. A chunking path must branch *before*
the hard-skip: when `kept.length`/`lines_considered` exceed the single-call
budget but are still within a new chunkable ceiling (e.g. ≤200 files / ≤12,000
lines), produce the `PrefilteredFile[]` (currently discarded on this branch)
and emit a new `chunkable` outcome instead of `oversized`. **Risk:** the
oversized branch never constructs `files`; a chunkable outcome must run
`kept.map(toPrefilteredFile)` (`:295`) so downstream batching has the file
objects. The hard ceiling for truly-too-big PRs (> chunk cap) must remain
`oversized`. The chunk-cap thresholds are new config keys (Seam analysis (c)).

---

### Seam 2 — Provider stage in the orchestrator

**`apps/github-app/src/pipeline/orchestrator.ts`**

- `buildProviderInput(files, cfg, guidance)` (`:246-284`) assembles a single
  `ProviderReviewInput` from **all** prefiltered files: sanitizes hunks
  (`:260-272`), sets `repo_heuristics` (`:251-256`, `:274`), conditionally sets
  `request_shaping.model` from `cfg.model` (`:277-279`), and
  `custom_guidance` (`:280-282`). [H]
- The single call: `providerOutput = await deps.provider.review(providerInput)`
  (`:533`), wrapped in try/catch (`:532-625`). [H]
- Stage ordering around it: augmentation resolution runs **before** the call
  (`:483-526`, producing `resolvedGuidance` + `allNotes`); validator (`:628`),
  ranker (`:651`), publisher (`:657`) run **after**. [H]
- `runValidator` (`:628`) takes the **whole `snapshot`** as context
  (`:629-634`), not the per-call file subset — so it validates findings against
  the full diff regardless of how files were batched (important: see Seam 4). [H]

**Chunking integration point.** The per-batch loop slots in at `:528-534`,
replacing the single `buildProviderInput` + `review` with: partition
`prefilter.files` → for each batch call `buildProviderInput(batchFiles, cfg,
guidance)` then `provider.review(...)` → accumulate
`ProviderReviewOutputFinding[]`. **`buildProviderInput` is already
batch-shaped** — it takes a `PrefilteredFile[]` parameter, so passing a subset
is a no-op change to its body (`:246-250`). The accumulated findings are merged
into a single `ProviderReviewOutput` before `runValidator` (`:628`), keeping the
validator → ranker → publisher tail **unchanged** (single publish). Guidance
(`:491-526`) and heuristics resolve once and are reused across batches (no
re-resolution per batch). [H]

**Risk.** The catch block (`:535-625`) currently classifies one throwable per
run. With N calls, batch-level failures need a policy (see Seam 7). Logging is
one event per stage (`:530`, `:534`); per-batch logging needs new fields/events
without breaking the existing taxonomy.

---

### Seam 3 — Provider interface + I/O schemas

**`packages/shared/src/schemas/provider.ts`**

- `ProviderReviewInput` (`:42-56`): `files: PrefilteredFile[]` (`:44`),
  optional `repo_heuristics`, `request_shaping`, `custom_guidance`. `.strict()`. [H]
- `PrefilteredFile` (`:24-31`): `{ path, language?, hunks: Hunk[] }`. `Hunk`
  (`:14-22`): `{ id, line_start, line_end, content }`. **The batchable unit is
  the file** (a `PrefilteredFile`), and within it the hunk is the finest grain. [H]
- `ProviderRequestShaping` (`:33-40`): `{ model?, deterministic_seed?,
  capability_hints? }`. No batch-index / continuation field today. [H]
- `ProviderReviewOutput` (`:78-83`): `{ findings: ProviderReviewOutputFinding[] }`.
  Finding (`:64-76`): `{ path, line, severity, category, message, rationale,
  confidence, suggested_fix? }`. **`findings` arrays from N batches concatenate
  trivially** — same element schema, no batch metadata to reconcile. [H]
- `ProviderCapabilities` (`:141-149`) **already carries `max_context_tokens`**
  (`:146`, `z.number().int().positive()`). This is the natural per-call budget
  input for token-based batching. [H]

**Chunking unit decision.** Batch by **file** (whole `PrefilteredFile`), not by
hunk: the validator joins findings on `(path, hunk-id)` (Seam 4) and the
publisher caps per-file (Seam 5), so splitting a single file across batches
risks duplicate/contradictory findings on the same file and complicates dedupe.
A token estimate per file = sum of its hunks' `content` lengths / 4 (see Seam
8's estimator pattern). A single file that alone exceeds the budget is the edge
case to flag (open question Q3). [M]

---

### Seam 4 — Finding DEDUPE (within-run + across-run) and ranking

**`packages/core/src/validator-ranker/validator/index.ts`** — the dedupe KEY is
**minted here**, not in the publisher.

- `computeDedupeKey(path, message)` (`:94-97`): `sha256(path + ":" +
  canonicalizeMessage(message)).slice(0, 16)`. [H]
- `canonicalizeMessage` (`:86-92`): lowercases, replaces ASCII punctuation
  (`PUNCTUATION_CHARS`, `:83`) with spaces, collapses whitespace. So the dedupe
  semantics are **(path, normalized-message)** — line number is NOT in the key. [H]
- The key is attached to each `NormalizedFinding.dedupe_key` (`:193`, `:206`). [H]
- The validator also re-derives hunk ids from the snapshot
  (`buildAnalyzableFiles`, `:48-62`) using the **same** arithmetic as the
  prefilter (`${path}#${new_start}-${new_start+new_lines}`, `:55`), and rejects
  findings whose `path` is not in the diff (`path_not_in_diff`, `:154-164`) or
  whose `line` is outside any touched hunk (`line_not_in_diff`, `:166-177`). [H]

**`packages/github/src/publisher/planner.ts`** — dedupe is **applied** here.

- `applyDedupe(inlineEligible, prior)` (`:159-207`): within-run, group by
  `dedupe_key` keeping highest-confidence; tie → first in ranker order
  (`:176-197`). Across-run: drop if `dedupe_key ∈
  prior.published_inline_dedupe_keys` (`:167-175`). [H]
- Across-run source: `collectAcrossRunDedupeKeys` (`effects.ts:155-186`) scans
  prior inline comments for `<!-- prisma-bot:dedupe=<KEY> -->` markers
  (`:178`); the marker is emitted at post time (`dedupeMarker`,
  `effects.ts:188-189`; `renderInlineCommentBody`, `:203`). [H]

**`packages/core/src/validator-ranker/ranker/index.ts`**

- `runRanker(findings)` (`:49-80`): pure sort, **never drops** (permutation of
  input). Order: severity → category priority → confidence DESC → path ASC →
  line ASC → id ASC (`:58-78`). [H]

**Chunking integration point.** **The dedupe key is content-derived
`(path, normalized-message)` and batch-agnostic** — two batches that surface the
same issue produce the **same** `dedupe_key`, so cross-batch dedupe needs **no
new key**: it falls out for free once all N batches' findings are merged into
one `findings: ProviderReviewOutputFinding[]` *before* `runValidator`
(`orchestrator.ts:628`). The within-run dedupe in `applyDedupe`
(`planner.ts:159-207`) then collapses cross-batch duplicates automatically,
keeping highest confidence. **The merge MUST happen before the validator** (so
all findings get keys and pass through one `runRanker`), giving the publisher a
single merged ranked set. Ranking is also batch-agnostic (pure sort over the
merged list). [H]

**Risk.** A finding whose `path` was in batch A's files but whose model output
references a path only present in another batch would be rejected
`path_not_in_diff` (`validator/index.ts:154-164`) — but since the validator uses
the **full snapshot** (not the batch subset), this is safe: any path in the real
diff validates regardless of which batch produced the finding. [H]

---

### Seam 5 — Publisher aggregation + caps

**`packages/github/src/publisher/planner.ts` + `effects.ts`**

- `planPublication(ranked, cfg, prior, notice?)` (`:357-527`) is the pure
  partition: eligibility (`:376`) → dedupe (`:393`) → caps (`:462`). Plan
  invariant: `inline + summary + dropped === ranked.length` (`:18-19`). [H]
- Caps: `applyCaps(survivors, perFileCap, perPrCap)` (`:222-252`) — per-file cap
  first (`:231-239`), then per-PR cap (`:243-249`). Defaults `per_pr=5`,
  `per_file=1` (`config.ts:42-44`). [H]
- `publish(...)` (`effects.ts:207-344`) is the single effectful entry: collects
  across-run keys (`:224`), builds the plan (`:237`), posts inline (`:261-278`),
  finalizes one check run (`:298-305`). [H]
- Orchestrator calls publish **once** (`orchestrator.ts:657-663`) via
  `hooks.runPublish ?? defaultPublish`. [H]

**Chunking integration point.** Because merged findings re-enter through the
**existing** validator → ranker → publisher tail (Seam 4), **caps apply to the
MERGED set automatically** — `applyCaps` (`planner.ts:222-252`) sees the full
deduped survivor list, so `comment_cap.per_pr` (`:243-249`) and `per_file`
(`:231-239`) bound the final published volume across all batches with **zero
publisher changes**. The single check-run + single publish is preserved. The
`notice` param (`:357-367`) is the surface for a chunking explanatory message
(see Seam analysis (d)). [H]

---

### Seam 6 — Existing token/size budgeting or batching

**Confirmed: NO diff-chunking or per-call batching exists.** [H] The only
budgeting in the repo:

- Per-adapter `maxTokensPerCall` cost-ceiling proxy — a **pre-flight reject**,
  not a splitter: openai `index.ts:214-223` (`JSON.stringify(input).length / 4`
  estimate, throws `capability`/`cost_ceiling` if exceeded). Mirrored in
  anthropic (`index.ts:140-147`) and copilot (`index.ts:204-210`). [H]
- `ProviderCapabilities.max_context_tokens` declared per adapter: openai
  128000 (`openai/index.ts:46`), anthropic 200000 (`anthropic/index.ts:30`),
  copilot 128000 (`copilot/index.ts:41`), fake 200000 (`fake/index.ts:20`).
  **Declared but never read** by the orchestrator today (only asserted `> 0` in
  tests). [H]
- `estimateTokens = text.length / 4` in augmentation
  (`packages/core/src/augmentation/index.ts:36`, `:43`) — the reusable token
  estimator pattern for a future batcher. [H]
- The "batch" matches in `review-comments/index.ts:95` and
  `snapshotter/index.ts:289` are GitHub **pagination** loops, unrelated. [H]
- Worker sets `maxTokensPerCall = MAX_TOKENS_PER_PR / 2` for every real adapter
  (`worker.ts:96`, `:105`, `:122`); `MAX_TOKENS_PER_PR` defaults **60000** from
  env (`worker.ts:61`). So today's effective per-call input ceiling is ~30,000
  tokens. [H]

**Implication.** A 12,000-line PR (~tens of thousands of tokens of diff) blows
past the 30k single-call ceiling — exactly the chunking trigger. The estimator
(`length/4`) and `max_context_tokens` are the existing primitives to reuse for
batch sizing.

---

### Seam 7 — Partial-failure handling (the provider catch block)

**`apps/github-app/src/pipeline/orchestrator.ts:535-625`** (main's current
version; a parallel change on `feat/provider-error-clarity` edits this — noted,
not depended on). [H]

- Catches `ProviderErrorThrowable` (`:536`), switches on `err.value.kind`
  (`:537`):
  - `schema_validation` → publish `malformed_provider_output` summary, return
    `succeeded` (no retry) (`:539-578`).
  - `auth` / `capability` → publish `review_unavailable` summary, then
    **re-throw** so the consumer marks terminal (`:579-616`).
  - `transport` / `rate_limit` → not matched here → fall through to `throw err`
    (`:616`) → consumer retries with backoff (per the doc comment, `:53-57`). [H]
- Unknown errors re-thrown for retry classification (`:618-624`). [H]

**Chunking risk / decision (batch 2 of 4 fails).** With N calls, a single catch
no longer suffices. The implementation must decide per-error-class:
- `rate_limit` / `transport` on batch K → the **whole job** should still retry
  (re-throw) so BullMQ re-runs all batches; partial-publish-then-retry would
  double-publish. Safest: **abort the batch loop on a retryable error and
  re-throw** (preserves today's retry semantics).
- `auth` / `capability` on any batch → non-transient → publish
  `review_unavailable` and re-throw (same as today).
- `schema_validation` on one batch of N → **degrade, don't fail**: drop that
  batch's findings, log it, continue with the surviving batches, and surface a
  "partial review" notice. This is the genuinely new policy and the main design
  decision for Seam 7. [M]

---

### Seam 8 — OpenAI adapter per-call request shape

**`packages/providers/openai/src/index.ts`**

- `max_tokens: 4096` **hardcoded** on the request (`:234`) — this is the
  **output** budget, not input. Truncation (`finish_reason === 'length'`) is
  mapped to `schema_validation` (`:255-274`). [H]
- Forced function-call: `tools: [prompt.tool]`, `tool_choice: prompt.tool_choice`
  (`:232-233`), validated against `ProviderReviewOutputSchema` (`:277`). [H]
- `maxTokensPerCall` pre-flight (`:214-223`): `JSON.stringify(input).length / 4`
  vs the ceiling; throws `capability`/`cost_ceiling`. **This is the input-side
  budget the batcher must stay under.** [H]
- `max_context_tokens: 128000` (`:46`); per-request `model` from
  `request_shaping.model ?? this.model` (`:228`); `seed` from
  `request_shaping.deterministic_seed` (`:236-238`). [H]

**Chunking integration point.** The per-batch context budget = `min(
maxTokensPerCall, max_context_tokens − max_tokens(4096) − guidance/heuristics
overhead)`. The batcher should size each batch's `JSON.stringify(input).length /
4` to stay under `maxTokensPerCall` (`:215-216`) so no batch trips the
pre-flight reject. **Risk:** `max_tokens: 4096` output cap (`:234`) means a
batch with very many findings could itself truncate (→ `schema_validation`,
`:269-273`); smaller batches reduce per-call output pressure, a secondary reason
to bound batch size by findings-expectation, not just input tokens. [M]

---

## Focused analysis

### (a) Where to draw batch boundaries — by file vs by token budget

**By file, sized by estimated token budget.** [M]

- The atomic unit is `PrefilteredFile` (`provider.ts:24-31`); never split a
  file across batches (Seam 3 rationale: per-file caps in `applyCaps`
  `planner.ts:231-239` and the `(path, message)` dedupe key
  `validator/index.ts:94-97` both assume a file's findings come from one place).
- Greedy bin-packing: accumulate whole files into a batch while the running
  estimate (Σ over files of `Σ hunk.content.length / 4`, reusing the
  `augmentation/index.ts:36` estimator) stays under the per-call budget
  (`min(maxTokensPerCall, max_context_tokens − output_reserve − guidance)`,
  Seam 8). Start a new batch when the next file would overflow.
- Pure-file batching keeps `buildProviderInput` (`orchestrator.ts:246`) a no-op
  change (it already takes a `PrefilteredFile[]`).
- **Edge case:** a single file whose token estimate alone exceeds the budget →
  cannot be batched whole. Options: (i) hunk-level fallback for that file only
  (breaks the no-split rule), or (ii) classify as `oversized` for that file and
  note it. → Open question Q3.

### (b) Dedupe + ranking + caps over N batches → apply to the MERGED set

The chain is already merge-friendly **provided the merge happens before the
validator**:

1. Concatenate all N batches' `ProviderReviewOutput.findings`
   (`provider.ts:78-83`) into one array.
2. Feed the merged array through `runValidator` ONCE
   (`orchestrator.ts:628`) — it stamps `dedupe_key` (`validator/index.ts:193`)
   on every finding and validates against the **full snapshot**
   (`validator/index.ts:48-62`), so batch origin is irrelevant.
3. `runRanker` ONCE (`orchestrator.ts:651`) — pure sort over the merged set
   (`ranker/index.ts:49-80`).
4. `planPublication` / `publish` ONCE (`orchestrator.ts:657`): within-run
   dedupe (`planner.ts:159-207`) collapses cross-batch duplicates by shared
   `dedupe_key`; `applyCaps` (`planner.ts:222-252`) enforces `per_pr` / `per_file`
   on the merged survivor set.

**Net: cross-batch dedupe + caps are FREE — they reuse the existing key and the
existing single-publish tail, with no new dedupe logic.** [H] The only new code
is the *merge step* (concatenate findings) inserted between the batch loop and
the validator. **Do NOT** validate/rank/publish per batch — that would
double-publish and break the per-PR caps.

### (c) Where the per-PR provider-call cap / cost guard should live

Three layers, each anchored:

1. **Batch-count cap (hard ceiling on N calls)** — lives in the orchestrator's
   new batcher, between prefilter and the provider loop (`orchestrator.ts:528`).
   A new config key (e.g. `max_provider_calls_per_pr`) added to
   `RepoConfigSchema` (`config.ts:105-153`, alongside `max_files`/`max_changed_lines`)
   bounds N. If the packed batch count would exceed it → fall back to
   `oversized` (truly too big). This is the cost guard. [M]
2. **Chunkable ceiling** — new config keys gating the *prefilter* branch (Seam
   1): the existing `max_files`/`max_changed_lines` (`config.ts:116-117`) become
   the *single-call* limit; new `max_chunk_files` / `max_chunk_changed_lines`
   (e.g. 200 / 12,000) become the *chunkable* ceiling. Between the two → chunk;
   above the chunkable ceiling → `oversized`. [M]
3. **Per-call input budget** — already enforced by adapter `maxTokensPerCall`
   (`openai/index.ts:214`); the batcher sizes batches to stay under it so the
   pre-flight reject never fires mid-run.

The cost guard is fundamentally `N ≤ max_provider_calls_per_pr`, decided in the
orchestrator before the loop, with config defaults in `config.ts`.

### (d) New outcomes/messages vs the `PipelineOutcome` union + the v0.7.0 `notice`

- `PipelineOutcome` union (`orchestrator.ts:208-213`): `review_complete`,
  `oversized`, `no_findings`, `review_unavailable`, `malformed_provider_output`.
  Only consumed in `worker.ts:476-488` (and tests) to compose the comment reply. [H]
- The v0.7.0 `notice` mechanism (PR #18, commit `4af9111`): an optional
  preamble string threaded `runPipeline` → `publishSummaryOnly`
  (`orchestrator.ts:325`, `:413-425`) → `publish` (`effects.ts:219`) →
  `planPublication` (`planner.ts:367`) → `renderSummary` (`planner.ts:304-307`),
  prepended to the check-run summary **without** altering the partition
  invariant. [H]

**Recommended additions (do NOT overload `review_complete`):**
- A new outcome variant, e.g. `{ kind: 'review_complete_chunked'; detail: {
  batches: number; files: number; partial?: boolean } }` added to the union
  (`orchestrator.ts:208-213`). The worker's reply branch (`worker.ts:476-488`)
  gets one more `else if` to explain "Large PR reviewed in N batches".
- If a batch was dropped (Seam 7 `schema_validation` degrade), surface it via
  the **existing `notice`** string (the v0.7.0 mechanism, `planner.ts:357-367`)
  prepended to the normal `summary-plus-inline` publication — e.g. "Note:
  reviewed in N batches; batch K skipped due to a provider error." This reuses
  the exact same plumbing the oversized notice uses, so no new publisher wiring.
- Keep `oversized` for PRs above the *chunkable* ceiling (unchanged path,
  `orchestrator.ts:389-440`). [M]

---

## Integration plan sketch (seam-by-seam — NOT an implementation)

1. **Config (`config.ts:105-153`)** — add `max_provider_calls_per_pr`,
   `max_chunk_files`, `max_chunk_changed_lines` (positive ints, with defaults
   and language overrides mirroring `max_files`/`max_changed_lines`).
2. **Prefilter (`prefilter/index.ts:276-293`)** — add a `chunkable` outcome
   variant carrying the built `PrefilteredFile[]` (run `kept.map(toPrefilteredFile)`,
   `:295`, on this branch). Branch: within single-call limits → `accepted`;
   between single-call and chunk ceiling → `chunkable`; above chunk ceiling →
   `oversized` (unchanged).
3. **Batcher (new, in core or orchestrator)** — pure function: greedy
   file-level bin-packing using `estimateTokens` (`augmentation/index.ts:36`
   pattern) and the per-call budget (`maxTokensPerCall` / `max_context_tokens`,
   Seam 8). Returns `PrefilteredFile[][]` (≤ `max_provider_calls_per_pr` bins) or
   signals "too big → oversized".
4. **Orchestrator provider stage (`orchestrator.ts:528-534`)** — replace the
   single call with: resolve guidance once (`:491-526`, unchanged) → for each
   batch `buildProviderInput(batch, cfg, guidance)` (`:246`, unchanged body) +
   `provider.review` → accumulate findings → **merge into one
   `ProviderReviewOutput`** → continue into the unchanged validator (`:628`).
5. **Partial-failure policy (`orchestrator.ts:535-625`)** — per-batch error
   handling: retryable (`rate_limit`/`transport`) → abort loop + re-throw;
   non-transient (`auth`/`capability`) → publish `review_unavailable` + re-throw;
   `schema_validation` on one batch → drop that batch, continue, set a `partial`
   flag for the notice. (Coordinate with `feat/provider-error-clarity`.)
6. **Validator / ranker / publisher (unchanged)** — they already operate on the
   merged set; cross-batch dedupe + caps are free (analysis (b), (d)).
7. **Outcomes + worker reply** — add `review_complete_chunked` to
   `PipelineOutcome` (`orchestrator.ts:208`); add a worker reply branch
   (`worker.ts:476`); reuse the v0.7.0 `notice` (`planner.ts:357`) for partial /
   chunked explanations.

---

## Open questions

- **Q1 — Chunkable ceiling values.** What are the production
  `max_chunk_files` / `max_chunk_changed_lines` defaults? Mission says ~200 /
  ~12,000 as an exceptional edge case — are those the hard caps or just targets?
  (→ human / SPECTRA)
- **Q2 — Per-call budget formula.** Should the batcher derive its budget from
  `ProviderCapabilities.max_context_tokens` (`provider.ts:146` — currently
  unread by the orchestrator) or stay with the worker's
  `MAX_TOKENS_PER_PR / 2` convention (`worker.ts:96`)? The two disagree (e.g.
  openai 128k context vs 30k worker ceiling). (→ human)
- **Q3 — Single oversized file.** What happens to one file whose token estimate
  alone exceeds the per-call budget? Hunk-level split (breaks the no-split rule
  + per-file dedupe assumption) vs per-file oversized-skip with a notice?
  (→ SPECTRA)
- **Q4 — Partial-review policy.** Is dropping one `schema_validation` batch of N
  and publishing a partial review acceptable product behavior, or must any batch
  failure fail the whole review? This is the core Seam 7 decision. (→ human)
- **Q5 — Cross-batch contradiction.** Two batches that disagree on the same
  `(path, line)` will both survive (dedupe is on `(path, normalized-message)`,
  not line — `validator/index.ts:94`). Acceptable, or does chunking need a
  line-level reconciliation pass? (→ SPECTRA)
- **Q6 — Determinism.** With `deterministic_seed` (`openai/index.ts:236`),
  should batch boundaries be deterministic (stable file ordering) so re-runs
  produce identical batches for reproducible reviews? Likely yes; confirm.
  (→ APIVR-Δ)
- **Q7 — Cost observability.** Should per-batch token estimates / call counts be
  logged (new `provider.batch.*` events) for the cost guard's audit trail,
  alongside the existing one-event-per-stage taxonomy (`orchestrator.ts:530`)?
  (→ human)

---

## Handoffs

- **→ SPECTRA:** Spec the chunkable prefilter outcome + the pure batcher
  (bin-packing contract, budget formula, single-oversized-file policy). Anchors:
  `prefilter/index.ts:276-295`, `augmentation/index.ts:36`, `provider.ts:146`.
- **→ SPECTRA:** Spec the partial-failure policy for N-batch runs (Q4/Q5).
  Anchor: `orchestrator.ts:535-625`.
- **→ human:** Decide chunkable ceiling values (Q1), budget source (Q2),
  partial-review acceptability (Q4).
- **→ APIVR-Δ:** Once specced — the orchestrator batch loop is a localized
  change at `orchestrator.ts:528-534` + `:535-625`; validator/ranker/publisher
  need no changes (analysis (b)). Coordinate the catch-block edit with
  `feat/provider-error-clarity`.

## Risks & gaps

- **R1 [H]** The oversized prefilter branch discards `PrefilteredFile[]`
  (`prefilter/index.ts:277-293` build no `files`); a chunkable branch must
  construct them.
- **R2 [H]** Merge MUST precede the validator (`orchestrator.ts:628`) — per-batch
  validate/rank/publish would double-publish and break per-PR caps.
- **R3 [M]** The catch block is single-call-shaped (`orchestrator.ts:535-625`)
  and is being edited in parallel on `feat/provider-error-clarity`; the N-batch
  error policy must rebase onto whatever lands.
- **R4 [M]** Output truncation: `max_tokens: 4096` is hardcoded
  (`openai/index.ts:234`); large batches risk per-call output truncation
  (`:269-273`) independent of input sizing.
- **R5 [L]** Worker per-call ceiling (`MAX_TOKENS_PER_PR/2` = 30k,
  `worker.ts:96`) and adapter `max_context_tokens` (128k–200k) disagree;
  unresolved budget source (Q2) could mis-size batches.

## Telemetry

```
phase: S | seams_mapped: 8 | tool_calls: ~18 | files_read: 9 | confidence: mostly H
```
