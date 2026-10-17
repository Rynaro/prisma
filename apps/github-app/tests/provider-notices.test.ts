import { describe, expect, it } from 'vitest';
import {
  capabilityRemedyNotice,
  declinedFilesNote,
  isRefusalError,
  reasoningModelNoFindingsNotice,
  refusalCategoryFromMessage,
  refusalNotice,
  withCapabilityRemedy,
} from '../src/provider-notices.js';

/**
 * Issue #40 § "the capability notice points at the remedy for this exact
 * rejection": when the provider's 400 says function tools are unsupported on
 * `/chat/completions`, the operator must be told about `OPENAI_API_STYLE`,
 * and must NOT be pointed at `reasoning_effort: 'none'` as the primary fix.
 */
const INCIDENT_MESSAGE =
  "Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";

/** Research digest § 13, verbatim (ADR-008 D11). */
const GPT6_CHAT_TOOLS_MESSAGE =
  "Function tools with reasoning_effort are not supported for gpt-6-astra in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";
const CHAT_EFFORT_NONE_MESSAGE =
  "Unsupported value: 'reasoning_effort' does not support 'none' with this model. Supported values are: 'low', 'medium', 'high', and 'xhigh'.";
const RESPONSES_EFFORT_NONE_MESSAGE =
  "Unsupported value: 'none' is not supported with the 'gpt-6-astra' model. Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'.";
const TEMPERATURE_MESSAGE =
  "Unsupported parameter: 'temperature' is not supported with this model.";

describe('capabilityRemedyNotice', () => {
  it('returns the OPENAI_API_STYLE remedy for the issue #40 rejection', () => {
    const remedy = capabilityRemedyNotice(INCIDENT_MESSAGE);
    expect(remedy).toBeDefined();
    expect(remedy).toContain('OPENAI_API_STYLE=responses');
    expect(remedy).toContain('auto');
  });

  it('does not offer reasoning_effort none as the primary fix', () => {
    const remedy = capabilityRemedyNotice(INCIDENT_MESSAGE) ?? '';
    // The phrase may appear only as an explicit warning against it.
    expect(remedy).toContain("Do not use `reasoning_effort: 'none'`");
    expect(remedy).toContain('docs/model-compatibility.md');
  });

  it('matches a reworded rejection naming a different model', () => {
    expect(
      capabilityRemedyNotice(
        'function tools are not supported for gpt-5.5 in /v1/chat/completions.',
      ),
    ).toBeDefined();
  });

  it('returns undefined for an unrelated capability message', () => {
    expect(capabilityRemedyNotice('The model `gpt-9` does not exist')).toBeUndefined();
    expect(
      capabilityRemedyNotice("This model's maximum context length is 128000 tokens"),
    ).toBeUndefined();
  });
});

describe('capabilityRemedyNotice — param / code meta (ADR-008 D11)', () => {
  it('keeps the OPENAI_API_STYLE remedy first for the chat+tools rejection even with param reasoning_effort', () => {
    const remedy = capabilityRemedyNotice(GPT6_CHAT_TOOLS_MESSAGE, { param: 'reasoning_effort' });
    expect(remedy).toContain('OPENAI_API_STYLE=responses');
    expect(remedy).not.toContain('does not support the configured reasoning effort');
  });

  it('returns the effort remedy for an unsupported_value on the reasoning effort', () => {
    const remedy = capabilityRemedyNotice(CHAT_EFFORT_NONE_MESSAGE, {
      param: 'reasoning_effort',
      code: 'unsupported_value',
    });
    expect(remedy).toContain('does not support the configured reasoning effort');
    expect(remedy).toContain('gpt-6-astra');
    expect(remedy).toContain('provider_options.openai.reasoning_effort');
    // The /responses spelling, without a code, is matched on the message.
    expect(
      capabilityRemedyNotice(RESPONSES_EFFORT_NONE_MESSAGE, { param: 'reasoning.effort' }),
    ).toBe(remedy);
    // An effort param with neither the code nor the wording gets no remedy.
    expect(
      capabilityRemedyNotice('reasoning is not available', { param: 'reasoning_effort' }),
    ).toBeUndefined();
  });

  it('returns the sampling remedy naming generation for param temperature', () => {
    const remedy = capabilityRemedyNotice(TEMPERATURE_MESSAGE, { param: 'temperature' });
    expect(remedy).toContain('rejects `temperature`');
    expect(remedy).toContain('`generation`');
    expect(remedy).toContain('.github/review-bot.yml');
    expect(capabilityRemedyNotice('rejected', { param: 'top_p' })).toContain('rejects `top_p`');
  });

  it('returns the seed remedy for param seed', () => {
    const remedy = capabilityRemedyNotice('rejected', { param: 'seed' });
    expect(remedy).toContain('rejects `seed`');
    expect(remedy).toContain('generation.seed');
  });

  it('returns the OPENAI_TOKEN_PARAM remedy for param max_tokens', () => {
    const remedy = capabilityRemedyNotice(
      "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      { param: 'max_tokens' },
    );
    expect(remedy).toContain('OPENAI_TOKEN_PARAM');
    expect(remedy).toContain('max_completion_tokens');
  });

  it('returns undefined for a param without a documented remedy', () => {
    expect(
      capabilityRemedyNotice('bad request', { param: 'store', code: 'unsupported_parameter' }),
    ).toBeUndefined();
    expect(capabilityRemedyNotice('bad request', { param: 'reasoning' })).toBeUndefined();
    // Never resolves an inherited property as a remedy.
    expect(capabilityRemedyNotice('bad request', { param: 'constructor' })).toBeUndefined();
  });
});

