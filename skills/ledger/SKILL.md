---
name: ledger
description: |
  @classytic/ledger — Production-grade double-entry accounting engine for MongoDB.
  Use when building accounting systems, journal entries, chart of accounts, financial reports,
  balance sheets, income statements, trial balance, general ledger, cash flow, fiscal periods,
  multi-tenant bookkeeping, country packs, tax codes, CSV export, or subledger integration.
  Triggers: ledger, accounting, double-entry, journal entry, chart of accounts, balance sheet,
  income statement, trial balance, general ledger, cash flow, fiscal period, fiscal close,
  Money cents, country pack, tax code, CSV export, subledger, posting contract, bookkeeping,
  debit credit, account type, fiscal year, retained earnings.
version: "0.5.1"
license: MIT
metadata:
  author: Classytic
  version: "0.5.1"
tags:
  - accounting
  - double-entry
  - bookkeeping
  - ledger
  - financial-reports
  - multi-tenant
  - mongodb
  - mongoose
  - typescript
  - tax
  - csv-export
progressive_disclosure:
  entry_point:
    summary: "Double-entry accounting engine: schemas, plugins, reports, Money, country packs, subledger contracts"
    when_to_use: "Building accounting, journal entries, financial reports, fiscal periods, multi-tenant bookkeeping, or subledger integration with MongoDB"
    quick_start: "1. npm install @classytic/ledger @classytic/mongokit mongoose 2. createAccountingEngine({ mongoose: mongoose.connection, country, currency }) 3. Use engine.repositories.* and engine.reports.* — models and plugins are wired automatically"
  context_limit: 700
---

# @classytic/ledger

Production-grade double-entry accounting engine for MongoDB. Built on `@classytic/mongokit`.

**Requires:** Node.js >= 22 | Mongoose >= 9.4.1 | @classytic/mongokit >= 3.5.3 | ESM only

## Install

```bash
npm install @classytic/ledger @classytic/mongokit mongoose
```

## Quick Start (engine-owned models — flow/promo pattern)

The engine eagerly creates models, wires plugins, and exposes repositories +
reports as properties. No manual schema creation, no manual wiring.

```typescript
import mongoose from 'mongoose';
import { createAccountingEngine } from '@classytic/ledger';
import { canadaPack } from '@classytic/ledger-ca';

const engine = createAccountingEngine({
  mongoose: mongoose.connection,                     // required — engine binds to this connection
  country: canadaPack,
  currency: 'CAD',
  multiTenant: { orgField: 'organizationId', orgRef: 'Organization' },
  fiscalYearStartMonth: 1,
  pagination: { account: { maxLimit: 1000 } },       // override per-collection list cap
  schemaOptions: {
    journalEntry: {
      extraFields: {                                  // top-level dimensions / branch tags / source refs
        departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
        sourceRef: { kind: String, docId: String },
      },
    },
  },
  strictness: { immutable: true, requireActor: true },
});

// Models, repositories, reports — all ready to use
await engine.repositories.accounts.seedAccounts(orgId);
await engine.repositories.journalEntries.post(entryId, orgId, { actorId });

const bs = await engine.reports.balanceSheet({
  organizationId: orgId,
  dateOption: 'year',
  dateValue: 2025,
});

// Semantic verbs for AI agents and humans
await engine.record.sale(orgId, { date, amount: 10000, receivableAccount: '1001', revenueAccount: '4010' });

// Runtime introspection for MCP tools
const catalog = await engine.introspect.catalog(orgId);
```

Need raw access? `engine.models.Account`, `engine.models.JournalEntry`, etc. are Mongoose models you can query directly.

## Engine Configuration

