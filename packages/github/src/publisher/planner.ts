import type { Mode, NormalizedFinding, RankedFindings, RepoConfig } from '@prisma-bot/shared';

/**
 * Pure planner for the publisher. Implements
 * `docs/publication-policy.md` § Mode behavior + § Threshold and cap
 * application order — every step here is deterministic, side-effect free,
 * and unit-testable without any GitHub or queue dependency.
 *
 * Caller (the effectful publisher in `effects.ts`) supplies:
 *   - `ranked`: the ranker's output.
 *   - `cfg`: the resolved `RepoConfig`.
 *   - `prior`: dedupe state (across-run dedupe-keys harvested from
 *     `ReviewCommentsClient.listOurs` and from prior Checks summaries).
 *
 * Returns a `PublicationPlan` that the effectful layer turns into HTTP calls.
 *
 * Plan invariant (test-asserted): every input finding ends up in exactly one
 * of `inline`, `summary`, or `dropped` (i.e., the plan partitions the input).
 */

export type PublisherDropReason =
  | 'severity_below_floor'
  | 'confidence_below_floor'
  | 'dedupe_collapsed'
  | 'dedupe_collapsed_across_run'
  | 'per_file_cap_exhausted'
  | 'per_pr_cap_exhausted';

export interface PublicationPlanDropEntry {
  finding: NormalizedFinding;
  reason_code: PublisherDropReason;
  /** Human-readable, short. Used for log entries and summary annotations. */
  reason_message: string;
}

export interface PublicationPlanSummaryEntry {
  finding: NormalizedFinding;
  reason_code: PublisherDropReason;
  reason_message: string;
}

export interface PublicationPlan {
  inline: NormalizedFinding[];
  summary: NormalizedFinding[];
  /**
   * Per-summary-item rejection metadata. `summary[i]` corresponds to
   * `summary_rejections[i]`; both arrays are the same length. Used by the
   * effectful publisher to materialise `RejectionLogEntry[]`.
   */
  summary_rejections: PublicationPlanSummaryEntry[];
  dropped: PublicationPlanDropEntry[];
  mode_applied: Mode;
  summary_markdown: string;
  /** Sub-counts for assertions and observability (counts only, no PII). */
  counts: {
    input: number;
    inline: number;
    summary: number;
    dropped: number;
    below_floors: number;
    deduped_within_run: number;
    deduped_across_run: number;
    overflowed_per_file: number;
    overflowed_per_pr: number;
  };
}

export interface PriorDedupeState {
  /**
   * Set of `dedupe_key` values already published as inline comments on this
   * PR (across-run dedupe source per `publication-policy.md` § Dedupe
   * behavior — sourced from the GitHub Checks/Review-Comments history of
   * this App on this PR).
   */
  published_inline_dedupe_keys: ReadonlySet<string>;
}

const SEVERITY_RANK: Record<NormalizedFinding['severity'], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

const meetsSeverityFloor = (
  finding: NormalizedFinding,
  floor: NormalizedFinding['severity'],
): boolean => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[floor];

const meetsConfidenceFloor = (finding: NormalizedFinding, floor: number): boolean =>
  finding.confidence >= floor;

const reasonMessageFor = (code: PublisherDropReason): string => {
  switch (code) {
    case 'severity_below_floor':
      return 'severity below configured inline floor';
    case 'confidence_below_floor':
      return 'confidence below configured inline floor';
    case 'dedupe_collapsed':
      return 'duplicate of another finding within this run';
    case 'dedupe_collapsed_across_run':
      return 'already published as an inline comment on this PR';
    case 'per_file_cap_exhausted':
      return 'per-file inline-comment cap exhausted';
    case 'per_pr_cap_exhausted':
      return 'per-PR inline-comment cap exhausted';
  }
};

interface InlineCandidateEval {
  finding: NormalizedFinding;
  inlineEligible: boolean;
  belowFloorReason?: 'severity_below_floor' | 'confidence_below_floor';
}