describe('withCapabilityRemedy', () => {
  it('appends the remedy to the rendered capability notice', () => {
    const base = '⚠️ Review unavailable — the AI provider rejected the request.';
    const out = withCapabilityRemedy(base, INCIDENT_MESSAGE);
    expect(out.startsWith(base)).toBe(true);
    expect(out).toContain('OPENAI_API_STYLE=responses');
  });

  it('leaves the notice untouched when no documented remedy applies', () => {
    const base = '⚠️ Review unavailable — the AI provider rejected the request.';
    expect(withCapabilityRemedy(base, 'The model `gpt-9` does not exist')).toBe(base);
  });

  it('passes param/code meta through', () => {
    const base = '⚠️ Review unavailable — the AI provider rejected the request.';
    const out = withCapabilityRemedy(base, TEMPERATURE_MESSAGE, {
      param: 'temperature',
      code: undefined,
    });
    expect(out.startsWith(`${base} Remedy:`)).toBe(true);
    expect(out).toContain('rejects `temperature`');
    // Without meta the same message keeps the generic notice.
    expect(withCapabilityRemedy(base, TEMPERATURE_MESSAGE)).toBe(base);
  });
});

describe('reasoningModelNoFindingsNotice', () => {
  it('names the model, the provider.usage event and the output-cap knob, never gpt-4.1', () => {
    const notice = reasoningModelNoFindingsNotice('gpt-6-astra');
    expect(notice).toContain('`gpt-6-astra` is a reasoning model');
    expect(notice).toContain('provider.usage');
    expect(notice).toContain('reasoning_tokens');
    expect(notice).toContain('OPENAI_MAX_OUTPUT_TOKENS');
    expect(notice).toContain('docs/model-compatibility.md');
    expect(notice).not.toContain('gpt-4.1');
  });

  it('carries no leading emoji (call sites add their own prefix)', () => {
    expect(reasoningModelNoFindingsNotice('o3').startsWith('`o3`')).toBe(true);
  });
});

