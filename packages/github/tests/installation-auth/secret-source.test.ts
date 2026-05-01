import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretNotFoundError, envSecretSource } from '../../src/installation-auth/index.js';

describe('envSecretSource', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns the value when the env var is set and non-empty', async () => {
    process.env.PRISMA_TEST_SECRET_PRESENT = 'shh';
    const source = envSecretSource();
    await expect(source.getSecret('PRISMA_TEST_SECRET_PRESENT')).resolves.toBe('shh');
  });

  it('throws SecretNotFoundError when the env var is unset', async () => {
    // Use a name extremely unlikely to be present in any environment.
    const unsetName = `PRISMA_TEST_UNSET_${Math.random().toString(36).slice(2)}`;
    expect(process.env[unsetName]).toBeUndefined();
    const source = envSecretSource();
    await expect(source.getSecret(unsetName)).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it('throws SecretNotFoundError when the env var is empty', async () => {
    process.env.PRISMA_TEST_SECRET_EMPTY = '';
    const source = envSecretSource();
    await expect(source.getSecret('PRISMA_TEST_SECRET_EMPTY')).rejects.toBeInstanceOf(
      SecretNotFoundError,
    );
  });
});
