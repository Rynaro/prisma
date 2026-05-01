import {
  type ChangedFile,
  NormalizedFindingSchema,
  type PrSnapshot,
  type ProviderReviewOutput,
  type ProviderReviewOutputFinding,
  RepoConfigSchema,
} from '@prisma-bot/shared';
import { describe, expect, it } from 'vitest';
import { type ValidatorContext, runValidator } from '../../src/validator-ranker/validator/index.js';

const config = RepoConfigSchema.parse({});

const file = (overrides: Partial<ChangedFile> = {}): ChangedFile => ({
  path: 'src/example.ts',
  status: 'modified',
  additions: 5,
  deletions: 1,
  hunks: [{ new_start: 10, new_lines: 5, old_start: 10, old_lines: 4 }],
  is_binary: false,
  ...overrides,
});

const snapshot = (files: ChangedFile[]): PrSnapshot => ({
  installation_id: 1,
  repository_id: 2,
  pull_request_number: 42,
  head_sha: 'a'.repeat(40),
  base_sha: 'b'.repeat(40),
  default_branch: 'main',
  total_changed_lines: files.reduce((s, f) => s + f.additions + f.deletions, 0),
  files,
});

const ctx = (snap: PrSnapshot, overrides: Partial<ValidatorContext> = {}): ValidatorContext => ({
  snapshot: snap,
  config,
  run_id: 'run-test-1',
  ran_at: '2026-04-30T17:03:21.000Z',
  ...overrides,
});

const validProviderFinding = (
  overrides: Partial<ProviderReviewOutputFinding> = {},
): ProviderReviewOutputFinding => ({
  path: 'src/example.ts',
  line: 12,
  severity: 'high',
  category: 'security',
  message: 'Unbounded user input passed into SQL builder',
  rationale: 'Reachable from public route handler; bypasses parameterization helper.',
  confidence: 0.86,
  ...overrides,
});

