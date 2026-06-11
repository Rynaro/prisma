/**
 * Pure resolution logic mapping job-payload and env inputs to a `RepoIdentity`.
 * Extracted from `worker.ts` so the precedence rules are unit-testable without
 * booting the worker (`worker.ts` starts Redis + BullMQ on import).
 *
 * Precedence (highest first):
 *
 *   1. **Env-var override** — `GITHUB_DEFAULT_OWNER` + `GITHUB_DEFAULT_REPO`,
 *      the single-tenant escape hatch. Both must be set; a partial override is
 *      ignored entirely so a misconfigured deployment falls through to the
 *      payload fields (or the error) instead of silently mixing sources.
 *   2. **Webhook payload fields** — `owner`/`repo` carried in the `JobPayload`
 *      from the GitHub webhook (`repository.owner.login`, `repository.name`).
 *      Primary production path; no extra GitHub API call.
 *   3. **Failure** — a descriptive `ok: false` result the caller logs and
 *      throws, instead of the historical `unknown-owner/unknown-repo`
 *      placeholders that produced confusing 404s against the GitHub API.
 */
import type { RepoIdentity } from './pipeline/index.js';

export interface RepoIdentityInputs {
  /** Webhook-carried fields from the JobPayload (absent on old payloads). */
  payloadOwner?: string | undefined;
  payloadRepo?: string | undefined;
  /** Env-var override pair (single-tenant escape hatch). */
  envOwner?: string | undefined;
  envRepo?: string | undefined;
  /** GITHUB_APP_ID raw string; non-numeric or missing maps to app_id 0. */
  appIdRaw?: string | undefined;
  /** GITHUB_APP_SLUG; defaults to 'prisma-bot'. */
  appLogin?: string | undefined;
}

export type RepoIdentityResolution =
  | { ok: true; identity: RepoIdentity; source: 'env' | 'payload' }
  | { ok: false; missing: 'owner' | 'repo' | 'owner and repo'; message: string };

const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

export const resolveRepoIdentity = (inputs: RepoIdentityInputs): RepoIdentityResolution => {
  const envOwner = nonEmpty(inputs.envOwner);
  const envRepo = nonEmpty(inputs.envRepo);
  const payloadOwner = nonEmpty(inputs.payloadOwner);
  const payloadRepo = nonEmpty(inputs.payloadRepo);

  const envOverrideComplete = envOwner !== undefined && envRepo !== undefined;
  const owner = envOverrideComplete ? envOwner : payloadOwner;
  const repo = envOverrideComplete ? envRepo : payloadRepo;

  if (owner === undefined || repo === undefined) {
    const missing =
      owner === undefined && repo === undefined
        ? ('owner and repo' as const)
        : owner === undefined
          ? ('owner' as const)
          : ('repo' as const);
    const message = `worker.repo_lookup: cannot resolve repository identity — ${missing} is missing. Set GITHUB_DEFAULT_OWNER / GITHUB_DEFAULT_REPO env vars, or upgrade the app to a version that carries owner/repo in the job payload.`;
    return { ok: false, missing, message };
  }

  const appIdParsed = inputs.appIdRaw !== undefined ? Number.parseInt(inputs.appIdRaw, 10) : 0;
  return {
    ok: true,
    identity: {
      owner,
      repo,
      app_id: Number.isFinite(appIdParsed) && appIdParsed > 0 ? appIdParsed : 0,
      app_login: inputs.appLogin ?? 'prisma-bot',
    },
    source: envOverrideComplete ? 'env' : 'payload',
  };
};
