import type IORedis from 'ioredis';

/**
 * Replay protection cache per docs/system-design.md § Queue and async model
 * § Replay protection. `X-GitHub-Delivery` is cached per installation for a
 * bounded window (env var `INSTALLATION_REPLAY_WINDOW_SECONDS`); a duplicate
 * delivery within the window short-circuits to `discarded_idempotent`.
 *
 * Keys are namespaced by installation_id per docs/system-design.md
 * § Multitenancy posture ("namespaced by installation_id" is the contract).
 */

export interface ReplayCache {
  isReplay(installationId: number, deliveryId: string): Promise<boolean>;
  remember(installationId: number, deliveryId: string): Promise<void>;
}

interface MemoryEntry {
  expiresAt: number;
}

export interface InMemoryReplayCacheOptions {
  windowSeconds: number;
  now?: () => number;
}

const buildKey = (installationId: number, deliveryId: string): string =>
  `${installationId}:${deliveryId}`;

export class InMemoryReplayCache implements ReplayCache {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: InMemoryReplayCacheOptions) {
    // windowSeconds = 0 disables replay protection: every delivery is fresh
    // and `remember` is a no-op (entries expire immediately on insert). This
    // edge case is documented and exercised in the unit tests.
    this.windowMs = Math.max(0, Math.floor(opts.windowSeconds * 1000));
    this.now = opts.now ?? (() => Date.now());
  }

  async isReplay(installationId: number, deliveryId: string): Promise<boolean> {
    const key = buildKey(installationId, deliveryId);
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return false;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  async remember(installationId: number, deliveryId: string): Promise<void> {
    if (this.windowMs === 0) {
      // Window of zero means no replay window — record nothing.
      return;
    }
    const key = buildKey(installationId, deliveryId);
    this.entries.set(key, { expiresAt: this.now() + this.windowMs });
  }
}

/**
 * Redis-backed replay cache. Keys are `prisma:replay:<installationId>:<deliveryId>`,
 * set with `EX windowSeconds NX`. The live-Redis integration test arrives in
 * Phase 5.5; this slice unit-tests the implementation against a fake client
 * exposing `exists` and `set`.
 */
export class RedisReplayCache implements ReplayCache {
  private readonly connection: Pick<IORedis, 'exists' | 'set'>;
  private readonly windowSeconds: number;

  constructor(connection: Pick<IORedis, 'exists' | 'set'>, windowSeconds: number) {
    this.connection = connection;
    this.windowSeconds = Math.max(0, Math.floor(windowSeconds));
  }

  private key(installationId: number, deliveryId: string): string {
    return `prisma:replay:${installationId}:${deliveryId}`;
  }

  async isReplay(installationId: number, deliveryId: string): Promise<boolean> {
    const exists = await this.connection.exists(this.key(installationId, deliveryId));
    return exists === 1;
  }

  async remember(installationId: number, deliveryId: string): Promise<void> {
    if (this.windowSeconds === 0) {
      return;
    }
    await this.connection.set(
      this.key(installationId, deliveryId),
      '1',
      'EX',
      this.windowSeconds,
      'NX',
    );
  }
}
