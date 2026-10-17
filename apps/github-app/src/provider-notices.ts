/**
 * `provider-notices.ts` — operator-facing remedy text appended to a
 * `capability` provider error when the error message identifies a rejection
 * this deployment has a specific, documented remedy for.
 *
 * Shared by the two places that render the "Review unavailable" notice:
 * `pipeline/orchestrator.ts` (check-run summary) and `worker.ts` (the comment
 * reply on the `ask` path). Both must say the same thing, so the text lives
 * once, here. The same applies to the reasoning-model empty-review notice
 * (`reasoningModelNoFindingsNotice`).
 *
 * The input is `ProviderError.message` — already the safe, secret-scrubbed
 * string each adapter's `map*Error` produced — plus the optional `param` /
 * `code` the adapter copied from the vendor payload (ADR-008 D11). Nothing
 * here logs, and nothing here reads configuration.
 */

import { isClaudeAdaptiveThinkingModel } from '@prisma-bot/shared';
import type { ProviderError } from '@prisma-bot/shared';

/**
 * The gpt-5.4+/gpt-5.6 rejection from issue #40, in the API's own words:
 *
 *   "Function tools with reasoning_effort are not supported for gpt-5.6-luna
 *    in /v1/chat/completions. To use function tools, use /v1/responses or set
 *    reasoning_effort to 'none'."
 *
 * Matched on the two invariant parts — a function-tool complaint naming the
 * chat-completions endpoint — rather than on the full sentence, so a reworded
 * message or a different model name still resolves. Deliberately narrow: a
 * capability error that is genuinely about model availability must NOT collect
 * an endpoint-routing suggestion.
 */
const FUNCTION_TOOLS_ON_CHAT_RE = /function tool/i;
const CHAT_COMPLETIONS_RE = /chat\/completions/i;

/**
 * The remedy for the above. Names `OPENAI_API_STYLE` in both directions
 * (`responses` to pin, unset for `auto`) and explicitly does not offer
 * `reasoning_effort: 'none'` as the primary fix: it clears the rejection and
 * then degrades the review output instead of failing visibly
 * (docs/model-compatibility.md).
 */
const RESPONSES_REMEDY =
  'Remedy: this model rejects function tools on `/v1/chat/completions`. ' +
  'Unset `OPENAI_API_STYLE` to let `auto` route reasoning models to `/v1/responses`, ' +
  'or set `OPENAI_API_STYLE=responses` to route every model there. ' +
  "Do not use `reasoning_effort: 'none'` as the fix — it clears the rejection and degrades " +
  'the review instead of failing visibly. See `docs/model-compatibility.md`.';

/**
 * The `param` values a reasoning-effort rejection carries: `reasoning_effort`
 * on `/chat/completions`, `reasoning.effort` on `/responses`.
 */
const EFFORT_PARAMS: ReadonlySet<string> = new Set(['reasoning_effort', 'reasoning.effort']);

/**
 * Matches the effort rejection when the vendor omits `code`, in the API's own
 * words (research digest § 13):
 *
 *   "Unsupported value: 'none' is not supported with the 'gpt-6-astra' model.
 *    Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'."
 */
const UNSUPPORTED_VALUE_RE = /^unsupported value/i;

/**
 * The remedy for an unsupported reasoning effort. Prisma forwards the effort
 * verbatim (ADR-008 D3), so the operator changes the config; the provider
 * message already lists the values this model accepts.
 */
const EFFORT_REMEDY =
  'Remedy: this model does not support the configured reasoning effort; the provider message lists the supported values. ' +
  '`none` is rejected by `gpt-6-astra` and `gpt-6.1-sol`; `minimal` by every GPT-6 model. ' +
  'Change `provider_options.openai.reasoning_effort` (or `reasoning.effort`). ' +
  'See `docs/model-compatibility.md` § Reasoning effort × model.';

const samplingRemedy = (param: string): string =>
  `Remedy: this model rejects \`${param}\` at its reasoning effort. Remove it from \`generation\` / \`provider_options.openai\` in \`.github/review-bot.yml\`. See \`docs/model-compatibility.md\` § Sampling parameters.`;

/**
 * Remedies keyed by the rejected request field (`ProviderError.param`). A
 * `Map`, not an object literal, so a gateway `param` such as `constructor`
 * can never resolve to an inherited property. A `param` outside this table
 * (e.g. `store`, `reasoning`) gets the generic notice, never a wrong remedy.
 */
const UNSUPPORTED_PARAM_REMEDY: ReadonlyMap<string, string> = new Map([
  ['temperature', samplingRemedy('temperature')],
  ['top_p', samplingRemedy('top_p')],
  ['top_logprobs', samplingRemedy('top_logprobs')],
  ['logprobs', samplingRemedy('logprobs')],
  ['seed', 'Remedy: this model rejects `seed`. Remove `generation.seed` for this model.'],
  [
    'max_tokens',
    'Remedy: this model requires `max_completion_tokens`. Unset `OPENAI_TOKEN_PARAM` (auto) or set it to `max_completion_tokens`.',
  ],
]);

