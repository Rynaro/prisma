import type { AssertionFailure, AssertionReport } from './assertions.js';

/**
 * Reporter — emits a JSON object to stdout and renders a Markdown report to a
 * caller-supplied path. The two outputs carry the same data; the Markdown form
 * is for humans (CI artifact upload), the JSON form is for machines (the
 * harness's own exit-code logic and any downstream consumers).
 */

export interface ScenarioOutcomeRecord {
  id: string;
  status: 'pass' | 'fail' | 'error';
  failures: AssertionFailure[];
  /** Populated when `status === 'error'` (harness error, not assertion fail). */
  error_message?: string;
  /** Brief one-liner per scenario, taken from the fixture. */
  description?: string;
}

export interface ScenarioReport {
  scenarios: ScenarioOutcomeRecord[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    errored: number;
  };
}

export const summarise = (records: ScenarioOutcomeRecord[]): ScenarioReport['summary'] => {
  let passed = 0;
  let failed = 0;
  let errored = 0;
  for (const r of records) {
    if (r.status === 'pass') passed += 1;
    else if (r.status === 'fail') failed += 1;
    else errored += 1;
  }
  return { total: records.length, passed, failed, errored };
};

export const buildReport = (records: ScenarioOutcomeRecord[]): ScenarioReport => ({
  scenarios: records,
  summary: summarise(records),
});

export const fromAssertionReport = (
  id: string,
  report: AssertionReport,
  description?: string,
): ScenarioOutcomeRecord => {
  const base: ScenarioOutcomeRecord = {
    id,
    status: report.status,
    failures: report.failures,
  };
  if (description !== undefined) base.description = description;
  return base;
};

export const renderJson = (report: ScenarioReport): string =>
  `${JSON.stringify(report, null, 2)}\n`;

const STATUS_BADGE: Record<ScenarioOutcomeRecord['status'], string> = {
  pass: 'PASS',
  fail: 'FAIL',
  error: 'ERROR',
};

export const renderMarkdown = (report: ScenarioReport): string => {
  const lines: string[] = [];
  lines.push('# Phase 6 Evaluation Report');
  lines.push('');
  lines.push(
    `Total: ${report.summary.total} | Passed: ${report.summary.passed} | Failed: ${report.summary.failed} | Errored: ${report.summary.errored}`,
  );
  lines.push('');
  lines.push('| Scenario | Status | Failures |');
  lines.push('| --- | --- | --- |');
  for (const s of report.scenarios) {
    lines.push(`| \`${s.id}\` | ${STATUS_BADGE[s.status]} | ${s.failures.length} |`);
  }
  lines.push('');
  for (const s of report.scenarios) {
    if (s.failures.length === 0 && s.status !== 'error') continue;
    lines.push(`## ${s.id} — ${STATUS_BADGE[s.status]}`);
    if (s.description !== undefined) {
      lines.push('');
      lines.push(`> ${s.description}`);
    }
    if (s.error_message !== undefined) {
      lines.push('');
      lines.push(`**Error:** ${s.error_message}`);
    }
    if (s.failures.length > 0) {
      lines.push('');
      for (const f of s.failures) {
        lines.push(`- \`${f.path}\``);
        lines.push(`  - expected: \`${JSON.stringify(f.expected)}\``);
        lines.push(`  - actual:   \`${JSON.stringify(f.actual)}\``);
        lines.push(`  - note:     ${f.message}`);
      }
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
};
