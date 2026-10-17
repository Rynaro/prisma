import { describe, expect, it } from 'vitest';
import { mapAnthropicError } from '../src/error-mapping.js';

describe('mapAnthropicError', () => {
  it('maps a network error (no status, ECONNREFUSED) to transport with retryable: true', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
      code: 'ECONNREFUSED',
    });
    const mapped = mapAnthropicError(err);
    expect(mapped.kind).toBe('transport');
    expect(mapped.retryable).toBe(true);
  });

  it('maps a timeout error to transport with retryable: true', () => {
    const err = new Error('Request timed out after 30000ms');
    const mapped = mapAnthropicError(err);
    expect(mapped.kind).toBe('transport');
    expect(mapped.retryable).toBe(true);
  });

  it('maps HTTP 401 to auth', () => {
    const mapped = mapAnthropicError({ status: 401, message: 'invalid api key' });
    expect(mapped.kind).toBe('auth');
  });

  it('maps HTTP 403 to auth', () => {
    const mapped = mapAnthropicError({ status: 403, message: 'forbidden' });
    expect(mapped.kind).toBe('auth');
  });

  it('maps HTTP 429 to rate_limit and extracts numeric retry-after seconds to ms', () => {
    const mapped = mapAnthropicError({
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
    const mapped = mapAnthropicError({ status: 503, message: 'service unavailable' });
    expect(mapped.kind).toBe('transport');
    expect(mapped.retryable).toBe(true);
  });

  it('maps HTTP 400 with invalid_request_error / model wording to capability', () => {
    const mapped = mapAnthropicError({
      status: 400,
      message: 'unsupported model: claude-opus-9001',
      error: { type: 'invalid_request_error' },
    });
    expect(mapped.kind).toBe('capability');
  });

  it('maps anything else to transport with retryable: false', () => {
    const mapped = mapAnthropicError({ status: 418, message: "I'm a teapot" });
    expect(mapped.kind).toBe('transport');
    expect(mapped.retryable).toBe(false);
  });

  it('never leaks Authorization / Bearer tokens into the mapped message', () => {
    const sensitive = {
      status: 500,
      message: 'request failed: Authorization: Bearer sk-ant-api03-secret-key-do-not-leak',
      headers: {
        authorization: 'Bearer sk-ant-api03-secret-key-do-not-leak',
      },
      request: {
        headers: { Authorization: 'Bearer sk-ant-api03-secret-key-do-not-leak' },
      },
    };
    const mapped = mapAnthropicError(sensitive);
    expect(mapped.kind).toBe('transport');
    expect(mapped.message.toLowerCase()).not.toContain('authorization');
    expect(mapped.message.toLowerCase()).not.toContain('bearer');
    expect(mapped.message).not.toContain('sk-ant-api03-secret-key-do-not-leak');
  });

  // ADR-009 D10
  const invalid = (message: string) => ({
    status: 400,
    message,
    error: { type: 'error', error: { type: 'invalid_request_error', message } },
  });

  it.each([
    'tool_choice: type "tool" and "any" are not supported for this model.',
    '"thinking.type.disabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.',
    "output_config.effort 'xhigh' is not supported when thinking is disabled on this model. Use effort 'high' or below, or enable thinking.",
    "role 'system' is not supported on this model",
    'prompt is too long: 1048576 tokens > 1000000 maximum',
    'Your credit balance is too low to access the Anthropic API.',
  ])('maps every invalid_request_error 400 to capability with a code: %s', (message) => {
    const mapped = mapAnthropicError(invalid(message));
    expect(mapped).toMatchObject({ kind: 'capability', code: 'invalid_request_error' });
  });

  it('maps a 404 (with or without a body) to capability not_found_error', () => {
    expect(
      mapAnthropicError({
        status: 404,
        message: 'model: claude-3-5-sonnet-latest',
        error: { type: 'error', error: { type: 'not_found_error', message: 'model: x' } },
      }),
    ).toMatchObject({ kind: 'capability', code: 'not_found_error' });
    expect(mapAnthropicError({ status: 404 })).toMatchObject({
      kind: 'capability',
      code: 'not_found_error',
    });
  });

  it('maps a 400 without an error type to non-retryable transport', () => {
    expect(mapAnthropicError({ status: 400, message: 'bad' })).toMatchObject({
      kind: 'transport',
      retryable: false,
    });
  });

  it('maps a 503 with retry-after to retryable transport carrying retry_after_ms', () => {
    expect(
      mapAnthropicError({ status: 503, message: 'busy', headers: { 'retry-after': '3' } }),
    ).toMatchObject({ kind: 'transport', retryable: true, retry_after_ms: 3000 });
  });

  it('maps a 529 to retryable transport', () => {
    expect(mapAnthropicError({ status: 529, message: 'overloaded' })).toMatchObject({
      kind: 'transport',
      retryable: true,
    });
  });
});
