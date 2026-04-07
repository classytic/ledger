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
version: "0.6.0"
license: MIT
metadata:
  author: Classytic
  version: "0.6.0"
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
| `engine.models.Reconciliation` | item-level open-item matching groups — `matchingNumber`, `items[{entry, itemIndex, debit, credit, amountCurrency?, exchangeRate?}]`, `isFullReconcile`, `currency?`, `fxRealizationEntry?` |
| `engine.models.Journal` | first-class posting channels — `code`, `name`, `journalType`, `kind`, `sequencePrefix`, `sequenceNextNum`, `defaultDebitAccount?`, `defaultCreditAccount?`, `allowedPaymentMethods[]`, `active`. Optional; consumers that never call `seedDefaults()` keep the enum-only flow. |

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
| `fiscalLockPlugin` | Blocks create/post in closed fiscal periods (period-table range lookup) |
| `taxLockPlugin` | Blocks posts touching tax accounts when the covering tax return is filed |
| `dailyLockPlugin` | Blocks posts on or before a per-branch `lastClosedDate` watermark |
| `createLockPlugin` | Low-level factory — compose your own scopes (bank recon, payroll, etc.) with `periodResolver` or `watermarkResolver` |
| `idempotencyPlugin` | Rejects duplicate `idempotencyKey` on create (409 Conflict) |

All lock plugins share the same factory — only their resolver differs — and all throw `AccountingError(409, 'PERIOD_LOCKED_{SCOPE}')`.

**Plugin pipeline coverage (0.5.1+):** `post`, `unpost`, `archive`, and the reverse-mark step on the original entry route through `repository.update()` so `before:update` and `after:update` hooks fire on every state transition. All lock plugins, auditTrailPlugin, observabilityPlugin, and any consumer-registered listener observe the transition. Pre-0.5.1 these methods called `entry.save()` directly and silently bypassed all plugins.

**Lock exemption policy (0.6.0):** `post` and `unpost` remain subject to locks — you cannot post into a closed period, and you cannot unpost an entry whose original date sits inside one. Only `reverseMark` and `fxRealize` are exempt: the first lets `reverse()` mark an original (potentially inside a closed period) as reversed while the counter-entry goes through the normal pipeline on its own date; the second lets `fxRealizationPlugin` book a realized gain/loss entry without the lock plugin blocking it.

## 0.6.0 — Open-item matching, Journals, FX, Repartition

### Item-level open-item matching

`reconciliationRepository.match()` stamps a shared `matchingNumber` onto individual journal items so you can represent the canonical AR/AP flows: one cheque settles two invoices, one invoice paid by three cheques, partial settlements with remainder. Replaces the entry-level `reconcile()` from 0.5.x.

```typescript
// Invoice: debit AR 500, credit Revenue 500
// Payment: debit Cash 500, credit AR 500
const rec = await engine.repositories.reconciliations.match({
  account: arId,
  items: [
    { entry: invoice._id, itemIndex: 0 }, // AR debit
    { entry: payment._id, itemIndex: 1 }, // AR credit
  ],
});
// rec.isFullReconcile === true when debit/credit totals balance
// rec.matchingNumber === 'RECN-000001' (auto-generated, unique per org)

// Unmatched items only:
const openInvoices = await engine.repositories.reconciliations.getOpenItems({
  accountId: arId,
});

// Unwind a match — clears the stamps and deletes the reconciliation:
await engine.repositories.reconciliations.unmatch({ matchingNumber: rec.matchingNumber });
```

Matching fires an `after:match` hook — consumer plugins (or the built-in `fxRealizationPlugin`) can listen here to react to settlement.

### First-class Journal resource

Optional catalogue of per-organization posting channels. Consumers that never call `seedDefaults()` keep the 0.5.x enum-only flow; consumers that do seed gain per-journal sequence prefixes, atomic counters, kinds, default accounts, and payment-method routing.

