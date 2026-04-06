# @classytic/ledger

Embeddable double-entry accounting engine for MongoDB. Integer-cents arithmetic, plugin-based, country-agnostic. Extensible journal types, multi-tenant isolation at every layer.

Build QuickBooks, Xero, or TaxCycle-grade apps — the engine handles the accounting, you handle the UX.

## Install

```bash
npm install @classytic/ledger @classytic/mongokit mongoose
npm install @classytic/ledger-ca  # Canada (GIFI, GST/HST, CRA)
npm install @classytic/ledger-bd  # Bangladesh (BFRS, VAT/TDS, Mushak)
```

## Quick Start

```typescript
import { createAccountingEngine, registerJournalType } from '@classytic/ledger';
import { canadaPack } from '@classytic/ledger-ca';

// Register custom journal types BEFORE schema creation
registerJournalType('POS_SALES', {
  code: 'POS_SALES',
  name: 'POS Sales Journal',
  description: 'Daily aggregated point-of-sale transactions',
});

const accounting = createAccountingEngine({
  country: canadaPack,
  currency: 'CAD',
  multiTenant: { orgField: 'organization', orgRef: 'Organization' },
});

// Schemas (freezes the journal type registry)
const Account = mongoose.model('Account', accounting.createAccountSchema());
const JournalEntry = mongoose.model('JournalEntry', accounting.createJournalEntrySchema('Account'));
const FiscalPeriod = mongoose.model('FiscalPeriod', accounting.createFiscalPeriodSchema());

// Reports
const reports = accounting.createReports({ Account, JournalEntry });
const bs = await reports.balanceSheet({ organizationId, dateOption: 'year', dateValue: 2025 });
```

## Core Features

**Accounting Engine**
- Double-entry validation with balance enforcement
- Integer-cents storage — zero floating-point drift
- Draft → Posted → Reversed state machine
- Configurable immutability (corrections only via reversal)
- Multi-tenant isolation at every layer (reports, schemas, repositories)
- Country packs for localized charts of accounts and tax codes
- Extensible journal type registry — add domain-specific types (POS, E-Commerce, Payroll) at startup

**10 Reports**
- Trial Balance (3-column: initial + period + ending)
- Balance Sheet (with computed retained earnings)
- Income Statement (revenue, COGS, gross profit, operating expenses, net income)
- General Ledger (per-account with running balances)
- Cash Flow (Operating / Investing / Financing)
- Aged Receivable / Payable (configurable buckets: current, 30, 60, 90+)
- Budget vs Actual (variance analysis)
- Dimension Breakdown (by department, project, cost center)
- Foreign Exchange Revaluation (unrealized gain/loss computation)
- Fiscal Year Close / Reopen (automatic closing entries)

**Plugins**
- `doubleEntryPlugin` — validates debits = credits, account existence, tenant integrity
- `fiscalLockPlugin` — prevents posting to closed fiscal periods
- `dateLockPlugin` — blocks entries before a configurable lock date
- `taxHookPlugin` — auto-generates tax lines via user-defined `TaxLineGenerator`
- `idempotencyPlugin` — prevents duplicate entries by key

**Utilities**
- `Money` — cents arithmetic, tax splitting, allocation with zero-sum guarantee
- `buildDimensionFields` — schema helpers for analytic dimensions
- `suggestMatches` — reconciliation matching suggestions
- `computeRevaluation` — FX gain/loss computation

## Engine Configuration

```typescript
createAccountingEngine({
  country: canadaPack,                    // required
  currency: 'CAD',                        // required — base/functional currency
  multiTenant: { orgField, orgRef },      // optional — multi-tenant scoping
  multiCurrency: { enabled: true, currencies: ['USD', 'EUR'] },
  fiscalYearStartMonth: 1,               // 1=Jan (default), 4=Apr, 7=Jul
  retainedEarningsAccountCode: '3600',   // overrides country pack
  audit: { trackActor: true },
  idempotency: true,
  strictness: {
    immutable: true,      // disable unpost, corrections via reverse only
    requireActor: true,   // actorId required on post/reverse
    requireApproval: true // entries must be approved before posting
  },
});
```

## Reports API

```typescript
const reports = accounting.createReports({ Account, JournalEntry, Budget });

// All reports accept: { organizationId, dateOption, dateValue, filters? }
await reports.trialBalance({ ... });
await reports.balanceSheet({ ... });
await reports.incomeStatement({ ... });
await reports.generalLedger({ ... });
await reports.cashFlow({ ... });
await reports.agedBalance({ type: 'receivable', asOfDate: new Date() });
await reports.budgetVsActual({ ... });        // requires Budget model
await reports.dimensionBreakdown({ dimension: 'departmentId', ... });
await reports.revaluation({ rates: [{ currency: 'USD', rate: 1.40 }], ... });
```

