import type { JobPayload } from '@prisma-bot/shared';
import { describe, expect, it, vi } from 'vitest';
import { BullMqJobQueue, type QueueLike } from '../../src/queue/index.js';

const makePayload = (idempotency_key: string): JobPayload => ({
  idempotency_key,
  installation_id: 1,
  repository_id: 2,
  pull_request_number: 3,
  head_sha: 'a'.repeat(40),
  event_type: 'pull_request.opened',
  received_at: '2025-01-01T00:00:00.000Z',
});

interface QueueLikeSpy extends QueueLike {
  _addCalls: Array<{
    name: string;
    data: JobPayload;
    opts: { jobId: string; attempts?: number; backoff?: { type: string; delay: number } };
  }>;
  _getJobCalls: string[];
  _closed: boolean;
}

const makeQueueLike = (overrides: Partial<QueueLike> = {}): QueueLikeSpy => {
  const spy: QueueLikeSpy = {
    _addCalls: [],
    _getJobCalls: [],
    _closed: false,
    add: vi.fn(async (name, data, opts) => {
      spy._addCalls.push({ name, data, opts });
      return { id: opts.jobId };
    }),
    getJob: vi.fn(async (jobId: string) => {
      spy._getJobCalls.push(jobId);
      return null;
    }),
    close: vi.fn(async () => {
      spy._closed = true;
    }),
    ...overrides,
  };
  return spy;
};

describe('BullMqJobQueue (seam, no Redis)', () => {
  it('enqueue calls queueLike.add with the idempotency_key as jobId', async () => {
    const queueImpl = makeQueueLike();
    const queue = new BullMqJobQueue({ queueImpl });
    const payload = makePayload('idemp-1');
    const result = await queue.enqueue(payload);
    expect(result).toEqual({ enqueued: true, idempotency_key: 'idemp-1' });
    expect(queueImpl._addCalls).toHaveLength(1);
    expect(queueImpl._addCalls[0]?.opts.jobId).toBe('idemp-1');
    expect(queueImpl._addCalls[0]?.data).toEqual(payload);
    // Also confirms the queue name uses the canonical 'pr-review'.
    expect(queueImpl._addCalls[0]?.name).toBe('pr-review');
  });

  it('detects an existing job via getJob and returns duplicate without calling add', async () => {
    const queueImpl = makeQueueLike({
      getJob: vi.fn(async () => ({ id: 'idemp-2' })),
    });
    const queue = new BullMqJobQueue({ queueImpl });
    const result = await queue.enqueue(makePayload('idemp-2'));
    expect(result).toEqual({
      enqueued: false,
      idempotency_key: 'idemp-2',
      reason: 'duplicate',
    });
    expect(queueImpl.add).not.toHaveBeenCalled();
  });

  it('maps a duplicate-id error from add() to { enqueued: false, reason: duplicate }', async () => {
    const queueImpl = makeQueueLike({
      add: vi.fn(async () => {
        throw new Error('Job with id idemp-3 already exists');
      }),
    });
    const queue = new BullMqJobQueue({ queueImpl });
    const result = await queue.enqueue(makePayload('idemp-3'));
    expect(result).toEqual({
      enqueued: false,
      idempotency_key: 'idemp-3',
      reason: 'duplicate',
    });
  });

  it('propagates non-duplicate errors from add()', async () => {
    const queueImpl = makeQueueLike({
      add: vi.fn(async () => {
        throw new Error('redis connection lost');
      }),
    });
    const queue = new BullMqJobQueue({ queueImpl });
    await expect(queue.enqueue(makePayload('idemp-4'))).rejects.toThrow('redis connection lost');
  });

  it('close() delegates to queueLike.close()', async () => {
    const queueImpl = makeQueueLike();
    const queue = new BullMqJobQueue({ queueImpl });
    await queue.close();
    expect(queueImpl.close).toHaveBeenCalledTimes(1);
    expect(queueImpl._closed).toBe(true);
  });

  it('passes the configured tunables (attempts, backoff) into add()', async () => {
    const queueImpl = makeQueueLike();
    const queue = new BullMqJobQueue({
      queueImpl,
      tunables: {
        attempts: 7,
        backoffBaseMs: 1234,
        backoffMaxMs: 9999,
        rateLimitAttempts: 11,
      },
    });
    await queue.enqueue(makePayload('idemp-5'));
    expect(queueImpl._addCalls[0]?.opts.attempts).toBe(7);
    expect(queueImpl._addCalls[0]?.opts.backoff).toEqual({ type: 'exponential', delay: 1234 });
  });
});