/**
 * Structured fields of a `capability` `ProviderError` that select a remedy.
 * Both optional: adapters that do not carry them, and the existing
 * one-argument calls, fall back to message matching alone.
 */
export interface CapabilityErrorMeta {
  param?: string | undefined;
  code?: string | undefined;
  /**
   * The active adapter's `Provider.name`. `'anthropic'` routes to the
   * Anthropic remedy table (ADR-009 D10); anything else (`openai`, `copilot`,
   * `fake`, absent) keeps the OpenAI-specific matching byte-identical.
   */
  provider?: string | undefined;
}

/**
 * Anthropic remedies (ADR-009 D10), first match wins. Every text starts with
 * `Remedy:` like the OpenAI ones. These regexes only select notice text; they
 * decide no routing (ADR-009 G-2).
 */
const ANTHROPIC_NOT_FOUND_REMEDY =
  'Remedy: the configured Claude model ID was not found — it is retired or misspelled (`claude-3-5-sonnet-latest` and every Claude 3.x ID are retired). Set `ANTHROPIC_MODEL`, or `model: anthropic/<id>` in `.github/review-bot.yml`, for example `claude-sonnet-5-5`. See `docs/model-compatibility.md` § Anthropic.';
const ANTHROPIC_TOOL_CHOICE_REMEDY =
  'Remedy: this model rejects forced tool choice. Prisma sends `tool_choice: auto` to Claude 5.x model IDs automatically; for an alias or gateway name in front of a Claude 5.x model, set `ANTHROPIC_TOOL_CHOICE=unforced` (and `ANTHROPIC_MAX_OUTPUT_TOKENS=16384`), and unset `ANTHROPIC_TOOL_CHOICE=forced` if it is set.';
const ANTHROPIC_THINKING_REMEDY =
  'Remedy: remove `provider_options.anthropic.thinking`. Claude 5.x thinks adaptively; use `provider_options.anthropic.effort` to control depth.';
const ANTHROPIC_EFFORT_REMEDY =
  'Remedy: this model does not support the configured `effort`. Claude 5.x accepts `low`, `medium`, `high`, `xhigh` or `max`; Claude 4.6 models have no `xhigh`; Haiku 4.5 and Sonnet 4.5 accept no effort. Change or remove `provider_options.anthropic.effort` (or `output_config.effort`). See `docs/model-compatibility.md` § Anthropic.';
const ANTHROPIC_SAMPLING_REMEDY =
  'Remedy: remove `temperature` / `top_p` / `top_k` from `provider_options.anthropic`; Claude 5.x rejects them (Sonnet 5.5 and Haiku 5.5 accept only the defaults).';
const ANTHROPIC_BUDGET_REMEDY =
  "Remedy: the request exceeded the model's context window. Lower `MAX_TOKENS_PER_PR` or `chunking.call_token_budget`.";

const ANTHROPIC_TOOL_CHOICE_RE = /tool_choice/i;
const ANTHROPIC_NOT_SUPPORTED_RE = /not supported/i;
const ANTHROPIC_THINKING_RE = /thinking\.type/i;
const ANTHROPIC_EFFORT_RE = /output_config\.effort|\beffort\b/i;
const ANTHROPIC_SAMPLING_RE = /\b(?:temperature|top_p|top_k)\b/i;
const ANTHROPIC_PROMPT_TOO_LONG_RE = /prompt is too long/i;

function anthropicRemedy(message: string, code: string | undefined): string | undefined {
  if (code === 'not_found_error') return ANTHROPIC_NOT_FOUND_REMEDY;
  if (ANTHROPIC_TOOL_CHOICE_RE.test(message) && ANTHROPIC_NOT_SUPPORTED_RE.test(message)) {
    return ANTHROPIC_TOOL_CHOICE_REMEDY;
  }
  if (ANTHROPIC_THINKING_RE.test(message)) return ANTHROPIC_THINKING_REMEDY;
  if (ANTHROPIC_EFFORT_RE.test(message)) return ANTHROPIC_EFFORT_REMEDY;
  if (ANTHROPIC_SAMPLING_RE.test(message)) return ANTHROPIC_SAMPLING_REMEDY;
  if (ANTHROPIC_PROMPT_TOO_LONG_RE.test(message)) return ANTHROPIC_BUDGET_REMEDY;
  return undefined;
}

/**
 * Return the remedy sentence for a provider `capability` message, or
 * `undefined` when no specific remedy applies.
 *
 * When `meta.provider === 'anthropic'` the Anthropic table applies instead
 * (ADR-009 D10; never an OpenAI remedy for an Anthropic error).
 *
 * Precedence (ADR-008 D11):
 *   1. function tools rejected on `/chat/completions` → `OPENAI_API_STYLE`
 *      remedy. Evaluated first: that rejection also carries
 *      `param: 'reasoning_effort'` (with `code: null`), and must not collect
 *      the effort remedy.
 *   2. `param` is the reasoning effort AND (`code === 'unsupported_value'` or
 *      the message opens with "Unsupported value") → effort remedy.
 *   3. `param` has an entry in `UNSUPPORTED_PARAM_REMEDY` → that remedy.
 *   4. otherwise `undefined` (the generic notice stands).
 *
 * Exported for direct unit-testing.
 */
