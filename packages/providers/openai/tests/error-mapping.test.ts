import { describe, expect, it } from 'vitest';
import { mapOpenAIError } from '../src/error-mapping.js';

describe('mapOpenAIError', () => {
  // T11: status table (401/403→auth, 429→rate_limit, 5xx→transport)
  it('maps a network error (no status, ECONNREFUSED) to transport with retryable: true', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
      code: 'ECONNREFUSED',
    });
    const mapped = mapOpenAIError(err);
    expect(mapped.kind).toBe('transport');
    expect(mapped.retryable).toBe(true);
  });

  it('maps a timeout error to transport with retryable: true', () => {
    const err = new Error('Request timed out after 30000ms');
    const mapped = mapOpenAIError(err);
    expect(mapped.kind).toBe('transport');
    expect(mapped.retryable).toBe(true);
  });

  it('maps HTTP 401 to auth', () => {
    const mapped = mapOpenAIError({ status: 401, message: 'invalid api key' });
    expect(mapped.kind).toBe('auth');
  });

  it('maps HTTP 403 to auth', () => {
    const mapped = mapOpenAIError({ status: 403, message: 'forbidden' });
    expect(mapped.kind).toBe('auth');
  });

  it('maps HTTP 429 to rate_limit and extracts numeric retry-after seconds to ms', () => {
    const mapped = mapOpenAIError({
      status: 429,
      message: 'too many requests',
      headers: { 'retry-after': '7' },
    });
    expect(mapped.kind).toBe('rate_limit');
    if (mapped.kind !== 'rate_limit') {
      throw new Error('unreachable');
    }
    expect(mapped.retry_after_ms).toBe(7000);
    expect(mapped.retryable).toBe(true);
  });

  it('maps HTTP 5xx to transport with retryable: true', () => {
    const mapped = mapOpenAIError({ status: 503, message: 'service unavailable' });
    expect(mapped.kind).toBe('transport');
    expect(mapped.retryable).toBe(true);
  });

  // T12: 400 context_length_exceeded → capability (GAP-001)
  it('maps HTTP 400 with error.code context_length_exceeded to capability', () => {
    const mapped = mapOpenAIError({
      status: 400,
      message: 'This model maximum context length is 128000 tokens',
      error: { code: 'context_length_exceeded' },
    });
    expect(mapped.kind).toBe('capability');
  });

  // T13: 400 model_not_found → capability (GAP-001)
  it('maps HTTP 400 with error.code model_not_found to capability', () => {
    const mapped = mapOpenAIError({
      status: 400,
      message: 'The model gpt-99 does not exist',
      error: { code: 'model_not_found' },
    });
    expect(mapped.kind).toBe('capability');
  });

  // T14: 429 insufficient_quota → rate_limit, not retryable (ADR-008 D11:
  // quota exhaustion does not clear by waiting).
  it('maps HTTP 429 insufficient_quota to rate_limit', () => {
    const mapped = mapOpenAIError({
      status: 429,
      message: 'You exceeded your current quota',
      error: { code: 'insufficient_quota' },
    });
    expect(mapped.kind).toBe('rate_limit');
    expect(mapped.retryable).toBe(false);
  });

  // T15: secret scrub
  it('never leaks Authorization / Bearer tokens into the mapped message', () => {
    const sensitive = {
      status: 500,
      message: 'request failed: Authorization: Bearer sk-secret_do_not_leak',
      headers: {
        authorization: 'Bearer sk-secret_do_not_leak',
      },
      request: {
        headers: { Authorization: 'Bearer sk-secret_do_not_leak' },
      },
    };
    const mapped = mapOpenAIError(sensitive);
    expect(mapped.kind).toBe('transport');
    expect(mapped.message.toLowerCase()).not.toContain('authorization');
    expect(mapped.message.toLowerCase()).not.toContain('bearer');
    expect(mapped.message).not.toContain('sk-secret_do_not_leak');
  });

  // T16: default branch parity with copilot — unknown 400 → transport retryable:false
  it('maps HTTP 400 with unrecognized error to transport with retryable: false (copilot parity)', () => {
    const mapped = mapOpenAIError({ status: 400, message: 'bad request without special code' });
    expect(mapped.kind).toBe('transport');
    expect(mapped.retryable).toBe(false);
  });

  it('maps anything else to transport with retryable: false', () => {
    const mapped = mapOpenAIError({ status: 418, message: "I'm a teapot" });
    expect(mapped.kind).toBe('transport');
    expect(mapped.retryable).toBe(false);
  });

  it('maps HTTP 400 with invalid_request_error / model wording to capability (copilot parity)', () => {
    const mapped = mapOpenAIError({
      status: 400,
      message: 'unsupported model: gpt-9001',
      error: { type: 'invalid_request_error' },
    });
    expect(mapped.kind).toBe('capability');
  });
  // ── ADR-008 D11: GPT-6 rejections (research digest § 13 verbatim strings) ──

  it('maps a 400 unsupported_value on reasoning_effort to capability carrying param and code', () => {
    const mapped = mapOpenAIError({
      status: 400,
      message:
        "Unsupported value: 'reasoning_effort' does not support 'none' with this model. Supported values are: 'low', 'medium', 'high', and 'xhigh'.",
      error: {
        type: 'invalid_request_error',
        param: 'reasoning_effort',
        code: 'unsupported_value',
      },
    });
    expect(mapped).toMatchObject({
      kind: 'capability',
      param: 'reasoning_effort',
      code: 'unsupported_value',
    });
  });

  it('maps a 400 unsupported temperature (code null) to capability with param and no code', () => {
    const mapped = mapOpenAIError({
      status: 400,
      message: "Unsupported parameter: 'temperature' is not supported with this model.",
      error: { type: 'invalid_request_error', param: 'temperature', code: null },
    });
    expect(mapped.kind).toBe('capability');
    if (mapped.kind !== 'capability') throw new Error('unreachable');
    expect(mapped.param).toBe('temperature');
    expect('code' in mapped).toBe(false);
  });

  it('maps the chat max_tokens rejection to capability with param max_tokens', () => {
    const mapped = mapOpenAIError({
      status: 400,
      message:
        "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      error: { type: 'invalid_request_error', param: 'max_tokens', code: 'unsupported_parameter' },
    });
    expect(mapped).toMatchObject({
      kind: 'capability',
      param: 'max_tokens',
      code: 'unsupported_parameter',
    });
  });

  it('maps the chat+tools rejection to capability with param reasoning_effort and no code', () => {
    const mapped = mapOpenAIError({
      status: 400,
      message:
        "Function tools with reasoning_effort are not supported for gpt-6-astra in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
      error: { type: 'invalid_request_error', param: 'reasoning_effort', code: null },
    });
    expect(mapped.kind).toBe('capability');
    if (mapped.kind !== 'capability') throw new Error('unreachable');
    expect(mapped.param).toBe('reasoning_effort');
    expect('code' in mapped).toBe(false);
  });

  it('maps a 400 code unsupported_parameter to capability even with a neutral message', () => {
    const mapped = mapOpenAIError({
      status: 400,
      message: 'bad request',
      error: { code: 'unsupported_parameter', param: 'store' },
    });
    expect(mapped).toMatchObject({
      kind: 'capability',
      param: 'store',
      code: 'unsupported_parameter',
    });
  });

  it('maps a 429 insufficient_quota to a non-retryable rate_limit without retry_after_ms', () => {
    const mapped = mapOpenAIError({
      status: 429,
      message: 'You exceeded your current quota, please check your plan and billing details.',
      headers: { 'retry-after': '20' },
      error: { type: 'insufficient_quota', code: 'insufficient_quota' },
    });
    expect(mapped.kind).toBe('rate_limit');
    expect(mapped.retryable).toBe(false);
    expect('retry_after_ms' in mapped).toBe(false);
  });

  it('maps a 503 with Retry-After to a retryable transport carrying retry_after_ms', () => {
    const mapped = mapOpenAIError({
      status: 503,
      message: 'The server is overloaded. Please retry after a short wait.',
      headers: { 'retry-after': '3' },
      error: { type: 'service_unavailable_error', code: 'server_is_overloaded' },
    });
    expect(mapped).toEqual({
      kind: 'transport',
      message: 'The server is overloaded. Please retry after a short wait.',
      retryable: true,
      retry_after_ms: 3000,
    });
  });
});
