# ADR-002 — Provider Abstraction

## Status

Accepted — 2026-04-30. ADRs are immutable once accepted; superseding decisions require a new ADR that explicitly references this one.

## Context

Operating principle 1 of the originating brief commits the product to vendor independence: no LLM provider lock-in, ever. The model layer is where lock-in actually accumulates — through SDK imports, output-shape coupling, capability assumptions, and pricing assumptions. This ADR records the decision that contains that risk in a single, replaceable surface.

The "Output shape variance across providers" finding in `research-summary.md` (`### Output shape variance across providers`) documents how providers diverge on output shape, JSON-mode guarantees, function-calling support, error semantics, and rate-limit/retry behavior. Any of those can change without notice. The pipeline must absorb that variance at exactly one boundary.

This ADR is also the natural home of operating principle 8 (every public interface typed and schema-validated) at the model layer: a provider's output is a public, untrusted input to the rest of the pipeline and must be schema-validated at the boundary, not trusted on the wire.

## Decision

All model interactions go through a single typed Provider interface; no vendor SDK is imported outside its adapter.

## Rationale

The decision is justified by:

- **Schema-drift risk.** Providers change their output shape. With direct SDK calls scattered through the pipeline, a silent shape change becomes a runtime fault somewhere downstream. With one adapter and a single validated output schema, drift produces a single, localized failure.
- **Cost and latency variance.** Providers differ on input/output token pricing, context windows, and end-to-end latency. Holding them behind one interface lets us swap or A/B them without touching pipeline code.
- **Capability variance.** Function calling, JSON mode, structured-output guarantees, and refusal semantics differ across providers. The abstraction exposes these as explicit capability flags, so the pipeline can choose a strategy rather than rediscover the differences.
- **Testability via fakes.** A typed interface admits a fake provider for unit and contract tests; no live keys are required to exercise the rest of the pipeline.
- **Ability to A/B providers.** Comparison and migration are normal operations behind the interface, not special projects.

## Interface contract (sketch)

This sketch is informative; full TypeScript types and Zod schemas land in Phase 2 implementation. The contract names the elements the rest of Phase 1 may reference.

- `review(input): ReviewResult` — the single entry point used by the pipeline. The function is asynchronous in implementation; signatures here are described by name only.
- **Input schema.** A Zod-validated input named `ProviderReviewInput`, carrying normalized diff context (the prefiltered hunks, file paths, and language tags) plus a request-shaping section (model selection, capability hints, deterministic seed where supported).
- **Output schema.** A Zod-validated output named `ProviderReviewOutput`. This is the canonical, vendor-neutral finding-list schema produced by the adapter and consumed by the validator/ranker stages downstream. Its fields normalize across providers and include at minimum `path`, `line`, `severity`, `category`, `message`, `rationale`, and `confidence`.
- **Error type.** A typed error union named `ProviderError` covering, at minimum: transport errors, authentication errors, rate-limit errors, capability errors (e.g., unsupported feature), and schema-validation errors.
- **Capability flags.** A typed `ProviderCapabilities` bag describing per-adapter capability presence (e.g., structured-output mode, function calling, deterministic seed, max context). The pipeline reads capabilities; it does not rediscover them.

`ProviderReviewOutput` is the identifier reused in ADR-003 (validator input) and in `mvp-scope.md` (pipeline bullets). The name does not change across files in Phase 1.

## Trade-offs

Accepted costs of this decision:

- **Indirection cost.** One more layer between the pipeline and the model, with the corresponding cognitive and code-navigation overhead.
- **Lowest-common-denominator capability surface.** The interface exposes only capabilities every adapter is required to expose; vendor-specific advanced features stay inside the adapter and are not visible to the pipeline.
- **One more module to maintain.** The adapter, its schemas, its fake, and its tests are real maintenance load.

## Rejected alternatives

### Single hard-coded provider

- **Alternative.** Pick one LLM provider, depend on its SDK directly throughout the pipeline.
- **Why considered.** Fastest path to a working prototype; no abstraction overhead; full access to vendor-specific capabilities.
- **Why rejected.** It violates operating principle 1's spirit (vendor independence) and couples the product roadmap to one vendor's pricing, availability, deprecation cadence, and policy decisions. A single outage or pricing change becomes a product-wide event.

### Direct SDK calls scattered through the pipeline

- **Alternative.** Allow each pipeline stage to call whichever vendor SDK it prefers, with no central interface.
- **Why considered.** Avoids the "one big abstraction" problem; each stage gets the SDK it wants.
- **Why rejected.** It makes prefilter/validation/ranking boundaries leaky (model assumptions diffuse through the pipeline), forces tests to use live keys (no central seam to fake), and turns schema-drift into a multi-site problem rather than a one-site problem.

### LangChain-style heavy framework

- **Alternative.** Adopt a large agent/orchestration framework and build inside its abstractions.
- **Why considered.** Many adapters and abstractions exist out of the box; community momentum.
- **Why rejected.** It imports a large abstract surface we do not need, hides retry/cost/rate-limit behavior behind framework conventions, complicates schema validation by interposing framework-shaped objects between us and the wire, and pulls the project's dependency surface in a direction that fights operating principle 1.

## Consequences (now)

- One reference adapter implementing the Provider interface (the choice of first reference provider is open; see Open Question OQ-1).
- Zod schemas for `ProviderReviewInput` and `ProviderReviewOutput`, validated at the adapter boundary.
- A fake provider used by tests; no live provider key is required to run the test suite.
- No provider SDK is imported outside its adapter; this is a hard project rule, enforceable by lint/dependency rules.

## Consequences (later)

Adding or swapping a provider must be additive: a new adapter that satisfies the interface and its schemas. No core pipeline change is permitted to add provider B. If a future provider's capability cannot be modeled in the existing capability flags, the flags evolve; the pipeline does not learn a new vendor.
