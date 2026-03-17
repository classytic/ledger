import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/money.ts',
    'src/schemas/index.ts',
    'src/reports/index.ts',
    'src/plugins/index.ts',
    'src/constants/index.ts',
    'src/country/index.ts',
    'src/repositories/index.ts',
    'src/exports/index.ts',
  ],
  format: 'esm',
  dts: false,
  sourcemap: false,
  external: ['mongoose'],
});