```typescript
createAccountingEngine({
  mongoose: mongoose.connection,         // required — engine owns models
  country: canadaPack,                    // CountryPack — account types, tax codes (required)
  currency: 'CAD',                        // ISO 4217 code (required)
  multiTenant: { orgField, orgRef },      // omit for single-tenant
  multiCurrency: { enabled: true, currencies: ['USD', 'EUR'] },
  fiscalYearStartMonth: 1,                // 1-12, default 1 (January)
  retainedEarningsAccountCode: '3600',   // overrides country pack
  modelNames: { account: 'GLAccount' },  // optional model name overrides
  schemaOptions: {                        // optional model extensions
    journalEntry: { extraFields: { aiJob: { status: String } } },
  },
  pagination: {                           // per-collection list-page caps
    account: { maxLimit: 1000 },
  },
  audit: { trackActor: true },
  idempotency: true,
  strictness: {
    immutable: true,                      // unpost() disabled — correction only via reverse()
    requireActor: true,                   // actorId required on post/reverse/unpost
    requireApproval: true,                // approvedBy + approvedAt required before posting
  },
});
```

## Models

The engine creates Mongoose models eagerly and exposes them on `engine.models`:

| Property | Document fields |
|---|---|
| `engine.models.Account` | `accountTypeCode`, `name`, `accountNumber?`, `description?`, `active`, plus orgField in multi-tenant mode |
| `engine.models.JournalEntry` | `date`, `label?`, `journalType`, `state` (draft/posted/archived), `journalItems[]` (account, debit, credit, label, taxDetails, custom item fields), `totalDebit`, `totalCredit`, `referenceNumber`, `reversed`, `reversedBy?`, `reversalOf?`, audit/approval fields, plus any `schemaOptions.journalEntry.extraFields` |
| `engine.models.FiscalPeriod` | `name`, `startDate`, `endDate`, `closed`, `closedAt?`, `closedBy?`, `reopenedAt?`, `reopenedBy?` (overlap protection per tenant) |
| `engine.models.Budget` | per-account budgets for variance reports |
| `engine.models.Reconciliation` | reconciliation records linking JEs to bank statements |

## Repositories

`engine.repositories.*` exposes mongokit repositories with all plugins (double-entry, fiscal-lock, idempotency, optional date-lock, optional tax-hook) pre-wired. Domain methods are bound directly on the repo.

### Journal Entry Repository

```typescript
const journalRepo = accounting.createJournalEntryRepository(
  createRepository,
  { JournalEntryModel: JournalEntry, AccountModel: Account, FiscalPeriodModel: FiscalPeriod },
);
```

All state-transition methods (`post`, `unpost`, `archive`) and the reverse-mark step now route through `repository.update()` so the **plugin pipeline fires on every transition** — fiscalLockPlugin, dateLockPlugin, audit, observability, and any consumer hooks attached via `engine.repositories.journalEntries.on('before:update', ...)`. The double-entry immutability guard reads a typed `_ledgerInternal` flag on the context to permit these legitimate transitions while still blocking arbitrary edits to posted entries.

```typescript
const journals = engine.repositories.journalEntries;

// draft → posted: validates balance, account existence, fiscal lock, idempotency,
// and fires before:update so plugins/audit observe the transition
await journals.post(entryId, orgId, { actorId, session });

// posted → reversal entry (debits↔credits swapped, dimension fields preserved).
// Both the reversal create AND the mark-as-reversed step on the original fire
// the plugin pipeline. Consumer extraFields (departmentId, sourceRef, branchTag,
// organizationId, ...) are propagated automatically.
await journals.reverse(entryId, orgId, { actorId, session });

// Clone an entry as a new draft (item-level + top-level extraFields preserved)
await journals.duplicate(entryId, orgId, { session });

// posted → draft (only when strictness.immutable is false)
await journals.unpost(entryId, orgId, { actorId, session });

// draft → archived (preserves audit trail instead of deleting)
await journals.archive(entryId, orgId, { actorId, session });
```

### Account Repository

```typescript
const accounts = engine.repositories.accounts;

// Seed every posting account from the country pack for a tenant
await accounts.seedAccounts(orgId);

// Bulk create custom accounts (returns { created, skipped, summary })
await accounts.bulkCreate([{ accountTypeCode: '1000', name: 'Operating Account' }], orgId);
```

## Plugins

Plugins hook into mongokit's `before:create` and `before:update` events:

| Plugin | What it does |
|---|---|
| `doubleEntryPlugin` | Validates `sum(debits) === sum(credits)`, account existence, cross-tenant integrity, posted-entry protection |
| `fiscalLockPlugin` | Blocks create/post in closed fiscal periods |
| `idempotencyPlugin` | Rejects duplicate `idempotencyKey` on create (409 Conflict) |

