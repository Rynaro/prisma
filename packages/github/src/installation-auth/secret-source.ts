import { SecretNotFoundError } from './auth.js';

/**
 * `SecretSource` — the boundary defined in
 * `docs/system-design.md` § Secret storage abstraction. The MVP implementation
 * reads from process env; operators are expected to wrap this with a managed
 * secret manager.
 *
 * This slice owns the boundary: even though earlier slices read process.env
 * directly for ergonomic reasons, every authenticated path through Phase 5.5+
 * routes through a `SecretSource`.
 */
export interface SecretSource {
  getSecret(name: string): Promise<string>;
}

export { SecretNotFoundError } from './auth.js';

/** Build a `SecretSource` that reads from `process.env`. */
export const envSecretSource = (): SecretSource => ({
  async getSecret(name: string): Promise<string> {
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
      throw new SecretNotFoundError(name);
    }
    return value;
  },
});
