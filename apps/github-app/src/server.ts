import { JobPayloadSchema, WebhookIngressRequestSchema } from '@prisma-bot/shared';
import type { JobPayload } from '@prisma-bot/shared';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import type { EnqueueJob } from './webhook/enqueue.js';
import { isAcceptedEvent } from './webhook/event-filter.js';
import { deriveIdempotencyKey } from './webhook/idempotency.js';
import type { ReplayCache } from './webhook/replay-cache.js';
import { verifySignature } from './webhook/signature.js';

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'prisma-review-bot';
const DEFAULT_BODY_LIMIT_BYTES = 10 * 1024 * 1024; // 10 MB

export interface BuildServerOptions {
  // Resolved per-request via the SecretSource boundary (system-design.md
  // § Secret storage abstraction). The function may return a string or
  // a Promise<string> so secret managers with async lookups are supported.
  webhookSecret: () => Promise<string> | string;
  replayCache: ReplayCache;
  enqueueJob: EnqueueJob;
  logger?: FastifyBaseLogger;
  // Default 10 MB; the route fails closed on oversize with 413.
  bodyLimit?: number;
}

interface ParsedJsonBody {
  parsed: unknown;
  raw: Buffer;
}

interface PullRequestEnvelope {
  installation: { id: number };
  repository: { id: number };
  pull_request: { number: number; head: { sha: string } };
  action?: string;
}

const isPullRequestEnvelope = (value: unknown): value is PullRequestEnvelope => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  const installation = v.installation as { id?: unknown } | undefined;
  const repository = v.repository as { id?: unknown } | undefined;
  const pullRequest = v.pull_request as { number?: unknown; head?: { sha?: unknown } } | undefined;
  if (!installation || typeof installation.id !== 'number') return false;
  if (!repository || typeof repository.id !== 'number') return false;
  if (!pullRequest || typeof pullRequest.number !== 'number') return false;
  if (!pullRequest.head || typeof pullRequest.head.sha !== 'string') return false;
  return true;
};

const eventTypeFor = (action: string): JobPayload['event_type'] => {
  switch (action) {
    case 'opened':
      return 'pull_request.opened';
    case 'synchronize':
      return 'pull_request.synchronize';
    case 'reopened':
      return 'pull_request.reopened';
    default:
      // The route gates on isAcceptedEvent before reaching this function;
      // any unexpected action here is a programming error, not a runtime
      // input error.
      throw new Error(`unexpected accepted action: ${action}`);
  }
};

/**
 * Audit-log emitter restricted to the explicit field set per
 * docs/observability.md § Top-level fields and § Redaction allowlist.
 *
 * The function only forwards the named fields; it never spreads an
 * arbitrary context object, so secret-shaped values cannot accidentally
 * appear in a log payload.
 */
interface AuditLogFields {
  installation_id?: number;
  repository_id?: number;
  pull_request_number?: number;
  idempotency_key?: string;
  payload?: Record<string, unknown>;
}

const emitAudit = (
  log: FastifyBaseLogger,
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: AuditLogFields,
): void => {
  const entry: Record<string, unknown> = { event };
  if (fields.installation_id !== undefined) entry.installation_id = fields.installation_id;
  if (fields.repository_id !== undefined) entry.repository_id = fields.repository_id;
  if (fields.pull_request_number !== undefined)
    entry.pull_request_number = fields.pull_request_number;
  if (fields.idempotency_key !== undefined) entry.idempotency_key = fields.idempotency_key;
  if (fields.payload !== undefined) entry.payload = fields.payload;
  log[level](entry);
};

