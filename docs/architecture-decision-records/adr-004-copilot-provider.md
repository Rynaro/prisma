# ADR-004 — GitHub Copilot Provider Adapter

## Status

Accepted — 2026-05-06. ADRs are immutable once accepted; superseding decisions require a new ADR that explicitly references this one. This ADR is additive to ADR-002 (Provider Abstraction) and does not modify it.

## Context

ADR-002 § Consequences-later commits the project to additive vendor introduction: *"Adding or swapping a provider must be additive: a new adapter that satisfies the interface and its schemas. No core pipeline change is permitted to add provider B."* OQ-1 selected Anthropic Claude as the first reference adapter; the abstraction has remained unexercised by a second concrete vendor since.

This ADR records the decision to ship a GitHub Copilot adapter as the second production-ready provider alongside Anthropic Claude. It also records the surface choice for "GitHub Copilot," which is not unambiguous: candidates include the Copilot Chat API for individual subscribers, Azure OpenAI behind Copilot Enterprise, and the GitHub Models inference endpoint exposed at `https://models.github.ai/inference`.

## Decision

The GitHub Copilot adapter targets the **GitHub Models inference endpoint** (`https://models.github.ai/inference/chat/completions`) over an OpenAI-compatible chat-completions surface. Authentication is `Authorization: Bearer <token>`, where the token is either a GitHub PAT with `models:read` scope or a GitHub App installation token resolved at runtime. The adapter package lives at `packages/providers/copilot` and exports `CopilotProvider`, which implements the `Provider` interface defined in `packages/shared/src/schemas/provider-interface.ts`.

Worker selection in `apps/github-app/src/worker.ts` follows a deterministic precedence:

1. `ANTHROPIC_API_KEY` set → `AnthropicProvider`.
2. else `COPILOT_API_KEY` set → `CopilotProvider`.
3. else → `FakeProvider({ script: [] })` (boot-only stub).

## Rationale

- **App identity alignment.** The product is delivered as a GitHub App; targeting GitHub's own inference endpoint keeps the operator's trust boundary inside GitHub and unlocks App-installation-token auth without a separate vendor account.
- **OpenAI-compatible surface.** The `/chat/completions` shape is the most widely-supported tool-calling API in the industry. Reusing it keeps the prompt envelope (`packages/providers/copilot/src/prompt.ts`) close to the Anthropic adapter's, and the validated `ProviderReviewOutput` schema is unchanged.
- **No new runtime dependency.** Native `fetch` (Node ≥22, already pinned at `package.json:6`) is sufficient. Adding `openai` SDK would broaden the type surface that must be firewalled by ADR-002's "no vendor SDK outside the adapter" rule for negligible capability gain.
- **Capability honesty.** GitHub Models (GPT-4o family) supports OpenAI tool-calls and 128K context but lacks deterministic-seed semantics. The adapter declares this exactly: `structured_output: true, function_calling: true, deterministic_seed: false, max_context_tokens: 128000`.
- **Additive change.** No file under `packages/core`, `packages/shared/src/schemas`, or `evals/` changes. The eval harness still uses `FakeProvider`; the 9/9 PASS gate is preserved.

## Interface contract

The Copilot adapter exposes the same three-member surface as the Anthropic adapter:

- `name: 'copilot'` (the canonical `Provider.name`).
- `capabilities: ProviderCapabilities` (declared above).
- `review(input: ProviderReviewInput): Promise<ProviderReviewOutput>` — pre-flight cost-ceiling check, build prompt, invoke the OpenAI-compatible `chatCompletions` shape, extract the `submit_review_findings` tool-call, JSON-parse the `arguments` string, validate against `ProviderReviewOutputSchema`, return.

Errors are mapped through `mapCopilotError` to the same five `ProviderError` variants (`transport | auth | rate_limit | capability | schema_validation`); the secret-scrubbing rule from `packages/providers/anthropic/src/error-mapping.ts:23` is reproduced verbatim with a copilot-flavored fallback message.

## Trade-offs

Accepted costs of this decision:

- **Surface ambiguity.** "GitHub Copilot" branding could conflict with operator expectations of the Copilot Chat REST API (no stable public surface) or Azure OpenAI variants. We choose `models.github.ai` as the most operationally stable interpretation; `COPILOT_BASE_URL` is exposed so operators can re-target without code changes.
- **Per-adapter prompt duplication.** `packages/providers/copilot/src/prompt.ts` repeats the user-message rendering from `packages/providers/anthropic/src/prompt.ts`. This is intentional (see `.spectra/plans/copilot-vendor/spec.md` § OQ-Copilot-3): three adapters is the abstraction threshold.
- **Single-vendor per-deployment.** The selector picks one adapter at boot; there is no in-process fan-out across vendors. A future ADR could introduce shadow-mode comparison without altering this contract.

## Rejected alternatives

### Adopt the `openai` npm SDK

Rejected: heavier dependency surface, more types to firewall, no compelling capability gain over `fetch` for our narrow tool-call use. The `client.ts` module is the only network-call site, and `fetch` keeps it ~120 lines.

### Target Azure OpenAI through Copilot Enterprise

Rejected for MVP: pulls in an Azure subscription requirement and Microsoft-tenant compliance assumptions that the App does not currently mandate. `COPILOT_BASE_URL` makes a future Azure pivot a configuration flip.

### Extract a shared `buildPrompt` helper between Anthropic and Copilot adapters

Rejected: tool-call envelopes diverge (`{ type: 'function', function: { … } }` vs `{ name, description, input_schema }`), and N=2 does not justify abstraction. Re-evaluate at N=3.

## Consequences (now)

- New package `packages/providers/copilot` with the four-file source layout and three-file test layout that mirror `packages/providers/anthropic`.
- `apps/github-app/package.json` adds `@prisma-bot/provider-copilot` as a workspace dependency.
- `apps/github-app/src/worker.ts buildProvider()` carries a third selector arm.
- Documentation surface: `.env.example`, `docs/deployment.md` (env-var table + readiness probe + `.env.example` snippet), `docs/operational-runbooks.md` (rotation + incident-response copy), `README.md` (module map + env-var table + Known limitations).
- `docs/open-questions.md` records the resolution log entry for `OQ-Copilot-1/2/3`.

## Consequences (later)

- A future change that introduces a third real adapter is the trigger to evaluate prompt-extraction (OQ-Copilot-3 reversal).
- A future Azure OpenAI integration may be modeled as a `COPILOT_BASE_URL` deployment variant or as a new ADR if it materially diverges from the OpenAI-compatible contract.
- Mechanical enforcement of "no vendor SDK / network primitive outside the adapter" is wired via `scripts/check-vendor-isolation.sh` and chained into `make lint` (see Makefile target `check-vendor-isolation`). Three rules are asserted today: `@anthropic-ai/sdk` confined to `packages/providers/anthropic/src/client.ts`; `@octokit/*` confined to `packages/github/src/installation-auth/`; `fetch(` calls under `packages/providers/` confined to `*/src/client.ts`. Adding a fourth adapter is one additional `check_rule` invocation in that script.
