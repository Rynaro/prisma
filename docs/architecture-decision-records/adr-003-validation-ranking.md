# ADR-003 — Validation, Ranking, and Publication Cap

## Status

Accepted — 2026-04-30. ADRs are immutable once accepted; superseding decisions require a new ADR that explicitly references this one.

## Context

Operating principles 3, 4, and 5 of the originating brief are, in summary: deterministic gates around non-deterministic components (3); never post raw model output to a PR (4); volume control is a first-class feature, not an afterthought (5). This ADR records the pipeline shape that satisfies all three.

`research-summary.md`'s "Noise, trust, and developer experience findings" section enumerates the failure modes that motivate this pipeline: noisy comments / trust erosion, duplicate comments and reprocessing loops, large diff overload, generated files / lockfiles / vendored code. ADRs 001 and 002 do not address these directly; they belong here.

This ADR does not specify cap values, schema field types, or queue/retry mechanics; those are Phase 2 concerns.

## Decision

All findings flow through prefilter → provider → validator → ranker → publication cap before any PR-visible artifact is created.

## Pipeline shape

The pipeline is an ordered composition. Each stage has a defined input, a defined output, and a defined ability to short-circuit (drop the rest of the work for the current PR or finding without producing a PR-visible artifact).

1. **Prefilter.**
   - Input: raw PR diff plus repo-local config (from `.github/review-bot.yml`).
   - Output: a normalized, scoped diff context (selected files, selected hunks, language tags) suitable for model input.
   - Short-circuit: yes — if everything in the diff is excluded by paths, globs, generated-file detection, or size rules, the pipeline ends here without invoking the provider. Prefilter runs before any provider call.
2. **Provider.**
   - Input: the prefiltered diff context, shaped as `ProviderReviewInput`.
   - Output: a `ProviderReviewOutput` instance, validated at the adapter boundary by Zod (per ADR-002).
   - Short-circuit: yes — adapter-level errors (transport, auth, rate-limit, capability, schema validation) terminate this PR's review with a logged reason; no partial output is forwarded.
3. **Validator.**
   - Input: a `ProviderReviewOutput` instance.
   - Output: a filtered finding list in which every finding has passed deterministic checks: schema conformance, structural sanity (path exists in the diff, line is within a touched hunk), and reference checks (e.g., the cited symbol or path actually appears in the diff context). Each rejected finding is recorded with a rejection reason.
   - Short-circuit: per-finding — the validator may drop individual findings; it does not abort the pipeline as a whole.
4. **Ranker.**
   - Input: the validator's surviving finding list.
   - Output: the same list, ordered by a deterministic ranking signal that combines severity, category, and the model-reported `confidence` field (used as a ranker signal, not a publication gate).
   - Short-circuit: no — ranking does not drop findings; it orders them.
5. **Publication cap.**
   - Input: the ranked finding list.
   - Output: the subset of findings that will become PR-visible artifacts, after applying per-PR cap, per-file cap, severity floor, and a duplicate-suppression key against previously published findings on the same PR.
   - Short-circuit: yes — findings beyond the caps are dropped with a recorded rejection reason. Ranker runs before publication; the cap consumes the ranked order.

The schema produced at stage 2 (`ProviderReviewOutput`) is the same identifier referenced as the validator input in this ADR and as the pipeline-bullet schema in `mvp-scope.md`.

## Rationale

- **Hallucinated findings.** Models produce findings that look plausible but reference paths or lines that do not exist, or cite symbols that are not in the diff. Deterministic structural and reference checks in the validator catch these without re-asking a model.
- **Noisy comments / trust erosion.** Even valid findings overwhelm reviewers if every finding is published. The ranker plus the publication cap address volume directly; together they prevent the failure mode where developers stop reading the bot.
- **Large diff overload.** Without prefiltering, large diffs force the model to spend tokens on generated/vendored content, degrading both quality and cost. The prefilter is a first-class stage, not a heuristic bolted on later.
- **Duplicate comments and reprocessing loops.** Re-runs on force-pushes, rebases, or webhook redeliveries must not republish identical findings. The publication cap consults a duplicate-suppression key keyed on finding identity for the PR, breaking the reprocessing loop.

## Trade-offs

Accepted costs of this pipeline shape:

- **Some valid findings will be dropped by caps.** A per-PR cap is a volume control; if more genuinely useful findings exist than the cap allows, the surplus is dropped. This is an explicit choice in favor of trust.
- **Ranking adds latency.** A ranker is an extra deterministic stage between validation and publication. It is small, but it is real.
- **Deterministic validation can reject legitimate-but-unverifiable findings.** A finding that is correct but cites a line outside the touched hunks will fail the structural check and be dropped. Better to drop a possibly-correct unverifiable finding than to publish a confidently-wrong one.

## Rejected alternatives

### Post raw LLM output

- **Alternative.** Take the provider's output and post it directly to the PR.
- **Why considered.** Simplest possible pipeline; minimum implementation cost.
- **Why rejected.** Directly violates operating principles 4 (never post raw model output) and 5 (volume control). Inherits every hallucination, every shape drift, and every noisy day from the model with no recourse.

### LLM-as-judge only (self-critique without deterministic validator)

- **Alternative.** Use a second model pass to critique or rank the first model's findings, with no deterministic validation stage.
- **Why considered.** Removes the need to write structural/reference checks; "the model can decide."
- **Why rejected.** A non-deterministic validator cannot satisfy operating principle 3 (deterministic gates around non-deterministic components). It also reintroduces schema-drift at the judge step, doubles model cost and latency, and provides no audit trail that a human can read.

### Heuristic-only (no model)

- **Alternative.** Skip the model entirely and rely on linters, static analyzers, and rule-based heuristics.
- **Why considered.** Trivially deterministic; cheap.
- **Why rejected.** Heuristics alone do not deliver the qualitative review value the product promises (cross-cutting reasoning, natural-language explanations, judgment calls about intent). The product is an AI reviewer; removing the model removes the product.

## Consequences (now)

- **Prefilter module.** A deterministic, configurable component that runs before any provider call.
- **Validator module.** A deterministic, schema- and reference-aware component that consumes `ProviderReviewOutput` and emits a filtered finding list.
- **Ranker module.** A deterministic ordering component over the validator's output.
- **Publication-cap module.** A deterministic subset selector that applies per-PR cap, per-file cap, severity floor, and a duplicate-suppression key.
- **Rejection-reason log.** A structured log of every dropped finding with the stage and reason for the drop, suitable for later analysis and for tuning defaults.

## Consequences (later)

An optional verifier (a second deterministic or model-assisted pass that re-checks high-stakes findings) and/or a stronger ranker can be added without changing the pipeline contract. This satisfies the brief's "no multi-agent complexity beyond optional verifier/ranker" non-goal: the pipeline accepts those two specific extensions and rejects the rest.
