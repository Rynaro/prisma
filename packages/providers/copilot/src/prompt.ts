import type { ProviderReviewInput } from '@prisma-bot/shared';
import {
  IMMUTABLE_SYSTEM_PROMPT,
  TOOL_DESCRIPTION,
  buildToolInputSchema,
  renderCustomGuidance,
  renderPositiveFeedback,
  renderUserMessage,
} from '@prisma-bot/shared';

/**
 * `PromptShape` — the pure-data envelope `buildPrompt` produces. The Copilot
 * adapter hands this to the OpenAI-compatible `/chat/completions` surface
 * exposed by GitHub Models. No vendor SDK type leaks from this module.
 *
 * Differences from the Anthropic envelope (`packages/providers/anthropic/src/prompt.ts`):
 *   - Anthropic places system content in a top-level `system` field; OpenAI-compatible
 *     APIs deliver it as the first message with `role: 'system'`.
 *   - Tool declaration uses the OpenAI shape `{ type: 'function', function: { name,
 *     description, parameters } }` rather than Anthropic's `{ name, description,
 *     input_schema }`.
 *
 * System prompt and user-message rendering are now shared via
 * `@prisma-bot/shared/prompt/review-prompt` (S5 extraction, D5).
 */
export interface PromptShape {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  tool: {
    type: 'function';
    function: {
      name: 'submit_review_findings';
      description: string;
      parameters: object;
    };
  };
  tool_choice: { type: 'function'; function: { name: 'submit_review_findings' } };
}

export function buildPrompt(input: ProviderReviewInput): PromptShape {
  const userMessage =
    renderUserMessage(input) +
    (renderCustomGuidance(input.custom_guidance) ?? '') +
    (renderPositiveFeedback(input.positive_feedback) ?? '');
  return {
    messages: [
      { role: 'system', content: IMMUTABLE_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    tool: {
      type: 'function',
      function: {
        name: 'submit_review_findings',
        description: TOOL_DESCRIPTION,
        parameters: buildToolInputSchema(input.positive_feedback),
      },
    },
    tool_choice: { type: 'function', function: { name: 'submit_review_findings' } },
  };
}
