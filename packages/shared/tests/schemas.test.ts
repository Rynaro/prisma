import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPO_CONFIG,
  JobPayloadSchema,
  MAX_CONTEXT_FILES,
  MAX_INSTRUCTION_BLOCK_BYTES,
  MAX_PATH_INSTRUCTIONS,
  NormalizedFindingSchema,
  ProviderReviewInputSchema,
  ProviderReviewOutputSchema,
  RejectionLogEntrySchema,
  RepoConfigSchema,
  ReviewGuidanceSchema,
} from '../src/index.js';

const validProviderFinding = {
  path: 'src/payments/charge.ts',
  line: 142,
  severity: 'high' as const,
  category: 'security' as const,
  message: 'Unbounded user input passed into SQL builder',
  rationale: 'Reachable from public route handler; bypasses parameterization helper.',
  confidence: 0.86,
};

const validNormalizedFinding = {
  id: 'f8b1e2c4-9a01-4d31-8f3a-1e2b3c4d5e6f',
  path: 'src/payments/charge.ts',
  line_start: 142,
  line_end: 144,
  category: 'security' as const,
  severity: 'high' as const,
  confidence: 0.86,
  title: 'Unbounded user input passed into SQL builder',
  explanation: 'The string in req.body.query is interpolated into the SQL builder.',
  evidence: ['src/payments/charge.ts:142-144'],
  render_target: 'inline' as const,
  source_artifacts_used: ['hunk:H2', 'file:src/payments/charge.ts'],
  dedupe_key: 'sha256:1a2b3c-payments-charge-142-144',
};

const validJobPayload = {
  idempotency_key: 'idem-abc-123',
  installation_id: 1234,
  repository_id: 9876,
  pull_request_number: 42,
  head_sha: 'deadbeefcafef00d',
  event_type: 'pull_request.opened' as const,
  received_at: '2026-04-30T17:03:21Z',
};