```typescript
// Seed from the country pack's `journalTemplates` (or the lean default set)
await engine.repositories.journals.seedDefaults(orgId);

const sales = await engine.repositories.journals.getByQuery({ code: 'SALES' });
const refNo = await engine.repositories.journals.nextSequenceNumber(sales._id);
// refNo === 'INV/2026/03/0001' — atomically incremented via $inc findOneAndUpdate

await engine.repositories.journalEntries.create({
  journal: sales._id,
  journalType: 'SALES',
  referenceNumber: refNo,
  state: 'posted',
  date: new Date(),
  journalItems: [...],
});
```

Country packs (`@classytic/ledger-bd`, `@classytic/ledger-ca`) ship `journalTemplates` fields with jurisdiction-specific defaults (BD Mushak journals, CA Payroll, etc.).

### Realized FX on reconciliation

```typescript
import { fxRealizationPlugin } from '@classytic/ledger/plugins';

fxRealizationPlugin({
  journalEntries: engine.repositories.journalEntries,
  realizedGainAccount: gainAcctId,
  realizedLossAccount: lossAcctId,
  baseCurrency: 'USD',
}).apply(engine.repositories.reconciliations);

// Now every match() on items that share a single foreign currency at
// different exchange rates auto-books a balancing entry to gain/loss.
// The entry is tagged `_ledgerInternal: 'fxRealize'` so locks don't block it.
```

Requires `multiCurrency: { enabled: true, currencies: [...] }` on the engine config so `originalDebit` / `originalCredit` / `exchangeRate` / `currency` fields are active on journal items.

### Tax repartition — multi-line tax from one tax code

`TaxCode.repartition` is a declarative array of `{factor, accountRole, gridCode?, documentTypes?}` lines. One tax percentage can emit multiple journal items — perfect for reverse-charge VAT, self-assessed sales tax, or multi-destination splits.

```typescript
// In your country pack:
taxCodes: {
  'RC-VAT-20': {
    code: 'RC-VAT-20',
    name: 'Reverse-charge VAT 20%',
    taxType: 'VAT',
    rate: 20,
    direction: 'collected',
    description: 'EU reverse-charge import VAT',
    active: true,
    repartition: [
      { factor: 1, accountRole: 'collected', gridCode: 'VAT-OUT' },
      { factor: 1, accountRole: 'recoverable', gridCode: 'VAT-IN' },
    ],
  },
},
resolveTaxRepartitionAccountCode: (role) => {
  if (role === 'collected') return '2131';
  if (role === 'recoverable') return '1150';
  return undefined;
},
```

The repartition generator then expands this into the correct multi-line entry:

```typescript
import { createRepartitionTaxGenerator, taxHookPlugin } from '@classytic/ledger';

const generator = createRepartitionTaxGenerator({
  country: pack,
  resolveAccount: (role, tax) => {
    // Your app resolves the role → code via the pack, then code → ObjectId
    const code = pack.resolveTaxRepartitionAccountCode?.(role, tax);
    return accountIdByCode.get(code);
  },
});

// Feed the generator to the existing taxHookPlugin — no API change.
const taxPlugin = taxHookPlugin({ generator });
```

Cash-basis exigibility is declared via `TaxCode.exigibility: 'cash'` + a `transition` repartition role. Consumers then listen on `after:match` and move the held tax from the transition account to the real liability account at payment time.

## Building A/P + A/R on @classytic/ledger — the canonical recipe

Everything an ERP needs for accounts payable and accounts receivable is built from **three primitives** plus a one-line schema field:

| Need | Primitive |
|---|---|
| Tag every line with a partner | `extraItemFields: { partnerId: { type: String, index: true } }` in `schemaOptions.journalEntry` |
| "What does Supplier X owe me?" | `reconciliations.getOpenItems({ accountId: apId, filter: { partnerId } })` |
| "Show me a supplier statement" | `generatePartnerLedger({ controlAccountId, partnerId, startDate, endDate })` |
| "Apply this payment across N bills" | `reconciliations.match({ account, items: [...] })` |
| "Block sales over the credit limit" | `creditLimitPlugin({ arControlAccountId, getCreditLimit })` |
| "Aged A/P / A/R buckets" | `generateAgedBalance({ type: 'payable' \| 'receivable', contactField: 'journalItems.partnerId' })` |

