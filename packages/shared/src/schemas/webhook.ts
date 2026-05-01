import { z } from 'zod';

/**
 * `WebhookIngressRequest` and `WebhookIngressResponse` per
 * docs/api-contracts.md § Webhook ingress contract.
 *
 * The schema mirrors the TypeScript sketch in the spec verbatim. `raw_body` is a
 * Node Buffer at runtime; we use `z.instanceof(Buffer)` for the structural guard
 * so the schema can validate parsed/structured ingress requests in tests and at
 * the route boundary (signature verification consumes the buffer separately).
 */

export const WebhookIngressHeadersSchema = z
  .object({
    'x-hub-signature-256': z.string().min(1),
    'x-github-event': z.string().min(1),
    'x-github-delivery': z.string().min(1),
    'content-type': z.literal('application/json'),
  })
  .strict();
export type WebhookIngressHeaders = z.infer<typeof WebhookIngressHeadersSchema>;

export const WebhookIngressRequestSchema = z
  .object({
    headers: WebhookIngressHeadersSchema,
    raw_body: z.instanceof(Buffer),
    parsed_body: z.unknown(),
  })
  .strict();
export type WebhookIngressRequest = z.infer<typeof WebhookIngressRequestSchema>;

export const WebhookIngressStatusSchema = z.enum(['2xx', '4xx', '5xx']);
export type WebhookIngressStatus = z.infer<typeof WebhookIngressStatusSchema>;

export const WebhookIngressResponseSchema = z
  .object({
    status: WebhookIngressStatusSchema,
    code: z.string().min(1),
  })
  .strict();
export type WebhookIngressResponse = z.infer<typeof WebhookIngressResponseSchema>;
