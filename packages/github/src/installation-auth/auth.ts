import { createAppAuth } from '@octokit/auth-app';
import { type OctokitLike, createDefaultOctokit } from './client.js';

/**
 * `InstallationAuth` — mints GitHub App installation tokens and caches them
 * per `installation_id` until just before expiry. Implementation of
 * `docs/system-design.md` § packages/github/installation-auth: tokens are
 * minted at job-execution time, never embedded in `JobPayload`, and never
 * appear in any log line.
 *
 * Per `docs/threat-model.md` § Secret leakage: error messages must not echo
 * the App private key, the JWT, or any minted access token; we map vendor
 * errors to a typed `InstallationAuthError` whose `.message` is a fixed
 * category string.
 *
 * Per the slice contract: this file (and `client.ts`) are the ONLY two files
 * in the repo allowed to import `@octokit/*` runtime symbols. Verified by the
 * SDK-leakage grep at the slice's verification gate.
 */

export interface AppCredentials {
  appId: number;
  privateKeyPem: string;
}

/** What we cache per installation. */
interface CachedToken {
  token: string;
  expiresAt: number; // ms since epoch
}

/** Internal type: the function that mints a fresh token from app credentials. */
export type TokenMintFn = (
  credentials: AppCredentials,
  installationId: number,
) => Promise<{ token: string; expiresAt: number }>;

export interface InstallationAuthOptions {
  credentials: AppCredentials;
  /** Token cache TTL in seconds; default 540 (GitHub tokens last 1 hour, refresh 9 minutes early). */
  tokenTtlSeconds?: number;
  /** Optional clock injection for testability. */
  now?: () => number;
  /** Optional inner client builder (defaults to `createDefaultOctokit`). */
  clientFactory?: (token: string) => OctokitLike;
  /**
   * Optional token minting function (for testability). Defaults to a real
   * implementation backed by `@octokit/auth-app`. Tests can inject a fake to
   * exercise caching behaviour without network IO.
   */
  mintToken?: TokenMintFn;
}

/**
 * Categories of auth failure that we surface to callers. The category is
 * deliberately coarse — the value of a finer taxonomy here is small relative
 * to the leakage risk of echoing vendor messages verbatim.
 */
export type InstallationAuthErrorCode =
  | 'private_key_invalid'
  | 'installation_not_found'
  | 'rate_limited'
  | 'transport';

export class InstallationAuthError extends Error {
  readonly code: InstallationAuthErrorCode;
  constructor(code: InstallationAuthErrorCode, message: string) {
    super(message);
    this.name = 'InstallationAuthError';
    this.code = code;
  }
}

/**
 * `SecretNotFoundError` — thrown by `envSecretSource()` when an env var is
 * unset or empty. Lives here (rather than in `secret-source.ts`) because the
 * auth module already declares the typed error vocabulary; co-locating keeps
 * the package's error types in one place.
 */
export class SecretNotFoundError extends Error {
  override readonly name = 'SecretNotFoundError' as const;
  readonly secretName: string;
  constructor(secretName: string) {
    super(`secret not found: ${secretName}`);
    this.secretName = secretName;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Map an unknown error thrown by `@octokit/auth-app` to a typed
 * `InstallationAuthError`. We never include the original message verbatim
 * (it can contain JWTs, PEM excerpts, or token-shaped values); we only map
 * an HTTP status / shape signal to a coarse category.
 */
const mapAuthError = (err: unknown): InstallationAuthError => {
  if (isObject(err)) {
    const status = err.status;
    if (typeof status === 'number') {
      if (status === 401 || status === 403) {
        return new InstallationAuthError(
          'private_key_invalid',
          'GitHub App credentials rejected (status 401/403)',
        );
      }
      if (status === 404) {
        return new InstallationAuthError(
          'installation_not_found',
          'GitHub installation not found (status 404)',
        );
      }
      if (status === 429) {
        return new InstallationAuthError(
          'rate_limited',
          'GitHub Installations API rate limit exceeded (status 429)',
        );
      }
    }
    const codeProp = err.code;
    if (codeProp === 'ECONNRESET' || codeProp === 'ETIMEDOUT' || codeProp === 'ENOTFOUND') {
      return new InstallationAuthError('transport', 'GitHub Installations API transport failure');
    }
  }
  return new InstallationAuthError('transport', 'GitHub Installations API call failed');
};

/**
 * Default mint function. Calls `@octokit/auth-app` to obtain an installation
 * access token. The error path translates everything to a typed
 * `InstallationAuthError` with a redacted message.
 */
const defaultMintToken: TokenMintFn = async (credentials, installationId) => {
  let auth: ReturnType<typeof createAppAuth>;
  try {
    auth = createAppAuth({
      appId: credentials.appId,
      privateKey: credentials.privateKeyPem,
    });
  } catch (err) {
    throw mapAuthError(err);
  }
  let result: { token: string; expiresAt: string };
  try {
    const installationAuth = await auth({
      type: 'installation',
      installationId,
    });
    result = { token: installationAuth.token, expiresAt: installationAuth.expiresAt };
  } catch (err) {
    throw mapAuthError(err);
  }
  const expiresAtMs = Date.parse(result.expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    throw new InstallationAuthError(
      'transport',
      'GitHub Installations API returned an unparseable expiry',
    );
  }
  return { token: result.token, expiresAt: expiresAtMs };
};

export class InstallationAuth {
  private readonly credentials: AppCredentials;
  private readonly tokenTtlMs: number;
  private readonly clockNow: () => number;
  private readonly clientFactory: (token: string) => OctokitLike;
  private readonly mintToken: TokenMintFn;
  private readonly cache: Map<number, CachedToken> = new Map();

  constructor(options: InstallationAuthOptions) {
    this.credentials = options.credentials;
    this.tokenTtlMs = (options.tokenTtlSeconds ?? 540) * 1000;
    this.clockNow = options.now ?? Date.now;
    this.clientFactory = options.clientFactory ?? createDefaultOctokit;
    this.mintToken = options.mintToken ?? defaultMintToken;
  }

  /**
   * Returns a cached token if one is present and not within the refresh
   * window; otherwise mints a fresh one and caches it.
   */
  async getToken(installationId: number): Promise<{ token: string; expiresAt: number }> {
    const cached = this.cache.get(installationId);
    const now = this.clockNow();
    if (cached !== undefined && cached.expiresAt > now) {
      return { token: cached.token, expiresAt: cached.expiresAt };
    }
    const minted = await this.mintToken(this.credentials, installationId);
    // Honour both the configured TTL and the GitHub-issued expiry; whichever is sooner wins.
    const ttlExpiry = now + this.tokenTtlMs;
    const effectiveExpiry = Math.min(minted.expiresAt, ttlExpiry);
    this.cache.set(installationId, { token: minted.token, expiresAt: effectiveExpiry });
    return { token: minted.token, expiresAt: effectiveExpiry };
  }

  async getOctokit(installationId: number): Promise<OctokitLike> {
    const { token } = await this.getToken(installationId);
    return this.clientFactory(token);
  }

  /** For tests: discard a cached token so the next `getToken` re-mints. */
  invalidate(installationId: number): void {
    this.cache.delete(installationId);
  }
}