describe('@prisma-bot/shared schemas', () => {
  describe('ProviderReviewOutput', () => {
    it('accepts a minimal valid finding list', () => {
      const result = ProviderReviewOutputSchema.safeParse({
        findings: [validProviderFinding],
      });
      expect(result.success).toBe(true);
    });

    it('rejects findings with confidence > 1', () => {
      const result = ProviderReviewOutputSchema.safeParse({
        findings: [{ ...validProviderFinding, confidence: 1.5 }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects findings with confidence < 0', () => {
      const result = ProviderReviewOutputSchema.safeParse({
        findings: [{ ...validProviderFinding, confidence: -0.1 }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('NormalizedFinding', () => {
    it('accepts a valid finding and round-trips its required fields', () => {
      const parsed = NormalizedFindingSchema.parse(validNormalizedFinding);
      expect(parsed.id).toBe(validNormalizedFinding.id);
      expect(parsed.path).toBe(validNormalizedFinding.path);
      expect(parsed.line_start).toBe(validNormalizedFinding.line_start);
      expect(parsed.line_end).toBe(validNormalizedFinding.line_end);
      expect(parsed.category).toBe('security');
      expect(parsed.severity).toBe('high');
      expect(parsed.render_target).toBe('inline');
      expect(parsed.dedupe_key).toBe(validNormalizedFinding.dedupe_key);
    });

    it('rejects unknown render_target values', () => {
      const result = NormalizedFindingSchema.safeParse({
        ...validNormalizedFinding,
        render_target: 'silenced',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('JobPayload', () => {
    it('accepts a valid payload with no traceparent', () => {
      const result = JobPayloadSchema.safeParse(validJobPayload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.traceparent).toBeUndefined();
      }
    });

    it('accepts a valid payload with a traceparent string (Phase 3 additive)', () => {
      const result = JobPayloadSchema.safeParse({
        ...validJobPayload,
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.traceparent).toBe(
          '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        );
      }
    });

    it('accepts a payload with owner and repo fields (new webhook-sourced fields)', () => {
      const result = JobPayloadSchema.safeParse({
        ...validJobPayload,
        owner: 'octocat',
        repo: 'hello-world',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.owner).toBe('octocat');
        expect(result.data.repo).toBe('hello-world');
      }
    });

    it('accepts an old-shape payload without owner/repo (backwards compatibility)', () => {
      // Payloads enqueued before the webhook-identity change must still parse
      // successfully; the worker handles the missing fields at lookup time.
      const result = JobPayloadSchema.safeParse(validJobPayload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.owner).toBeUndefined();
        expect(result.data.repo).toBeUndefined();
      }
    });

    it('rejects a payload where owner is an empty string', () => {
      const result = JobPayloadSchema.safeParse({
        ...validJobPayload,
        owner: '',
        repo: 'hello-world',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('RejectionLogEntry', () => {
    it('rejects an unknown stage value', () => {
      const result = RejectionLogEntrySchema.safeParse({
        finding_id: 'a7c2d6e1-3b04-4ee0-9f12-7d8e9a0b1c2d',
        stage: 'queue',
        reason_code: 'per_pr_cap_exhausted',
        reason_message: 'cap reached',
        provider_output_excerpt: '[redacted]',
        timestamp: '2026-04-30T17:03:21Z',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('DEFAULT_REPO_CONFIG', () => {
    it('parses through RepoConfigSchema cleanly (regression guard against drift)', () => {
      const result = RepoConfigSchema.safeParse(DEFAULT_REPO_CONFIG);
      expect(result.success).toBe(true);
      expect(DEFAULT_REPO_CONFIG.mode).toBe('dry-run');
      expect(DEFAULT_REPO_CONFIG.comment_cap.per_pr).toBe(5);
      expect(DEFAULT_REPO_CONFIG.comment_cap.per_file).toBe(1);
      expect(DEFAULT_REPO_CONFIG.thresholds.severity_floor.inline).toBe('medium');
      expect(DEFAULT_REPO_CONFIG.thresholds.confidence_floor.inline).toBe(0.7);
      expect(DEFAULT_REPO_CONFIG.provider).toBe('anthropic');
    });

    it('has empty review_guidance defaults (zero-config invariant)', () => {
      expect(DEFAULT_REPO_CONFIG.review_guidance).toBeDefined();
      expect(DEFAULT_REPO_CONFIG.review_guidance.path_instructions).toEqual([]);
      expect(DEFAULT_REPO_CONFIG.review_guidance.context_files).toEqual([]);
      expect(DEFAULT_REPO_CONFIG.review_guidance.instructions).toBeUndefined();
    });
  });

  describe('ReviewGuidance schema', () => {
    it('accepts an empty object and applies defaults', () => {
      const result = ReviewGuidanceSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.path_instructions).toEqual([]);
        expect(result.data.context_files).toEqual([]);
        expect(result.data.instructions).toBeUndefined();
      }
    });

    it('accepts valid instructions, path_instructions, and context_files', () => {
      const result = ReviewGuidanceSchema.safeParse({
        instructions: 'Focus on security.',
        path_instructions: [{ path: 'src/**', instructions: 'Enforce strict types.' }],
        context_files: [{ path: 'docs/arch.md' }],
      });
      expect(result.success).toBe(true);
    });

    it('rejects instructions exceeding MAX_INSTRUCTION_BLOCK_BYTES', () => {
      const tooLong = 'x'.repeat(MAX_INSTRUCTION_BLOCK_BYTES + 1);
      const result = ReviewGuidanceSchema.safeParse({ instructions: tooLong });
      expect(result.success).toBe(false);
    });

    it('rejects path_instructions exceeding MAX_PATH_INSTRUCTIONS count', () => {
      const entries = Array.from({ length: MAX_PATH_INSTRUCTIONS + 1 }, (_, i) => ({
        path: `src/file${i}.ts`,
        instructions: 'Do something.',
      }));
      const result = ReviewGuidanceSchema.safeParse({ path_instructions: entries });
      expect(result.success).toBe(false);
    });

    it('rejects context_files exceeding MAX_CONTEXT_FILES count', () => {
      const entries = Array.from({ length: MAX_CONTEXT_FILES + 1 }, (_, i) => ({
        path: `docs/file${i}.md`,
      }));
      const result = ReviewGuidanceSchema.safeParse({ context_files: entries });
      expect(result.success).toBe(false);
    });

    it('rejects extra keys on path_instruction entries (.strict())', () => {
      const result = ReviewGuidanceSchema.safeParse({
        path_instructions: [{ path: 'src/**', instructions: 'ok', extra: 'nope' }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ProviderReviewInput with custom_guidance', () => {
    const baseInput = {
      files: [],
    };

    it('accepts input without custom_guidance (zero-config backward compat)', () => {
      const result = ProviderReviewInputSchema.safeParse(baseInput);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.custom_guidance).toBeUndefined();
      }
    });

    it('accepts input with custom_guidance round-trips correctly', () => {
      const result = ProviderReviewInputSchema.safeParse({
        ...baseInput,
        custom_guidance: {
          instructions: 'Focus on correctness.',
          matched_path_instructions: [{ path: 'src/**', instructions: 'Check types.' }],
          context_files: [{ path: 'docs/arch.md', content: '# Architecture' }],
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.custom_guidance?.instructions).toBe('Focus on correctness.');
        expect(result.data.custom_guidance?.matched_path_instructions).toHaveLength(1);
        expect(result.data.custom_guidance?.context_files).toHaveLength(1);
      }
    });

    it('rejects unknown keys in custom_guidance (.strict())', () => {
      const result = ProviderReviewInputSchema.safeParse({
        ...baseInput,
        custom_guidance: { unknown_key: 'nope' },
      });
      expect(result.success).toBe(false);
    });
  });
});
