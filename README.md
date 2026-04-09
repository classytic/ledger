# @classytic/ledger

Embeddable double-entry accounting engine for MongoDB. Integer-cents arithmetic, plugin-based, country-agnostic, multi-tenant at every layer. Framework-agnostic — works with Express, Fastify, Nest, Arc, or any plain Mongoose app.

> **0.7.0 (BREAKING)** — `@classytic/ledger` is now a **pure double-entry accounting engine**. Tax computation, return templates, repartition, and exigibility have been removed from the core and country-pack contracts and now live in dedicated tax packages (`@classytic/bd-tax` is the existing reference; `@classytic/ca-tax` will follow). Country packs `@classytic/ledger-bd@0.2.0` and `@classytic/ledger-ca@0.2.0` ship the chart of accounts + journal templates only — they re-export the raw tax data tables as named constants for tax engines to lift. The 0.6.x A/P + A/R primitives (item-level matching, partner ledger, credit limit, FX realization, journal resource, open-item queries) are unchanged. See [CHANGELOG.md](CHANGELOG.md).

## Install

```bash
npm install @classytic/ledger @classytic/mongokit mongoose
npm install @classytic/ledger-ca   # Canada (GIFI chart of accounts)
npm install @classytic/ledger-bd   # Bangladesh (BFRS chart of accounts)
```

## Quick Start

```ts
import mongoose from "mongoose";
import { createAccountingEngine } from "@classytic/ledger";
import { canadaPack } from "@classytic/ledger-ca";

const engine = createAccountingEngine({
  mongoose: mongoose.connection,
  country: canadaPack,
  currency: "CAD",
  multiTenant: { orgField: "organizationId", orgRef: "Organization" },
});

await engine.repositories.accounts.seedAccounts(orgId);

await engine.record.sale(orgId, {
  date: new Date("2025-04-01"),
  amount: 11300,                 // $113.00 in cents (caller pre-computes any tax)
  receivableAccount: "1200",     // AR
  revenueAccount:    "4010",     // Service Revenue
  label: "INV-001",
});

const bs = await engine.reports.balanceSheet({
  organizationId: orgId,
  dateOption: "year",
  dateValue: 2025,
});
```

The engine owns the models. After `createAccountingEngine` you have:

| Property | What it gives you |
| --- | --- |
| `engine.models.{Account,JournalEntry,FiscalPeriod,Budget,Reconciliation,Journal}` | Mongoose models |
| `engine.repositories.accounts` | `seedAccounts()`, `bulkCreate()` + plugins |
| `engine.repositories.journalEntries` | `post()`, `unpost()`, `reverse()`, `duplicate()` + double-entry, fiscal-lock, idempotency |
| `engine.repositories.journals` | First-class posting channels — `seedDefaults()`, `nextSequenceNumber()` |
| `engine.repositories.reconciliations` | Item-level matching — `match()`, `unmatch()`, `getOpenItems()` |
| `engine.repositories.{fiscalPeriods,budgets}` | Plain CRUD |
| `engine.record.*` | Domain verbs (`sale`, `expense`, `transfer`, `payment`, `adjustment`) |
| `engine.introspect.*` | Runtime catalog of accounts, journal types, reports, fiscal periods |
| `engine.reports.*` | All 12 reports, bound to owned models |

## Semantic Record API

Record business operations as domain verbs. The engine resolves account codes and produces a balanced journal entry — you never touch debits/credits.

```ts
await engine.record.sale(orgId, {
  date, amount: 10000,
  receivableAccount: "1001", revenueAccount: "4010",
});

await engine.record.expense(orgId, {
  date, amount: 3000,
  expenseAccount: "6010", paidFromAccount: "2001",
});

await engine.record.transfer(orgId, { date, amount: 5000, fromAccount: "1001", toAccount: "1002" });

await engine.record.payment(orgId, {
  date, amount: 11300,
  fromReceivableAccount: "1200", toCashAccount: "1001",
});

// Multi-line adjustment (depreciation, accruals, corrections)
await engine.record.adjustment(orgId, {
  date, label: "Monthly depreciation",
  lines: [
    { account: "6030", debit:  1000 },
    { account: "1500", credit: 1000 },
  ],
});
```

> **Tax lines:** the semantic verbs are tax-agnostic in 0.7+. Compute VAT/GST/HST via your tax engine of choice (`@classytic/bd-tax`, the forthcoming `@classytic/ca-tax`, or your own) and either pre-add the tax to `amount` and post the tax line via `record.adjustment`, or post the full entry directly via `engine.repositories.journalEntries.create()`.