**You do NOT need:** a `Bill` model, an `Invoice` model, an `AccountPayment` model, a `PartialReconcile` collection, a `FullReconcile` collection, a credit-memo workflow, or a debit-note workflow. Every one of those concepts is just a journal entry with the right `journalType` + `partnerId` + `maturityDate`. The matching number tells you what's settled. The control account tells you whose subsidiary ledger it belongs to.

### Step 1 — Wire `partnerId` once at engine creation

```typescript
const engine = createAccountingEngine({
  mongoose: mongoose.connection,
  country: bangladeshPack,
  currency: 'BDT',
  multiTenant: { orgField: 'organizationId', orgRef: 'Organization' },
  schemaOptions: {
    journalEntry: {
      extraItemFields: {
        partnerId: { type: String, index: true, default: null },
      },
      // Optional but recommended — speeds up partner-scoped queries.
      extraIndexes: [
        { fields: { 'journalItems.partnerId': 1, 'journalItems.matchingNumber': 1 } },
      ],
    },
  },
});
```

That's the entire schema change. No `Bill` collection, no `Invoice` collection.

### Step 2 — Bill receipt (A/P) posts on receipt, not payment

```typescript
// Receive goods on credit from supplier-A — accrual fix.
// THIS is the moment 2111 (A/P) actually carries a balance.
const bill = await engine.repositories.journalEntries.create({
  journalType: 'PURCHASES',
  state: 'posted',
  date: new Date('2026-02-05'),
  label: 'Bill #PO-001 from supplier-A',
  journalItems: [
    { account: inventoryId, debit: 200_000 },
    {
      account: apControlId,
      credit: 200_000,
      partnerId: 'supplier-A',
      maturityDate: new Date('2026-03-07'), // 30-day terms
    },
  ],
});
```

### Step 3 — Credit sale (A/R) posts on order, not collection

```typescript
const invoice = await engine.repositories.journalEntries.create({
  journalType: 'SALES',
  state: 'posted',
  date: new Date('2026-02-10'),
  label: 'Invoice #INV-001 to wholesale-1',
  journalItems: [
    {
      account: arControlId,
      debit: 300_000,
      partnerId: 'wholesale-1',
      maturityDate: new Date('2026-03-12'),
    },
    { account: revenueId, credit: 300_000 },
  ],
});
```

### Step 4 — Apply one cash payment across N bills (the canonical AR/AP question)

```typescript
// Customer wires $1000 covering invoices INV-001 ($600) and INV-002 ($400).
const payment = await engine.repositories.journalEntries.create({
  journalType: 'CASH_RECEIPTS',
  state: 'posted',
  date: new Date('2026-02-25'),
  label: 'Payment #PAY-001 from wholesale-1',
  journalItems: [
    { account: cashId, debit: 100_000 },
    { account: arControlId, credit: 100_000, partnerId: 'wholesale-1' },
  ],
});

// Match the AR sides together — settles both invoices in one call.
await engine.repositories.reconciliations.match({
  account: arControlId,
  items: [
    { entry: inv1._id, itemIndex: 0 },     // first invoice's AR debit
    { entry: inv2._id, itemIndex: 0 },     // second invoice's AR debit
    { entry: payment._id, itemIndex: 1 },  // payment's AR credit
  ],
});
// Reconciliation has matchingNumber: 'RECN-000001', isFullReconcile: true.
// Both invoices and the payment now carry that matching number on the AR line.
```

### Step 5 — Subsidiary ledgers

