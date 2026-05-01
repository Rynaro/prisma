import type { JobPayload } from '@prisma-bot/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryJobConsumer, InMemoryJobQueue, type JobOutcome } from '../../src/queue/index.js';

const makePayload = (idempotency_key: string): JobPayload => ({
  idempotency_key,
  installation_id: 1,
  repository_id: 2,
  pull_request_number: 3,
  head_sha: 'a'.repeat(40),
  event_type: 'pull_request.opened',
  received_at: '2025-01-01T00:00:00.000Z',
});

describe('InMemoryJobQueue', () => {
  let queue: InMemoryJobQueue;
  let consumer: InMemoryJobConsumer;

  beforeEach(() => {
    queue = new InMemoryJobQueue();
    consumer = new InMemoryJobConsumer(queue);
  });

  it('enqueues a fresh payload as enqueued: true', async () => {
    const result = await queue.enqueue(makePayload('key-1'));
    expect(result).toEqual({ enqueued: true, idempotency_key: 'key-1' });
  });

  it('returns enqueued: false with reason: duplicate on a repeat idempotency_key', async () => {
    const payload = makePayload('key-2');
    await queue.enqueue(payload);
    const second = await queue.enqueue(payload);
    expect(second).toEqual({
      enqueued: false,
      idempotency_key: 'key-2',
      reason: 'duplicate',
    });
  });

  it('invokes the registered handler with the enqueued payload', async () => {
    const handler = vi.fn(async (): Promise<JobOutcome> => ({ state: 'discarded_idempotent' }));
    await consumer.run(handler);
    const payload = makePayload('key-3');
    await queue.enqueue(payload);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('surfaces a handler error to the enqueue caller', async () => {
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    await consumer.run(handler);
    await expect(queue.enqueue(makePayload('key-4'))).rejects.toThrow('boom');
  });

  it('rejects enqueue calls after close()', async () => {
    await queue.close();
    await expect(queue.enqueue(makePayload('key-5'))).rejects.toThrow(/closed/);
  });

  it('detects a duplicate even when no handler is attached', async () => {
    const payload = makePayload('key-6');
    await queue.enqueue(payload);
    const second = await queue.enqueue(payload);
    expect(second.enqueued).toBe(false);
    expect(second.reason).toBe('duplicate');
  });
});
