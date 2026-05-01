import { ProviderErrorThrowable } from '@prisma-bot/shared';
import { describe, expect, it } from 'vitest';
import { classifyRetry } from '../../src/queue/index.js';

describe('classifyRetry', () => {
  it('classifies ProviderErrorThrowable transport as transient', () => {
    const err = new ProviderErrorThrowable({
      kind: 'transport',
      message: 'connection refused',
    });
    expect(classifyRetry(err)).toBe('transient');
  });

  it('classifies ProviderErrorThrowable rate_limit as rate_limited', () => {
    const err = new ProviderErrorThrowable({
      kind: 'rate_limit',
      message: 'too many requests',
    });
    expect(classifyRetry(err)).toBe('rate_limited');
  });

  it('classifies ProviderErrorThrowable auth as non_transient', () => {
    const err = new ProviderErrorThrowable({
      kind: 'auth',
      message: 'invalid api key',
    });
    expect(classifyRetry(err)).toBe('non_transient');
  });

  it('classifies ProviderErrorThrowable capability as non_transient', () => {
    const err = new ProviderErrorThrowable({
      kind: 'capability',
      message: 'cost ceiling exceeded',
      missing_capability: 'cost_ceiling',
    });
    expect(classifyRetry(err)).toBe('non_transient');
  });

  it('classifies ProviderErrorThrowable schema_validation as non_transient', () => {
    const err = new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'malformed output',
    });
    expect(classifyRetry(err)).toBe('non_transient');
  });

  it('classifies an arbitrary Error as transient (default to retry)', () => {
    expect(classifyRetry(new Error('socket hang up'))).toBe('transient');
  });

  it('classifies a non-Error throw as transient', () => {
    expect(classifyRetry('boom')).toBe('transient');
    expect(classifyRetry(undefined)).toBe('transient');
  });
});
