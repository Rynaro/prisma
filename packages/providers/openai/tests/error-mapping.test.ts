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

  // T14: 429 insufficient_quota → rate_limit
  it('maps HTTP 429 insufficient_quota to rate_limit', () => {
    const mapped = mapOpenAIError({
      status: 429,
      message: 'You exceeded your current quota',
      error: { code: 'insufficient_quota' },
    });
    expect(mapped.kind).toBe('rate_limit');
    expect(mapped.retryable).toBe(true);
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
});
