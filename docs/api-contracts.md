# API Contracts — Internal Pipeline Contracts

## Conventions

This document defines the internal contracts between pipeline modules as TypeScript-style sketches. Signatures use `Promise<T>` for asynchronous operations. No vendor SDK type appears in any signature. Full Zod schemas land in Phase 4; this file names input schemas, output schemas, error shapes, and at least one invariant per contract.

Type identifiers reused verbatim from Phase 1 (defined in ADR-002):

- `ProviderReviewInput`
- `ProviderReviewOutput`
- `ProviderError`
- `ProviderCapabilities`

Schema identifiers introduced by Phase 2 (defined here or in the cross-referenced files):

- `WebhookIngressRequest`, `WebhookIngressResponse` — defined here.
- `JobPayload`, `JobResult` — defined here.
- `NormalizedFinding` — defined in `review-findings-schema.md`.
- `RankedFindings` — defined here (an ordered list of `NormalizedFinding`).
- `RejectionLogEntry` — defined in `review-findings-schema.md`.
- `PublicationPolicy`, `PublishContext`, `PublicationResult` — defined here.
- `ValidatorContext`, `RankerPolicy` — named here; full shapes are Phase 4.

The mode strings `dry-run`, `summary-only`, `summary-plus-inline` and the configuration default `provider: anthropic` (per OQ-1) are referenced by the publisher's `PublicationPolicy`; they are defined in `product-spec.md` and `config-spec.md` respectively. Pipeline stage names `prefilter`, `provider`, `validator`, `ranker`, `publication cap` match ADR-003 § Pipeline shape verbatim.

## Webhook ingress contract

The webhook ingress is the single externally reachable HTTP surface of the App.

- **HTTP method.** `POST`.
- **Path.** `/webhooks/github`.
- **Required headers.**
  - `X-Hub-Signature-256` — HMAC-SHA-256 over the raw request body using the App's webhook secret. Signature verification precedes any other processing.
  - `X-GitHub-Event` — the GitHub event name (e.g., `pull_request`).
  - `X-GitHub-Delivery` — the delivery UUID assigned by GitHub.
  - `Content-Type: application/json`.
- **Idempotency key derivation.** A deterministic function named `deriveIdempotencyKey` whose inputs are the `X-GitHub-Delivery` header value and the `(installation_id, repository_id, pull_request.number, head_sha)` tuple parsed from the body when the event is one of the accepted ones. Output is a deterministic string. Sketch:

  ```ts
  function deriveIdempotencyKey(input: {
    delivery_id: string;            // X-GitHub-Delivery
    installation_id: number;
    repository_id: number;
    pull_request_number: number;
    head_sha: string;
  }): string;
  ```

- **Accepted events (closed list for MVP).**
  - `pull_request.opened`
  - `pull_request.synchronize`
  - `pull_request.reopened`

  Any other event returns `2xx` and is otherwise discarded with a structured log entry naming the event type and the delivery id.

- **Response semantics.** **2xx-on-accept**: the receiver returns `2xx` only after (1) signature verification succeeds, (2) `deriveIdempotencyKey` produces a key, and (3) the job is enqueued. The 2xx budget is ≤ 1s; the pipeline (`prefilter → provider → validator → ranker → publication cap`) runs asynchronously after the 2xx is returned. Failure semantics:
  - Signature verification failure: `4xx` with a generic error code in the body. No header content is echoed.
  - Enqueue failure: `5xx` so GitHub retries the delivery.
  - Idempotency-key already seen with the same `head_sha`: `2xx`; the body's job state resolves to `discarded_idempotent` in the async layer.

- **Schemas.**
  - **Input.** `WebhookIngressRequest` — the union of the required headers and the parsed JSON body. The body is bounded to the accepted events; payloads from other events are still accepted at the HTTP layer (returning 2xx) and discarded.
  - **Output.** `WebhookIngressResponse` — `{ status: '2xx' | '4xx' | '5xx', code: string }`. No header content is echoed.

  ```ts
  type WebhookIngressRequest = {
    headers: {
      'x-hub-signature-256': string;
      'x-github-event': string;
      'x-github-delivery': string;
      'content-type': 'application/json';
    };
    raw_body: Buffer;
    parsed_body: unknown; // validated against the accepted-events schema before enqueue
  };

  type WebhookIngressResponse = {
    status: '2xx' | '4xx' | '5xx';
    code: string; // e.g., 'accepted', 'signature_invalid', 'enqueue_failed', 'discarded_other_event'
  };
  ```

- **Invariant.** No PR-visible artifact may be produced before the async job runs to completion. Signature verification precedes idempotency-key derivation, which precedes enqueue, which precedes the 2xx response.

## Async job contract

The async job is the unit of pipeline work for a single PR event.

