import type { ProviderReviewInput } from '@prisma-bot/shared';

/**
 * `PromptShape` — the pure-data envelope `buildPrompt` produces. The OpenAI
 * adapter hands this to the OpenAI-compatible `/chat/completions` surface.
 * No vendor SDK type leaks from this module.
 *
 * Differences from the Anthropic envelope (`packages/providers/anthropic/src/prompt.ts`):
 *   - Anthropic places system content in a top-level `system` field; OpenAI-compatible
 *     APIs deliver it as the first message with `role: 'system'`.
 *   - Tool declaration uses the OpenAI shape `{ type: 'function', function: { name,
 *     description, parameters } }` rather than Anthropic's `{ name, description,
 *     input_schema }`.
 *
 * The user-message rendering (file/hunk listing + repo heuristics) is byte-identical
 * to Anthropic's so prompt-equivalence comparisons across vendors stay clean.
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

const SYSTEM_PROMPT = [
  'You are a precise code reviewer.',
  'You will be shown a normalized diff snapshot: a list of files, each with one or more hunks.',
  'Return findings ONLY by calling the `submit_review_findings` tool.',
  'Rules:',
  '- Only report issues you can verify from the supplied hunks. Do not invent code.',
  '- Each finding must reference a real `path` from the input and a `line` inside one of its hunks.',
  '- Categories are limited to: security, correctness, performance, tests, style, migration, dependency.',
  '- Severities are limited to: info, low, medium, high, critical.',
  '- `confidence` is a number between 0 and 1.',
  '- If you have no verifiable findings, still call the tool with `findings: []`.',
].join('\n');

const TOOL_DESCRIPTION = [
  'Submit your review findings as a structured array.',
  'Always call this tool exactly once. If you have nothing to flag, pass an empty array.',
].join(' ');

const FINDING_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'line', 'severity', 'category', 'message', 'rationale', 'confidence'],
  properties: {
    path: { type: 'string', minLength: 1 },
    line: { type: 'integer', minimum: 1 },
    severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] },
    category: {
      type: 'string',
      enum: ['security', 'correctness', 'performance', 'tests', 'style', 'migration', 'dependency'],
    },
    message: { type: 'string', minLength: 1 },
    rationale: { type: 'string', minLength: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    suggested_fix: { type: 'string', minLength: 1 },
  },
};

const TOOL_PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: FINDING_JSON_SCHEMA,
    },
  },
};

function renderUserMessage(input: ProviderReviewInput): string {
  const lines: string[] = [];
  lines.push('## Files');
  for (const file of input.files) {
    const lang = file.language ? ` (lang: ${file.language})` : '';
    lines.push(`- ${file.path}${lang}`);
    for (const hunk of file.hunks) {
      lines.push(`  - hunk ${hunk.id} L${hunk.line_start}-L${hunk.line_end}:`);
      const indented = hunk.content
        .split('\n')
        .map((line) => `      ${line}`)
        .join('\n');
      lines.push(indented);
    }
  }
  const heuristics = input.repo_heuristics ?? {};
  const heuristicKeys = Object.keys(heuristics);
  lines.push('');
  lines.push('## Repo heuristics');
  if (heuristicKeys.length === 0) {
    lines.push('(none)');
  } else {
    for (const key of heuristicKeys) {
      lines.push(`- ${key}: ${heuristics[key] ? 'true' : 'false'}`);
    }
  }
  lines.push('');
  lines.push('Review the diff and call `submit_review_findings` with your findings.');
  return lines.join('\n');
}

export function buildPrompt(input: ProviderReviewInput): PromptShape {
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: renderUserMessage(input) },
    ],
    tool: {
      type: 'function',
      function: {
        name: 'submit_review_findings',
        description: TOOL_DESCRIPTION,
        parameters: TOOL_PARAMETERS_SCHEMA,
      },
    },
    tool_choice: { type: 'function', function: { name: 'submit_review_findings' } },
  };
}
