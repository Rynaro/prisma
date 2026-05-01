import type { ProviderError } from '@prisma-bot/shared';

/**
 * `mapAnthropicError` — translates an unknown thrown value (typically from the
 * Anthropic SDK) into a vendor-neutral `ProviderError` value.
 *
 * Hard rule (api-contracts.md § Invariants and error semantics, item 1 and
 * threat-model.md § Token/cost blowups): the returned `message` MUST NOT
 * contain the API key or any allow-list-failing header. We only read fields we
 * recognize as safe (`message`, `status`, `error.type`, response status, the
 * `Retry-After` header value when numeric).
 *
 * Mapping (from spec):
 *   - network / timeout / connection           → `transport`, retryable: true
 *   - HTTP 401, 403                             → `auth`
 *   - HTTP 429                                  → `rate_limit` (with retry_after_ms)
 *   - HTTP 5xx                                  → `transport`, retryable: true
 *   - HTTP 400 with invalid model / capability  → `capability`
 *   - anything else                             → `transport`, retryable: false
 */

const SAFE_MESSAGE_FALLBACK = 'anthropic provider error';
const FORBIDDEN_TOKENS = ['authorization', 'bearer', 'x-api-key', 'api-key'];

function safeMessage(raw: unknown): string {
  if (typeof raw !== 'string') {
    return SAFE_MESSAGE_FALLBACK;
  }
  const lower = raw.toLowerCase();
  for (const token of FORBIDDEN_TOKENS) {
    if (lower.includes(token)) {
      return SAFE_MESSAGE_FALLBACK;
    }
  }
  // Cap message length so we never accidentally surface large bodies in logs.
  if (raw.length > 500) {
    return `${raw.slice(0, 500)}...`;
  }
  return raw;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}

function readStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const record = err as Record<string, unknown>;
  const direct = readNumber(record.status);
  if (direct !== undefined) {
    return direct;
  }
  const responseRaw = record.response;
  if (typeof responseRaw === 'object' && responseRaw !== null) {
    const responseRecord = responseRaw as Record<string, unknown>;
    const responseStatus = readNumber(responseRecord.status);
    if (responseStatus !== undefined) {
      return responseStatus;
    }
  }
  return undefined;
}

function readErrorType(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const record = err as Record<string, unknown>;
  const errorField = record.error;
  if (typeof errorField === 'object' && errorField !== null) {
    const errRecord = errorField as Record<string, unknown>;
    const inner = errRecord.error;
    if (typeof inner === 'object' && inner !== null) {
      const innerRecord = inner as Record<string, unknown>;
      const t = innerRecord.type;
      if (typeof t === 'string') {
        return t;
      }
    }
    const t = errRecord.type;
    if (typeof t === 'string') {
      return t;
    }
  }
  return undefined;
}

function readRawMessage(err: unknown): string | undefined {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  if (typeof err === 'object' && err !== null) {
    const record = err as Record<string, unknown>;
    const m = record.message;
    if (typeof m === 'string') {
      return m;
    }
  }
  return undefined;
}

function readRetryAfterMs(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const record = err as Record<string, unknown>;
  const headersRaw = record.headers;
  let retryAfter: unknown;
  if (typeof headersRaw === 'object' && headersRaw !== null) {
    const headersRecord = headersRaw as Record<string, unknown>;
    retryAfter = headersRecord['retry-after'] ?? headersRecord['Retry-After'];
  }
  if (retryAfter === undefined) {
    const responseRaw = record.response;
    if (typeof responseRaw === 'object' && responseRaw !== null) {
      const responseRecord = responseRaw as Record<string, unknown>;
      const responseHeadersRaw = responseRecord.headers;
      if (typeof responseHeadersRaw === 'object' && responseHeadersRaw !== null) {
        const responseHeadersRecord = responseHeadersRaw as Record<string, unknown>;
        retryAfter = responseHeadersRecord['retry-after'] ?? responseHeadersRecord['Retry-After'];
      }
    }
  }
  const seconds = readNumber(retryAfter);
  if (seconds === undefined) {
    return undefined;
  }
  return Math.max(0, Math.floor(seconds * 1000));
}

function isNetworkOrTimeoutError(err: unknown, status: number | undefined): boolean {
  if (status !== undefined) {
    return false;
  }
  const message = readRawMessage(err)?.toLowerCase() ?? '';
  if (message.includes('timeout') || message.includes('timed out')) {
    return true;
  }
  if (message.includes('econnrefused') || message.includes('econnreset')) {
    return true;
  }
  if (message.includes('network') || message.includes('socket hang up')) {
    return true;
  }
  if (message.includes('etimedout') || message.includes('enotfound')) {
    return true;
  }
  if (typeof err === 'object' && err !== null) {
    const record = err as Record<string, unknown>;
    const code = record.code;
    if (typeof code === 'string') {
      const lower = code.toLowerCase();
      if (
        lower === 'econnrefused' ||
        lower === 'econnreset' ||
        lower === 'etimedout' ||
        lower === 'enotfound'
      ) {
        return true;
      }
    }
  }
  return false;
}

export function mapAnthropicError(err: unknown): ProviderError {
  const status = readStatus(err);
  const rawMessage = readRawMessage(err);
  const safe = safeMessage(rawMessage);

  if (isNetworkOrTimeoutError(err, status)) {
    return { kind: 'transport', message: safe, retryable: true };
  }

  if (status === 401 || status === 403) {
    return { kind: 'auth', message: safe };
  }

  if (status === 429) {
    const retryAfterMs = readRetryAfterMs(err);
    const out: ProviderError = { kind: 'rate_limit', message: safe, retryable: true };
    if (retryAfterMs !== undefined) {
      out.retry_after_ms = retryAfterMs;
    }
    return out;
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return { kind: 'transport', message: safe, retryable: true };
  }

  if (status === 400) {
    const type = readErrorType(err);
    const lowerMessage = (rawMessage ?? '').toLowerCase();
    const looksLikeCapability =
      type === 'invalid_request_error' &&
      (lowerMessage.includes('model') ||
        lowerMessage.includes('unsupported') ||
        lowerMessage.includes('capability') ||
        lowerMessage.includes('tool'));
    if (looksLikeCapability) {
      return { kind: 'capability', message: safe };
    }
    return { kind: 'transport', message: safe, retryable: false };
  }

  return { kind: 'transport', message: safe, retryable: false };
}