/** Step 1: compute eligibility per `publication-policy.md` § step 1. */
const evaluateEligibility = (
  ranked: RankedFindings,
  severityFloor: NormalizedFinding['severity'],
  confidenceFloor: number,
): InlineCandidateEval[] =>
  ranked.map<InlineCandidateEval>((finding) => {
    const severityOk = meetsSeverityFloor(finding, severityFloor);
    const confidenceOk = meetsConfidenceFloor(finding, confidenceFloor);
    if (!severityOk) {
      return {
        finding,
        inlineEligible: false,
        belowFloorReason: 'severity_below_floor',
      };
    }
    if (!confidenceOk) {
      return {
        finding,
        inlineEligible: false,
        belowFloorReason: 'confidence_below_floor',
      };
    }
    return { finding, inlineEligible: true };
  });

interface DedupeOutcome {
  survivors: NormalizedFinding[];
  withinRunDropped: PublicationPlanDropEntry[];
  acrossRunDropped: PublicationPlanDropEntry[];
}

/**
 * Step 2: dedupe within-run and across-run.
 *
 * Within-run: when multiple findings share a `dedupe_key`, keep the
 * highest-confidence; ties broken by ranker order (i.e., the first occurrence
 * in the input list, since the input is already in ranker order).
 *
 * Across-run: drop any finding whose `dedupe_key` is in
 * `prior.published_inline_dedupe_keys`.
 */
const applyDedupe = (
  inlineEligible: NormalizedFinding[],
  prior: PriorDedupeState,
): DedupeOutcome => {
  const byKey = new Map<string, NormalizedFinding>();
  const withinRunDropped: PublicationPlanDropEntry[] = [];
  const acrossRunDropped: PublicationPlanDropEntry[] = [];

  for (const finding of inlineEligible) {
    if (prior.published_inline_dedupe_keys.has(finding.dedupe_key)) {
      acrossRunDropped.push({
        finding,
        reason_code: 'dedupe_collapsed_across_run',
        reason_message: reasonMessageFor('dedupe_collapsed_across_run'),
      });
      continue;
    }
    const existing = byKey.get(finding.dedupe_key);
    if (existing === undefined) {
      byKey.set(finding.dedupe_key, finding);
      continue;
    }
    // Existing finding shares the same dedupe_key — pick the highest-confidence;
    // on tie, the existing one wins (it came first in ranker order).
    if (finding.confidence > existing.confidence) {
      withinRunDropped.push({
        finding: existing,
        reason_code: 'dedupe_collapsed',
        reason_message: reasonMessageFor('dedupe_collapsed'),
      });
      byKey.set(finding.dedupe_key, finding);
    } else {
      withinRunDropped.push({
        finding,
        reason_code: 'dedupe_collapsed',
        reason_message: reasonMessageFor('dedupe_collapsed'),
      });
    }
  }

  // Preserve ranker order on the survivors.
  const survivorIds = new Set<string>();
  for (const f of byKey.values()) survivorIds.add(f.id);
  const survivors: NormalizedFinding[] = [];
  for (const f of inlineEligible) {
    if (survivorIds.has(f.id)) survivors.push(f);
  }
  return { survivors, withinRunDropped, acrossRunDropped };
};

interface CapOutcome {
  accepted: NormalizedFinding[];
  perFileOverflow: NormalizedFinding[];
  perPrOverflow: NormalizedFinding[];
}

/**
 * Steps 3 + 4: apply the per-file cap, then the per-PR cap.
 *
 * Per `publication-policy.md` worked example: walk the survivors in ranker
 * order; for each file, accept up to `comment_cap.per_file`. Then walk the
 * combined survivors and accept up to `comment_cap.per_pr` total.
 */