All verbs accept `options.user`, `options.session`, `options.idempotencyKey`, plus any custom field — they all flow into mongokit's `RepositoryContext` so audit/observability plugins (and your hooks) pick them up automatically.

## Accounts Payable & Receivable

The 0.6.x A/P + A/R primitives are the foundation for any ERP workflow on top of the ledger.

```ts
// Tag every journal item with a partnerId via extraItemFields (one-time setup)
const engine = createAccountingEngine({
  // ...
  schemaOptions: {
    journalEntry: {
      extraItemFields: {
        partnerId: { type: String, index: true },
      },
    },
  },
});

// Post a credit sale on 30-day terms
const invoice = await engine.repositories.journalEntries.create({
  state: "posted",
  date: new Date("2026-01-15"),
  journalItems: [
    { account: arId, debit: 100_000, partnerId: "wholesale-1", maturityDate: new Date("2026-02-14") },
    { account: revenueId, credit: 100_000 },
  ],
});

// Customer pays $400 of the $1000 invoice
const payment = await engine.repositories.journalEntries.create({
  state: "posted",
  date: new Date("2026-01-25"),
  journalItems: [
    { account: cashId, debit: 40_000 },
    { account: arId, credit: 40_000, partnerId: "wholesale-1" },
  ],
});

// Match the AR sides — partial settlement
await engine.repositories.reconciliations.match({
  account: arId,
  items: [
    { entry: invoice._id, itemIndex: 0 },
    { entry: payment._id, itemIndex: 1 },
  ],
});

// Open items for this partner (subsidiary ledger)
await engine.repositories.reconciliations.getOpenItems({
  accountId: arId,
  filter: { partnerId: "wholesale-1" },
});

// Customer statement with running balance + aged buckets
import { generatePartnerLedger } from "@classytic/ledger";
await generatePartnerLedger(
  { AccountModel: engine.models.Account, JournalEntryModel: engine.models.JournalEntry },
  {
    controlAccountId: arId,
    partnerId: "wholesale-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-03-31"),
  },
);

// Cross-partner aged A/R buckets
import { generateAgedBalance } from "@classytic/ledger";
await generateAgedBalance(
  { AccountModel, JournalEntryModel, country: canadaPack },
  { type: "receivable", contactField: "journalItems.partnerId" },
);

// Enforce per-customer credit limits
import { creditLimitPlugin } from "@classytic/ledger/plugins";
creditLimitPlugin({
  arControlAccountId: arId,
  JournalEntryModel: engine.models.JournalEntry,
  getCreditLimit: async (partnerId) => Customer.findById(partnerId).then(c => c?.creditLimit ?? null),
}).apply(engine.repositories.journalEntries);
```

## Introspection

```ts
const catalog = await engine.introspect.catalog(orgId);
// { accounts, journalTypes, reports, fiscalPeriods }

engine.introspect.accounts(orgId);
engine.introspect.reports();   // sync — static catalog
```

## Structured Validation Errors

```ts
try {
  await engine.record.sale(orgId, { ... });
} catch (err) {
  if (err instanceof AccountingError) {
    err.status   // 400 | 402 | 403 | 404 | 409
    err.code     // 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CREDIT_LIMIT_EXCEEDED' | 'PERIOD_LOCKED_FISCAL' | ...
    err.fields   // [{ path, issue, value }, ...]
    err.toJSON();
  }
}
```

## Audit, Observability & Framework Integration

Every operation flows through mongokit's `RepositoryContext`. Custom plugins can hook `before:create` / `after:create` / `before:update` / `after:update` / `after:match` to add audit trails, metrics, webhooks, or business rules — none of it is hardcoded into the core.

The `_ledgerInternal` context flag (`'post' | 'unpost' | 'archive' | 'reverseMark' | 'fxRealize'`) tells plugins which engine operation is in flight, so guards (locks, credit limit, immutability) can exempt legitimate engine writes without affecting consumer code.

## Reports

12 typed reports, all multi-tenant scoped, all returning structured JSON ready for any UI:

| Report | Purpose |
| --- | --- |
| `trialBalance` | Debits/credits per account with running balances |
| `balanceSheet` | Assets, liabilities, equity at a date with computed retained earnings |
| `incomeStatement` | Revenue, COGS, expenses, net income for a period |
| `generalLedger` | Per-account transaction detail with running balance |
| `cashFlow` | Operating / investing / financing breakdown |
| `agedBalance` | A/R or A/P bucketed by age, optionally per partner |
| `partnerLedger` | Supplier/customer statement with opening + running balance + aged buckets |
| `dimensionBreakdown` | Group by department/project/cost center |
| `budgetVsActual` | Variance vs budget per account/period |
| `revaluation` | Foreign-currency unrealized FX gain/loss at a date |
| `closeFiscalPeriod` / `reopenFiscalPeriod` | Year-end close pipeline |

## Engine Configuration

```ts
const engine = createAccountingEngine({
  mongoose: mongoose.connection,
  country: canadaPack,
  currency: "CAD",
  multiTenant: { orgField: "organizationId", orgRef: "Organization" },
  multiCurrency: { enabled: true, currencies: ["USD", "EUR"] },
  fiscalYearStartMonth: 1,
  idempotency: true,
  strictness: { immutable: true, requireActor: true },
  schemaOptions: {
    journalEntry: {
      extraItemFields: {
        partnerId: { type: String, index: true },
        departmentId: { type: mongoose.Schema.Types.ObjectId },
      },
    },
  },
});
```

## Built-in Plugins

| Plugin | Purpose |
| --- | --- |
| `doubleEntryPlugin` | Validates debits = credits, account existence, tenant integrity, posted-entry immutability |
| `fiscalLockPlugin` | Prevents posting into closed fiscal periods (auto-wired) |
| `dailyLockPlugin` | Per-branch `lastClosedDate` watermark for daily POS close |
| `createLockPlugin` | Generic lock factory — compose your own scopes (bank recon, payroll, tax filings) |
| `idempotencyPlugin` | Prevents duplicate entries by key (auto-wired when `idempotency: true`) |
| `creditLimitPlugin` | Per-partner A/R credit limit enforcement |
| `fxRealizationPlugin` | Books realized FX gain/loss when matched items have different exchange rates |

`doubleEntryPlugin`, `fiscalLockPlugin`, and `idempotencyPlugin` (when enabled) are wired automatically by the engine. The others are opt-in via `.apply(engine.repositories.journalEntries)` or `.apply(engine.repositories.reconciliations)`.

## Custom Journal Types

The 15 built-in journal types (SALES, PURCHASES, GENERAL, PAYROLL, …) cover standard accounting. Register custom types **before** the first engine call:

```ts
import { registerJournalType } from "@classytic/ledger";

registerJournalType("POS_SALES",  { code: "POS_SALES",  name: "POS Sales Journal" });
registerJournalType("ECOM_SALES", { code: "ECOM_SALES", name: "E-Commerce Sales" });
```

Reference numbers use the type prefix (`POS_SALES/2025/03/0001`). The registry freezes after the first schema is created.

## Country Packs

A country pack ships the **chart of accounts** + accounting conventions for a jurisdiction. Tax (VAT/GST/HST/income-tax) lives in separate tax packages — see "Tax" below.

```ts
import { defineCountryPack } from "@classytic/ledger";

export const myPack = defineCountryPack({
  code: "US",
  name: "United States",
  defaultCurrency: "USD",
  retainedEarningsAccountCode: "3200",
  accountTypes: [/* chart of accounts */],
  journalTemplates: [
    { code: "SALES", name: "Sales", journalType: "SALES", kind: "sale", sequencePrefix: "INV" },
    // ...
  ],
});
```

Available: `@classytic/ledger-ca` (Canada GIFI), `@classytic/ledger-bd` (Bangladesh BFRS).

## Tax

`@classytic/ledger@0.7+` is intentionally tax-agnostic. The same separation Odoo (`account/` vs `l10n_*`), QuickBooks (Ledger vs TaxService), and Xero (accounting vs Xero Tax) all use.

For tax computation, return generation, and repartition:

- **`@classytic/bd-tax`** — Bangladesh income tax + VAT compute, IT-11GA forms, Mushak 9.1 returns, deduction optimizer, depreciation
- **`@classytic/ca-tax`** *(planned)* — Canadian GST/HST/PST/QST compute, CRA GST34 form, ITC tracking
- **Or your own** — tax engines just call `engine.repositories.journalEntries.create()` with the tax line items they want posted

