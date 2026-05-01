import { describe, expect, it } from 'vitest';
import {
  CHECK_RUNS_MODULE,
  GITHUB_PACKAGE_NAME,
  INSTALLATION_AUTH_MODULE,
  REVIEW_COMMENTS_MODULE,
} from '../src/index.js';

describe('@prisma-bot/github', () => {
  it('exports module markers for installation-auth, check-runs, review-comments', () => {
    expect(GITHUB_PACKAGE_NAME).toBe('@prisma-bot/github');
    expect(INSTALLATION_AUTH_MODULE).toBe('installation-auth');
    expect(CHECK_RUNS_MODULE).toBe('check-runs');
    expect(REVIEW_COMMENTS_MODULE).toBe('review-comments');
  });
});
