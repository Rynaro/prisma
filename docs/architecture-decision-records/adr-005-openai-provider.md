# ADR-005 — OpenAI Provider Adapter

## Status

Accepted — 2026-06-09. ADRs are immutable once accepted; superseding decisions require a new ADR that explicitly references this one. This ADR is additive to ADR-002 (Provider Abstraction) and ADR-004 (GitHub Copilot Provider Adapter) and does not modify either.

## Context

ADR-002 § Consequences-later commits the project to additive vendor introduction: *"Adding or swapping a provider must be additive: a new adapter that satisfies the interface and its schemas. No core pipeline change is permitted to add provider B."* OQ-1 selected Anthropic Claude as the reference adapter; ADR-004 added GitHub Copilot (the GitHub Models endpoint) as the second production provider.

This ADR records the decision to ship an **OpenAI** adapter as the third production-ready provider. Unlike the Anthropic and Copilot surfaces — neither of which exposes deterministic-seed semantics — OpenAI's `/chat/completions` endpoint honors an integer `seed`. This is the adapter's distinguishing capability and the reason it is worth adding a third vendor rather than retargeting Copilot's `COPILOT_BASE_URL`.

With OpenAI, the provider count reaches **N=3**, which is the threshold ADR-004 § Rejected alternatives named as the trigger to re-evaluate prompt-helper extraction (OQ-Copilot-3). That re-evaluation is recorded below as a deferred decision.

## Decision

The OpenAI adapter targets the **OpenAI Chat Completions endpoint** (`https://api.openai.com/v1/chat/completions`) over the standard OpenAI-compatible chat-completions surface. Authentication is `Authorization: Bearer <token>`, where the token is an OpenAI API key supplied via `OPENAI_API_KEY`. The adapter package lives at `packages/providers/openai` and exports `OpenAIProvider`, which implements the `Provider` interface defined in `packages/shared/src/schemas/provider-interface.ts`.

Worker selection in `apps/github-app/src/worker.ts` follows a deterministic precedence (OpenAI appended after the existing Anthropic and Copilot arms):

1. `ANTHROPIC_API_KEY` set → `AnthropicProvider`.
2. else `COPILOT_API_KEY` set → `CopilotProvider`.
3. else `OPENAI_API_KEY` set → `OpenAIProvider`.
4. else → `FakeProvider({ script: [] })` (boot-only stub).

Operators override the model via `OPENAI_MODEL` and the endpoint via `OPENAI_BASE_URL` (e.g. for Azure OpenAI or a proxy gateway).

## Rationale

- **OpenAI-compatible surface.** The `/chat/completions` shape is the most widely-supported tool-calling API in the industry and is byte-compatible with the Copilot adapter. The prompt envelope (`packages/providers/openai/src/prompt.ts`) and the validated `ProviderReviewOutput` schema are reused unchanged.
- **No new runtime dependency.** Native `fetch` (Node ≥22) is sufficient. Adding the `openai` SDK would broaden the type surface that ADR-002's "no vendor SDK outside the adapter" rule must firewall, for negligible capability gain.
- **Capability honesty — the differentiator.** OpenAI honors an integer `seed`. The adapter declares this exactly: `structured_output: true, function_calling: true, deterministic_seed: true, max_context_tokens: 128000`. Anthropic and Copilot both declare `deterministic_seed: false`. To make the declaration honest, the adapter **threads** `request_shaping.deterministic_seed` (an INT seed value) into the request as `seed`, and `request_shaping.model` as a per-request model override. Anthropic and Copilot ignore `request_shaping`; OpenAI is the first adapter to consume it.
- **Additive change.** No file under `packages/core`, `packages/shared/src/schemas`, or `evals/` changes. The eval harness still uses `FakeProvider`; the PASS gate is preserved.

## Interface contract

The OpenAI adapter exposes the same three-member surface as the other adapters:

- `name: 'openai'` (the canonical `Provider.name`).
- `capabilities: ProviderCapabilities` (declared above; `deterministic_seed: true`).
- `review(input: ProviderReviewInput): Promise<ProviderReviewOutput>` — pre-flight cost-ceiling check, build prompt, resolve per-request `model`/`seed` from `input.request_shaping` (conditional-assign — never assign `undefined` under `exactOptionalPropertyTypes`), invoke the OpenAI `chatCompletions` shape, extract the `submit_review_findings` tool-call, JSON-parse the `arguments` string, validate against `ProviderReviewOutputSchema`, return.

