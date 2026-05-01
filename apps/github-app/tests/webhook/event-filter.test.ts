import { describe, expect, it } from 'vitest';
import { isAcceptedEvent } from '../../src/webhook/event-filter.js';

describe('isAcceptedEvent', () => {
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