The country packs (`ledger-bd`, `ledger-ca`) still re-export their raw tax data tables (`TAX_CODES`, `TAX_CODES_BY_REGION`, `mushakReturnTemplate`, `craReturnTemplate`) as named exports so tax packages can lift them — they're just no longer wired into the `CountryPack` contract.

## Invoice Engine Integration

Wire `@classytic/invoice` to the ledger with one call — no manual journal wiring needed:

```ts
import { createAccountingEngine } from "@classytic/ledger";
import { createLedgerBridge } from "@classytic/ledger/sync";
import { createInvoiceEngine } from "@classytic/invoice";
import { canadaPack } from "@classytic/ledger-ca";

const accounting = createAccountingEngine({
  mongoose: mongoose.connection,
  country: canadaPack,
  currency: "CAD",
  multiTenant: { orgField: "organizationId", orgRef: "Organization" },
  idempotency: true,
});

const invoicing = createInvoiceEngine({
  mongoose: mongoose.connection,
  ledger: createLedgerBridge(accounting, {
    accounts: {
      receivable: "1200",     // Accounts Receivable
      payable: "2000",        // Accounts Payable
      revenue: "4000",        // Revenue
      expense: "5000",        // Expenses
      taxPayable: "2100",     // Tax Payable
      taxReceivable: "1150",  // Tax Receivable
      cash: "1000",           // Cash / Bank
    },
  }),
});
```

The bridge handles all 5 move types (`out_invoice`, `in_invoice`, `out_refund`, `in_refund`, `receipt`), payment recording, and reversal. See [docs/sync.md](docs/sync.md) for the full mapping table and configuration options.

For custom subledgers (inventory, payroll, etc.) that don't use `@classytic/invoice`, see [docs/subledger-integration.md](docs/subledger-integration.md) for the manual `PostingContract` pattern.

## URL-Driven Queries

Parse URL query parameters directly into paginated repository queries via mongokit's `QueryParser`:

```ts
const parser = engine.createQueryParser("journalEntry");
const parsed = parser.parse(req.query);
// ?state=posted&date[gte]=2025-01-01&sort=-date&limit=25

const result = await engine.repositories.journalEntries.getAll({
  ...parsed,
  filters: { ...parsed.filters, organizationId },
});
```

Available for all 6 models: `account`, `journalEntry`, `fiscalPeriod`, `budget`, `reconciliation`, `journal`.

## Subpath Exports

| Path | Contents |
| --- | --- |
| `@classytic/ledger`           | Engine, Money, plugins, reports, types |
| `@classytic/ledger/sync`      | `createLedgerBridge`, `wireImport`, `wireExport`, bank/invoice/JE mappers |
| `@classytic/ledger/money`     | `Money` class |
| `@classytic/ledger/reports`   | Standalone report generators |
| `@classytic/ledger/plugins`   | All plugins |
| `@classytic/ledger/exports`   | CSV export + QuickBooks field maps |
| `@classytic/ledger/country`   | `defineCountryPack`, `CountryPack` |
| `@classytic/ledger/constants` | Categories, journal types, currencies |

## Testing

```bash
npm test                            # 1327 tests, 77 files
npm run smoke                       # full pipeline against published dist/
npx vitest run tests/e2e/           # end-to-end scenarios
npx vitest run tests/scenarios/     # multi-step business scenarios
npx vitest run tests/hardening/     # edge cases & invariants
```

Coverage includes:

- Canadian small-business full-year lifecycle (open → post → close → reopen)
- Multi-year fiscal cycles with retained-earnings rollover
- Multi-currency trading with realized + unrealized FX
- Multi-tenant report isolation (org A cannot see org B)
- All 12 reports with month / quarter / year / custom date ranges
- Reversal and correction workflows
- Custom journal type registry → schema → posting pipeline
- Item-level matching: 1-to-1, 1-to-many, partial settlement, unmatch
- Per-partner credit limit enforcement + reversal exemption
- FX realization plugin auto-booking gain/loss on cross-rate match
- Full ERP A/P + A/R cycle (bill receipt → match → supplier statement → aged balance)
- Double-entry conservation across all entries
- Money arithmetic hardening (overflow, penny-leak, float traps)
- O-Level / A-Level / university textbook accounting problems

## Requirements

- Node.js >= 22
- MongoDB (replica set recommended for transactions)
- Mongoose >= 9.4.1
- @classytic/mongokit >= 3.5.6

## License

MIT
