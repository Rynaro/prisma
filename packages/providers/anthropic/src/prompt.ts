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

/**
 * Keywords the Anthropic strict-tool grammar accepts that Prisma's shared tool
 * schema uses (ADR-009 D2). Everything else is dropped from the wire copy; Zod
 * (`ProviderReviewOutputSchema`) stays authoritative.
 */
export const ANTHROPIC_STRICT_SCHEMA_KEYWORDS = [
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'description',
] as const;

const STRICT_KEYWORDS: ReadonlySet<string> = new Set(ANTHROPIC_STRICT_SCHEMA_KEYWORDS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strictNode(node: unknown): unknown {
  if (!isPlainObject(node)) {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!STRICT_KEYWORDS.has(key)) {
      continue;
    }
    if (key === 'properties' && isPlainObject(value)) {
      const props: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value)) {
        props[name] = strictNode(child);
      }
      out[key] = props;
    } else if (key === 'items') {
      out[key] = strictNode(value);
    } else if (Array.isArray(value)) {
      out[key] = [...value];
    } else {
      out[key] = value;
    }
  }
  if (out.type === 'object') {
    // Kept in place when present, appended when absent (R4).
    out.additionalProperties = false;
  }
  return out;
}

/**
 * `toAnthropicStrictSchema` — build the strict-tool copy of a JSON schema
 * (ADR-009 D2). A recursive allowlist deep copy: only
 * `ANTHROPIC_STRICT_SCHEMA_KEYWORDS` survive (so `minLength`, `maxLength`,
 * `minimum`, `maximum`, `maxItems` are dropped), and every `type: 'object'`
 * node gets `additionalProperties: false`. The input is never mutated.
 */
export function toAnthropicStrictSchema(schema: object): object {
  return strictNode(schema) as object;
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
