/**
 * 0.9.0 exports smoke test — verifies every new subpath is importable
 * from the built `dist/` and that the types round-trip.
 *
 * This is a published-shape safety net: catches regressions in
 * `tsdown.config.ts` entries, the `exports` map in `package.json`, and
 * `.d.mts` generation for the new `/events` and `/bridges` subpaths.
 *
 * Runs against the committed dist/ — CI must run `npm run build` before
 * this. Skips (not fails) when dist/ is missing so watch-mode users are
 * not blocked.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '..', '..', 'dist');
const distBuilt = existsSync(join(distDir, 'index.mjs'));

describe.skipIf(!distBuilt)('0.9.0 — dist/ subpath exports', () => {
  it('exposes `@classytic/ledger/events` with expected surface', async () => {
    const mod: Record<string, unknown> = await import(
      /* @vite-ignore */ join(distDir, 'events', 'index.mjs')
    );
    expect(mod.LEDGER_EVENTS).toBeDefined();
    expect(mod.createEvent).toBeTypeOf('function');
    expect(mod.InProcessLedgerBus).toBeTypeOf('function');

    const events = mod.LEDGER_EVENTS as Record<string, string>;
    expect(events.ENTRY_POSTED).toBe('ledger:entry.posted');
    expect(events.RECONCILIATION_MATCHED).toBe('ledger:reconciliation.matched');
  });

  it('exposes `@classytic/ledger/bridges` as type-only module', async () => {
    // Bridges is a types-only entrypoint (all exports are interfaces).
    // ESM-import must still succeed and return an empty-ish module.
    const mod: Record<string, unknown> = await import(
      /* @vite-ignore */ join(distDir, 'bridges', 'index.mjs')
    );
    // Empty module or with only Symbol.toStringTag from ESM wrapper — both OK.
    expect(mod).toBeDefined();
  });

  it('re-exports events primitives from the root entry point', async () => {
    const mod: Record<string, unknown> = await import(
      /* @vite-ignore */ join(distDir, 'index.mjs')
    );
    expect(mod.LEDGER_EVENTS).toBeDefined();
    expect(mod.createEvent).toBeTypeOf('function');
    expect(mod.InProcessLedgerBus).toBeTypeOf('function');
    expect(mod.createAccountingEngine).toBeTypeOf('function');
  });

  it('InProcessLedgerBus has publishMany — arc EventTransport compatibility', async () => {
    const { InProcessLedgerBus } = (await import(
      /* @vite-ignore */ join(distDir, 'events', 'index.mjs')
    )) as { InProcessLedgerBus: new () => { publishMany: unknown } };
    const bus = new InProcessLedgerBus();
    expect(bus.publishMany).toBeTypeOf('function');
  });
});
