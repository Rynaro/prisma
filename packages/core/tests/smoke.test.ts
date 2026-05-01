import { describe, expect, it } from 'vitest';
import {
  CORE_PACKAGE_NAME,
  PREFILTER_MODULE,
  SNAPSHOTTER_MODULE,
  VALIDATOR_RANKER_MODULE,
} from '../src/index.js';

describe('@prisma-bot/core', () => {
  it('exports the three pipeline-stage module markers', () => {
    expect(CORE_PACKAGE_NAME).toBe('@prisma-bot/core');
    expect(SNAPSHOTTER_MODULE).toBe('snapshotter');
    expect(PREFILTER_MODULE).toBe('prefilter');
    expect(VALIDATOR_RANKER_MODULE).toBe('validator-ranker');
  });
});