All report data is sorted by account code. All monetary values are integer cents — use `Money.toDecimal()` at your API boundary.

## Schemas

```typescript
accounting.createAccountSchema(options?)
accounting.createJournalEntrySchema(accountModelName, {
  extraItemFields: { departmentId: { type: ObjectId, ref: 'Department' } },
})
accounting.createFiscalPeriodSchema(options?)
accounting.createBudgetSchema(options?)
accounting.createReconciliationSchema(accountModelName, journalEntryModelName, options?)
```

## Plugins

```typescript
import { dateLockPlugin, taxHookPlugin } from '@classytic/ledger';

// Date lock — block posting before a date
dateLockPlugin({
  getLockDate: async (orgId) => db.getOrgLockDate(orgId),
  JournalEntryModel,
});

// Tax hook — auto-generate tax lines
taxHookPlugin({
  generator: {
    generateTaxLines(input) {
      if (!input.taxCode) return [];
      const tax = Money.percentage(input.amount, 1300); // 13%
      return [{ account: hstAccountId, debit: 0, credit: tax, taxDetails: [{ taxCode: 'HST' }] }];
    },
  },
});
```

## Subpath Exports

| Path | Contents |
|------|----------|
| `@classytic/ledger` | Engine, Money, all schemas, plugins, reports, types |
| `@classytic/ledger/money` | `Money` class |
| `@classytic/ledger/schemas` | Schema factories |
| `@classytic/ledger/reports` | Report generators |
| `@classytic/ledger/plugins` | All plugins |
| `@classytic/ledger/repositories` | Repository wiring |
| `@classytic/ledger/exports` | CSV export + QuickBooks field maps |
| `@classytic/ledger/country` | `defineCountryPack`, `CountryPack` interface |
| `@classytic/ledger/constants` | Categories, journal types (+ registry), currencies |

## Extensible Journal Types

The 15 built-in journal types (SALES, PURCHASES, GENERAL, PAYROLL, etc.) cover standard accounting. For domain-specific needs, register custom types **before** schema creation:

```typescript
import { registerJournalType, getJournalTypeCodes, isValidJournalType } from '@classytic/ledger';

// Register at startup, before createJournalEntrySchema()
registerJournalType('POS_SALES', {
  code: 'POS_SALES',
  name: 'POS Sales Journal',
  description: 'Daily aggregated point-of-sale transactions',
});

registerJournalType('ECOM_SALES', {
  code: 'ECOM_SALES',
  name: 'E-Commerce Sales Journal',
  description: 'Per-order online transactions',
});

// Custom types pass Mongoose enum validation, appear in all lookups
isValidJournalType('POS_SALES');  // true
getJournalTypeCodes();            // [...15 built-in, 'POS_SALES', 'ECOM_SALES']

// Reference numbers use the custom type prefix: POS_SALES/2025/03/0001
```

The registry freezes when `createJournalEntrySchema()` is called. Late registration throws. Built-in types cannot be overridden.

## Country Packs

Build your own or use an existing one:

```typescript
import { defineCountryPack } from '@classytic/ledger';

export const myPack = defineCountryPack({
  code: 'US',
  name: 'United States',
  defaultCurrency: 'USD',
  retainedEarningsAccountCode: '3200',
  accountTypes: [ /* your chart of accounts */ ],
  taxCodes: { /* your tax codes */ },
  taxCodesByRegion: {},
  regions: [],
});
```

Available packs: `@classytic/ledger-ca` (Canada), `@classytic/ledger-bd` (Bangladesh).

## Testing

```bash
npm test                           # run all
npx vitest run tests/e2e/          # e2e scenarios only
npx vitest run tests/scenarios/    # integration scenarios
npx vitest run tests/hardening/    # edge cases & invariants
```

Test suites cover:
- Canadian small business full-year lifecycle
- Multi-currency trading with FX revaluation
- Multi-tenant report isolation (org A cannot see org B)
- Posting pipeline → Trial Balance → Income Statement → Balance Sheet
- Reversal & correction workflows with audit trail
- Custom journal type registry → schema → posting pipeline
- Double-entry conservation law (debit = credit across all entries)
- Money arithmetic hardening (overflow, penny-leak, float traps)
- Public API surface & subpath export verification
- O-Level / A-Level / university textbook accounting problems

## Requirements

- Node.js >= 22
- MongoDB (replica set recommended for transactions)
- Mongoose >= 9.4.1
- @classytic/mongokit >= 3.5.3

## License

MIT
