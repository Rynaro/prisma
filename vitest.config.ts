import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'apps/**/tests/**/*.test.ts',
      'apps/**/src/**/*.test.ts',
      'packages/**/tests/**/*.test.ts',
      'packages/**/src/**/*.test.ts',
      'evals/runner/tests/**/*.test.ts',
      'evals/runner/src/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['apps/**/src/**', 'packages/**/src/**'],
      exclude: ['**/index.ts', '**/*.test.ts'],
    },
  },
});
