import { describe, expect, it } from 'vitest';
import type { CheckRunsClient } from '../../src/check-runs/index.js';
import {
  INTERACTION_MARKER_RE,
  buildInteractionMarker,
  harvestFindings,
  harvestInteractionState,
  harvestLatestRoundSummary,
  parseFindingCommentBody,
  renderInteractionReply,
} from '../../src/interactions/index.js';
import type { IssueCommentsClient } from '../../src/issue-comments/index.js';
import type { ReviewCommentsClient } from '../../src/review-comments/index.js';

/**
 * Tests for the GitHub-adjacent harvest + rendering helpers backing the
 * reviewer-interaction feature (`@bot ask <message>`).
 * Per docs/_planning/reviewer-interaction/spec.md § 5 / § 7.
 */

const ctx = {
  owner: 'o',
  repo: 'r',
  pull_request_number: 42,
  head_sha: 'deadbeefcafef00d',
  app_login: 'prisma-bot',
  app_id: 1,
};

// A finding comment rendered exactly like `renderInlineCommentBody` (publisher/effects.ts).
const findingBody = (
  overrides: Partial<{
    severity: string;
    title: string;
    explanation: string;
    category: string;
    suggestedFix: string;
  }> = {},
): string => {
  const severity = overrides.severity ?? 'MEDIUM';
  const title = overrides.title ?? 'Unbounded user input';
  const explanation = overrides.explanation ?? 'Reachable from a public route handler.';
  const category = overrides.category ?? 'security';
  const suggestedFixLine =
    overrides.suggestedFix !== undefined ? `\n\nSuggested fix: ${overrides.suggestedFix}` : '';
  return `**[${severity}]** ${title}\n\n${explanation}${suggestedFixLine}\n\n<sub>confidence 0.80 · ${category}</sub>\n<!-- prisma-bot:dedupe=abc123 -->`;
};

describe('INTERACTION_MARKER_RE / buildInteractionMarker', () => {
  it('builds and matches the interaction marker format', () => {
    const marker = buildInteractionMarker(3, 2);
    expect(marker).toBe('<!-- prisma-bot:interaction round=3 seq=2 -->');
    const m = INTERACTION_MARKER_RE.exec(marker);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe('3');
    expect(m?.[2]).toBe('2');
  });
});

describe('parseFindingCommentBody', () => {
  it('parses a well-formed finding comment', () => {
    const parsed = parseFindingCommentBody(findingBody());
    expect(parsed).toEqual({
      severity: 'medium',
      title: 'Unbounded user input',
      body: 'Reachable from a public route handler.',
      category: 'security',
    });
  });

  it('parses a finding comment with a suggested fix', () => {
    const parsed = parseFindingCommentBody(
      findingBody({ suggestedFix: 'Use a parameterized query.' }),
    );
    expect(parsed?.body).toBe('Reachable from a public route handler.');
    expect(parsed?.category).toBe('security');
  });

  it('returns null for a malformed body', () => {
    expect(parseFindingCommentBody('not a finding comment')).toBeNull();
  });
});

describe('harvestLatestRoundSummary', () => {
  const makeCheckRuns = (
    runs: Array<{ output_summary: string | null }>,
    shouldThrow = false,
  ): CheckRunsClient =>
    ({
      startInProgress: async () => ({ check_run_id: 1 }),
      finalize: async () => undefined,
      listOurs: async () => {
        if (shouldThrow) throw new Error('boom');
        return runs.map((r) => ({ id: 1, conclusion: null, ...r }));
      },
    }) as unknown as CheckRunsClient;

  it('returns round=0 and empty summary when no marker is present', async () => {
    const checkRuns = makeCheckRuns([{ output_summary: null }]);
    const out = await harvestLatestRoundSummary({ checkRuns }, ctx);
    expect(out).toEqual({ round: 0, summary_markdown: '' });
  });

  it('returns the highest round + its summary text', async () => {
    const checkRuns = makeCheckRuns([
      { output_summary: 'Round 1\n\n<!-- prisma-bot:round=1 head=deadbeef -->' },
      { output_summary: 'Round 2 · 1 still open\n\n<!-- prisma-bot:round=2 head=cafef00d -->' },
    ]);
    const out = await harvestLatestRoundSummary({ checkRuns }, ctx);
    expect(out.round).toBe(2);
    expect(out.summary_markdown).toContain('Round 2 · 1 still open');
  });

  it('fails open (round=0) when listOurs throws', async () => {
    const checkRuns = makeCheckRuns([], true);
    const out = await harvestLatestRoundSummary({ checkRuns }, ctx);
    expect(out).toEqual({ round: 0, summary_markdown: '' });
  });
});

describe('harvestFindings', () => {
  const makeReviewComments = (
    comments: Array<{ path: string; line: number | null; body: string }>,
    shouldThrow = false,
  ): ReviewCommentsClient =>
    ({
      postInline: async () => ({ id: 1 }),
      listOurs: async () => {
        if (shouldThrow) throw new Error('boom');
        return comments;
      },
    }) as unknown as ReviewCommentsClient;

  it('parses well-formed finding comments into RespondFinding[]', async () => {
    const reviewComments = makeReviewComments([
      { path: 'src/a.ts', line: 10, body: findingBody() },
    ]);
    const out = await harvestFindings({ reviewComments }, ctx);
    expect(out).toEqual([
      {
        file: 'src/a.ts',
        line: 10,
        severity: 'medium',
        category: 'security',
        title: 'Unbounded user input',
        body: 'Reachable from a public route handler.',
      },
    ]);
  });

  it('skips comments with a null line or malformed body', async () => {
    const reviewComments = makeReviewComments([
      { path: 'src/a.ts', line: null, body: findingBody() },
      { path: 'src/b.ts', line: 5, body: 'not a finding' },
    ]);
    const out = await harvestFindings({ reviewComments }, ctx);
    expect(out).toEqual([]);
  });

  it('caps at MAX_RESPOND_FINDINGS (20) entries', async () => {
    const comments = Array.from({ length: 25 }, (_, i) => ({
      path: `src/f${i}.ts`,
      line: i + 1,
      body: findingBody({ title: `finding ${i}` }),
    }));
    const reviewComments = makeReviewComments(comments);
    const out = await harvestFindings({ reviewComments }, ctx);
    expect(out).toHaveLength(20);
  });

  it('fails open ([]) when listOurs throws', async () => {
    const reviewComments = makeReviewComments([], true);
    const out = await harvestFindings({ reviewComments }, ctx);
    expect(out).toEqual([]);
  });
});

