/**
 * `provider-notices.ts` — operator-facing remedy text appended to a
 * `capability` provider error when the error message identifies a rejection
 * this deployment has a specific, documented remedy for.
 *
 * Shared by the two places that render the "Review unavailable" notice:
 * `pipeline/orchestrator.ts` (check-run summary) and `worker.ts` (the comment
 * reply on the `ask` path). Both must say the same thing, so the text lives
 * once, here.
 *
 * The input is `ProviderError.message` — already the safe, secret-scrubbed
 * string each adapter's `map*Error` produced. Nothing here logs, and nothing
 * here reads configuration.
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
 * Return the remedy sentence for a provider `capability` message, or
 * `undefined` when no specific remedy applies.
 *
 * Exported for direct unit-testing.
 */
export function capabilityRemedyNotice(message: string): string | undefined {
  if (FUNCTION_TOOLS_ON_CHAT_RE.test(message) && CHAT_COMPLETIONS_RE.test(message)) {
    return RESPONSES_REMEDY;
  }
  return undefined;
}

/**
 * Append the remedy to an already-rendered capability notice, when one applies.
 * A no-op for every other capability failure, so the generic notice is
 * unchanged where no documented remedy exists.
 */
export function withCapabilityRemedy(notice: string, message: string): string {
  const remedy = capabilityRemedyNotice(message);
  return remedy === undefined ? notice : `${notice} ${remedy}`;
}
