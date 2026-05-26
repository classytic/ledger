# @classytic/ledger

Double-entry accounting engine for MongoDB. Integer-cents arithmetic, plugin-based, country-agnostic, multi-tenant. Framework-agnostic — works with Fastify, Express, Nest, or plain Mongoose.

## Install

```bash
npm install @classytic/ledger @classytic/mongokit mongoose
npm install @classytic/ledger-bd   # Bangladesh (BFRS chart of accounts)
```

## Quick Start

```ts
import mongoose from 'mongoose';
import { createAccountingEngine } from '@classytic/ledger';
import { bangladeshPack } from '@classytic/ledger-bd';

const engine = createAccountingEngine({
  mongoose: mongoose.connection,
  country: bangladeshPack,
  currency: 'BDT',
  multiTenant: { orgField: 'organizationId', orgRef: 'organization' },
});

// Seed chart of accounts for a branch
await engine.repositories.accounts.seedAccounts(orgId);

// Post a journal entry
const entry = await engine.repositories.journalEntries.create({
  journalType: 'GENERAL',
  date: new Date(),
  label: 'Office supplies',
  journalItems: [
    { account: expenseAccountId, debit: 500_00, credit: 0 },
    { account: cashAccountId, debit: 0, credit: 500_00 },
  ],
});
await engine.repositories.journalEntries.post(entry._id, orgId);
```

## Multi-Currency (0.9.0+)

GL stays in base currency (BDT). Foreign currency is audit metadata.

```ts
const engine = createAccountingEngine({
  country: bangladeshPack,
  currency: 'BDT',
  multiCurrency: { enabled: true, currencies: ['USD', 'EUR', 'GBP'] },
  bridges: {
    exchangeRate: myRateBridge, // host-injected rate source
  },
});

// Post with foreign currency metadata
await engine.repositories.journalEntries.create({
  journalType: 'PURCHASES',
  date: new Date(),
  label: 'Import from China',
  journalItems: [
    {
      account: inventoryId,
      debit: 120_500_00,    // BDT (base currency, always)
      credit: 0,
      currency: 'USD',
      originalDebit: 1_000_00, // USD 1,000.00
      exchangeRate: 120.50,
    },
    { account: apId, debit: 0, credit: 120_500_00 },
  ],
});
```

## Features

| Feature | What it does |
|---------|-------------|
| **Double-entry** | `doubleEntryPlugin` validates debit = credit on every post |
| **Integer cents** | All amounts in minor units (paisa/cents). No float errors. |
| **Multi-tenant** | `organizationId` scoping via mongokit plugin |
| **Multi-currency** | Optional foreign currency fields + FX realization + revaluation |
| **Idempotency** | `idempotencyPlugin` prevents duplicate postings |
| **Period locking** | `createLockPlugin` blocks edits to closed periods |
| **Credit limits** | `creditLimitPlugin` enforces per-partner credit caps |
| **Immutable guard** | `immutableGuardPlugin` prevents posted entry edits |
| **Country packs** | Pluggable chart of accounts (BD, CA, custom) |

## Reports

```ts
import {
  generateTrialBalance,
  generateBalanceSheet,
  generateIncomeStatement,
  generateCashFlow,
  generateGeneralLedger,
  generateAgedBalance,
  generateBudgetVsActual,
  generatePartnerLedger,
  generateRevaluation,
} from '@classytic/ledger';
```

All reports accept `{ startDate, endDate, organizationId }` and return typed result objects.

## Bridges

All optional. All methods optional. Features degrade gracefully.

```ts
import type { ExchangeRateBridge, SourceBridge, NotificationBridge } from '@classytic/ledger';

const engine = createAccountingEngine({
  // ...
  bridges: {
    exchangeRate: myRateBridge,    // FX rate lookup
    source: mySourceBridge,        // resolve external doc refs
    notification: myNotifBridge,   // alert on reversals, period locks
  },
});
```

### Source provenance — `JournalEntry.sourceRef` (0.13.0+)

Every JE carries a typed `sourceRef: { sourceModel, sourceId, label?, kind? }`
slot for "what produced this whole JE". Per-line back-references live on
`journalItems[].sourceRef` (settles which document) and
`journalItems[].linkedRefs[]` (additional docs touched).

Add the index for fast source → JEs drill-down:

```ts
import { createAccountingEngine, ENTRY_SOURCE_INDEX } from '@classytic/ledger';

createAccountingEngine({
  schemaOptions: {
    journalEntry: { extraIndexes: [ENTRY_SOURCE_INDEX] },
  },
});

// After import — stamp the back-reference, then query by it.
await JE.updateMany({ _importRunId: docId }, { $set: { sourceRef: {
  sourceModel: 'SourceDocument', sourceId: docId,
  label: 'INV-2026-001 — Acme Corp', kind: 'xero-invoice',
}}});

// Drill-down. Include `sourceModel` in the predicate so the query
// planner reliably picks `sourceRef_idx` (the partial index only
// contains stamped docs; the planner prefers it when both fields are
// constrained). The sourceId-only form returns identical results but
// may COLLSCAN on small collections.
await JE.find({ 'sourceRef.sourceModel': 'SourceDocument', 'sourceRef.sourceId': docId });
```

## Plugins

```ts
import {
  doubleEntryPlugin,
  idempotencyPlugin,
  creditLimitPlugin,
  fxRealizationPlugin,
  immutableGuardPlugin,
  createLockPlugin,
} from '@classytic/ledger';
```

Plugins attach to mongokit repository hooks. They run at POLICY priority before any query.

## Subpath Exports

```ts
import { Money } from '@classytic/ledger/money';
import { CATEGORIES, CURRENCIES } from '@classytic/ledger/constants';
import { defineCountryPack } from '@classytic/ledger/country';
import { exportToCsv, quickbooksFieldMap } from '@classytic/ledger/exports';
```

## Architecture

- Repositories extend `@classytic/mongokit` Repository directly
- No service layer — domain verbs live on the repository
- No barrel re-exports — import from source paths
- Events: arc-compatible `DomainEvent` / `EventTransport` shapes
- Country packs: pluggable chart of accounts + journal type seeds
- Tax: NOT in ledger. Use `@classytic/bd-tax` for Bangladesh tax calculations.

## License

MIT
