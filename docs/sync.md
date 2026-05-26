# Sync — Removed in 0.11.0

> **The `@classytic/ledger/sync` subpath was removed in `@classytic/ledger@0.11.0`.**
> Sync orchestration is now host responsibility. This doc page is preserved
> so links from older releases still resolve to a useful migration pointer
> instead of a 404.

## What used to live here

The `/sync` subpath shipped with three concerns bundled together:

1. **`createLedgerBridge(accounting, config)`** — `@classytic/invoice` `LedgerBridge` adapter.
2. **`wireImport` / `wireExport`** — generic batch importer/exporter pipeline.
3. **Mapper factories** — `bankStatementMapper`, `invoiceMapper`, `journalEntryMapper`, `openingBalanceMapper` (fin-io canonical shapes → `JournalEntryInput`).

All three were moved out of `@classytic/ledger` because:

- They forced **`@classytic/fin-io`** as an optional peer on every consumer, even when no fin-io shape was ever read.
- The invoice-bridge adapter imported `@classytic/invoice` types — a cross-package import that violates [`PACKAGE_RULES` P1](../PACKAGE_RULES.md) (no inter-package imports beyond `mongokit` + `primitives`).
- Only one host ever consumed the subpath, so the cost wasn't worth keeping in a shared library.

## What stayed (still on the main entry)

The pure ledger-side primitives that don't pull in fin-io OR invoice types are kept:

- `buildOpeningBalanceEntry(input)` — pure helper, re-exported from `@classytic/ledger`.
- `OpeningBalanceInput`, `OpeningBalanceResult` — re-exported from `@classytic/ledger`.
- `JournalEntryInput`, `JournalItemInput` — describe the `journalEntries.create()` input; inherent to the engine, not a sync concern.

```ts
import { buildOpeningBalanceEntry } from '@classytic/ledger';
import type { JournalEntryInput, JournalItemInput } from '@classytic/ledger';
```

## How to wire an invoice engine today

Pick one of two paths:

### Option A — Copy the canonical reference implementation

`fajr-be-arc` carries the production-grade implementation at
`src/shared/ledger-sync/`. The relevant files are:

- `ledger-bridge.ts` — implements `@classytic/invoice`'s `LedgerBridge`
  contract on top of an `AccountingEngine`. Includes multi-tenant scope,
  multi-currency, withholding tax, refunds, and an opt-in
  `resolvePaymentAccounts({ debit, credit })` callback for AR/AP-aware
  hosts (clears AR-shape for `out_invoice`, AP-shape for `in_invoice`).

Drop the files into your repo, adjust the import paths, done. The
implementation is < 600 lines total and stable.

### Option B — Implement `LedgerBridge` yourself

Implement the three-method interface against your accounting engine
directly. The contract lives in `@classytic/invoice/dist/domain/contracts/ledger-bridge.d.ts`:

```ts
export interface LedgerBridge {
  createJournalEntry(input: LedgerPostInput): Promise<string>;
  reverseJournalEntry(jeId: string, reason: string, ctx: LedgerReverseContext): Promise<string>;
  recordPayment(input: LedgerPaymentInput): Promise<string>;
}
```

A bare-minimum implementation is ~80 lines (one tax line, no withholding,
no FX). Useful when your COA is small and stable enough that the
`createLedgerBridge` config map's flexibility is overkill.

## How to wire fin-io imports today

The mapper helpers (`bankStatementMapper`, `invoiceMapper`, etc.) and the
`wireImport`/`wireExport` pipeline moved to host code along with the
bridge. The canonical implementation lives in `fajr-be-arc` under
`src/workflows/ai-bank-import.workflow.ts` (for AI-extracted bank
statements) and `src/resources/integrations/` (for QBO / Xero sync).

`@classytic/fin-io` is a normal direct dependency in fajr — not a peer
of ledger. Hosts that don't need fin-io shapes don't pull it in.

---

For the architectural rationale + full migration list, see
[`CHANGELOG.md` → 0.11.0](../CHANGELOG.md).
