/**
 * `installation-auth` module barrel — preserves the Phase 4 marker
 * `INSTALLATION_AUTH_MODULE` (consumed by the smoke test) and re-exports the
 * Phase 5.5 public API: the `OctokitLike` seam, the typed error vocabulary,
 * the `InstallationAuth` class, and the `SecretSource` boundary.
 */

export const INSTALLATION_AUTH_MODULE = 'installation-auth';

export type {
  OctokitLike,
  PullsGetData,
  PullsListFilesData,
  ReposGetContentData,
  ChecksCreateParams,
  ChecksUpdateParams,
  ChecksListItemData,
  PullsCreateReviewCommentParams,
  PullsReviewCommentData,
  IssuesCreateCommentParams,
  IssueCommentData,
  ReactionsCreateForIssueCommentParams,
} from './client.js';

export { createDefaultOctokit } from './client.js';

export type {
  AppCredentials,
  InstallationAuthOptions,
  InstallationAuthErrorCode,
  TokenMintFn,
} from './auth.js';

export { InstallationAuth, InstallationAuthError, SecretNotFoundError } from './auth.js';

export type { SecretSource } from './secret-source.js';
export { envSecretSource } from './secret-source.js';