const applyCaps = (
  survivors: NormalizedFinding[],
  perFileCap: number,
  perPrCap: number,
): CapOutcome => {
  const perFileCounts = new Map<string, number>();
  const perFileOverflow: NormalizedFinding[] = [];
  const afterPerFile: NormalizedFinding[] = [];

  for (const finding of survivors) {
    const count = perFileCounts.get(finding.path) ?? 0;
    if (count >= perFileCap) {
      perFileOverflow.push(finding);
      continue;
    }
    perFileCounts.set(finding.path, count + 1);
    afterPerFile.push(finding);
  }

  const accepted: NormalizedFinding[] = [];
  const perPrOverflow: NormalizedFinding[] = [];
  for (const finding of afterPerFile) {
    if (accepted.length >= perPrCap) {
      perPrOverflow.push(finding);
      continue;
    }
    accepted.push(finding);
  }

  return { accepted, perFileOverflow, perPrOverflow };
};

const SEVERITY_LABELS: Record<NormalizedFinding['severity'], string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
  info: 'INFO',
};

const fmtFinding = (f: NormalizedFinding): string =>
  `- \`${f.path}:${f.line_start}\` — **${SEVERITY_LABELS[f.severity]}** (confidence ${f.confidence.toFixed(2)}) — ${f.title}`;

const fmtSummaryFinding = (entry: PublicationPlanDropEntry): string =>
  `- \`${entry.finding.path}:${entry.finding.line_start}\` — **${SEVERITY_LABELS[entry.finding.severity]}** (confidence ${entry.finding.confidence.toFixed(2)}) — ${entry.finding.title} _(${entry.reason_code})_`;

const SUMMARY_MAX_BYTES = 60 * 1024;
const TRUNCATION_NOTICE = '\n\n_... summary truncated (size cap reached) ..._\n';

const utf8ByteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

interface RenderInputs {
  mode: Mode;
  inline: NormalizedFinding[];
  summary: NormalizedFinding[];
  withinRunDropped: PublicationPlanDropEntry[];
  acrossRunDropped: PublicationPlanDropEntry[];
  belowFloors: PublicationPlanDropEntry[];
  perFileOverflowEntries: PublicationPlanDropEntry[];
  perPrOverflowEntries: PublicationPlanDropEntry[];
  cfg: RepoConfig;
  /**
   * Optional notice/preamble prepended to the summary body before the
   * findings section. Used for outcomes like `oversized` where the publisher
   * needs to explain _why_ the review was skipped without injecting fake
   * findings. The notice is inserted as-is (already markdown-formatted by the
   * caller); it does NOT alter the plan's partition invariant.
   *
   * Per `docs/publication-policy.md` § Diff too large: summary-only output
   * is required; adding an explanatory body is explicitly compatible.
   */
  notice?: string;
}

const renderSummary = (inputs: RenderInputs): string => {
  const lines: string[] = [];
  lines.push(`**Mode: ${inputs.mode}**`);
  lines.push('');

  // Prepend the optional notice/preamble (e.g. oversized explanation) before
  // the findings section. Inserted as-is; the caller is responsible for valid
  // markdown. Separate from the findings body with a blank line.
  if (inputs.notice !== undefined && inputs.notice.length > 0) {
    lines.push(inputs.notice);
    lines.push('');
  }

  if (inputs.inline.length > 0) {
    lines.push(`### Inline (${inputs.inline.length})`);
    for (const f of inputs.inline) lines.push(fmtFinding(f));
    lines.push('');
  }

  const summaryOnly = [
    ...inputs.belowFloors,
    ...inputs.acrossRunDropped,
    ...inputs.withinRunDropped,
    ...inputs.perFileOverflowEntries,
    ...inputs.perPrOverflowEntries,
  ];
  if (summaryOnly.length > 0) {
    lines.push(`### Summary-only (${summaryOnly.length})`);
    for (const e of summaryOnly) lines.push(fmtSummaryFinding(e));
    lines.push('');
  }

  if (inputs.inline.length === 0 && summaryOnly.length === 0) {
    lines.push('_No findings._');
    lines.push('');
  }

  const sevFloor = inputs.cfg.thresholds.severity_floor.inline;
  const confFloor = inputs.cfg.thresholds.confidence_floor.inline;
  lines.push(
    `Caps: per_pr=${inputs.cfg.comment_cap.per_pr} per_file=${inputs.cfg.comment_cap.per_file}. Floors: severity≥${sevFloor}, confidence≥${confFloor.toFixed(2)}.`,
  );

  let body = lines.join('\n');
  if (utf8ByteLength(body) > SUMMARY_MAX_BYTES) {
    // Truncate by lines to stay coherent (don't slice mid-bullet).
    const noticeBytes = utf8ByteLength(TRUNCATION_NOTICE);
    const budget = SUMMARY_MAX_BYTES - noticeBytes;
    const truncated: string[] = [];
    let used = 0;
    for (const line of lines) {
      const needed = utf8ByteLength(`${line}\n`);
      if (used + needed > budget) break;
      truncated.push(line);
      used += needed;
    }
    body = `${truncated.join('\n')}${TRUNCATION_NOTICE}`;
  }
  return body;
};