Plugins fire in order: double-entry → fiscal-lock → idempotency.

**Plugin pipeline coverage (0.5.1+):** `post`, `unpost`, `archive`, and the reverse-mark step on the original entry route through `repository.update()` so `before:update` and `after:update` hooks fire on every state transition. fiscalLockPlugin, dateLockPlugin, auditTrailPlugin, observabilityPlugin, and any consumer-registered listener observe the transition. Pre-0.5.1 these methods called `entry.save()` directly and silently bypassed all plugins — see CHANGELOG for the regression history.

**Posted-entry protection:** The double-entry plugin blocks direct modifications to posted entries through `repository.update()`. Internal state-transition methods opt out via a typed `_ledgerInternal` flag on the context (`'post' | 'unpost' | 'archive' | 'reverseMark'`), which only ledger's own repo methods can set — external `repository.update()` callers cannot spoof it. When `strictness.immutable` is enabled, `unpost()` is also disabled — correction only via `reverse()`. Plugin authors can read `context._ledgerInternal` directly thanks to the mongokit module augmentation in `@classytic/ledger`.

**extraFields propagation:** `reverse()` and `duplicate()` copy every consumer-defined top-level field on the source entry — `departmentId`, `projectId`, `sourceRef`, `branchTag`, `organizationId`, etc. — onto the new entry. Reversed-out branch reports, plugin hooks, and audit trails see the same scope as the original. A frozen reserved-keys set excludes only fields these methods own (`_id`, `state`, `journalItems`, `referenceNumber`, `reversalOf`, `idempotencyKey`, …).

## Reports

All reports use live aggregation pipelines. Multi-tenant isolation is automatic.

```typescript
const reports = engine.reports;

await reports.trialBalance({ organizationId, dateOption, dateValue, filters? });
await reports.balanceSheet({ organizationId, dateOption, dateValue, filters? });
await reports.incomeStatement({ organizationId, dateOption, dateValue, filters? });
await reports.generalLedger({ organizationId, dateOption, dateValue, accountId?, filters? });
await reports.cashFlow({ organizationId, dateOption, dateValue, filters? });
```

**Date options:** `'month'` (`'2025-03'`), `'quarter'` (`'2025-Q1'`), `'year'` (`2025`), `'custom'` (`{ start, end }`)

**Dimension filters:** Filter any report by custom journal item fields:

```typescript
const bs = await reports.balanceSheet({
  organizationId: orgId,
  dateOption: 'year',
  dateValue: 2025,
  filters: {
    'journalItems.departmentId': departmentId,
    'journalItems.projectId': { $in: [proj1, proj2] },
  },
});
```

Dangerous MongoDB operators (`$where`, `$expr`, `$function`, etc.) are blocked by `buildItemFilters()`.

**Account identity:** Reports use the actual account document's `name`/`accountNumber` fields, falling back to the account type template only when these are not set.

**Cash flow scope:** Indirect method only — classifies by `cashFlowCategory` on account types. Does not perform direct method cash flow analysis.

## Fiscal Period Close / Reopen

```typescript
import { closeFiscalPeriod, reopenFiscalPeriod } from '@classytic/ledger';

// Close: zeroes income/expense accounts, transfers net income to retained earnings
const result = await closeFiscalPeriod(
  { AccountModel, JournalEntryModel, FiscalPeriodModel, country, orgField },
  { periodId, organizationId, closedBy: 'admin' },
);
// → { periodId, netIncome, closingEntryId, accountsClosed, closedAt }

// Reopen: deletes closing entry, validates no later period is closed
const result = await reopenFiscalPeriod(
  { JournalEntryModel, FiscalPeriodModel, orgField },
  { periodId, organizationId, reopenedBy: 'admin' },
);
```

## Money (Cents-Based Arithmetic)

