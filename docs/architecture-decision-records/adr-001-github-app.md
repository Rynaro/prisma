# ADR-001 — Deliver as a GitHub App

## Status

Accepted — 2026-04-30. ADRs are immutable once accepted; superseding decisions require a new ADR that explicitly references this one.

## Context

Operating principle 1 of the originating brief states: "GitHub App first, not GitHub Action first." This ADR records the decision that locks that principle into the architecture and makes it costly to silently drift.

The integration-surface findings in `research-summary.md` (`### GitHub App vs GitHub Action`) contrast the two deployment shapes on token model, Checks API richness, rate-limit isolation, multi-repo install UX, and webhook ownership. Those findings are the empirical basis for the decision below; they are not re-derived here.

The product target is an advisory, non-blocking AI code reviewer that posts findings on PRs across multiple repositories and installations, vendor-independent at the model layer, with predictable trust posture. Both token and identity model matter for that target.

## Decision

We will deliver this product as a GitHub App.

## Rationale

The App model gives us, at minimum:

- **Checks API richness.** A stable App identity owns the Checks runs it creates and can update them, surface annotations, and present advisory findings as Checks output rather than as inline comment noise.
- **Installation token model.** Permissions are declared in the App manifest and minted per-installation as installation tokens, rather than tied to a per-workflow `GITHUB_TOKEN` whose scopes vary by repo and by job.
- **App-level rate-limit isolation.** Apps have rate limits applied to their installation tokens, isolated from a repository's other Actions usage and `GITHUB_TOKEN` activity. This protects review throughput from being starved by unrelated CI load.
- **Multi-repo installability.** A single App can be installed at the organization level and applied to many repositories without per-repo workflow edits.
- **Webhook ownership.** The App receives events at its own endpoint, decoupled from any individual repo's CI configuration; the receiver is ours to control and instrument.

## Trade-offs

Choosing the App model has known costs that we accept:

- **Setup friction.** Installing a GitHub App takes more steps than referencing a published Action in a workflow file, particularly for repos that already standardize on Actions.
- **Hosting requirement.** We must host the webhook receiver and its worker(s); there is no zero-infrastructure delivery path comparable to "publish an Action and let users add a job."
- **Key and secret management.** App private keys, webhook secrets, and provider credentials must be stored in a managed secret store and rotated; this is a real operational obligation rather than a configuration line in a workflow file.

## Rejected alternatives

### GitHub Action

- **Alternative.** Ship as a GitHub Action that consumers add to their PR workflows.
- **Why considered.** Lower onboarding friction for repos that already use Actions; no separate hosting required since execution rides on the consumer's runners.
- **Why rejected.** Weaker Checks UX in this usage shape (Checks attributed to the Actions identity in the consuming repo's workflow context rather than to a stable third-party App identity); per-workflow `GITHUB_TOKEN` constraints make permission management repo-by-repo; repo-by-repo configuration in workflow files produces config sprawl across an organization; rate-limit coupling to repo-level Actions runners means review throughput shares quotas with unrelated CI load.

### OAuth App

- **Alternative.** Ship as an OAuth App that acts on behalf of an individual user's token.
- **Why considered.** OAuth flows are well understood and require no App manifest registration.
- **Why rejected.** OAuth tokens are user-bound; an automated reviewer that posts on PRs across many repositories would act as some specific human, which is the wrong trust model — actions would be attributed to that user, would inherit that user's permissions, and would break when that user is offboarded or rotates credentials.

### PR webhook + bot account

- **Alternative.** Configure a generic webhook plus a "bot" GitHub user account that posts via that user's token.
- **Why considered.** Avoids App registration and keeps the integration shape minimal.
- **Why rejected.** Bot user accounts violate platform expectations for automated integrations, complicate authentication (the credentials of a real user account masquerading as automation), and lose first-class Checks API integration tied to a stable App identity.

## Consequences (now)

The App-first decision implies the following are required from day one:

- **Webhook receiver.** A hosted HTTPS endpoint that receives GitHub events and validates `X-Hub-Signature-256` against the configured webhook secret.
- **App manifest.** A declared set of permissions and event subscriptions registered with GitHub for the App.
- **Installation flow.** A documented installation path for organizations and repositories, including the per-installation token exchange.
- **Key management.** Secure storage and rotation of the App's private key, webhook secret, and any per-installation derived credentials in a managed secret store.
- **Signature verification.** HMAC-SHA-256 verification of every incoming webhook delivery against the App's webhook secret, plus delivery-ID-based idempotency keying to resist replay.

## Consequences (later)

If a GitHub Action distribution is later requested for ergonomic reasons, it must be a thin wrapper that calls the App's HTTP surface — not a fork of the review pipeline. The pipeline remains single-sourced behind the App; any Action distribution exists only to drive that surface from a workflow context.
