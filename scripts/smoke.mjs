#!/usr/bin/env node
/**
 * Smoke-test runner.
 *
 * Flow (matches how `vitest`, `tsup`, `unbuild` etc. protect their releases):
 *
 *   1. Build dist/ for `@classytic/ledger`, `@classytic/ledger-bd`,
 *      and `@classytic/ledger-ca` so all three packages have a current
 *      published shape on disk.
 *   2. `npm install` inside `example/`, which dereferences the
 *      `file:..` / `file:../../ledger-bd` / `file:../../ledger-ca`
 *      dependencies and links the freshly built dist/ folders in.
 *   3. Run `example/smoke.mjs` — a CLI that imports every package by
 *      its public name (`@classytic/ledger`, `@classytic/ledger-bd`,
 *      `@classytic/ledger-ca`, never `../src/`) and drives every major
 *      primitive — including BD/CA country pack integration — against a
 *      real `mongodb-memory-server`.
 *
 * Exits non-zero on any build/install/smoke failure. Wired into
 * `prepublishOnly` so `npm publish` cannot ship a broken dist/ for any
 * of the three packages.
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..');
const exampleDir = join(packageRoot, 'example');
const ledgerBdDir = join(packageRoot, '..', 'ledger-bd');
const ledgerCaDir = join(packageRoot, '..', 'ledger-ca');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...opts,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function step(title) {
  console.log(`\n${BOLD}▶ ${title}${RESET}`);
}

try {
  step('1/4  Build dist/ for @classytic/ledger (tsdown)');
  await run('npx', ['tsdown'], { cwd: packageRoot });

  step('2/4  Build dist/ for @classytic/ledger-bd + @classytic/ledger-ca');
  // Country packs depend on the freshly built ledger dist via their own
  // file: link or via the workspace-installed copy. We just rebuild them
  // so the smoke step 13 + 14 import the latest.
  if (existsSync(ledgerBdDir)) {
    await run('npx', ['tsdown'], { cwd: ledgerBdDir });
  }
  if (existsSync(ledgerCaDir)) {
    await run('npx', ['tsdown'], { cwd: ledgerCaDir });
  }

  step('3/4  Install example/ against file: links (ledger + ledger-bd + ledger-ca)');
  // Wipe stale node_modules + lockfile so the file: link is always fresh.
  const staleNm = join(exampleDir, 'node_modules');
  const staleLock = join(exampleDir, 'package-lock.json');
  if (existsSync(staleNm)) rmSync(staleNm, { recursive: true, force: true });
  if (existsSync(staleLock)) rmSync(staleLock, { recursive: true, force: true });
  await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: exampleDir,
  });

  step('4/4  Run smoke.mjs against installed dist/ (all 3 packages)');
  await run('node', ['smoke.mjs'], { cwd: exampleDir });

  console.log(`\n${GREEN}${BOLD}✓ SMOKE TEST PASSED${RESET} ${DIM}— safe to publish${RESET}`);
} catch (err) {
  console.error(`\n${RED}${BOLD}✗ SMOKE TEST FAILED${RESET}`);
  console.error(`${RED}${err instanceof Error ? err.message : String(err)}${RESET}`);
  process.exit(1);
}
