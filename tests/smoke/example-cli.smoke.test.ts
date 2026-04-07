/**
 * Smoke-test bridge into the vitest suite.
 *
 * Runs `scripts/smoke.mjs`, which builds dist/, installs the `example/`
 * CLI against the `file:..` link, and drives every major public primitive
 * against a real mongodb-memory-server. This is the *published-shape*
 * safety net — catches regressions in the exports map, subpath bundling,
 * tree-shaking, and type-stripping that the src/-level unit tests miss.
 *
 * This test is opt-in because it rebuilds the package and reinstalls
 * `example/node_modules` — too slow for watch mode. Run it explicitly:
 *
 *   LEDGER_SMOKE=1 npx vitest run tests/smoke
 *
 * or via the shortcut script:
 *
 *   npm run smoke
 *
 * CI should set LEDGER_SMOKE=1 before the publish step. The same runner
 * is also wired into `prepublishOnly`, so `npm publish` cannot ship a
 * broken dist/ even if a human forgets to run this.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..', '..');
const runner = join(packageRoot, 'scripts', 'smoke.mjs');

const enabled = process.env.LEDGER_SMOKE === '1';

describe.skipIf(!enabled)('published-shape smoke test (opt-in via LEDGER_SMOKE=1)', () => {
  it(
    'build + install example/ + run CLI against dist/ — all green',
    () => {
      const result = spawnSync('node', [runner], {
        cwd: packageRoot,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });

      if (result.status !== 0) {
        const output = [
          '\n──── smoke stdout ────',
          result.stdout,
          '\n──── smoke stderr ────',
          result.stderr,
        ].join('\n');
        throw new Error(`scripts/smoke.mjs failed (exit ${result.status})\n${output}`);
      }

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/SMOKE TEST PASSED/);
    },
    // Five minutes — first run downloads mongodb-memory-server binaries.
    5 * 60_000,
  );
});
