# ADR-006 — Diff-Chunking Stability: Derived Token Budget and Hunk-Level Splitting

## Status

Accepted — 2026-06-15. ADRs are immutable once accepted; superseding decisions require a new ADR that explicitly references this one.

## Context

The diff-chunking subsystem (`ProviderReviewInput` → batcher → orchestrator) was the dominant source of review instability. Three structural defects compounded:

1. **Output truncation dropped whole batches.** When the model filled the hardcoded `max_tokens=4096` output budget, adapters threw `schema_validation` errors, and the orchestrator dropped the entire batch's findings. A single large, finding-dense file silently lost its whole review.

2. **Two divergent token estimators disagreed, aborting the PR.** The batcher estimated tokens via `content.length/4` against a `60k` ceiling; the per-call adapter guard estimated via `JSON.stringify(input).length/4` against a `120k` ceiling. Neither counted the exact serialized prompt (system + line-numbered diff + guidance + tool schema, ~7500–9500 tokens). When the guard tripped, it aborted the entire PR with `capability/cost_ceiling` — the worst failure mode for a mere sizing miss.

3. **No sub-file granularity.** The batcher bin-packed whole files; a file over `call_token_budget` got its own batch, and over `HARD_SAFETY_CAP_TOKENS=110000` was skipped entirely. No way to review part of a large file.

4. **Over-budget was an all-or-nothing cliff.** When the plan needed more than `max_provider_calls_per_pr=6` batches, `overCap` fired and the orchestrator skipped the **entire PR** with an "oversized" notice. No partial review, no highest-risk subset.

See the stability-core spec (`chunking-stability-spec.md`) for the full technical analysis, the research grounding (Qodo, CodeRabbit, Cursor Bugbot, Ellipsis consensus on token budgeting), and the four-phase implementation plan.

## Decision

Rebuild the diff-chunking subsystem for stability across four pillars:

1. **Configurable output budget with split-and-retry on truncation.** Output `max_tokens` is configurable per provider; on truncation the batch splits and retries instead of dropping findings.

2. **Unified token estimator grounded in the exact serialized prompt.** One real tokenizer (js-tiktoken for OpenAI/Copilot; fast approximation for Anthropic) called by both batcher and per-call guard, counting the exact wire-sent serialization (system + user message + tool schema + rendered guidance). Eliminates divergent estimators and the "line-span fallback" code path.

3. **Derived per-call input budget from the provider's context window.** Instead of hand-tuned 60k/120k literals, the budget is:
   ```
   hard_cap_in = window − reserved_output − prompt_overhead − safety_margin
   ```
   where `window` is the provider's `max_context_tokens`, and safety is 7% of the window (consensus 5–10% band). This ensures the input stays well under the window with headroom for estimator error.

4. **Hunk-level splitting + graceful degradation (subset-and-note).** Files larger than the budget are split at hunk boundaries into sub-file chunks. Over-budget batches that exceed the call limit are reordered by risk (security/migration > size > path) and the highest-risk subset is reviewed with a visible "not reviewed: <files>" notice — no PR-wide skip.

## Rationale

The decision is justified by:

- **Stability for real-world diffs.** Output truncation is the dominant failure mode; split-and-retry eliminates silent finding loss. Derived budgets eliminate the divergent-estimator cliff. Hunk splitting and subset-and-note eliminate the "large file" and "too many calls" cliffs.
- **Grounded in research consensus.** Qodo, CodeRabbit, Cursor Bugbot, and Ellipsis all reserve output first, use small chunks (hunk-level), keep context well under the window, and post visible omission notices. This design is the proven pattern.
- **Vendor-neutral.** The unified estimator lives in `@prisma-bot/shared` (no vendor SDK imports); each adapter sets its tokenizer family (`cl100k`, `o200k`, `anthropic-approx`) via `ProviderCapabilities`. The reservation formula is a config contract, not adapter-specific code.
- **Backward compatible.** The `call_token_budget` and `MAX_TOKENS_PER_PR` knobs are kept as optional ceilings for existing deployments. Default behavior changes (derived budgets now dominate), but configs that set explicit ceilings still work.
- **Independently shippable phases.** Output-truncation fix ships alone and stabilizes the dominant failure. Unified estimator ships second and eliminates HOTSPOT-6. Hunk splitting ships third and unlocks large-file review. Subset-and-note ships last and removes the PR-wide skip cliff. Each phase is testable and individually valuable.

## Interface changes

### New config knobs (in `ChunkingSchema`)

- `reserved_output_tokens` (default 4096): output reserve per call, wired to adapter `max_tokens`.
- `max_truncation_retries` (default 2): bounded retry on output truncation.
- `prompt_overhead_tokens` (default 9000): fixed prompt overhead reserve.
- `safety_fraction` (default 0.07): safety margin as fraction of window.
- `hunk_context_lines` (default 10): forward-compat knob for prefilter re-trimming (unused in Phase 3).
- `min_hunk_split_tokens` (default 0): threshold for hunk splitting (0 = always split when over budget).

