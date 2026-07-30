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

  it('rejects a whitespace-only message with reason blank_message (would otherwise yield an empty title)', () => {
    // `message: z.string().min(1)` admits whitespace-only strings; normalizing
    // collapses them to '', which must not silently escape as an empty title.
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [validProviderFinding({ path: 'src/a.ts', line: 11, message: '   \n\t ' })],
    };
    const result = runValidator(output, ctx(snap));
    expect(result.findings).toEqual([]);
    expect(result.rejections).toHaveLength(1);
    const [reject] = result.rejections;
    if (reject === undefined) throw new Error('expected one rejection');
    expect(reject.stage).toBe('validator');
    expect(reject.reason_code).toBe('blank_message');
    expect(reject.finding_id).toBeNull();
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

  it('dedupe_key is identical for same path+category regardless of wording or line', () => {
    // The same logical issue, reworded and at a different line, must collapse:
    // the key is derived from (path, category), not the free-text message.
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [
        validProviderFinding({
          path: 'src/a.ts',
          line: 11,
          category: 'security',
          message: 'Missing explicit authorization in this controller',
        }),
        validProviderFinding({
          path: 'src/a.ts',
          line: 13,
          category: 'security',
          message: 'Authorization check appears to be absent here',
        }),
      ],
    };
    const result = runValidator(output, ctx(snap));
    expect(result.findings).toHaveLength(2);
    const [a, b] = result.findings;
    if (a === undefined || b === undefined) throw new Error('expected two findings');
    expect(a.dedupe_key).toBe(b.dedupe_key);
  });

  it('dedupe_key differs for different categories in the same file', () => {
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [
        validProviderFinding({ path: 'src/a.ts', line: 11, category: 'security', message: 'a' }),
        validProviderFinding({ path: 'src/a.ts', line: 11, category: 'correctness', message: 'b' }),
      ],
    };
    const result = runValidator(output, ctx(snap));
    expect(result.findings).toHaveLength(2);
    const [a, b] = result.findings;
    if (a === undefined || b === undefined) throw new Error('expected two findings');
    expect(a.dedupe_key).not.toBe(b.dedupe_key);
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

  // --- Title derivation (deriveTitle) — AC-001 … AC-009, AC-015 ---

  it('title never exceeds the cap', () => {
    // AC-001
    const longMessage = 'A'.repeat(300);
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [validProviderFinding({ path: 'src/a.ts', line: 11, message: longMessage })],
    };
    const result = runValidator(output, ctx(snap));
    const [first] = result.findings;
    if (first === undefined) throw new Error('expected one finding');
    expect(first.title.length).toBeLessThanOrEqual(120);
  });

  it('short message is unchanged', () => {
    // AC-002
    const shortMessage = 'B'.repeat(80);
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [validProviderFinding({ path: 'src/a.ts', line: 11, message: shortMessage })],
    };
    const result = runValidator(output, ctx(snap));
    const [first] = result.findings;
    if (first === undefined) throw new Error('expected one finding');
    expect(first.title).toBe(shortMessage);
  });

  it('cuts at a word boundary', () => {
    // AC-003 — the 120-char prefix of this message ends mid-word ("...alp").
    const longMessage = Array.from({ length: 20 }, () => 'alphabet').join(' ');
    expect(longMessage.slice(0, 120).endsWith(' ')).toBe(false);
    expect(longMessage.slice(119, 120)).not.toBe(' ');
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [validProviderFinding({ path: 'src/a.ts', line: 11, message: longMessage })],
    };
    const result = runValidator(output, ctx(snap));
    const [first] = result.findings;
    if (first === undefined) throw new Error('expected one finding');
    const withoutEllipsis = first.title.replace(/…$/, '');
    expect(longMessage.startsWith(withoutEllipsis)).toBe(true);
    expect(withoutEllipsis.endsWith(' ')).toBe(false);
    expect(longMessage.charAt(withoutEllipsis.length)).toBe(' ');
  });

  it('uses the last space at or before the 120-char boundary, not an earlier one (off-by-one regression)', () => {
    // Repro: a space sits exactly at index 119 (the last position that still
    // lets "<word>…" land flush at 120 chars). An earlier, buggy window that
    // searched only slice(0, 119) would miss it and cut at the first space
    // instead, wasting most of the budget.
    const longMessage = `${'A'.repeat(100)} ${'B'.repeat(18)} ${'C'.repeat(50)}`;
    expect(longMessage.charAt(119)).toBe(' ');
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [validProviderFinding({ path: 'src/a.ts', line: 11, message: longMessage })],
    };
    const result = runValidator(output, ctx(snap));
    const [first] = result.findings;
    if (first === undefined) throw new Error('expected one finding');
    expect(first.title).toBe(`${'A'.repeat(100)} ${'B'.repeat(18)}…`);
    expect(first.title.length).toBe(120);
  });

  it('never splits an astral code point (emoji) at the degenerate hard-cut boundary', () => {
    // No spaces anywhere, so the degenerate hard-cut path fires. The emoji
    // (a surrogate pair) straddles the raw code-unit cut index.
    const emoji = '\u{1F600}';
    const longMessage = `${'A'.repeat(118)}${emoji}${'A'.repeat(50)}`;
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [validProviderFinding({ path: 'src/a.ts', line: 11, message: longMessage })],
    };
    const result = runValidator(output, ctx(snap));
    const [first] = result.findings;
    if (first === undefined) throw new Error('expected one finding');
    const unpairedSurrogateRe =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(unpairedSurrogateRe.test(first.title)).toBe(false);
    expect(first.title.endsWith('…')).toBe(true);
    expect(first.title.length).toBeLessThanOrEqual(120);
  });

  it('never splits an astral code point (emoji) at the word-boundary cut', () => {
    // The emoji is the final character of the word immediately preceding the
    // space chosen as the cut point.
    const emoji = '\u{1F600}';
    const longMessage = `${'A'.repeat(90)} ${'B'.repeat(25)}${emoji} ${'C'.repeat(30)}`;
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [validProviderFinding({ path: 'src/a.ts', line: 11, message: longMessage })],
    };
    const result = runValidator(output, ctx(snap));
    const [first] = result.findings;
    if (first === undefined) throw new Error('expected one finding');
    const unpairedSurrogateRe =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(unpairedSurrogateRe.test(first.title)).toBe(false);
    expect(first.title).toContain(emoji);
    expect(first.title.endsWith('…')).toBe(true);
    expect(first.title.length).toBeLessThanOrEqual(120);
  });

  it('marks truncation with an ellipsis', () => {
    // AC-004
    const longMessage = Array.from({ length: 20 }, () => 'alphabet').join(' ');
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [validProviderFinding({ path: 'src/a.ts', line: 11, message: longMessage })],
    };
    const result = runValidator(output, ctx(snap));
    const [first] = result.findings;
    if (first === undefined) throw new Error('expected one finding');
    expect(first.title.endsWith('…')).toBe(true);
  });

  it('prefers the first sentence', () => {
    // AC-005 — first sentence is 97 chars (within [30,120]), followed by a
    // second sentence that pushes the whole message past the cap.
    const longMessage =
      'This function does not validate its input parameter properly and could throw at runtime for null. ' +
      'It might additionally throw if given a negative number as well, causing further problems downstream.';
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [validProviderFinding({ path: 'src/a.ts', line: 11, message: longMessage })],
    };
    const result = runValidator(output, ctx(snap));
    const [first] = result.findings;
    if (first === undefined) throw new Error('expected one finding');
    expect(first.title).toBe(
      'This function does not validate its input parameter properly and could throw at runtime for null.',
    );
    expect(first.title.endsWith('…')).toBe(false);
  });

  it('preserves the full message in the explanation', () => {
    // AC-006
    const longMessage = Array.from({ length: 20 }, () => 'alphabet').join(' ');
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [
        validProviderFinding({
          path: 'src/a.ts',
          line: 11,
          message: longMessage,
          rationale: 'Some rationale text.',
        }),
      ],
    };
    const result = runValidator(output, ctx(snap));
    const [first] = result.findings;
    if (first === undefined) throw new Error('expected one finding');
    expect(first.explanation).toContain(longMessage);
    expect(first.explanation).toContain('Some rationale text.');
  });

  it('leaves the explanation untouched when the title fits', () => {
    // AC-007
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [
        validProviderFinding({
          path: 'src/a.ts',
          line: 11,
          message: 'Short headline.',
          rationale: 'Full rationale narrative goes here.',
        }),
      ],
    };
    const result = runValidator(output, ctx(snap));
    const [first] = result.findings;
    if (first === undefined) throw new Error('expected one finding');
    expect(first.explanation).toBe('Full rationale narrative goes here.');
  });

  it('renders the title on a single line', () => {
    // AC-008
    const message =
      'Race condition:\n  the counter increments\twithout   locking causing double charges';
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [validProviderFinding({ path: 'src/a.ts', line: 11, message })],
    };
    const result = runValidator(output, ctx(snap));
    const [first] = result.findings;
    if (first === undefined) throw new Error('expected one finding');
    expect(first.title).not.toMatch(/\n/);
    expect(first.title).not.toMatch(/\s{2,}/);
    expect(first.title).toBe(
      'Race condition: the counter increments without locking causing double charges',
    );
  });

  it('hard-cuts a single oversized token', () => {
    // AC-009
    const longMessage = 'A'.repeat(200);
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [validProviderFinding({ path: 'src/a.ts', line: 11, message: longMessage })],
    };
    const result = runValidator(output, ctx(snap));
    const [first] = result.findings;
    if (first === undefined) throw new Error('expected one finding');
    expect(first.title.length).toBe(120);
    expect(first.title).toBe(`${'A'.repeat(119)}…`);
  });

  it('dedupe_key is independent of the message', () => {
    // AC-015
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [
        validProviderFinding({ path: 'src/a.ts', line: 11, category: 'security', message: 'x' }),
        validProviderFinding({
          path: 'src/a.ts',
          line: 12,
          category: 'security',
          message: 'A much, much longer message describing the very same issue in different words',
        }),
      ],
    };
    const result = runValidator(output, ctx(snap));
    expect(result.findings).toHaveLength(2);
    const [a, b] = result.findings;
    if (a === undefined || b === undefined) throw new Error('expected two findings');
    expect(a.dedupe_key).toBe(b.dedupe_key);
  });

  it('regression: production mid-word truncation defect (PR #8647, discussion r3524035352) is fixed', () => {
    const productionMessage =
      "Potential bug: The string conversion in the value of `answers` may always return `'true'` or " +
      "`'false'` rather than the intended value";
    const snap = snapshot([file({ path: 'src/a.ts' })]);
    const output: ProviderReviewOutput = {
      findings: [
        validProviderFinding({
          path: 'src/a.ts',
          line: 11,
          message: productionMessage,
          rationale: 'The == operator coerces types; use === and check the actual boolean.',
        }),
      ],
    };
    const result = runValidator(output, ctx(snap));
    const [first] = result.findings;
    if (first === undefined) throw new Error('expected one finding');
    // The observed production defect: a mid-word cut ending in "...the i" with
    // no ellipsis. Assert it is not that.
    expect(first.title).not.toBe(productionMessage.slice(0, 120));
    expect(first.title.endsWith('the i')).toBe(false);
    expect(first.title.length).toBeLessThanOrEqual(120);
    expect(first.title.endsWith('…')).toBe(true);
    // The full sentence survives, unabridged, in the explanation.
    expect(first.explanation).toContain(productionMessage);
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
