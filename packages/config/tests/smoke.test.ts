import { describe, expect, it } from 'vitest';
import { CONFIG_PACKAGE_NAME, REPO_LOCAL_CONFIG_PATH } from '../src/index.js';

describe('@prisma-bot/config', () => {
  it('exports its package name constant', () => {
    expect(CONFIG_PACKAGE_NAME).toBe('@prisma-bot/config');
  });

  it('declares the repo-local config path from the brief', () => {
    expect(REPO_LOCAL_CONFIG_PATH).toBe('.github/review-bot.yml');
  });
});