describe('capabilityRemedyNotice — Anthropic (ADR-009 D10)', () => {
  const meta = (code?: string) => ({ provider: 'anthropic', ...(code ? { code } : {}) });
  const TOOL_CHOICE_400 = 'tool_choice: type "tool" and "any" are not supported for this model.';
  const THINKING_400 =
    '"thinking.type.disabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.';
  const EFFORT_400 =
    "output_config.effort 'xhigh' is not supported when thinking is disabled on this model. Use effort 'high' or below, or enable thinking.";
  const ROLE_400 = "role 'system' is not supported on this model";
  const TOO_LONG_400 = 'prompt is too long: 1048576 tokens > 1000000 maximum';
  const CREDIT_400 = 'Your credit balance is too low to access the Anthropic API.';

  it('a not_found_error names ANTHROPIC_MODEL and claude-sonnet-5-5', () => {
    const remedy = capabilityRemedyNotice(
      'model: claude-3-5-sonnet-latest',
      meta('not_found_error'),
    );
    expect(remedy).toContain('ANTHROPIC_MODEL');
    expect(remedy).toContain('claude-sonnet-5-5');
    expect(remedy?.startsWith('Remedy:')).toBe(true);
  });

  it('a forced tool_choice 400 names ANTHROPIC_TOOL_CHOICE=unforced', () => {
    expect(capabilityRemedyNotice(TOOL_CHOICE_400, meta('invalid_request_error'))).toContain(
      'ANTHROPIC_TOOL_CHOICE=unforced',
    );
  });

  it('the thinking.type 400 gets the thinking remedy, not the effort one', () => {
    const remedy = capabilityRemedyNotice(THINKING_400, meta('invalid_request_error'));
    expect(remedy).toContain('remove `provider_options.anthropic.thinking`');
    expect(remedy).not.toContain('does not support the configured `effort`');
  });

  it('the effort 400 gets the effort remedy', () => {
    expect(capabilityRemedyNotice(EFFORT_400, meta('invalid_request_error'))).toContain(
      'does not support the configured `effort`',
    );
  });

  it('a sampling 400 gets the sampling remedy', () => {
    expect(
      capabilityRemedyNotice('temperature: Input should be 1', meta('invalid_request_error')),
    ).toContain('remove `temperature` / `top_p` / `top_k`');
  });

  it('prompt is too long gets the budget remedy', () => {
    expect(capabilityRemedyNotice(TOO_LONG_400, meta('invalid_request_error'))).toContain(
      'MAX_TOKENS_PER_PR',
    );
  });

  it('role/system and credit-balance 400s get no remedy (generic notice stands)', () => {
    expect(capabilityRemedyNotice(ROLE_400, meta('invalid_request_error'))).toBeUndefined();
    expect(capabilityRemedyNotice(CREDIT_400, meta('invalid_request_error'))).toBeUndefined();
  });

  it('negatives: other providers and OpenAI remedies are unaffected', () => {
    expect(capabilityRemedyNotice(TOOL_CHOICE_400, { provider: 'openai' })).toBeUndefined();
    const incident = capabilityRemedyNotice(INCIDENT_MESSAGE);
    expect(capabilityRemedyNotice(INCIDENT_MESSAGE, { provider: 'anthropic' })).not.toBe(incident);
    expect(capabilityRemedyNotice(INCIDENT_MESSAGE, { provider: 'anthropic' })).toBeUndefined();
    expect(capabilityRemedyNotice(INCIDENT_MESSAGE, { provider: 'openai' })).toBe(incident);
    expect(
      capabilityRemedyNotice('model: x', { provider: 'anthropic', code: 'not_found_error' }),
    ).not.toContain('OPENAI_');
  });
});

describe('refusal notices (ADR-009 D8)', () => {
  it('refusalCategoryFromMessage extracts the category, else none', () => {
    expect(
      refusalCategoryFromMessage(
        'anthropic declined the request: stop_reason refusal (category: cyber)',
      ),
    ).toBe('cyber');
    expect(refusalCategoryFromMessage('malformed output')).toBe('none');
  });

  it('isRefusalError keys on schema_validation + code refusal', () => {
    expect(isRefusalError({ kind: 'schema_validation', code: 'refusal', message: 'x' })).toBe(true);
    expect(isRefusalError({ kind: 'schema_validation', message: 'x' })).toBe(false);
    expect(isRefusalError({ kind: 'auth', message: 'x' })).toBe(false);
  });

  it('refusalNotice names the classifier, the category, and says it is not a config error', () => {
    const notice = refusalNotice(['cyber']);
    expect(notice).toContain('safety classifier');
    expect(notice).toContain('`cyber`');
    expect(notice).toContain('not a configuration error');
    expect(notice).toContain('`review` command');
    expect(refusalNotice([])).toContain('`none`');
  });

  it('declinedFilesNote starts with a space and lists the paths', () => {
    const note = declinedFilesNote(['a.ts', 'b.ts'], ['cyber']);
    expect(note.startsWith(' ')).toBe(true);
    expect(note).toContain('a.ts, b.ts');
    expect(note).toContain('`cyber`');
    expect(note).not.toContain('max_provider_calls_per_pr');
  });
});

describe('reasoningModelNoFindingsNotice — Claude (ADR-009 D12)', () => {
  it('Claude 5.x gets the adaptive-thinking text', () => {
    const notice = reasoningModelNoFindingsNotice('claude-sonnet-5-5');
    for (const needle of [
      'adaptive thinking',
      'provider.usage',
      'output_tokens',
      'ANTHROPIC_TOOL_CHOICE=forced',
      'provider_options.anthropic.effort',
      'docs/model-compatibility.md',
    ]) {
      expect(notice).toContain(needle);
    }
    expect(notice).not.toContain('reasoning_tokens');
    expect(notice).not.toContain('OPENAI_');
  });

  it('the OpenAI text is byte-identical', () => {
    expect(reasoningModelNoFindingsNotice('gpt-6-astra')).toBe(
      "`gpt-6-astra` is a reasoning model and reported no findings. If you expected some, check the `provider.usage` log event: `reasoning_tokens` near zero means the model skipped reasoning (do not set `reasoning_effort: 'none'`; unset `OPENAI_TOOL_CHOICE=forced`); a large count with an empty result usually means a tight output cap — raise `OPENAI_MAX_OUTPUT_TOKENS` (≥ 25,000 on GPT-6) or the effort. See docs/model-compatibility.md.",
    );
  });
});