export const planPublication = (
  ranked: RankedFindings,
  cfg: RepoConfig,
  prior: PriorDedupeState,
  /**
   * Optional notice/preamble prepended to the rendered summary markdown. Used
   * by the oversized fast-path and other summary-only outcomes to surface an
   * explanatory message without injecting fake findings. Does not alter the
   * plan partition invariant (inline + summary + dropped === ranked.length).
   */
  notice?: string,
): PublicationPlan => {
  const mode = cfg.mode;
  const severityFloor = cfg.thresholds.severity_floor.inline;
  const confidenceFloor = cfg.thresholds.confidence_floor.inline;
  const perFileCap = cfg.comment_cap.per_file;
  const perPrCap = cfg.comment_cap.per_pr;

  // Step 1: eligibility.
  const evaluations = evaluateEligibility(ranked, severityFloor, confidenceFloor);
  const inlineEligible: NormalizedFinding[] = [];
  const belowFloors: PublicationPlanDropEntry[] = [];
  for (const ev of evaluations) {
    if (ev.inlineEligible) {
      inlineEligible.push(ev.finding);
    } else {
      const code = ev.belowFloorReason ?? 'severity_below_floor';
      belowFloors.push({
        finding: ev.finding,
        reason_code: code,
        reason_message: reasonMessageFor(code),
      });
    }
  }

  // Step 2: dedupe.
  const dedupe = applyDedupe(inlineEligible, prior);

  // Steps 3 + 4: caps. Note: in `dry-run` and `summary-only` we skip the cap
  // walk because no inline comments are produced regardless. The plan
  // partition must satisfy |input| === |inline| + |summary| + |dropped|;
  // each finding lands in exactly one bucket (the Markdown body may render
  // entries from multiple buckets, but the typed arrays are disjoint).
  if (mode === 'dry-run' || mode === 'summary-only') {
    // Per `publication-policy.md` § dry-run: nothing PR-visible. Summary-only:
    // the summary lists all eligible (= survivors of dedupe). Findings filtered
    // by floors or by within/across-run dedupe go in `dropped`.
    const summary: NormalizedFinding[] = mode === 'dry-run' ? [] : [...dedupe.survivors];
    // Summary entries in `summary-only` are not "dropped" — they're published.
    // We attach a sentinel reason_code so callers can iterate uniformly. We
    // pick `dedupe_collapsed` as the no-op-in-this-mode marker only when the
    // mode is dry-run (the whole survivor set is conceptually deferred).
    const summary_rejections: PublicationPlanSummaryEntry[] = [];
    const droppedSurvivors: PublicationPlanDropEntry[] =
      mode === 'dry-run'
        ? dedupe.survivors.map((f) => ({
            finding: f,
            // In dry-run nothing is "really" dropped — the policy says the
            // structured log records the eligibility decision; we surface
            // them as dry-run drops with a stable reason for audit.
            reason_code: 'dedupe_collapsed',
            reason_message: 'dry-run mode: no PR-visible artifact published',
          }))
        : [];
    const dropped: PublicationPlanDropEntry[] = [
      ...belowFloors,
      ...dedupe.acrossRunDropped,
      ...dedupe.withinRunDropped,
      ...droppedSurvivors,
    ];
    const counts = {
      input: ranked.length,
      inline: 0,
      summary: summary.length,
      dropped: dropped.length,
      below_floors: belowFloors.length,
      deduped_within_run: dedupe.withinRunDropped.length,
      deduped_across_run: dedupe.acrossRunDropped.length,
      overflowed_per_file: 0,
      overflowed_per_pr: 0,
    };
    const summary_markdown = renderSummary({
      mode,
      inline: [],
      summary,
      withinRunDropped: dedupe.withinRunDropped,
      acrossRunDropped: dedupe.acrossRunDropped,
      belowFloors,
      perFileOverflowEntries: [],
      perPrOverflowEntries: [],
      cfg,
      ...(notice !== undefined ? { notice } : {}),
    });
    return {
      inline: [],
      summary,
      summary_rejections,
      dropped,
      mode_applied: mode,
      summary_markdown,
      counts,
    };
  }

  // mode === 'summary-plus-inline'
  const caps = applyCaps(dedupe.survivors, perFileCap, perPrCap);

  const perFileOverflowEntries: PublicationPlanDropEntry[] = caps.perFileOverflow.map((f) => ({
    finding: f,
    reason_code: 'per_file_cap_exhausted',
    reason_message: reasonMessageFor('per_file_cap_exhausted'),
  }));
  const perPrOverflowEntries: PublicationPlanDropEntry[] = caps.perPrOverflow.map((f) => ({
    finding: f,
    reason_code: 'per_pr_cap_exhausted',
    reason_message: reasonMessageFor('per_pr_cap_exhausted'),
  }));

  const inline = caps.accepted;
  // Per `publication-policy.md` step 5: overflow goes into the summary list.
  // Across-run-dedupe findings also land in the summary with reason
  // `dedupe_collapsed_across_run` (per slice 5.5 spec test #6).
  const summary_rejections: PublicationPlanSummaryEntry[] = [
    ...perFileOverflowEntries,
    ...perPrOverflowEntries,
    ...dedupe.acrossRunDropped,
  ];
  const summary: NormalizedFinding[] = summary_rejections.map((e) => e.finding);

  // `dropped` = the truly suppressed: below-floors + within-run dedupe
  // collapsed siblings. Per the partition invariant, these never appear in
  // `inline` or `summary`. Cap-overflow and across-run-dedupe items live in
  // `summary` (they are surfaced to reviewers, just not as inline comments)
  // and acquire a `RejectionLogEntry` via the effectful publisher.
  const dropped: PublicationPlanDropEntry[] = [...belowFloors, ...dedupe.withinRunDropped];

  const counts = {
    input: ranked.length,
    inline: inline.length,
    summary: summary.length,
    dropped: dropped.length,
    below_floors: belowFloors.length,
    deduped_within_run: dedupe.withinRunDropped.length,
    deduped_across_run: dedupe.acrossRunDropped.length,
    overflowed_per_file: caps.perFileOverflow.length,
    overflowed_per_pr: caps.perPrOverflow.length,
  };

  const summary_markdown = renderSummary({
    mode,
    inline,
    summary,
    withinRunDropped: dedupe.withinRunDropped,
    acrossRunDropped: dedupe.acrossRunDropped,
    belowFloors,
    perFileOverflowEntries,
    perPrOverflowEntries,
    cfg,
    ...(notice !== undefined ? { notice } : {}),
  });

  return {
    inline,
    summary,
    summary_rejections,
    dropped,
    mode_applied: mode,
    summary_markdown,
    counts,
  };
};
