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
 * `PromptShape` — the pure-data envelope `buildPrompt` produces. The Anthropic
 * adapter passes this to `messages.create({...})` along with the tool
 * definition. No SDK type leaks from this module.
 *
 * The tool-use shape mirrors `ProviderReviewOutput` (an object with `findings:
 * Array<...>`); the adapter validates the tool-use input against
 * `ProviderReviewOutputSchema` at the boundary, so JSON Schema is informative
 * for the model and Zod is authoritative for the pipeline (api-contracts.md §
 * Invariants and error semantics, item 8).
 *
 * System prompt and user-message rendering are now shared via
 * `@prisma-bot/shared/prompt/review-prompt` (S5 extraction, D5).
 */
export interface PromptShape {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tool: {
    name: 'submit_review_findings';
    description: string;
    input_schema: object;
  };
}

export function buildPrompt(input: ProviderReviewInput): PromptShape {
  const userMessage =
    renderUserMessage(input) +
    (renderCustomGuidance(input.custom_guidance) ?? '') +
    (renderPositiveFeedback(input.positive_feedback) ?? '');
  return {
    system: IMMUTABLE_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: userMessage,
      },
    ],
    tool: {
      name: 'submit_review_findings',
      description: TOOL_DESCRIPTION,
      input_schema: buildToolInputSchema(input.positive_feedback),
    },
  };
}
