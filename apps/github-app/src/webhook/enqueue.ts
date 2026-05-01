import type { JobPayload } from '@prisma-bot/shared';

/**
 * `EnqueueJob` is the dependency-injected boundary the route uses to enqueue
 * a `JobPayload` (Phase 2 schema, with the Phase 3 additive `traceparent`).
 *
 * @deprecated for production: use `BullMqJobQueue.enqueue` from
 * `apps/github-app/src/queue/index.ts`. The `createNoopEnqueueJob` factory
 * below is retained as a placeholder for tests that need a non-functional
 * enqueue stub.
 */

export interface EnqueueResult {
  enqueued: boolean;
  idempotency_key: string;
  reason?: 'duplicate' | 'pending_phase_5_5';
}

export type EnqueueJob = (payload: JobPayload) => Promise<EnqueueResult>;

/**
 * @deprecated use `InMemoryJobQueue.enqueue` for tests; production wiring
 * uses `BullMqJobQueue` (see `apps/github-app/src/main.ts`). Retained as a
 * placeholder so callers that haven't migrated still compile.
 */
export const createNoopEnqueueJob = (): EnqueueJob => {
  return async (payload) => ({
    enqueued: false,
    idempotency_key: payload.idempotency_key,
    reason: 'pending_phase_5_5',
  });
};
