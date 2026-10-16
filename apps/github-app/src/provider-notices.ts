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
}

/**
 * Return the remedy sentence for a provider `capability` message, or
 * `undefined` when no specific remedy applies.
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
 * The empty-review notice for a reasoning-family model (`isReasoningModel`),
 * shared by the check-run summary (`pipeline/orchestrator.ts`, both the
 * single-call and chunked paths) and the `review` command reply (`worker.ts`).
 *
 * Carries no leading emoji: the check-run call sites add their own prefix.
 * Points at the `provider.usage` telemetry rather than at another model:
 * near-zero `reasoning_tokens` means skipped reasoning, a large count with no
 * findings means a tight output cap (ADR-008 D10).
 */
export function reasoningModelNoFindingsNotice(model: string): string {
  return `\`${model}\` is a reasoning model and reported no findings. If you expected some, check the \`provider.usage\` log event: \`reasoning_tokens\` near zero means the model skipped reasoning (do not set \`reasoning_effort: 'none'\`; unset \`OPENAI_TOOL_CHOICE=forced\`); a large count with an empty result usually means a tight output cap — raise \`OPENAI_MAX_OUTPUT_TOKENS\` (≥ 25,000 on GPT-6) or the effort. See docs/model-compatibility.md.`;
}
