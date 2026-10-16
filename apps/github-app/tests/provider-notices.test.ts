import { describe, expect, it } from 'vitest';
import {
  OPENAI_DEFAULT_MODEL_REPLACEMENT,
  OPENAI_DEFAULT_MODEL_SHUTDOWN,
  OPENAI_DEFAULT_MODEL_WARNING,
  capabilityRemedyNotice,
  reasoningModelNoFindingsNotice,
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

describe('OPENAI_DEFAULT_MODEL_WARNING', () => {
  it('names the shutdown date, the replacement and OPENAI_MODEL', () => {
    expect(OPENAI_DEFAULT_MODEL_WARNING).toContain('2027-01-14');
    expect(OPENAI_DEFAULT_MODEL_WARNING).toContain('gpt-6-luna');
    expect(OPENAI_DEFAULT_MODEL_WARNING).toContain('OPENAI_MODEL');
    expect(OPENAI_DEFAULT_MODEL_WARNING).toContain('`gpt-4o`');
  });

  it('is built from the exported shutdown date and replacement, byte for byte', () => {
    expect(OPENAI_DEFAULT_MODEL_SHUTDOWN).toBe('2027-01-14');
    expect(OPENAI_DEFAULT_MODEL_REPLACEMENT).toBe('gpt-6-luna');
    expect(OPENAI_DEFAULT_MODEL_WARNING).toBe(
      'OPENAI_MODEL is unset; the default `gpt-4o` resolves to a snapshot scheduled for shutdown on 2027-01-14 (replacement: `gpt-6-luna`). Set OPENAI_MODEL explicitly before then; see docs/model-compatibility.md.',
    );
  });
});
