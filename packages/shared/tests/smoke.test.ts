import { describe, expect, it } from 'vitest';
import { SHARED_PACKAGE_NAME } from '../src/index.js';

describe('@prisma-bot/shared', () => {
  it('exports its package name constant', () => {
    expect(SHARED_PACKAGE_NAME).toBe('@prisma-bot/shared');
  });
});
