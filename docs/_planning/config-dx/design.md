# Config DX: vendor-neutral model settings ("Easy Prisma Settings")

Status: **proposal / design** (not yet implemented). Owner decision pending.

## Goal

Make model selection and tuning in `.github/review-bot.yml`:

1. **Vendor-neutral** — no vendor-specific parameter names leaking into the user's
   config (the `max_tokens` vs `max_completion_tokens` friction that broke
   `gpt-5.4-nano` in v0.8.0→v0.8.1 must never reach the user).
2. **Swap-in-one-line** — changing provider or model is a single edit; "model
   interchange" between OpenAI / Anthropic / Copilot is trivial.
3. **Forward-compatible** — a model released tomorrow with a setting Prisma hasn't
   normalized yet is still usable *today*, via a raw vendor passthrough escape hatch.

## What the field does (web research)

Every mature multi-vendor LLM tool converges on the same three-part shape:

| Tool | Model reference | Normalized settings | Vendor passthrough |
|------|-----------------|---------------------|--------------------|
| Vercel AI SDK | `provider/modelId` slug (`openai/gpt-5.1`) | `temperature`, `maxOutputTokens`, `topP`, `stopSequences`, `seed` | `providerOptions: { openai: {…}, anthropic: {…} }` keyed by provider slug |
| LiteLLM | `model: openai/gpt-4o` inside `litellm_params` | normalized params in `litellm_params` | arbitrary keys in `litellm_params` forwarded to the vendor |
| OpenRouter | `provider/model` slug | OpenAI-compatible core | `provider.options` / `extraBody` per slug |
| Rasa / Aider (via LiteLLM) | `provider:` + `model:` | shared core | free-form extra fields per provider |

Distilled DX principles:

- **P1 — Portable slug.** A `provider/name` string makes switching vendors a
  one-token edit and is self-describing. (Vercel, OpenRouter, LiteLLM.)
- **P2 — Normalize the common core, passthrough the long tail.** Stabilize the
  ~5 settings everyone shares; everything else goes through a per-vendor bag.
  (Vercel `providerOptions`, LiteLLM `litellm_params`.)
- **P3 — Forward-compat via passthrough.** Un-normalized / brand-new knobs are
  expressible without waiting for a release. Directly satisfies the robustness ask.
- **P4 — Progressive disclosure + sensible defaults.** Minimal config = just a
  model (or nothing). Advanced knobs are opt-in and live deeper.
- **P5 — Escape hatch wins.** Raw vendor passthrough overrides normalization, so a
  lagging or wrong normalization never blocks a user.
- **P6 — Consistent, vendor-neutral names.** snake_case (matching the existing
  schema), and names that describe intent (`max_output_tokens`), not a vendor's API
  field (`max_tokens`).

## Proposed schema

```yaml
# 1. Pick a model — vendor-neutral "provider/name" slug. Swap vendors in one line.
model: openai/gpt-5.4-nano
#   - a bare name ("gpt-4o") uses the default provider
#   - legacy `provider:` + `model:` keys still parse (deprecated, see Back-compat)

# 2. Vendor-neutral generation settings. Prisma translates each to the vendor's
#    dialect (e.g. max_output_tokens -> max_tokens OR max_completion_tokens).
generation:
  max_output_tokens: 4096
  temperature: 0.2
  top_p: 1.0
  seed: 42                # reproducibility, where the provider supports it

# 3. Escape hatch — raw settings forwarded to a named provider untouched.
#    For brand-new model knobs Prisma hasn't normalized yet. Overrides `generation`.
provider_options:
  openai:
    reasoning_effort: low
    verbosity: low
  anthropic:
    thinking:
      type: enabled
      budget_tokens: 8000
```

### Why these names / this leveling

- **`model` as a `provider/name` slug** (P1): unifies today's separate `provider:` +
  `model:` into one portable token. `openai/gpt-5.4-nano` → `anthropic/claude-sonnet-4.5`
  is the entire change needed to interchange models.
- **`generation:` block** (P2, P4): groups the normalized knobs so they're clearly
  "what to ask the model for," separate from model *selection*. `max_output_tokens`
  is the headline — it is the v0.8.1 `resolveTokenParam` lesson lifted into the
  user's language: the user expresses intent, the adapter picks the vendor field.
- **`provider_options:` keyed by provider slug** (P3, P5): the escape hatch. Chosen
  over a top-level `openai:` section (the original sketch) because (a) it scopes the
  passthrough clearly to model behavior instead of polluting the top-level namespace,
  (b) it matches the established Vercel `providerOptions` term operators already know,
  and (c) it reads naturally alongside `model:`/`generation:`. snake_cased to match the
  repo's YAML style.

### Precedence

`provider_options` (raw vendor) **>** `generation` (normalized) **>** Prisma defaults.
The escape hatch always wins, so an incorrect or lagging normalization is overridable
without a code change.

## Back-compat & migration (additive, non-breaking)

- All keys optional → absent = today's behavior, byte-for-byte.
- `model:` parsing: contains `/` → treat as `provider/name` slug; otherwise a bare
  model name resolved against the (legacy) `provider:` key or the default provider.
- Keep `provider:` working as a deprecated sibling; warn-and-ignore on conflict
  (consistent with the existing unknown-key policy in `config-loader/parse.ts`).
- Env defaults (`OPENAI_MODEL`, `OPENAI_TOKEN_PARAM`, `OPENAI_MAX_OUTPUT_TOKENS`)
  remain deployment-level defaults; repo config overrides them. `OPENAI_TOKEN_PARAM`
  becomes an ops-level escape hatch equivalent to a `provider_options.openai` override.

## Implementation sketch (on approval)

- `packages/shared/src/schemas/config.ts` — add `generation` + `provider_options`
  blocks; teach `model` to parse a slug; keep `provider`/`model` legacy path.
- `packages/shared/src/schemas/provider-interface.ts` — extend `request_shaping`
  with normalized `generation` + a raw `provider_options[provider]` bag.
- Adapters (`packages/providers/*`) — map `generation.*` to vendor fields (OpenAI
  already does `max_output_tokens` selection via `resolveTokenParam`); merge the raw
  `provider_options[self]` bag last (P5 precedence).
- `worker.ts` `buildConfigReply` — surface the resolved model slug + generation block.
- Docs: `config-spec.md` rewrite of the model section; migration note.

Suggested delivery: SPECTRA spec → vivi implementation, test-anchored, with the
eval suite run (the chunking-regression lesson).

## Sources

- Vercel AI SDK — provider management / `providerOptions`: https://ai-sdk.dev/docs/ai-sdk-core/provider-management
- LiteLLM — proxy config (`model_list` / `litellm_params`): https://docs.litellm.ai/docs/proxy/config_settings
- OpenRouter provider for Vercel AI SDK: https://github.com/OpenRouterTeam/ai-sdk-provider
- Rasa — provider-agnostic LLM configuration: https://rasa.com/docs/reference/config/components/llm-configuration/
- Aider — multi-provider LLM integration (via LiteLLM): https://deepwiki.com/Aider-AI/aider/6.3-multi-provider-llm-integration
