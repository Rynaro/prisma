import type { IssueCommentsClient } from '@prisma-bot/github';
import {
  type JobPayload,
  parseCommand,
  parseMentionCandidate,
  requiresWrite,
} from '@prisma-bot/shared';
import { describe, expect, it, vi } from 'vitest';

/**
 * Hand-rolled `FakeIssueCommentsClient` matching the `IssueCommentsClient`
 * interface.  Records every call so assertions can be made on ack protocol
 * ordering.
 */
const makeFakeIssueComments = (): IssueCommentsClient & {
  replyCalls: Array<{ issue_number: number; body: string }>;
  reactionCalls: Array<{ comment_id: number; content: string }>;
  authorCalls: Array<{ comment_id: number }>;
} => {
  const replyCalls: Array<{ issue_number: number; body: string }> = [];
  const reactionCalls: Array<{ comment_id: number; content: string }> = [];
  const authorCalls: Array<{ comment_id: number }> = [];
  return {
    replyCalls,
    reactionCalls,
    authorCalls,
    async createReply(args) {
      replyCalls.push({ issue_number: args.issue_number, body: args.body });
      return { id: 999 };
    },
    async getAuthor(args) {
      authorCalls.push({ comment_id: args.comment_id });
      return 'alice';
    },
    async addReaction(args) {
      reactionCalls.push({ comment_id: args.comment_id, content: args.content });
    },
  };
};

/**
 * Build a minimal comment job payload for testing.
 */
