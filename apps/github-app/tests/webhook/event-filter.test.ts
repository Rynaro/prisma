import { describe, expect, it } from 'vitest';
import { isAcceptedEvent } from '../../src/webhook/event-filter.js';

describe('isAcceptedEvent', () => {
  // --- pull_request (existing, regression guard) ---
  it('accepts pull_request.opened', () => {
    expect(isAcceptedEvent('pull_request', 'opened')).toBe(true);
  });

  it('accepts pull_request.synchronize', () => {
    expect(isAcceptedEvent('pull_request', 'synchronize')).toBe(true);
  });

  it('accepts pull_request.reopened', () => {
    expect(isAcceptedEvent('pull_request', 'reopened')).toBe(true);
  });

  it('rejects pull_request.closed', () => {
    expect(isAcceptedEvent('pull_request', 'closed')).toBe(false);
  });

  it('rejects pull_request.edited', () => {
    expect(isAcceptedEvent('pull_request', 'edited')).toBe(false);
  });

  // --- issue_comment ---
  it('accepts issue_comment.created', () => {
    expect(isAcceptedEvent('issue_comment', 'created')).toBe(true);
  });

  it('rejects issue_comment.edited', () => {
    expect(isAcceptedEvent('issue_comment', 'edited')).toBe(false);
  });

  it('rejects issue_comment.deleted', () => {
    expect(isAcceptedEvent('issue_comment', 'deleted')).toBe(false);
  });

  // --- check_run ---
  it('accepts check_run.rerequested', () => {
    expect(isAcceptedEvent('check_run', 'rerequested')).toBe(true);
  });

  it('rejects check_run.completed', () => {
    expect(isAcceptedEvent('check_run', 'completed')).toBe(false);
  });

  it('rejects check_run.created', () => {
    expect(isAcceptedEvent('check_run', 'created')).toBe(false);
  });

  // --- other ---
  it('rejects issues.opened', () => {
    expect(isAcceptedEvent('issues', 'opened')).toBe(false);
  });

  it('rejects when event name is missing', () => {
    expect(isAcceptedEvent(undefined, 'opened')).toBe(false);
  });

  it('rejects when action is missing', () => {
    expect(isAcceptedEvent('pull_request', undefined)).toBe(false);
  });

  it('rejects when both are missing', () => {
    expect(isAcceptedEvent(undefined, undefined)).toBe(false);
  });
});