export const buildServer = (opts: BuildServerOptions) => {
  const bodyLimit = opts.bodyLimit ?? DEFAULT_BODY_LIMIT_BYTES;

  // Fastify's logger option accepts either pino options or a pre-built
  // logger; the pre-built-logger overload is typed differently. We branch
  // explicitly so the constructor's overload set picks the right shape.
  const app = opts.logger
    ? Fastify({ bodyLimit, loggerInstance: opts.logger })
    : Fastify({
        bodyLimit,
        logger: {
          level: process.env.LOG_LEVEL ?? 'info',
          formatters: {
            level: (label) => ({ level: label }),
          },
          timestamp: () => `,"ts":"${new Date().toISOString()}"`,
          base: { service: SERVICE_NAME },
        },
      });

  // Capture the raw body alongside the parsed JSON. Fastify's default JSON
  // parser drops the raw bytes; HMAC verification requires them, so we
  // register a replacement that retains both.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    const buffer = body as Buffer;
    try {
      const parsed = buffer.length === 0 ? {} : JSON.parse(buffer.toString('utf8'));
      const result: ParsedJsonBody = { parsed, raw: buffer };
      done(null, result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('invalid JSON');
      // Fastify maps thrown content-type-parser errors to 400.
      done(error, undefined);
    }
  });

  app.get('/healthz/live', async () => ({ status: 'ok' }));

  app.get('/healthz/ready', async () => ({ status: 'ok' }));

  app.get('/healthz/deps', async () => ({
    status: 'ok',
    dependencies: {
      redis: 'unchecked',
      github: 'unchecked',
      provider: 'unchecked',
    },
  }));

  // The webhook ingress: 2xx-on-accept budget ≤ 1s per
  // docs/api-contracts.md § Webhook ingress contract. All I/O on this
  // path — signature verify, replay cache check, enqueue — must complete
  // within ~1s. The replay cache and enqueue paths are async but
  // expected to be sub-100ms; if they're slow, that's a follow-up.
  app.post('/webhooks/github', async (request, reply) => {
    const log = request.log;
    const contentType = request.headers['content-type'];
    const deliveryHeader = request.headers['x-github-delivery'];
    const eventHeader = request.headers['x-github-event'];
    const signatureHeader = request.headers['x-hub-signature-256'];
    const traceparentHeader = request.headers.traceparent;

    const deliveryId = typeof deliveryHeader === 'string' ? deliveryHeader : undefined;
    const eventName = typeof eventHeader === 'string' ? eventHeader : undefined;
    const signatureValue = typeof signatureHeader === 'string' ? signatureHeader : undefined;
    const traceparent = typeof traceparentHeader === 'string' ? traceparentHeader : undefined;

    if (
      typeof contentType !== 'string' ||
      !contentType.toLowerCase().startsWith('application/json')
    ) {
      emitAudit(log, 'warn', 'webhook.invalid_content_type', {
        payload: { delivery_id: deliveryId ?? null, content_type: contentType ?? null },
      });
      return reply.code(400).send({ ok: false, reason: 'invalid_content_type' });
    }

    const body = request.body as ParsedJsonBody | undefined;
    if (!body || !Buffer.isBuffer(body.raw)) {
      emitAudit(log, 'warn', 'webhook.invalid_request', {
        payload: { delivery_id: deliveryId ?? null, reason: 'missing_body' },
      });
      return reply.code(400).send({ ok: false, reason: 'invalid_request' });
    }

    let secret: string;
    try {
      secret = await opts.webhookSecret();
    } catch (err) {
      emitAudit(log, 'error', 'webhook.secret_unavailable', {
        payload: {
          delivery_id: deliveryId ?? null,
          message: err instanceof Error ? err.message : 'unknown',
        },
      });
      return reply.code(500).send({ accepted: false });
    }

    const verification = verifySignature({
      rawBody: body.raw,
      signatureHeader: signatureValue,
      secret,
    });

    if (!verification.ok) {
      emitAudit(log, 'warn', 'webhook.signature_failed', {
        payload: {
          delivery_id: deliveryId ?? null,
          event_type: eventName ?? null,
          reason: verification.reason,
        },
      });
      return reply.code(401).send({ ok: false, reason: verification.reason });
    }

    const ingressParse = WebhookIngressRequestSchema.safeParse({
      headers: {
        'x-hub-signature-256': signatureValue,
        'x-github-event': eventName,
        'x-github-delivery': deliveryId,
        'content-type': 'application/json',
      },
      raw_body: body.raw,
      parsed_body: body.parsed,
    });

    if (!ingressParse.success) {
      emitAudit(log, 'warn', 'webhook.invalid_request', {
        payload: {
          delivery_id: deliveryId ?? null,
          issues: ingressParse.error.issues.map((issue) => ({
            path: issue.path,
            code: issue.code,
            message: issue.message,
          })),
        },
      });
      return reply.code(400).send({ ok: false, reason: 'invalid_request' });
    }

    const parsedBody = body.parsed;
    const action =
      typeof parsedBody === 'object' &&
      parsedBody !== null &&
      typeof (parsedBody as { action?: unknown }).action === 'string'
        ? ((parsedBody as { action: string }).action as string)
        : undefined;

    if (!isAcceptedEvent(eventName, action)) {
      emitAudit(log, 'info', 'webhook.event_ignored', {
        payload: {
          delivery_id: deliveryId ?? null,
          event_type: eventName ?? null,
          action: action ?? null,
        },
      });
      return reply.code(202).send({ accepted: false, ignored: true });
    }

    if (!isPullRequestEnvelope(parsedBody)) {
      emitAudit(log, 'warn', 'webhook.invalid_request', {
        payload: {
          delivery_id: deliveryId ?? null,
          reason: 'envelope_missing_fields',
        },
      });
      return reply.code(400).send({ ok: false, reason: 'invalid_request' });
    }

    const installationId = parsedBody.installation.id;
    const repositoryId = parsedBody.repository.id;
    const pullRequestNumber = parsedBody.pull_request.number;
    const headSha = parsedBody.pull_request.head.sha;

    // delivery_id is required for replay-protection and idempotency-key
    // derivation. The Zod schema enforces presence above, so this branch
    // is defensive against future schema relaxation.
    if (deliveryId === undefined) {
      emitAudit(log, 'warn', 'webhook.invalid_request', {
        payload: { reason: 'missing_delivery_id' },
      });
      return reply.code(400).send({ ok: false, reason: 'invalid_request' });
    }

    const idempotencyKey = deriveIdempotencyKey({
      installation_id: installationId,
      repository_id: repositoryId,
      pull_request_number: pullRequestNumber,
      head_sha: headSha,
      delivery_id: deliveryId,
    });

    const isReplay = await opts.replayCache.isReplay(installationId, deliveryId);
    if (isReplay) {
      emitAudit(log, 'info', 'webhook.discarded_idempotent', {
        installation_id: installationId,
        repository_id: repositoryId,
        pull_request_number: pullRequestNumber,
        idempotency_key: idempotencyKey,
        payload: {
          delivery_id: deliveryId,
          event_type: eventName ?? null,
        },
      });
      return reply.code(202).send({
        accepted: true,
        idempotency_key: idempotencyKey,
        status: 'discarded_idempotent',
      });
    }

    // Build the JobPayload per docs/api-contracts.md § Async job contract;
    // include `traceparent` if the header is present (Phase 3 additive
    // extension — system-design.md § Cross-cutting concerns).
    const jobPayload: JobPayload = {
      idempotency_key: idempotencyKey,
      installation_id: installationId,
      repository_id: repositoryId,
      pull_request_number: pullRequestNumber,
      head_sha: headSha,
      event_type: eventTypeFor(action ?? ''),
      received_at: new Date().toISOString(),
      ...(traceparent !== undefined ? { traceparent } : {}),
    };

    // Validate the payload against the canonical schema; this is a
    // last-mile guard so we never enqueue a payload that violates the
    // Phase 5.1 schema invariants.
    const payloadParse = JobPayloadSchema.safeParse(jobPayload);
    if (!payloadParse.success) {
      emitAudit(log, 'error', 'webhook.invalid_request', {
        installation_id: installationId,
        repository_id: repositoryId,
        pull_request_number: pullRequestNumber,
        idempotency_key: idempotencyKey,
        payload: {
          delivery_id: deliveryId,
          issues: payloadParse.error.issues.map((issue) => ({
            path: issue.path,
            code: issue.code,
            message: issue.message,
          })),
        },
      });
      return reply.code(400).send({ ok: false, reason: 'invalid_request' });
    }

    emitAudit(log, 'info', 'webhook.received', {
      installation_id: installationId,
      repository_id: repositoryId,
      pull_request_number: pullRequestNumber,
      idempotency_key: idempotencyKey,
      payload: {
        delivery_id: deliveryId,
        event_type: eventName,
      },
    });

    try {
      await opts.enqueueJob(payloadParse.data);
    } catch (err) {
      emitAudit(log, 'error', 'webhook.enqueue_failed', {
        installation_id: installationId,
        repository_id: repositoryId,
        pull_request_number: pullRequestNumber,
        idempotency_key: idempotencyKey,
        payload: {
          delivery_id: deliveryId,
          message: err instanceof Error ? err.message : 'unknown',
        },
      });
      return reply.code(500).send({ accepted: false });
    }

    emitAudit(log, 'info', 'job.enqueued', {
      installation_id: installationId,
      repository_id: repositoryId,
      pull_request_number: pullRequestNumber,
      idempotency_key: idempotencyKey,
      payload: { head_sha: headSha },
    });

    await opts.replayCache.remember(installationId, deliveryId);

    return reply.code(202).send({ accepted: true, idempotency_key: idempotencyKey });
  });

  // Fastify's body-limit guard fires before the content-type parser; map the
  // standard payload-too-large error code to our audit event so operators can
  // see oversize attempts.
  app.setErrorHandler((error, request, reply) => {
    if (error.statusCode === 413) {
      emitAudit(request.log, 'warn', 'webhook.body_too_large', {
        payload: { url: request.url },
      });
      return reply.code(413).send({ ok: false, reason: 'body_too_large' });
    }
    request.log.error({ event: 'http.error', err: error.message }, 'unhandled error');
    return reply
      .code(error.statusCode ?? 500)
      .send({ ok: false, reason: error.code ?? 'internal_error' });
  });

  return app;
};
