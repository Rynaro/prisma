import type { JobPayload } from '@prisma-bot/shared';
import type { EnqueueResult, JobConsumer, JobHandler, JobQueue } from './job-queue.js';

/**
 * In-memory `JobQueue` + `JobConsumer` pair for tests.
 *
 * Design choice: `enqueue` invokes the registered handler synchronously
 * (awaited) before returning. This collapses the queue's normal
 * "enqueue → background-poll → execute" sequence into a single call so the
 * end-to-end integration test (`apps/github-app/tests/e2e/full-loop.test.ts`)
 * can drive the pipeline deterministically without standing up Redis.
 *
 * The trade-off is that this implementation does not exercise the framework
 * retry loop; that surface is unit-tested separately by
 * `apps/github-app/tests/queue/bullmq-job-queue.test.ts` against the
 * BullMQ seam.
 */

interface SharedRegistry {
  /** Set of idempotency_keys that have been enqueued. Used to flag duplicates. */
  jobs: Set<string>;
  /** The currently-attached handler, if any. */
  handler: JobHandler | undefined;
  /** Once `close()` is called, further enqueues are rejected. */
  closed: boolean;
}

export class InMemoryJobQueue implements JobQueue {
  private readonly shared: SharedRegistry;

  constructor(shared?: SharedRegistry) {
    this.shared = shared ?? { jobs: new Set(), handler: undefined, closed: false };
  }

  /** Internal seam: lets the consumer share the same registry. */
  get registry(): SharedRegistry {
    return this.shared;
  }

  async enqueue(payload: JobPayload): Promise<EnqueueResult> {
    if (this.shared.closed) {
      throw new Error('InMemoryJobQueue is closed');
    }
    const key = payload.idempotency_key;
    if (this.shared.jobs.has(key)) {
      return { enqueued: false, idempotency_key: key, reason: 'duplicate' };
    }
    // Reserve the key before invoking the handler so a re-entrant enqueue
    // (e.g., a handler that itself enqueues during execution) sees the
    // duplicate path.
    this.shared.jobs.add(key);
    const handler = this.shared.handler;
    if (handler !== undefined) {
      // Surface handler errors to the caller of enqueue(). The registry has
      // already been updated, so a duplicate enqueue from a retry would
      // short-circuit.
      await handler(payload);
    }
    return { enqueued: true, idempotency_key: key };
  }

  async close(): Promise<void> {
    this.shared.closed = true;
  }
}

export class InMemoryJobConsumer implements JobConsumer {
  private readonly shared: SharedRegistry;

  constructor(queue: InMemoryJobQueue) {
    this.shared = queue.registry;
  }

  async run(handler: JobHandler): Promise<void> {
    this.shared.handler = handler;
  }

  async close(): Promise<void> {
    this.shared.handler = undefined;
  }
}
