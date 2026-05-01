import type { JobPayload } from '@prisma-bot/shared';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import {
  type EnqueueResult,
  type JobConsumer,
  type JobHandler,
  type JobQueue,
  QUEUE_NAME,
  classifyRetry,
} from './job-queue.js';

/**
 * BullMQ-backed `JobQueue` + `JobConsumer` per `docs/system-design.md`
 * § Queue and async model. Both classes are constructed with their
 * IORedis connection (the application owns the lifecycle); test seams
 * accept a `QueueLike` / `WorkerLike` pair so unit tests can exercise the
 * adapter without standing up Redis.
 *
 * Tunables (`docs/operational-runbooks.md` § Numeric tunables):
 *   - `QUEUE_CONCURRENCY`               (default 4)
 *   - `JOB_TIMEOUT_SECONDS`             (default 120) → BullMQ `lockDuration`
 *   - `RETRY_TRANSIENT_MAX_ATTEMPTS`    (default 3)
 *   - `RETRY_TRANSIENT_BACKOFF_BASE_MS` (default 500)
 *   - `RETRY_TRANSIENT_BACKOFF_MAX_MS`  (default 8000) — passed through for
 *                                                       observability; the
 *                                                       backoff is capped
 *                                                       implicitly via the
 *                                                       attempt budget.
 *   - `RETRY_RATELIMIT_MAX_ATTEMPTS`    (default 5) — surfaced to the
 *                                                    `enqueue` path via the
 *                                                    job's `attempts` option
 *                                                    only when the spec
 *                                                    requires per-error-class
 *                                                    differentiation; for
 *                                                    MVP we use a single
 *                                                    attempt budget that
 *                                                    covers both transient
 *                                                    and rate-limited
 *                                                    classes.
 */

export interface BullMqJobQueueTunables {
  attempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  rateLimitAttempts: number;
}

export const DEFAULT_BULLMQ_TUNABLES: BullMqJobQueueTunables = {
  attempts: 3,
  backoffBaseMs: 500,
  backoffMaxMs: 8000,
  rateLimitAttempts: 5,
};

const parseIntEnv = (name: string, fallback: number): number => {
  const v = process.env[name];
  if (v === undefined || v.length === 0) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const tunablesFromEnv = (): BullMqJobQueueTunables => ({
  attempts: parseIntEnv('RETRY_TRANSIENT_MAX_ATTEMPTS', DEFAULT_BULLMQ_TUNABLES.attempts),
  backoffBaseMs: parseIntEnv(
    'RETRY_TRANSIENT_BACKOFF_BASE_MS',
    DEFAULT_BULLMQ_TUNABLES.backoffBaseMs,
  ),
  backoffMaxMs: parseIntEnv('RETRY_TRANSIENT_BACKOFF_MAX_MS', DEFAULT_BULLMQ_TUNABLES.backoffMaxMs),
  rateLimitAttempts: parseIntEnv(
    'RETRY_RATELIMIT_MAX_ATTEMPTS',
    DEFAULT_BULLMQ_TUNABLES.rateLimitAttempts,
  ),
});

/**
 * Minimal `Queue` shape we consume. Mirrors the upstream BullMQ surface
 * but excludes everything we don't use, so unit tests can substitute a
 * hand-rolled fake without instantiating the SDK.
 */
export interface QueueLike {
  add(
    name: string,
    data: JobPayload,
    opts: { jobId: string; attempts?: number; backoff?: { type: string; delay: number } },
  ): Promise<{ id?: string }>;
  getJob(jobId: string): Promise<{ id?: string } | null | undefined>;
  close(): Promise<void>;
}

export interface BullMqJobQueueOptions {
  connection?: ConnectionOptions;
  /** Test seam: substitute a hand-rolled QueueLike to avoid real Redis. */
  queueImpl?: QueueLike;
  /** Override env-backed tunables. */
  tunables?: BullMqJobQueueTunables;
  /** Override the queue name (production wiring uses the canonical name). */
  queueName?: string;
}

const DUPLICATE_MARKERS = ['Job with id', 'already exists', 'job-already-exists'];

const isDuplicateError = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  return DUPLICATE_MARKERS.some((marker) => message.includes(marker));
};

export class BullMqJobQueue implements JobQueue {
  private readonly queue: QueueLike;
  private readonly tunables: BullMqJobQueueTunables;

  constructor(opts: BullMqJobQueueOptions = {}) {
    this.tunables = opts.tunables ?? tunablesFromEnv();
    if (opts.queueImpl !== undefined) {
      this.queue = opts.queueImpl;
    } else {
      if (opts.connection === undefined) {
        throw new Error('BullMqJobQueue requires either a connection or queueImpl');
      }
      const created = new Queue<JobPayload, unknown, string>(opts.queueName ?? QUEUE_NAME, {
        connection: opts.connection,
      });
      // The Queue type is parameterised on payload + result, but the
      // QueueLike seam requires a narrower add signature; the cast is
      // confined to this single seam construction.
      this.queue = created as unknown as QueueLike;
    }
  }

