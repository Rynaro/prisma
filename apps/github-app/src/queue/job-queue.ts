import {
  type JobPayload,
  ProviderErrorThrowable,
  type PublicationResult,
} from '@prisma-bot/shared';

/**
 * `JobQueue` — the boundary between the Fastify webhook ingress (which owns
 * the request/response cycle) and the worker pipeline (which owns the
 * BullMQ-backed retry loop). Implements `docs/system-design.md` § Queue and
 * async model § JobQueue interface.
 *
 * Two implementations live alongside this contract:
 *   - `BullMqJobQueue` / `BullMqJobConsumer` (production, this slice).
 *   - `InMemoryJobQueue` / `InMemoryJobConsumer` (tests; the e2e harness
 *     consumes the handler synchronously inside `enqueue`).
 *
 * The `idempotency_key` carried in the `JobPayload` is the unique BullMQ
 * job id. Re-enqueuing the same key short-circuits to a `duplicate` outcome
 * per `docs/api-contracts.md` § Async job contract: terminal states are
 * `succeeded | failed_terminal | discarded_idempotent`, and the duplicate
 * branch maps to `discarded_idempotent` at the consumer layer.
 */

export interface EnqueueResult {
  enqueued: boolean;
  idempotency_key: string;
  reason?: 'duplicate';
}

export interface JobQueue {
  /**
   * Enqueue a JobPayload using its derived idempotency key as the unique
   * job id. Returns `enqueued: false` with `reason: 'duplicate'` if a job
   * with the same id already exists (active or completed).
   */
  enqueue(payload: JobPayload): Promise<EnqueueResult>;
  /** Close any underlying connections. Used by main.ts on SIGTERM and by tests. */
  close(): Promise<void>;
}

/**
 * `JobOutcome` mirrors `docs/api-contracts.md` § Async job contract terminal
 * states. The handler returned to the queue framework reports the outcome;
 * the framework does not interpret the inner `result`.
 */
export type JobOutcome =
  | { state: 'succeeded'; result: PublicationResult }
  | { state: 'failed_terminal'; reason: string }
  | { state: 'discarded_idempotent' };

export type JobHandler = (payload: JobPayload) => Promise<JobOutcome>;

export interface JobConsumer {
  /**
   * Run until `close()` is called. Handler errors are classified per the
   * retry policy and re-thrown so the underlying framework (BullMQ) can
   * apply backoff + attempt accounting.
   */
  run(handler: JobHandler): Promise<void>;
  close(): Promise<void>;
}

/**
 * Retry policy classes per `docs/system-design.md` § Error taxonomy mapping:
 *   - `transient`     → retry with exponential backoff bounded by
 *                       `RETRY_TRANSIENT_MAX_ATTEMPTS`.
 *   - `rate_limited`  → retry per `RETRY_RATELIMIT_MAX_ATTEMPTS`; honour
 *                       `Retry-After` when the provider supplies it.
 *   - `non_transient` → terminal; do not retry.
 */
export type RetryClass = 'transient' | 'rate_limited' | 'non_transient';

/**
 * Classify an unknown thrown value into a retry class.
 *
 * Mapping matrix (`docs/system-design.md` § Error taxonomy mapping):
 *   - `ProviderErrorThrowable.kind === 'transport'`         → transient
 *   - `ProviderErrorThrowable.kind === 'rate_limit'`        → rate_limited
 *   - `ProviderErrorThrowable.kind ∈ {auth, capability, schema_validation}`
 *                                                           → non_transient
 *   - Anything else (raw `Error`, non-Error throw, network fault)
 *                                                           → transient
 *
 * Defaulting to `transient` for unknowns is deliberate: the spec requires
 * non-transient classification to be explicit. Unknown faults are typically
 * network-shaped (DNS, socket) and are safe to retry.
 */
export const classifyRetry = (err: unknown): RetryClass => {
  if (err instanceof ProviderErrorThrowable) {
    switch (err.value.kind) {
      case 'transport':
        return 'transient';
      case 'rate_limit':
        return 'rate_limited';
      case 'auth':
      case 'capability':
      case 'schema_validation':
        return 'non_transient';
    }
  }
  return 'transient';
};

/** Canonical queue name across all implementations (`docs/system-design.md`). */
export const QUEUE_NAME = 'pr-review';