export function capabilityRemedyNotice(
  message: string,
  meta?: CapabilityErrorMeta,
): string | undefined {
  if (meta?.provider === 'anthropic') {
    return anthropicRemedy(message, meta.code);
  }
  if (FUNCTION_TOOLS_ON_CHAT_RE.test(message) && CHAT_COMPLETIONS_RE.test(message)) {
    return RESPONSES_REMEDY;
  }
  const param = meta?.param;
  if (param === undefined) {
    return undefined;
  }
  if (
    EFFORT_PARAMS.has(param) &&
    (meta?.code === 'unsupported_value' || UNSUPPORTED_VALUE_RE.test(message))
  ) {
    return EFFORT_REMEDY;
  }
  return UNSUPPORTED_PARAM_REMEDY.get(param);
}

/**
 * Append the remedy to an already-rendered capability notice, when one applies.
 * A no-op for every other capability failure, so the generic notice is
 * unchanged where no documented remedy exists.
 */
export function withCapabilityRemedy(
  notice: string,
  message: string,
  meta?: CapabilityErrorMeta,
): string {
  const remedy = capabilityRemedyNotice(message, meta);
  return remedy === undefined ? notice : `${notice} ${remedy}`;
}

/**
 * The empty-review notice for a thinking-before-answering model, shared by the
 * check-run summary (`pipeline/orchestrator.ts`, both the single-call and
 * chunked paths) and the `review` command reply (`worker.ts`).
 *
 * Dispatches on the model family: Claude 5.x+ (`isClaudeAdaptiveThinkingModel`)
 * gets the adaptive-thinking text (ADR-009 D12); everything else keeps the
 * OpenAI reasoning-model text byte-identical (eval fixtures assert its
 * substrings).
 *
 * Carries no leading emoji: the check-run call sites add their own prefix.
 * Points at the `provider.usage` telemetry rather than at another model:
 * near-zero `reasoning_tokens` (OpenAI) / `output_tokens` (Claude) means
 * skipped thinking, a large count with no findings means a tight output cap
 * (ADR-008 D10).
 */
export function reasoningModelNoFindingsNotice(model: string): string {
  if (isClaudeAdaptiveThinkingModel(model)) {
    return `\`${model}\` thinks before answering (adaptive thinking) and reported no findings. If you expected some, check the \`provider.usage\` log event: \`output_tokens\` in the low tens means the model answered without thinking — unset \`ANTHROPIC_TOOL_CHOICE=forced\` if set; otherwise raise \`provider_options.anthropic.effort\` (Opus 5.5 and Haiku 5.5 default to \`medium\`). See docs/model-compatibility.md § Anthropic.`;
  }
  return `\`${model}\` is a reasoning model and reported no findings. If you expected some, check the \`provider.usage\` log event: \`reasoning_tokens\` near zero means the model skipped reasoning (do not set \`reasoning_effort: 'none'\`; unset \`OPENAI_TOOL_CHOICE=forced\`); a large count with an empty result usually means a tight output cap — raise \`OPENAI_MAX_OUTPUT_TOKENS\` (≥ 25,000 on GPT-6) or the effort. See docs/model-compatibility.md.`;
}

// ---------------------------------------------------------------------------
// Refusals (ADR-009 D8)
// ---------------------------------------------------------------------------

const REFUSAL_CATEGORY_IN_MESSAGE_RE = /\(category: ([a-z0-9_]+)\)/;

/** `true` for the adapter's refusal error (`schema_validation` + `code: 'refusal'`). */
export function isRefusalError(value: ProviderError): boolean {
  return value.kind === 'schema_validation' && value.code === 'refusal';
}

/** The sanitized category from the adapter's refusal message, else `none`. */
export function refusalCategoryFromMessage(message: string): string {
  const m = REFUSAL_CATEGORY_IN_MESSAGE_RE.exec(message);
  return m?.[1] ?? 'none';
}

const renderCategories = (categories: readonly string[]): string =>
  categories.length > 0 ? categories.map((c) => `\`${c}\``).join(', ') : '`none`';

/**
 * Check-run / reply notice when the provider's safety classifier declined the
 * review. Says "the bot's `review` command" (no bot handle reaches here; R2).
 */
export function refusalNotice(categories: readonly string[]): string {
  return `⚠️ Review unavailable — the provider's safety classifier declined to review this diff (category: ${renderCategories(categories)}). This is not a configuration error; it can happen on security-related code. Re-run the review with the bot's \`review\` command, or pin a different model for this repository with \`model:\` in \`.github/review-bot.yml\`.`;
}

/**
 * Note for the files of a declined chunked batch (R3). Leading space, like the
 * sibling "not reviewed" notes; deliberately does not name the call budget.
 */
export function declinedFilesNote(paths: readonly string[], categories: readonly string[]): string {
  return ` Not reviewed (the provider's safety classifier declined this section; category: ${renderCategories(categories)}): ${paths.join(', ')}. This is not a configuration error; re-run the review or pin a different model with \`model:\` in \`.github/review-bot.yml\`.`;
}