describe('harvestInteractionState', () => {
  const makeIssueComments = (
    comments: Array<{ id: number; body: string }>,
    shouldThrow = false,
  ): IssueCommentsClient =>
    ({
      createReply: async () => ({ id: 1 }),
      getAuthor: async () => null,
      addReaction: async () => undefined,
      listOurs: async () => {
        if (shouldThrow) throw new Error('boom');
        return comments;
      },
    }) as unknown as IssueCommentsClient;

  it('counts markers matching the round and parses the thread context', async () => {
    const body = renderInteractionReply({
      author_login: 'alice',
      question: 'why is finding 2 risky?',
      reply_markdown: 'It allows unsanitized input to reach the DB.',
      round: 3,
      seq: 1,
    });
    const issueComments = makeIssueComments([{ id: 1, body }]);
    const out = await harvestInteractionState({ issueComments }, ctx, 3);
    expect(out.used).toBe(1);
    expect(out.exchanges).toEqual([
      {
        author_login: 'alice',
        question: 'why is finding 2 risky?',
        reply_markdown: 'It allows unsanitized input to reach the DB.',
      },
    ]);
  });

  it('only counts markers for the queried round', async () => {
    const roundTwoBody = renderInteractionReply({
      author_login: 'alice',
      question: 'q1',
      reply_markdown: 'r1',
      round: 2,
      seq: 1,
    });
    const roundThreeBody = renderInteractionReply({
      author_login: 'alice',
      question: 'q2',
      reply_markdown: 'r2',
      round: 3,
      seq: 1,
    });
    const issueComments = makeIssueComments([
      { id: 1, body: roundTwoBody },
      { id: 2, body: roundThreeBody },
    ]);
    const out = await harvestInteractionState({ issueComments }, ctx, 3);
    expect(out.used).toBe(1);
    expect(out.exchanges).toHaveLength(1);
    expect(out.exchanges[0]?.question).toBe('q2');
  });

  it('malformed marked comments count toward budget but are skipped as thread context', async () => {
    const malformed = `some unrelated text\n\n${buildInteractionMarker(3, 1)}`;
    const wellFormed = renderInteractionReply({
      author_login: 'bob',
      question: 'q2',
      reply_markdown: 'r2',
      round: 3,
      seq: 2,
    });
    const issueComments = makeIssueComments([
      { id: 1, body: malformed },
      { id: 2, body: wellFormed },
    ]);
    const out = await harvestInteractionState({ issueComments }, ctx, 3);
    expect(out.used).toBe(2);
    expect(out.exchanges).toHaveLength(1);
    expect(out.exchanges[0]?.question).toBe('q2');
  });

  it('caps thread exchanges at the 10 most recent, oldest→newest order preserved', async () => {
    const comments = Array.from({ length: 15 }, (_, i) =>
      renderInteractionReply({
        author_login: 'alice',
        question: `q${i}`,
        reply_markdown: `r${i}`,
        round: 1,
        seq: i + 1,
      }),
    ).map((body, i) => ({ id: i + 1, body }));
    const issueComments = makeIssueComments(comments);
    const out = await harvestInteractionState({ issueComments }, ctx, 1);
    expect(out.used).toBe(15);
    expect(out.exchanges).toHaveLength(10);
    // Oldest of the retained window is q5 (0-indexed: entries q5..q14 survive).
    expect(out.exchanges[0]?.question).toBe('q5');
    expect(out.exchanges.at(-1)?.question).toBe('q14');
  });

  it('fails open ({used: 0, exchanges: []}) when listOurs throws', async () => {
    const issueComments = makeIssueComments([], true);
    const out = await harvestInteractionState({ issueComments }, ctx, 1);
    expect(out).toEqual({ used: 0, exchanges: [] });
  });
});

describe('renderInteractionReply', () => {
  it('renders the blockquoted question, the reply, and the marker', () => {
    const body = renderInteractionReply({
      author_login: 'alice',
      question: 'why is finding 2 a security risk?',
      reply_markdown: 'Because it reaches the DB unsanitized.',
      round: 3,
      seq: 2,
    });
    expect(body).toBe(
      '> **@alice asked:** why is finding 2 a security risk?\n\n' +
        'Because it reaches the DB unsanitized.\n\n' +
        '<!-- prisma-bot:interaction round=3 seq=2 -->',
    );
  });

  it('truncates the reply body (not the header or marker) to fit maxBytes', () => {
    const longReply = 'x'.repeat(200);
    const body = renderInteractionReply(
      {
        author_login: 'alice',
        question: 'q',
        reply_markdown: longReply,
        round: 1,
        seq: 1,
      },
      100,
    );
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(100);
    expect(body).toContain('> **@alice asked:** q');
    expect(body).toContain('<!-- prisma-bot:interaction round=1 seq=1 -->');
  });
});