- **`JobPayload` shape.**

  ```ts
  type JobPayload = {
    idempotency_key: string;          // output of deriveIdempotencyKey
    installation_id: number;
    repository_id: number;
    pull_request_number: number;
    head_sha: string;
    event_type: 'pull_request.opened' | 'pull_request.synchronize' | 'pull_request.reopened';
    received_at: string;              // ISO-8601
  };
  ```

  No raw provider credentials, App private key material, or webhook secret material is permitted in the payload. Installation tokens are minted at job execution time, not embedded in the payload.

- **Idempotency key.** Equal to the `deriveIdempotencyKey` output produced by the ingress. The async layer maintains a per-key state record so that a job with a previously seen `idempotency_key` and the same `head_sha` resolves to `discarded_idempotent` without performing any provider call.

- **Retry policy class.** Retries are described as a class, not as numbers (specific counts and intervals are Phase 3):
  - `ProviderError` variants classified as **transient** are retried with bounded exponential backoff: `transport`, `rate_limit`.
  - `ProviderError` variants classified as **non-transient** fail terminally: `auth`, `capability`, `schema_validation`.
  - Enqueue/transport errors at the GitHub API boundary are transient and retried with bounded exponential backoff.

- **Terminal states (closed list).**
  - `succeeded` — the pipeline ran to completion. `JobResult.publication_result` is non-null when the publisher produced any artifact (Checks run, inline comments).
  - `failed_terminal` — a non-transient error terminated the pipeline; an audit entry is written.
  - `discarded_idempotent` — a previously seen idempotency key short-circuited the job.

- **Schemas.**

  ```ts
  type JobResult = {
    state: 'succeeded' | 'failed_terminal' | 'discarded_idempotent';
    publication_result: PublicationResult | null;
    rejections: RejectionLogEntry[];
    failure_reason_code: string | null;  // present iff state === 'failed_terminal'
  };
  ```

- **Invariant.** A job with a previously seen `idempotency_key` and identical `head_sha` resolves to `discarded_idempotent` without performing any provider call.

## Provider adapter contract

The provider adapter is the only place a vendor SDK is imported. The first reference adapter (per OQ-1) is the Anthropic Claude adapter located at `packages/providers/anthropic`. No Anthropic-specific type is exported from that package.

- **Signature.**

  ```ts
  interface Provider {
    review(input: ProviderReviewInput): Promise<ProviderReviewOutput>;
    capabilities(): ProviderCapabilities;
  }
  ```

- **Error union.** `ProviderError` (Phase 1 identifier) covers, at minimum: `transport`, `auth`, `rate_limit`, `capability`, `schema_validation`. The adapter throws `ProviderError`; no vendor exception escapes.

- **Capability flags.** `ProviderCapabilities` (Phase 1 identifier). The pipeline reads capabilities; it does not rediscover them.

- **Invariant.** No vendor SDK type leaks into or out of `review`. The adapter at `packages/providers/anthropic` exports only the `Provider` interface and the Phase-2/Phase-1 schemas; no Anthropic SDK type, response shape, or error class crosses the package boundary.

## Validator contract

The validator consumes `ProviderReviewOutput` and produces a list of `NormalizedFinding` plus a list of `RejectionLogEntry`.

- **Signature.**

  ```ts
  function validate(
    output: ProviderReviewOutput,
    ctx: ValidatorContext
  ): {
    findings: NormalizedFinding[];
    rejections: RejectionLogEntry[];
  };
  ```

- **`ValidatorContext`.** Carries the prefiltered diff context (selected file paths, hunk records with line ranges, language tags) and the `repo_heuristics` flags from the resolved configuration. Field-by-field shape is declared in Phase 4; this contract names the type.

- **Rejection log shape.** `RejectionLogEntry` (defined in `review-findings-schema.md`) with `stage = 'validator'`. Reason codes include at minimum `path_not_in_diff`, `line_outside_hunk`, `evidence_unverifiable`, `provider_output_zod_failed`.

- **Invariant.** Every emitted `NormalizedFinding` has `path` present in the prefiltered diff and `[line_start, line_end]` within a touched hunk; otherwise the finding is rejected with a `RejectionLogEntry` whose `stage` is `validator`.

## Ranker contract

The ranker orders findings; it does not drop them.

- **Signature.**

  ```ts
  type RankedFindings = NormalizedFinding[]; // ordered, highest-priority first

  function rank(
    findings: NormalizedFinding[],
    policy: RankerPolicy
  ): RankedFindings;
  ```

- **`RankerPolicy`.** Declares the ordering signal: severity weight, category weight, confidence weight. Sourced from configuration (in particular `severity` overrides and `repo_heuristics` flags from `config-spec.md`). Specific weight values are Phase 4.

- **Invariant.** `rank` does not drop findings. It orders them and may set `render_target` to `summary` for findings unlikely to be inline-publishable, but never to `dropped`. The publisher is the only stage that may set `render_target = 'dropped'`.

## Publisher contract

The publisher consumes `RankedFindings` and applies the deterministic ruleset defined in `publication-policy.md`.