```typescript
// "What does supplier-A owe right now?"
const open = await engine.repositories.reconciliations.getOpenItems({
  accountId: apControlId,
  filter: { partnerId: 'supplier-A' },
});
// → [{ entry, itemIndex, debit, credit, date, maturityDate, item: {...full item} }]

// "What did supplier-A owe me as of last quarter?"
const snapshot = await engine.repositories.reconciliations.getOpenItems({
  accountId: apControlId,
  filter: { partnerId: 'supplier-A' },
  asOfDate: new Date('2025-12-31'),
});

// "Send a Q1 statement to wholesale-1" — full running-balance report
import { generatePartnerLedger } from '@classytic/ledger';
const statement = await generatePartnerLedger(
  { AccountModel: engine.models.Account, JournalEntryModel: engine.models.JournalEntry },
  {
    controlAccountId: arControlId,
    partnerId: 'wholesale-1',
    startDate: new Date('2026-01-01'),
    endDate: new Date('2026-03-31'),
  },
);
// → { openingBalance, lines: [{ date, ref, debit, credit, balance, daysPastDue, isMatched, ... }],
//     closingBalance, openItemsTotal, agedBuckets: { Current, '31-60', '61-90', '90+' } }
```

### Step 6 — Aged A/P + A/R reports across all partners

```typescript
import { generateAgedBalance } from '@classytic/ledger';

const apAging = await generateAgedBalance(
  { AccountModel, JournalEntryModel, country: bangladeshPack },
  {
    type: 'payable',
    asOfDate: new Date(),
    contactField: 'journalItems.partnerId', // groups by supplier
  },
);
// → { rows: [{ accountId, contactId: 'supplier-A', total, buckets: { Current, '31-60', ... } }, ...] }
```

Same call with `type: 'receivable'` gives A/R aging.

### Step 7 — Credit limit enforcement

```typescript
import { creditLimitPlugin } from '@classytic/ledger/plugins';

creditLimitPlugin({
  arControlAccountId: arControlId,
  JournalEntryModel: engine.models.JournalEntry,
  getCreditLimit: async (partnerId, session) => {
    const customer = await CustomerModel.findById(partnerId).session(session).lean();
    return customer?.creditLimit ?? null; // null = no limit
  },
}).apply(engine.repositories.journalEntries);
```

Now any `journalEntries.create()` that debits the A/R control account triggers a limit check. The plugin sums existing open A/R for the partner, adds the new debit, and throws `AccountingError(402, 'CREDIT_LIMIT_EXCEEDED')` if over. Reversals and FX-realization entries are exempt automatically via `_ledgerInternal`.

### Step 8 — Credit notes & debit notes

A **credit note** is `engine.repositories.journalEntries.reverse(invoiceId, undefined, { reversalDate: today })`. The reversal posts to the open period via the existing `reverseMark` exemption, the original stays posted with `reversed: true`, and your subsidiary ledger immediately reflects the cancellation.

A **debit note** (price increase post-invoice) is `engine.repositories.journalEntries.duplicate(invoiceId)` followed by a manual edit + post on the duplicate. It carries the same `partnerId` so the subsidiary ledger picks it up automatically.

There is **no separate credit-memo or debit-note model** — these are journal entries with the right semantic.

### Comparison to Odoo

| What Odoo ships | Our equivalent |
|---|---|
| `account.move` + `account.move.line` | `JournalEntry` + embedded `journalItems` |
| `account.partial_reconcile` + `account.full_reconcile` + `matching_number` | One `match()` call + a stamped `matchingNumber` string |
| `account.payment` + payment state machine | A journal entry; "paid" = matched; no separate document |
| `account.account.partner_ledger` Python view | `generatePartnerLedger()` typed function |
| `report.account.aged.partner.balance` | `generateAgedBalance({ contactField })` |
| `account.move` credit-memo type | `journalEntries.reverse()` |
| Credit limit on `res.partner` + invoice validation hook | `creditLimitPlugin` |
| Tax repartition (`account.tax.repartition.line`) | `TaxCode.repartition` declarative array |

Every concept Odoo encodes as a separate model, table, or class is collapsed into either a journal entry, a journal item, a matching number, or a single declarative field on the country pack. The whole A/P + A/R surface lives in **5 calls and one schema field**.

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
import {
  doubleEntryPlugin,
  idempotencyPlugin,
  // Unified lock primitive
  createLockPlugin,
  fiscalLockPlugin,
  taxLockPlugin,
  dailyLockPlugin,
  periodResolver,
  watermarkResolver,
} from '@classytic/ledger/plugins';
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