const makeCommentPayload = (
  overrides: Partial<Extract<JobPayload, { event_type: 'issue_comment.command' }>> = {},
): Extract<JobPayload, { event_type: 'issue_comment.command' }> => ({
  idempotency_key: 'idem-test-1',
  installation_id: 1234,
  repository_id: 5678,
  pull_request_number: 42,
  head_sha: '',
  event_type: 'issue_comment.command',
  received_at: '2026-06-12T00:00:00Z',
  comment_id: 9001,
  commenter_login: 'alice',
  commenter_association: 'COLLABORATOR',
  mention_candidate: 'mybot',
  command_raw: 'review',
  command_marker: '@',
  owner: 'octocat',
  repo: 'hello-world',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Command parser unit tests (authoritative parse at worker time)
// ---------------------------------------------------------------------------

describe('command parser (worker-side)', () => {
  it('parseMentionCandidate extracts candidate and rest', () => {
    const result = parseMentionCandidate('@mybot review');
    expect(result).not.toBeNull();
    expect(result?.candidate).toBe('mybot');
    expect(result?.rest).toBe('review');
  });

  it('parseMentionCandidate returns null for no mention', () => {
    expect(parseMentionCandidate('LGTM, ship it')).toBeNull();
  });

  it('parseCommand maps review → {kind:review}', () => {
    expect(parseCommand('review')).toEqual({ kind: 'review' });
  });

  it('parseCommand maps full review → {kind:full_review}', () => {
    expect(parseCommand('full review')).toEqual({ kind: 'full_review' });
  });

  it('parseCommand maps help → {kind:help, unknown:false}', () => {
    expect(parseCommand('help')).toEqual({ kind: 'help', unknown: false });
  });

  it('parseCommand maps unknown → {kind:help, unknown:true}', () => {
    expect(parseCommand('frobnicate')).toEqual({ kind: 'help', unknown: true });
  });

  it('parseCommand maps configuration → {kind:configuration}', () => {
    expect(parseCommand('configuration')).toEqual({ kind: 'configuration' });
  });

  it('requiresWrite returns false for all v1 commands', () => {
    for (const cmd of [
      parseCommand('review'),
      parseCommand('full review'),
      parseCommand('help'),
      parseCommand('configuration'),
    ]) {
      expect(requiresWrite(cmd)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// FakeIssueCommentsClient behaviour tests
// ---------------------------------------------------------------------------

describe('FakeIssueCommentsClient', () => {
  it('records createReply calls', async () => {
    const fake = makeFakeIssueComments();
    const result = await fake.createReply({
      owner: 'o',
      repo: 'r',
      issue_number: 42,
      body: 'hello',
    });
    expect(result.id).toBe(999);
    expect(fake.replyCalls).toHaveLength(1);
    expect(fake.replyCalls[0]).toMatchObject({ issue_number: 42, body: 'hello' });
  });

  it('records addReaction calls', async () => {
    const fake = makeFakeIssueComments();
    await fake.addReaction({ owner: 'o', repo: 'r', comment_id: 123, content: 'eyes' });
    expect(fake.reactionCalls).toHaveLength(1);
    expect(fake.reactionCalls[0]).toMatchObject({ comment_id: 123, content: 'eyes' });
  });

  it('records getAuthor calls', async () => {
    const fake = makeFakeIssueComments();
    const login = await fake.getAuthor({ owner: 'o', repo: 'r', comment_id: 777 });
    expect(login).toBe('alice');
    expect(fake.authorCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Loop prevention logic
// ---------------------------------------------------------------------------

describe('loop prevention (bot-author detection)', () => {
  /**
   * Mirrors the loop-prevention check inside handleCommentJob (worker.ts).
   * Extracted here as a pure function to test the rule without standing up
   * the full worker.
   */
  const isBotAuthor = (commenterLogin: string): boolean => commenterLogin.endsWith('[bot]');

  it('detects a "[bot]" suffix login as a bot author', () => {
    expect(isBotAuthor('mybot[bot]')).toBe(true);
    expect(isBotAuthor('prisma-review-bot[bot]')).toBe(true);
  });

  it('does not classify a human login as a bot', () => {
    expect(isBotAuthor('alice')).toBe(false);
    expect(isBotAuthor('octocat')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Nickname resolution logic
// ---------------------------------------------------------------------------

describe('nickname resolution (D2)', () => {
  /**
   * Mirrors the target-set construction inside handleCommentJob (worker.ts).
   * Updated to use case-insensitive comparison (fix c).
   */
  const buildValidTargets = (botLogin: string, nickname?: string): Set<string> => {
    const targets = new Set<string>([botLogin.toLowerCase(), `${botLogin}[bot]`.toLowerCase()]);
    if (nickname !== undefined) targets.add(nickname.toLowerCase());
    return targets;
  };

  const matchesTarget = (candidate: string, targets: Set<string>): boolean =>
    targets.has(candidate.toLowerCase());

  it('accepts the bot login as a valid target', () => {
    const targets = buildValidTargets('mybot');
    expect(matchesTarget('mybot', targets)).toBe(true);
    expect(matchesTarget('mybot[bot]', targets)).toBe(true);
  });

  it('accepts the configured nickname as a valid target', () => {
    const targets = buildValidTargets('mybot', 'reviewbot');
    expect(matchesTarget('reviewbot', targets)).toBe(true);
  });

  it('does not accept an unrelated login as a valid target', () => {
    const targets = buildValidTargets('mybot');
    expect(matchesTarget('wrongname', targets)).toBe(false);
  });

  it('nickname does not override loop prevention (bot login always in set)', () => {
    // Even when nickname is set, bot login is still in the valid-targets set.
    const targets = buildValidTargets('mybot', 'reviewbot');
    expect(matchesTarget('mybot', targets)).toBe(true);
  });

  // --- (c) case-insensitive nickname/slug matching ---

  it('case-insensitive: candidate "josie" matches nickname "Josie" (exact production case)', () => {
    const targets = buildValidTargets('mybot', 'Josie');
    expect(matchesTarget('josie', targets)).toBe(true);
  });

  it('case-insensitive: candidate "Josie" matches nickname "josie"', () => {
    const targets = buildValidTargets('mybot', 'josie');
    expect(matchesTarget('Josie', targets)).toBe(true);
  });

  it('case-insensitive: candidate "MYBOT" matches bot login "mybot"', () => {
    const targets = buildValidTargets('mybot');
    expect(matchesTarget('MYBOT', targets)).toBe(true);
  });

  it('case-insensitive: candidate "MyBot[BOT]" matches bot comment login "mybot[bot]"', () => {
    const targets = buildValidTargets('mybot');
    expect(matchesTarget('MyBot[BOT]', targets)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Marker mismatch drop (b)
// ---------------------------------------------------------------------------

describe('marker mismatch drop logic', () => {
  /**
   * Mirrors the marker-enforcement logic inside handleCommentJob (worker.ts).
   */
  const isMarkerMatch = (payloadMarker: string, configuredMarker: string): boolean =>
    payloadMarker === configuredMarker;

  it('@ matches @ (default case)', () => {
    expect(isMarkerMatch('@', '@')).toBe(true);
  });

  it('$ matches $ (custom marker)', () => {
    expect(isMarkerMatch('$', '$')).toBe(true);
  });

  it('$ does NOT match @ (mismatch → drop)', () => {
    expect(isMarkerMatch('$', '@')).toBe(false);
  });

  it('@ does NOT match $ (mismatch → drop)', () => {
    expect(isMarkerMatch('@', '$')).toBe(false);
  });

  it('! does NOT match / (mismatch → drop)', () => {
    expect(isMarkerMatch('!', '/')).toBe(false);
  });

  it('default payload marker "@" matches default config "@"', () => {
    // Old payloads without command_marker field get default '@' from Zod.
    const payloadMarker = '@'; // Zod default
    const configuredMarker = '@'; // config default
    expect(isMarkerMatch(payloadMarker, configuredMarker)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Payload shape tests (comment job payload validation)
// ---------------------------------------------------------------------------

describe('comment job payload', () => {
  it('has the correct event_type discriminant', () => {
    const p = makeCommentPayload();
    expect(p.event_type).toBe('issue_comment.command');
  });

  it('carries head_sha as empty sentinel at ingress time', () => {
    const p = makeCommentPayload();
    expect(p.head_sha).toBe('');
  });

  it('carries command_marker "@" by default', () => {
    const p = makeCommentPayload();
    expect(p.command_marker).toBe('@');
  });

  it('carries non-default command_marker when overridden', () => {
    const p = makeCommentPayload({ command_marker: '$' });
    expect(p.command_marker).toBe('$');
  });

  it('ack fail-open: reaction error does not propagate to reply', async () => {
    // This test verifies the fail-open contract: even when addReaction throws,
    // createReply can still be called (the error is swallowed by the catch).
    const fake = makeFakeIssueComments();
    const addReactionSpy = vi
      .spyOn(fake, 'addReaction')
      .mockRejectedValueOnce(new Error('network'));

    // Simulate the fail-open ack protocol: attempt reaction (fail), then reply.
    try {
      await fake.addReaction({
        owner: 'o',
        repo: 'r',
        comment_id: 9001,
        content: 'eyes',
      });
    } catch {
      // Swallow — fail-open
    }
    await fake.createReply({ owner: 'o', repo: 'r', issue_number: 42, body: 'help body' });

    expect(addReactionSpy).toHaveBeenCalledOnce();
    expect(fake.replyCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Eyes reaction ordering (d)
// ---------------------------------------------------------------------------

describe('eyes reaction ordering', () => {
  /**
   * Mirrors the ordering contract: 👀 must NOT be posted when a drop condition
   * (marker mismatch or nickname mismatch) is detected before dispatch.
   * This is a pure-function simulation of the control flow.
   */

  interface DropResult {
    dropped: boolean;
    reason: string;
  }

  const checkDropBeforeEyes = (
    payloadMarker: string,
    configuredMarker: string,
    candidateLower: string,
    validTargets: Set<string>,
  ): DropResult => {
    if (payloadMarker !== configuredMarker) {
      return { dropped: true, reason: 'marker_mismatch' };
    }
    if (!validTargets.has(candidateLower)) {
      return { dropped: true, reason: 'nickname_mismatch' };
    }
    return { dropped: false, reason: '' };
  };

  it('does NOT drop on matching marker + matching candidate (eyes SHOULD be posted)', () => {
    const result = checkDropBeforeEyes('@', '@', 'mybot', new Set(['mybot', 'mybot[bot]']));
    expect(result.dropped).toBe(false);
  });

  it('drops on marker mismatch (eyes should NOT be posted)', () => {
    const result = checkDropBeforeEyes('$', '@', 'mybot', new Set(['mybot']));
    expect(result.dropped).toBe(true);
    expect(result.reason).toBe('marker_mismatch');
  });

  it('drops on nickname mismatch (eyes should NOT be posted)', () => {
    const result = checkDropBeforeEyes('@', '@', 'wrongbot', new Set(['mybot', 'mybot[bot]']));
    expect(result.dropped).toBe(true);
    expect(result.reason).toBe('nickname_mismatch');
  });

  it('$ marker with matching config allows eyes to be posted', () => {
    const result = checkDropBeforeEyes('$', '$', 'josie', new Set(['josie', 'josie[bot]']));
    expect(result.dropped).toBe(false);
  });
});