  async enqueue(payload: JobPayload): Promise<EnqueueResult> {
    const jobId = payload.idempotency_key;
    // BullMQ's `Queue#add` with an existing `jobId` silently returns the
    // pre-existing job rather than throwing. Detect the duplicate via a
    // pre-check; if a `getJob` lookup fails (e.g., transient Redis
    // hiccup), fall through to the add path and rely on the duplicate
    // error message detection below as a backstop.
    try {
      const existing = await this.queue.getJob(jobId);
      if (existing !== null && existing !== undefined) {
        return { enqueued: false, idempotency_key: jobId, reason: 'duplicate' };
      }
    } catch {
      // Fall through to the add path; the duplicate detection in the catch
      // below handles the residual case where the job was created between
      // the pre-check and the add.
    }
    try {
      await this.queue.add(QUEUE_NAME, payload, {
        jobId,
        attempts: this.tunables.attempts,
        backoff: { type: 'exponential', delay: this.tunables.backoffBaseMs },
      });
    } catch (err) {
      if (isDuplicateError(err)) {
        return { enqueued: false, idempotency_key: jobId, reason: 'duplicate' };
      }
      throw err;
    }
    return { enqueued: true, idempotency_key: jobId };
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/**
 * Minimal `Worker` shape we consume. The seam keeps unit tests free of
 * Redis while letting the production wiring use the real BullMQ Worker.
 */
export interface WorkerLike {
  close(): Promise<void>;
  on(event: 'failed' | 'completed' | 'error', listener: (...args: unknown[]) => void): void;
}

export type WorkerLikeFactory = (
  queueName: string,
  handler: (job: { data: JobPayload; id?: string }) => Promise<unknown>,
  options: { connection?: ConnectionOptions; concurrency: number; lockDuration: number },
) => WorkerLike;

export interface BullMqJobConsumerOptions {
  connection?: ConnectionOptions;
  /** Test seam: substitute a Worker factory that does not stand up Redis. */
  workerFactory?: WorkerLikeFactory;
  /** Override env-backed tunables. */
  tunables?: BullMqJobConsumerTunables;
  /** Override the queue name. */
  queueName?: string;
}

export interface BullMqJobConsumerTunables {
  concurrency: number;
  jobTimeoutSeconds: number;
}

export const DEFAULT_BULLMQ_CONSUMER_TUNABLES: BullMqJobConsumerTunables = {
  concurrency: 4,
  jobTimeoutSeconds: 120,
};

export const consumerTunablesFromEnv = (): BullMqJobConsumerTunables => ({
  concurrency: parseIntEnv('QUEUE_CONCURRENCY', DEFAULT_BULLMQ_CONSUMER_TUNABLES.concurrency),
  jobTimeoutSeconds: parseIntEnv(
    'JOB_TIMEOUT_SECONDS',
    DEFAULT_BULLMQ_CONSUMER_TUNABLES.jobTimeoutSeconds,
  ),
});

const defaultWorkerFactory: WorkerLikeFactory = (queueName, handler, options) => {
  if (options.connection === undefined) {
    throw new Error('default Worker factory requires a connection');
  }
  const w = new Worker<JobPayload, unknown, string>(
    queueName,
    async (job) => {
      // The Worker passes a Job whose .data is the typed payload; we
      // cast through the seam's narrower shape.
      return handler({ data: job.data, ...(job.id !== undefined ? { id: job.id } : {}) });
    },
    {
      connection: options.connection,
      concurrency: options.concurrency,
      lockDuration: options.lockDuration,
    },
  );
  // The cast here narrows the Worker's event surface to the WorkerLike
  // contract used by the consumer; the inner Worker implements `on` with a
  // wider event signature.
  return {
    close: () => w.close(),
    on: (event, listener) => {
      w.on(event, listener as never);
    },
  };
};

export class BullMqJobConsumer implements JobConsumer {
  private readonly tunables: BullMqJobConsumerTunables;
  private readonly factory: WorkerLikeFactory;
  private readonly connection: ConnectionOptions | undefined;
  private readonly queueName: string;
  private worker: WorkerLike | undefined;

  constructor(opts: BullMqJobConsumerOptions = {}) {
    this.tunables = opts.tunables ?? consumerTunablesFromEnv();
    this.factory = opts.workerFactory ?? defaultWorkerFactory;
    this.connection = opts.connection;
    this.queueName = opts.queueName ?? QUEUE_NAME;
    if (opts.workerFactory === undefined && opts.connection === undefined) {
      throw new Error('BullMqJobConsumer requires either a connection or workerFactory');
    }
  }

  async run(handler: JobHandler): Promise<void> {
    if (this.worker !== undefined) {
      throw new Error('BullMqJobConsumer is already running');
    }
    const wrapped = async (job: { data: JobPayload; id?: string }): Promise<unknown> => {
      try {
        const outcome = await handler(job.data);
        if (outcome.state === 'succeeded') return outcome.result;
        if (outcome.state === 'discarded_idempotent') return undefined;
        // failed_terminal — surface as an UnrecoverableError so BullMQ
        // does not retry and the job is marked failed_terminal once.
        throw new UnrecoverableError(outcome.reason);
      } catch (err) {
        const cls = classifyRetry(err);
        if (cls === 'non_transient') {
          // Non-transient errors must not be retried.
          if (err instanceof UnrecoverableError) throw err;
          throw new UnrecoverableError(
            err instanceof Error ? err.message : 'non-transient failure',
          );
        }
        // Transient and rate_limited: re-throw the original error so
        // BullMQ's exponential-backoff retry loop applies.
        throw err;
      }
    };
    this.worker = this.factory(this.queueName, wrapped, {
      ...(this.connection !== undefined ? { connection: this.connection } : {}),
      concurrency: this.tunables.concurrency,
      lockDuration: this.tunables.jobTimeoutSeconds * 1000,
    });
  }

  async close(): Promise<void> {
    if (this.worker !== undefined) {
      await this.worker.close();
      this.worker = undefined;
    }
  }
}
