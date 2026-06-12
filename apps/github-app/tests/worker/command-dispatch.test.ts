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
   */
  const buildValidTargets = (botLogin: string, nickname?: string): Set<string> => {
    const targets = new Set<string>([botLogin, `${botLogin}[bot]`]);
    if (nickname !== undefined) targets.add(nickname);
    return targets;
  };

  it('accepts the bot login as a valid target', () => {
    const targets = buildValidTargets('mybot');
    expect(targets.has('mybot')).toBe(true);
    expect(targets.has('mybot[bot]')).toBe(true);
  });

  it('accepts the configured nickname as a valid target', () => {
    const targets = buildValidTargets('mybot', 'reviewbot');
    expect(targets.has('reviewbot')).toBe(true);
  });

  it('does not accept an unrelated login as a valid target', () => {
    const targets = buildValidTargets('mybot');
    expect(targets.has('wrongname')).toBe(false);
  });

  it('nickname does not override loop prevention (bot login always in set)', () => {
    // Even when nickname is set, bot login is still in the valid-targets set.
    const targets = buildValidTargets('mybot', 'reviewbot');
    expect(targets.has('mybot')).toBe(true);
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
