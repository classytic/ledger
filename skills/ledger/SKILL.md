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
version: "0.1.0"
license: MIT
metadata:
  author: Classytic
  version: "0.1.0"
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
    quick_start: "1. npm install @classytic/ledger @classytic/mongokit mongoose 2. createAccountingEngine({ country, currency }) 3. Create schemas → wire repositories → generate reports"
  context_limit: 700
---

# @classytic/ledger

Production-grade double-entry accounting engine for MongoDB. Built on `@classytic/mongokit`.

**Requires:** Node.js >= 22 | Mongoose >= 9 | @classytic/mongokit >= 3.3.2 | ESM only

## Install

```bash
npm install @classytic/ledger @classytic/mongokit mongoose
```

## Quick Start

```typescript
import { createAccountingEngine } from '@classytic/ledger';
import { canadaPack } from '@classytic/ledger-ca';
import mongoose from 'mongoose';

// 1. Create engine
const accounting = createAccountingEngine({
  country: canadaPack,
  currency: 'CAD',
  multiTenant: { orgField: 'business', orgRef: 'Business' },
  audit: { trackActor: true },
  idempotency: true,
  strictness: { immutable: true, requireActor: true },
});

// 2. Create schemas & models
const Account = mongoose.model('Account', accounting.createAccountSchema());
const JournalEntry = mongoose.model('JournalEntry', accounting.createJournalEntrySchema('Account', {
  extraItemFields: {
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  },
}));
const FiscalPeriod = mongoose.model('FiscalPeriod', accounting.createFiscalPeriodSchema());

// 3. Wire repositories
import { createRepository } from '@classytic/mongokit';

const journalRepo = accounting.createJournalEntryRepository(
  createRepository,
  { JournalEntryModel: JournalEntry, AccountModel: Account, FiscalPeriodModel: FiscalPeriod },
);

const accountRepo = createRepository(Account, []);
accounting.wireAccountRepository(accountRepo, Account);

// 4. Generate reports
const reports = accounting.createReports({ Account, JournalEntry });
const bs = await reports.balanceSheet({
  organizationId: orgId,
  dateOption: 'year',
  dateValue: 2025,
  filters: { 'journalItems.departmentId': deptId },
});
```

## Engine Configuration

```typescript
const accounting = createAccountingEngine({
  country: canadaPack,            // CountryPack — account types, tax codes (required)
  currency: 'CAD',                // ISO 4217 code (required)
  multiTenant: {                  // omit for single-tenant
    orgField: 'business',         // field name on documents
    orgRef: 'Business',           // Mongoose model name for ObjectId ref
  },
  fiscalYearStartMonth: 4,       // 1-12, default 1 (January)
  logger: winstonLogger,          // { warn, error, info } — defaults to console
  audit: { trackActor: true },    // adds createdBy, postedBy, reversedByUser fields
  idempotency: true,              // adds idempotencyKey field (unique sparse index)
  strictness: {
    immutable: true,              // unpost() disabled — correction only via reverse()
    requireActor: true,           // actorId required on post/reverse/unpost
    requireApproval: true,        // approvedBy + approvedAt required before posting
  },
});
```

## Schemas

### Account Schema

```typescript
const accountSchema = accounting.createAccountSchema();
// Fields: accountType (string, required), name, accountNumber, description, isActive
// Multi-tenant: adds orgField as ObjectId ref with compound indexes
```

### Journal Entry Schema

```typescript
const jeSchema = accounting.createJournalEntrySchema('Account', {
  extraItemFields: {
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
  },
});
// Fields: date, label, journalType, state (draft|posted|archived), journalItems[], totalDebit, totalCredit
// Conditional: createdBy, postedBy (audit), approvedBy, approvedAt (approval), idempotencyKey
// journalItems[]: account (ObjectId ref), debit, credit, label + any extraItemFields
```

### Fiscal Period Schema

```typescript
const fpSchema = accounting.createFiscalPeriodSchema();
// Fields: name, startDate, endDate, closed, closedAt, closedBy, reopenedAt, reopenedBy
// Overlap protection: pre-validate hook rejects overlapping date ranges per tenant
```

## Repositories

### Journal Entry Repository (recommended)

```typescript
const journalRepo = accounting.createJournalEntryRepository(
  createRepository,
  { JournalEntryModel: JournalEntry, AccountModel: Account, FiscalPeriodModel: FiscalPeriod },
);
```

Includes all plugins (double-entry + fiscal lock + idempotency) and domain methods:

```typescript
// Post a draft → validates double-entry balance, account existence, fiscal lock, idempotency
await journalRepo.post(entryId, organizationId, { actorId, session });

// Create a reversal entry (debits↔credits swapped, dimension fields preserved)
await journalRepo.reverse(entryId, organizationId, { actorId, session });

// Duplicate an entry as a new draft (dimension fields preserved, new date)
await journalRepo.duplicate(entryId, organizationId, { session });

// Unpost (only when strictness.immutable is false)
await journalRepo.unpost(entryId, organizationId, { actorId, session });

// Archive a draft (draft → archived, preserves audit trail instead of deleting)
await journalRepo.archive(entryId, organizationId, { actorId, session });
```

### Account Repository

```typescript
const accountRepo = createRepository(Account, []);
accounting.wireAccountRepository(accountRepo, Account);

// Seed all account types from the country pack for a tenant
await accountRepo.seedAccounts(organizationId);

// Bulk create custom accounts
await accountRepo.bulkCreate([{ accountType: '1000', name: 'Operating Account' }], organizationId);
```

## Plugins

Plugins hook into mongokit's `before:create` and `before:update` events:

| Plugin | What it does |
|---|---|
| `doubleEntryPlugin` | Validates `sum(debits) === sum(credits)`, account existence, cross-tenant integrity, posted-entry protection |
| `fiscalLockPlugin` | Blocks create/post in closed fiscal periods |
| `idempotencyPlugin` | Rejects duplicate `idempotencyKey` on create (409 Conflict) |

Plugins fire in order: double-entry → fiscal-lock → idempotency.

**Account validation** runs on both `before:create` (fail-closed — throws if `AccountModel` missing) and `before:update` (runs when `AccountModel` available). This closes the `repository.update(id, { state: 'posted' })` bypass.

**Posted-entry protection:** The double-entry plugin blocks direct modifications to posted entries via `repository.update()`. When `strictness.immutable` is enabled, `unpost()` is also disabled — correction only via `reverse()`. Without `strictness.immutable`, `unpost()` is available to transition back to draft.

## Reports

All reports use live aggregation pipelines. Multi-tenant isolation is automatic.

```typescript
const reports = accounting.createReports({ Account, JournalEntry });

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