### New error kinds (in `ProviderErrorSchema`)

- `output_truncated`: batch's output filled the max-tokens budget; split-and-retry triggered.
- `over_budget`: estimated prompt tokens exceed `hard_cap_in`; split-and-retry triggered (Phase 4).

### New provider interface surface (in `ProviderCapabilitiesSchema`)

- `tokenizer_family`: enum (`'cl100k'`, `'o200k'`, `'anthropic-approx'`) — tells the orchestrator which tokenizer to use for `estimatePromptTokens`.

### New shared utility

- `@prisma-bot/shared/tokens/estimator.ts`: `estimatePromptTokens(prompt, family)` and `serializeForEstimate(input)`. Called by batcher and all adapters' per-call guards. Zero vendor SDK imports.

## Locked product decisions (do not re-litigate)

- **Stability core only.** Voting, validation, and ranking quality are out of scope; this is infrastructure stabilization.
- **Real tokenizer.** js-tiktoken for OpenAI/Copilot; fast heuristic (chars/4 × 1.15) for Anthropic. Never under-count; the estimator is a floor, not a ceiling.
- **Split-and-retry, not continuation.** Each call is stateless. Continuation (multi-turn) is deferred.
- **Subset-and-note, not PR-wide skip.** Review the highest-risk subset; post a visible "not reviewed" list.

## Trade-offs

Accepted costs of this decision:

- **Dependency on js-tiktoken.** New transitive dependency; mitigated by lazy initialization and fallback to the approximation path for Anthropic.
- **Config growth.** Six new knobs; mitigated by strong defaults and a new config-spec section documenting the reservation formula.
- **Increased complexity in orchestrator and batcher.** Serial loop kept (not parallelized) to keep budget accounting trivial. New split logic and priority ordering add ~200 lines; offset by removal of divergent estimators and magic-number fallbacks.
- **Hunk-level granularity in findings.** Line citations are now preserved verbatim across hunk splits, with no re-diffing in core. Forward-compat knob `hunk_context_lines` reserved for a future prefilter change (out of scope).

## Rejected alternatives

### Increase output budget, no retry

- **Alternative.** Raise `max_tokens` to e.g., 16k, no split-and-retry.
- **Why rejected.** Does not fix the root cause (differing estimators, whole-file granularity). Single large finding-dense file still loses its review if output is still exceeded.

### Parallel batch fan-out

- **Alternative.** Parallelize the orchestrator's batch loop.
- **Why rejected.** Complicates `max_provider_calls_per_pr` accounting and retry-depth guards. Serial loop keeps the math trivial. If parallelism is needed for latency later, add a semaphore — not worth the complexity for stability.

### Re-diff and context-trim in core

- **Alternative.** `core` re-diffs each oversized file to re-trim hunk context.
- **Why rejected.** `core` lacks the raw patch; the prefilter owns diff production. Re-diffing belongs to the prefilter, not the orchestrator. Forward-compat knob `hunk_context_lines` reserved for a future prefilter change.

## Consequences (now)

- Batcher and adapters both call `estimatePromptTokens` over the same serialized prompt — one source of truth.
- Output truncation is a degradable error that triggers split-and-retry, not a terminal batch loss.
- Per-call input budget is derived from the provider's window, with reserves for output, overhead, and safety margin.
- Large files are split at hunk boundaries into sub-file chunks, each dequeuable independently.
- Over-budget batches degrade gracefully: highest-risk subset is reviewed, remainder posted as "not reviewed" — no PR-wide skip.
- New config knobs with sensible defaults; existing `call_token_budget` and `MAX_TOKENS_PER_PR` act as optional ceilings.

## Consequences (later)

- A future prefilter change can use `hunk_context_lines` to re-trim context around hunks (out of scope for Phase 3).
- The estimator can be enhanced to call the Anthropic count-tokens API where a round-trip is affordable (currently the fast heuristic is used in the hot path).
- Parallel batch fan-out can be added behind a config flag with a semaphore (not needed for stability).

## Testing

- Unit: token estimator never under-counts (`anthropic-approx`); exact match (cl100k/o200k); `serializeForEstimate` reuses real renderers.
- Unit: derived `hard_cap_in` boundary tests; priority ordering; subset-and-note `notReviewed` population.
- Unit: hunk-split partition conservation, line-number stability, determinism.
- Integration: split-and-retry on truncation; batch over-budget triggers split, not abort; PR survives output truncation on single hunks; happy-path golden (byte-identical to pre-Phase-1).
- Regression: `scripts/check-vendor-isolation.sh` stays green; no vendor SDK imports in `shared`.

## References

- `chunking-stability-spec.md` — full technical spec, all four phases, 4 acceptance-criteria per phase.
- `config-spec.md` § The Token Budget Derivation Formula — operator guide to the reservation formula.
- `publication-policy.md` § Chunked review and Partial review — updated narrative on subset-and-note.
