import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/money.ts',
    'src/reports/index.ts',
    'src/plugins/index.ts',
    'src/constants/index.ts',
    'src/country/index.ts',
    'src/exports/index.ts',
    'src/sync/index.ts',
    'src/events/index.ts',
    'src/bridges/index.ts',
  ],
  format: ['esm'],
  dts: { sourcemap: false },
  clean: true,
  sourcemap: false,
  treeshake: true,
  deps: {
    neverBundle: ['mongoose', 'zod', /^@classytic\//],
  },
});