- **Signature.**

  ```ts
  function publish(
    ranked: RankedFindings,
    ctx: PublishContext,
    policy: PublicationPolicy
  ): Promise<PublicationResult>;
  ```

- **`PublicationPolicy`.** The resolved-config view consumed by the publisher:

  ```ts
  type PublicationPolicy = {
    mode: 'dry-run' | 'summary-only' | 'summary-plus-inline';
    comment_cap: { per_pr: number; per_file: number };
    thresholds: {
      severity_floor: { inline: 'info' | 'low' | 'medium' | 'high' | 'critical' };
      confidence_floor: { inline: number };
    };
    dedupe_state: {
      already_published_dedupe_keys: string[]; // sourced from prior Checks runs / inline comments on this PR
    };
  };
  ```

  The keys (`mode`, `comment_cap`, `thresholds`) and their value vocabularies match `config-spec.md` § Key reference. The rules the policy enforces live in `publication-policy.md`; this contract only declares the shape.

- **`PublishContext`.** Identifies the target PR and the App credentials needed to author Checks runs and inline review comments:

  ```ts
  type PublishContext = {
    installation_id: number;
    repository_id: number;
    pull_request_number: number;
    head_sha: string;
  };
  ```

- **`PublicationResult`.**

  ```ts
  type PublicationResult = {
    published_inline: NormalizedFinding[];
    published_summary: NormalizedFinding[];
    dropped: NormalizedFinding[];
    rejections: RejectionLogEntry[];
    checks_run_id: string;        // populated when a Checks run is created
    summary_artifact: string;     // Markdown body sent to the Checks run
  };
  ```

- **Invariants.**
  - `published_inline.length <= policy.comment_cap.per_pr`.
  - For every file `p`, the count of items in `published_inline` whose `path === p` is `<= policy.comment_cap.per_file`.
  - Every item in `dropped` has at least one matching `RejectionLogEntry` in `rejections` with the same `finding_id` and `stage = 'publisher'`.

## GitHub interactions (named, no curl)

The publisher and supporting layers interact with public GitHub APIs at the following named surfaces. No URL or `curl` example is reproduced here; precise endpoint paths and request bodies are to be confirmed against current GitHub documentation in Phase 4.

- **GitHub Checks API** — used to create a Check run on the PR's `head_sha`, attach the rendered Markdown summary, attach per-line annotations where applicable, and update the Check run's conclusion (`success`, `neutral`, `failure`) at end of run. (verify against current GitHub docs in Phase 4)
- **GitHub Pull Request Review Comments API** — used to create line-anchored review comments when `mode = summary-plus-inline`. The publisher uses this surface only for findings whose `render_target = inline` after caps and thresholds have been applied. (verify against current GitHub docs in Phase 4)
- **GitHub Pull Requests API** — used to read PR metadata (diff, `head_sha`, base ref) when needed by the prefilter or by dedupe lookups. (verify against current GitHub docs in Phase 4)
- **GitHub Installations API** — used to mint installation tokens at job execution time, scoped by the App manifest's declared permissions. (verify against current GitHub docs in Phase 4)

## Invariants and error semantics

The per-contract invariants above are aggregated here as a numbered list:

1. No vendor SDK type appears outside `packages/providers/<adapter>`. The Anthropic adapter at `packages/providers/anthropic` is the only place an Anthropic SDK type is referenced; downstream code sees only `ProviderReviewInput`, `ProviderReviewOutput`, `ProviderError`, and `ProviderCapabilities`.
2. Webhook signature verification precedes idempotency-key derivation, which precedes enqueue, which precedes the 2xx response. No PR-visible artifact is produced before the async job runs to completion.
3. A job with a previously seen `idempotency_key` and identical `head_sha` resolves to `discarded_idempotent` without performing any provider call.
4. Every emitted `NormalizedFinding` has `path` in the prefiltered diff and `[line_start, line_end]` within a touched hunk; otherwise it is rejected with a `RejectionLogEntry` whose `stage = 'validator'`.
5. The ranker never sets `render_target = 'dropped'` and never drops findings; only the publisher may.
6. `published_inline.length <= comment_cap.per_pr`, and the per-file count is `<= comment_cap.per_file`.
7. Every dropped `NormalizedFinding` is accompanied by exactly one `RejectionLogEntry` with a `stage` and a `reason_code`.
8. If `ProviderReviewOutput` fails Zod validation at the adapter boundary, no `NormalizedFinding` is emitted for that PR; the job terminates with `failed_terminal` and an audit entry (`stage = 'validator'`, `reason_code = 'provider_output_zod_failed'`, or — when the failure is at the adapter boundary itself — `stage = 'validator'` with the same reason code referencing the adapter-side rejection).
9. The accepted-events list in the webhook ingress is the closed set `{pull_request.opened, pull_request.synchronize, pull_request.reopened}`; any other event returns 2xx and is otherwise discarded.