```typescript
import { Money } from '@classytic/ledger/money';

Money.fromDecimal(100.50);          // → 10050 (cents)
Money.toDecimal(10050);             // → 100.50
Money.add(10050, 2000);             // → 12050
Money.subtract(10050, 2000);        // → 8050
Money.multiply(10050, 3);           // → 30150
Money.percentage(10050, 13);        // → 1307 (rounded)
Money.splitTaxInclusive(11300, 13); // → { base: 10000, tax: 1300 }
Money.splitTaxExclusive(10000, 13); // → { base: 10000, tax: 1300 }
Money.allocate(10000, [50, 30, 20]);// → [5000, 3000, 2000]
Money.format(10050, 'CAD');         // → "$100.50"
Money.parseCents('100.50');         // → 10050
```

All monetary values throughout the system are stored as **integer cents**. Never use floating-point for money.

## Country Packs

```typescript
import { defineCountryPack } from '@classytic/ledger/country';

const myPack = defineCountryPack({
  code: 'CA',
  name: 'Canada',
  currency: 'CAD',
  fiscalYearStartMonth: 1,
  accountTypes: [
    { code: '1000', name: 'Cash', category: 'asset', statementType: 'balance_sheet', normalBalance: 'debit', cashFlowCategory: 'operating' },
    { code: '4000', name: 'Revenue', category: 'revenue', statementType: 'income_statement', normalBalance: 'credit' },
    // ...
  ],
  taxCodes: [
    { code: 'GST', name: 'GST', rate: 5, region: 'CA' },
    { code: 'HST-ON', name: 'HST Ontario', rate: 13, region: 'ON' },
  ],
});
```

Country packs define **metadata only** (account type catalogs, tax code catalogs). They do not compute taxes or enforce tax rules — that is the application's responsibility.

## CSV Export

```typescript
import { exportToCsv, flattenJournalEntries } from '@classytic/ledger/exports';

const rows = flattenJournalEntries(entries, { fieldMap: 'quickbooks' });
const csv = exportToCsv(rows);
```

Field maps: `'quickbooks'` (QuickBooks-compatible) or `'universal'` (generic).

## Subledger Integration

The ledger exports type-only posting contracts for structuring subledger integrations:

```typescript
import type { PostingContract, SubledgerPostingInput, PostingResult } from '@classytic/ledger';

const billingContract: PostingContract<Invoice> = {
  name: 'billing',
  validate(invoice) { /* throw on failure */ },
  toJournalEntries(invoice) {
    return [{
      journalType: 'SALE',
      label: `Invoice ${invoice.number}`,
      date: invoice.date,
      journalItems: [
        { accountCode: '1200', debit: invoice.total, credit: 0 },
        { accountCode: '4000', debit: 0, credit: invoice.total },
      ],
      idempotencyKey: `billing:invoice:${invoice._id}`,
    }];
  },
};
```

**The ledger validates and stores journal entries. Everything upstream — account code resolution, tax calculation, workflow orchestration — is the application's job.** See the [subledger-integration reference](references/subledger-integration.md) for the full integration pattern.

## Subpath Imports

```typescript
import { createAccountingEngine, Money } from '@classytic/ledger';
import { Money } from '@classytic/ledger/money';
import { createAccountSchema, createJournalEntrySchema } from '@classytic/ledger/schemas';
import { generateTrialBalance, generateBalanceSheet } from '@classytic/ledger/reports';
import { doubleEntryPlugin, fiscalLockPlugin, idempotencyPlugin } from '@classytic/ledger/plugins';
import { wireJournalEntryMethods, wireAccountMethods } from '@classytic/ledger/repositories';
import { exportToCsv, flattenJournalEntries } from '@classytic/ledger/exports';
import { CATEGORIES, JOURNAL_TYPES } from '@classytic/ledger/constants';
import { defineCountryPack } from '@classytic/ledger/country';
```

## References (Progressive Disclosure)

- **[schemas](references/schemas.md)** — Full schema API, extraItemFields, conditional fields, overlap protection
- **[reports](references/reports.md)** — All 5 report types, dimension filters, standalone usage, fiscal close/reopen
- **[plugins](references/plugins.md)** — Plugin options, validation details, immutability guard, composition
- **[subledger-integration](references/subledger-integration.md)** — Posting contracts, responsibility boundaries, integration pattern, idempotency
- **[money](references/money.md)** — Full Money API, allocation, tax splitting, formatting
