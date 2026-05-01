import { describe, expect, it } from 'vitest';
import { InMemoryReplayCache, RedisReplayCache } from '../../src/webhook/replay-cache.js';

describe('InMemoryReplayCache', () => {
  it('returns false for a fresh delivery and true after remember', async () => {
    const cache = new InMemoryReplayCache({ windowSeconds: 60 });
    expect(await cache.isReplay(1, 'delivery-a')).toBe(false);
    await cache.remember(1, 'delivery-a');
    expect(await cache.isReplay(1, 'delivery-a')).toBe(true);
  });

  it('treats different installation_ids as independent keyspaces', async () => {
    const cache = new InMemoryReplayCache({ windowSeconds: 60 });
    await cache.remember(1, 'delivery-shared');
    expect(await cache.isReplay(1, 'delivery-shared')).toBe(true);
    expect(await cache.isReplay(2, 'delivery-shared')).toBe(false);
    await cache.remember(2, 'delivery-shared');
    expect(await cache.isReplay(2, 'delivery-shared')).toBe(true);
  });

  it('expires entries past windowSeconds (clock advanced via injected now)', async () => {
    let now = 1_000_000;
    const cache = new InMemoryReplayCache({
      windowSeconds: 5,
      now: () => now,
    });
    await cache.remember(7, 'delivery-x');
    expect(await cache.isReplay(7, 'delivery-x')).toBe(true);

    // Advance past the 5-second window.
    now += 6_000;
    expect(await cache.isReplay(7, 'delivery-x')).toBe(false);
  });

  it('with windowSeconds = 0 records nothing (no replay protection window)', async () => {
    const cache = new InMemoryReplayCache({ windowSeconds: 0 });
    await cache.remember(1, 'delivery-y');
    expect(await cache.isReplay(1, 'delivery-y')).toBe(false);
  });
});

// Hand-rolled in-memory Redis fake exposing the surface RedisReplayCache uses.
// The live-Redis integration test arrives in slice 5.5 per the spec; this
// suite proves the shape and arguments of the Redis calls we issue.
class FakeRedis {
  private readonly store = new Map<string, string>();
  public readonly setCalls: Array<readonly unknown[]> = [];
  public readonly existsCalls: string[] = [];

  async exists(key: string): Promise<number> {
    this.existsCalls.push(key);
    return this.store.has(key) ? 1 : 0;
  }

  async set(key: string, value: string, ...rest: unknown[]): Promise<'OK' | null> {
    this.setCalls.push([key, value, ...rest]);
    // Mimic NX semantics: if the key already exists, return null.
    if (this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }
}

describe('RedisReplayCache (against in-memory fake)', () => {
  it('keys are prefixed with prisma:replay:<installation>:<delivery>', async () => {
    const fake = new FakeRedis();
    const cache = new RedisReplayCache(
      fake as unknown as ConstructorParameters<typeof RedisReplayCache>[0],
      300,
    );
    await cache.isReplay(99, 'delivery-z');
    expect(fake.existsCalls).toEqual(['prisma:replay:99:delivery-z']);
  });

  it('remember calls SET with EX windowSeconds NX', async () => {
    const fake = new FakeRedis();
    const cache = new RedisReplayCache(
      fake as unknown as ConstructorParameters<typeof RedisReplayCache>[0],
      300,
    );
    await cache.remember(99, 'delivery-z');
    expect(fake.setCalls).toEqual([['prisma:replay:99:delivery-z', '1', 'EX', 300, 'NX']]);
  });

  it('isReplay reports true after remember', async () => {
    const fake = new FakeRedis();
    const cache = new RedisReplayCache(
      fake as unknown as ConstructorParameters<typeof RedisReplayCache>[0],
      300,
    );
    expect(await cache.isReplay(1, 'd1')).toBe(false);
    await cache.remember(1, 'd1');
    expect(await cache.isReplay(1, 'd1')).toBe(true);
  });

  it('with windowSeconds = 0, remember is a no-op (no SET issued)', async () => {
    const fake = new FakeRedis();
    const cache = new RedisReplayCache(
      fake as unknown as ConstructorParameters<typeof RedisReplayCache>[0],
      0,
    );
    await cache.remember(1, 'd1');
    expect(fake.setCalls).toEqual([]);
  });
});