describe('runValidator', () => {
  it('maps a single valid provider finding to a single NormalizedFinding with all 15 fields', () => {
    const snap = snapshot([file()]);
    const output: ProviderReviewOutput = {
      findings: [validProviderFinding({ suggested_fix: 'use parameterized query' })],
    };
    const result = runValidator(output, ctx(snap));
    expect(result.rejections).toEqual([]);
    expect(result.findings).toHaveLength(1);
    const [finding] = result.findings;
    if (finding === undefined) throw new Error('expected one finding');
    // Round-trip via the schema to assert full conformance.
    const parsed = NormalizedFindingSchema.parse(finding);
    expect(parsed.id).toBe('run-test-1:0');
    expect(parsed.path).toBe('src/example.ts');
    expect(parsed.line_start).toBe(12);
    expect(parsed.line_end).toBe(12);
    expect(parsed.category).toBe('security');
    expect(parsed.severity).toBe('high');
    expect(parsed.confidence).toBe(0.86);
    expect(parsed.title).toBe('Unbounded user input passed into SQL builder');
    expect(parsed.explanation).toBe(
      'Reachable from public route handler; bypasses parameterization helper.',
    );
    expect(parsed.suggested_fix).toBe('use parameterized query');
    expect(parsed.evidence).toEqual(['src/example.ts:12', 'hunk:src/example.ts#10-15']);
    expect(parsed.render_target).toBe('inline');
    expect(parsed.source_artifacts_used).toEqual(['pr_diff']);
    expect(parsed.dedupe_key.length).toBeGreaterThan(0);
  });

  it('rejects a finding whose path is absent from the diff with reason path_not_in_diff', () => {
    const snap = snapshot([file({ path: 'src/in-diff.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [validProviderFinding({ path: 'src/elsewhere.ts' })],
    };
    const result = runValidator(output, ctx(snap));
    expect(result.findings).toEqual([]);
    expect(result.rejections).toHaveLength(1);
    const [reject] = result.rejections;
    if (reject === undefined) throw new Error('expected one rejection');
    expect(reject.stage).toBe('validator');
    expect(reject.reason_code).toBe('path_not_in_diff');
    expect(reject.finding_id).toBeNull();
    expect(reject.timestamp).toBe('2026-04-30T17:03:21.000Z');
  });

  it('rejects a finding whose line is outside any hunk with reason line_not_in_diff', () => {
    const snap = snapshot([file()]);
    const output: ProviderReviewOutput = {
      findings: [validProviderFinding({ line: 999 })],
    };
    const result = runValidator(output, ctx(snap));
    expect(result.findings).toEqual([]);
    expect(result.rejections).toHaveLength(1);
    const [reject] = result.rejections;
    if (reject === undefined) throw new Error('expected one rejection');
    expect(reject.reason_code).toBe('line_not_in_diff');
  });

  it('treats a removed-file path as path_not_in_diff (snapshot drops it from the analyzable set)', () => {
    const snap = snapshot([file({ path: 'src/gone.ts', status: 'removed', hunks: [] })]);
    const output: ProviderReviewOutput = {
      findings: [validProviderFinding({ path: 'src/gone.ts' })],
    };
    const result = runValidator(output, ctx(snap));
    expect(result.findings).toEqual([]);
    expect(result.rejections).toHaveLength(1);
    const [reject] = result.rejections;
    if (reject === undefined) throw new Error('expected one rejection');
    expect(reject.reason_code).toBe('path_not_in_diff');
  });

  it('produces 1 finding + 1 rejection when one provider finding is valid and one is not', () => {
    const snap = snapshot([file({ path: 'src/in.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [
        validProviderFinding({ path: 'src/in.ts', line: 11 }),
        validProviderFinding({ path: 'src/missing.ts' }),
      ],
    };
    const result = runValidator(output, ctx(snap));
    expect(result.findings).toHaveLength(1);
    expect(result.rejections).toHaveLength(1);
    const [first] = result.findings;
    if (first === undefined) throw new Error('expected first finding');
    expect(first.path).toBe('src/in.ts');
    const [reject] = result.rejections;
    if (reject === undefined) throw new Error('expected one rejection');
    expect(reject.reason_code).toBe('path_not_in_diff');
  });

  it('produces identical dedupe_key for two findings with same path+line+identical message', () => {
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [
        validProviderFinding({ path: 'src/a.ts', line: 11, message: 'Same   issue!' }),
        validProviderFinding({ path: 'src/a.ts', line: 11, message: 'same issue' }),
      ],
    };
    const result = runValidator(output, ctx(snap));
    expect(result.findings).toHaveLength(2);
    const [a, b] = result.findings;
    if (a === undefined || b === undefined) throw new Error('expected two findings');
    expect(a.dedupe_key).toBe(b.dedupe_key);
  });

  it('uses the injected generateId for deterministic ids', () => {
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    let counter = 0;
    const generateId = () => {
      counter += 1;
      return `injected-id-${counter}`;
    };
    const output: ProviderReviewOutput = {
      findings: [
        validProviderFinding({ path: 'src/a.ts', line: 11 }),
        validProviderFinding({ path: 'src/a.ts', line: 12 }),
      ],
    };
    const result = runValidator(output, ctx(snap, { generateId }));
    expect(result.findings.map((f) => f.id)).toEqual(['injected-id-1', 'injected-id-2']);
  });

  it('emits findings whose audit timestamps would equal ctx.ran_at when included', () => {
    // NormalizedFinding does not carry created_at directly in the schema, but
    // RejectionLogEntry.timestamp does — the validator threads ctx.ran_at into
    // every rejection it emits. This is the closest schema-visible assertion.
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [validProviderFinding({ path: 'src/missing.ts' })],
    };
    const result = runValidator(output, ctx(snap, { ran_at: '2026-04-30T17:03:21.000Z' }));
    expect(result.rejections).toHaveLength(1);
    const [reject] = result.rejections;
    if (reject === undefined) throw new Error('expected one rejection');
    expect(reject.timestamp).toBe('2026-04-30T17:03:21.000Z');
  });

  it('initial render_target is inline for every produced finding', () => {
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [validProviderFinding({ path: 'src/a.ts', line: 11 })],
    };
    const result = runValidator(output, ctx(snap));
    expect(result.findings).toHaveLength(1);
    const [first] = result.findings;
    if (first === undefined) throw new Error('expected one finding');
    expect(first.render_target).toBe('inline');
  });

  it('returns empty findings + provider_output_zod_failed rejection for malformed provider output', () => {
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const malformed = {
      findings: [
        {
          // missing required fields — Zod will reject
          path: 'src/a.ts',
        },
      ],
    } as unknown as ProviderReviewOutput;
    const result = runValidator(malformed, ctx(snap));
    expect(result.findings).toEqual([]);
    expect(result.rejections.length).toBeGreaterThanOrEqual(1);
    const codes = new Set(result.rejections.map((r) => r.reason_code));
    expect(codes.has('provider_output_zod_failed')).toBe(true);
    for (const r of result.rejections) {
      expect(r.stage).toBe('validator');
      expect(r.finding_id).toBeNull();
    }
  });

  it('truncates very long messages into a 120-char title', () => {
    const longMessage = `${'A'.repeat(200)}`;
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [validProviderFinding({ path: 'src/a.ts', line: 11, message: longMessage })],
    };
    const result = runValidator(output, ctx(snap));
    const [first] = result.findings;
    if (first === undefined) throw new Error('expected one finding');
    expect(first.title.length).toBe(120);
    expect(first.title).toBe('A'.repeat(120));
    // The full provider message is preserved as the explanation source via rationale
    expect(first.explanation.length).toBeGreaterThan(0);
  });

  it('records line_start === line_end for single-line findings', () => {
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [validProviderFinding({ path: 'src/a.ts', line: 13 })],
    };
    const result = runValidator(output, ctx(snap));
    const [first] = result.findings;
    if (first === undefined) throw new Error('expected one finding');
    expect(first.line_start).toBe(13);
    expect(first.line_end).toBe(13);
  });
});