Errors are mapped through `mapOpenAIError` to the same five `ProviderError` variants (`transport | auth | rate_limit | capability | schema_validation`); the secret-scrubbing rule is reproduced with an openai-flavored fallback message. The mapping mirrors `mapCopilotError`, plus an OpenAI-specific delta: HTTP 400 with `error.code ∈ {context_length_exceeded, model_not_found}` maps to `capability`; `insufficient_quota` arrives with HTTP 429 and therefore maps to `rate_limit`. Unmatched 400s keep the Copilot-parity default (`transport`, non-retryable).

## Trade-offs

Accepted costs of this decision:

- **Per-adapter prompt duplication at N=3.** `packages/providers/openai/src/prompt.ts` repeats the user-message rendering shared by the Anthropic and Copilot adapters. ADR-004 named N=3 as the threshold to re-evaluate extracting a shared `buildPrompt`. This delta keeps the per-adapter file (lowest-risk parity) but the re-evaluation is now due — see Consequences (later).
- **New policy surface: per-request model override.** `request_shaping.model` lets a caller override the model per request. This is a new (reversible) policy/cost surface that the other adapters do not expose.
- **Single-vendor per-deployment.** The selector picks one adapter at boot; there is no in-process fan-out across vendors. A future ADR could introduce shadow-mode comparison without altering this contract.

## Rejected alternatives

### Adopt the `openai` npm SDK
Rejected: heavier dependency surface, more types to firewall under ADR-002, no compelling capability gain over `fetch` for our narrow tool-call use. The `client.ts` module is the only network-call site, and `fetch` keeps it small. A fetch-based adapter is auto-covered by `scripts/check-vendor-isolation.sh` Rule 3 (`fetch(` confined to `packages/providers/*/src/client.ts`); an SDK import would require a new rule.

### Use `response_format: { type: 'json_schema' }` (structured outputs) instead of tool-calling
Rejected for this delta: there is no `response_format` precedent in the repository, and it would diverge the `client.ts` args and `index.ts` extraction path from the proven Copilot template. Forced tool-calling (`submit_review_findings`) is the established structured-output mechanism. Re-evaluate only if a repo-wide precedent lands and tool-calling proves unreliable.

### Target Azure OpenAI as a distinct adapter
Rejected: Azure OpenAI shares the `/chat/completions` surface. `OPENAI_BASE_URL` makes an Azure or proxy deployment a configuration flip, not a new adapter.

### Extract a shared `buildPrompt` helper across all three adapters
Deferred (the OQ-Copilot-3 reversal trigger): tool-call envelopes still differ between the OpenAI-compatible adapters and Anthropic (`{ type: 'function', function: { … } }` vs `{ name, description, input_schema }`). Now that N=3, this is a live re-evaluation; flagged in Consequences (later) and `docs/open-questions.md` (OQ-OpenAI-3).

## Consequences (now)

- New package `packages/providers/openai` with the four-file source layout and three-file test layout that mirror `packages/providers/copilot`.
- `apps/github-app/package.json` adds `@prisma-bot/provider-openai` as a workspace dependency.
- `apps/github-app/src/worker.ts buildProvider()` carries a fourth selector arm, appended after the Copilot arm (precedence `ANTHROPIC → COPILOT → OPENAI → Fake`), observable via the `worker.provider.selected` log event (`{ provider: 'openai' }`).
- Documentation surface: `.env.example`, `README.md`, `docs/contributing.md`, `docs/deployment.md`, `docs/install-github-app.md`, `docs/quickstart.md`, `docs/operational-runbooks.md`.
- `docs/open-questions.md` records the resolution log entry for `OQ-OpenAI-1/2/3`.
- **No change** to `scripts/check-vendor-isolation.sh`: the adapter is fetch-based, so Rule 3 (generic) already covers it; the script still asserts three rules.

## Consequences (later)

- N=3 is reached, so prompt-helper extraction across adapters is now a live re-evaluation (OQ-Copilot-3 / OQ-OpenAI-3 reversal). Until then the per-adapter `prompt.ts` files stand.
- A future Azure OpenAI integration may be modeled as an `OPENAI_BASE_URL` deployment variant or as a new ADR if it materially diverges from the OpenAI-compatible contract.
- Per-request model override (`request_shaping.model`) and seed threading establish a precedent for consuming `request_shaping`; a future change may extend this to other adapters or add usage/cost telemetry on model selection.
