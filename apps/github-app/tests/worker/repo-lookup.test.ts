/**
 * Unit tests for `resolveRepoIdentity` (`src/repo-identity.ts`) — the pure
 * resolution logic behind the worker's `buildRepoLookup`. Extracted to its own
 * module so these tests exercise the REAL implementation (worker.ts boots
 * Redis + BullMQ on import and cannot be imported here).
 *
 * Covers:
 *   (b) env-var override takes precedence over payload fields (both-or-neither)
 *   (c) payload fields are used when env vars are absent
 *   (d) descriptive error result when neither source resolves
 *   (e) old-shape payloads (no owner/repo) still parse and route to the error path
 */

import { JobPayloadSchema } from '@prisma-bot/shared';
import { describe, expect, it } from 'vitest';
import { resolveRepoIdentity } from '../../src/repo-identity.js';

describe('resolveRepoIdentity', () => {
  describe('(b) env-var override takes precedence over payload fields', () => {
    it('uses GITHUB_DEFAULT_OWNER/REPO when both env vars and payload fields are set', () => {
      const result = resolveRepoIdentity({
        payloadOwner: 'payload-owner',
        payloadRepo: 'payload-repo',
        envOwner: 'env-owner',
        envRepo: 'env-repo',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.identity.owner).toBe('env-owner');
        expect(result.identity.repo).toBe('env-repo');
        expect(result.source).toBe('env');
      }
    });

    it('ignores a PARTIAL env override (only owner set) and uses payload for both', () => {
      const result = resolveRepoIdentity({
        payloadOwner: 'payload-owner',
        payloadRepo: 'payload-repo',
        envOwner: 'env-owner-only',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.identity.owner).toBe('payload-owner');
        expect(result.identity.repo).toBe('payload-repo');
        expect(result.source).toBe('payload');
      }
    });

    it('ignores a PARTIAL env override (only repo set) and uses payload for both', () => {
      const result = resolveRepoIdentity({
        payloadOwner: 'payload-owner',
        payloadRepo: 'payload-repo',
        envRepo: 'env-repo-only',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.identity.owner).toBe('payload-owner');
        expect(result.identity.repo).toBe('payload-repo');
        expect(result.source).toBe('payload');
      }
    });

    it('treats empty-string env vars as absent', () => {
      const result = resolveRepoIdentity({
        payloadOwner: 'payload-owner',
        payloadRepo: 'payload-repo',
        envOwner: '',
        envRepo: '',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.source).toBe('payload');
      }
    });
  });

  describe('(c) payload fields are used when env vars are absent', () => {
    it('resolves from payload owner/repo when no env vars are set', () => {
      const result = resolveRepoIdentity({
        payloadOwner: 'webhook-owner',
        payloadRepo: 'webhook-repo',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.identity.owner).toBe('webhook-owner');
        expect(result.identity.repo).toBe('webhook-repo');
        expect(result.source).toBe('payload');
      }
    });

    it('returns correct app_id and app_login when provided', () => {
      const result = resolveRepoIdentity({
        payloadOwner: 'webhook-owner',
        payloadRepo: 'webhook-repo',
        appIdRaw: '42',
        appLogin: 'my-bot',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.identity.app_id).toBe(42);
        expect(result.identity.app_login).toBe('my-bot');
      }
    });

    it('defaults app_id to 0 and app_login to "prisma-bot" when absent', () => {
      const result = resolveRepoIdentity({
        payloadOwner: 'webhook-owner',
        payloadRepo: 'webhook-repo',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.identity.app_id).toBe(0);
        expect(result.identity.app_login).toBe('prisma-bot');
      }
    });

    it('maps a non-numeric GITHUB_APP_ID to app_id 0', () => {
      const result = resolveRepoIdentity({
        payloadOwner: 'webhook-owner',
        payloadRepo: 'webhook-repo',
        appIdRaw: 'not-a-number',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.identity.app_id).toBe(0);
      }
    });
  });

  describe('(d) descriptive error result when neither source resolves', () => {
    it('fails when neither env vars nor payload owner/repo are set', () => {
      const result = resolveRepoIdentity({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.missing).toBe('owner and repo');
        expect(result.message).toMatch(/cannot resolve repository identity/);
      }
    });

    it('error message carries the env-var remediation hint', () => {
      const result = resolveRepoIdentity({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toMatch(/GITHUB_DEFAULT_OWNER \/ GITHUB_DEFAULT_REPO/);
      }
    });

    it('names "repo" when only owner is present', () => {
      const result = resolveRepoIdentity({ payloadOwner: 'some-owner' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.missing).toBe('repo');
      }
    });

    it('names "owner" when only repo is present', () => {
      const result = resolveRepoIdentity({ payloadRepo: 'some-repo' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.missing).toBe('owner');
      }
    });
  });

  describe('(e) old-shape payloads (no owner/repo) still parse at the schema level', () => {
    const oldShapePayload = {
      idempotency_key: 'idem-old-001',
      installation_id: 1234,
      repository_id: 9876,
      pull_request_number: 42,
      head_sha: 'deadbeefcafe0001',
      event_type: 'pull_request.opened' as const,
      received_at: '2026-04-30T17:03:21Z',
      // deliberately omit owner and repo
    };

    it('parses cleanly without owner/repo fields (backwards compat)', () => {
      const result = JobPayloadSchema.safeParse(oldShapePayload);
      expect(result.success).toBe(true);
    });

    it('produces undefined owner/repo after parse', () => {
      const result = JobPayloadSchema.safeParse(oldShapePayload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.owner).toBeUndefined();
        expect(result.data.repo).toBeUndefined();
      }
    });

    it('old-shape payload routes to the error path at lookup time', () => {
      const parsed = JobPayloadSchema.safeParse(oldShapePayload);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        const result = resolveRepoIdentity({
          payloadOwner: parsed.data.owner,
          payloadRepo: parsed.data.repo,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.message).toMatch(/cannot resolve repository identity/);
        }
      }
    });
  });
});
