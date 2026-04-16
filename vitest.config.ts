import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            'tests/api/**/*.test.ts',
            'tests/constants/**/*.test.ts',
            'tests/exports/**/*.test.ts',
            'tests/hardening/**/*.test.ts',
            'tests/money.test.ts',
            'tests/plugins/**/*.test.ts',
            'tests/schemas/**/*.test.ts',
            'tests/utils/**/*.test.ts',
          ],
          testTimeout: 10_000,
          hookTimeout: 10_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: [
            'tests/country/**/*.test.ts',
            'tests/e2e/**/*.test.ts',
            'tests/engine.test.ts',
            'tests/multi-currency.test.ts',
            'tests/reports/**/*.test.ts',
            'tests/repositories/**/*.test.ts',
            'tests/scenarios/**/*.test.ts',
            'tests/security-fixes.test.ts',
            'tests/semantic/**/*.test.ts',
            'tests/smoke/**/*.test.ts',
            'tests/sync/**/*.test.ts',
            'tests/architectural-improvements.test.ts',
          ],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
    },
  },
});
