import { describe, expect, it } from 'vitest';
import { capabilityRemedyNotice, withCapabilityRemedy } from '../src/provider-notices.js';

/**
 * Issue #40 § "the capability notice points at the remedy for this exact
 * rejection": when the provider's 400 says function tools are unsupported on
 * `/chat/completions`, the operator must be told about `OPENAI_API_STYLE`,
 * and must NOT be pointed at `reasoning_effort: 'none'` as the primary fix.
 */
const INCIDENT_MESSAGE =
  "Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";

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
});
