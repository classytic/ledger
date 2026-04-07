# @classytic/ledger

Embeddable double-entry accounting engine for MongoDB. Integer-cents arithmetic, plugin-based, country-agnostic, multi-tenant at every layer. Framework-agnostic — works with Express, Fastify, Nest, Arc, or any plain Mongoose app.

> **0.5.1** — Critical plugin-pipeline fixes. `post()`, `unpost()`, `archive()`, and the `reverse()` mark-as-reversed step now route through `repository.update()` so `before:update` / `after:update` hooks fire on every state transition (period locks, audit, observability are no longer silently bypassed). `reverse()` and `duplicate()` propagate every consumer-defined top-level field (`departmentId`, `projectId`, `sourceRef`, `branchTag`, `organizationId`, …). New typed `_ledgerInternal` flag on `RepositoryContext` lets plugin authors observe internal transitions without casts. See [CHANGELOG.md](CHANGELOG.md).

## Install

```bash
npm install @classytic/ledger @classytic/mongokit mongoose
npm install @classytic/ledger-ca   # Canada (GIFI, GST/HST, CRA)
npm install @classytic/ledger-bd   # Bangladesh (BFRS, VAT/TDS, Mushak)
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
  amount: 10000,                 // $100.00 in cents (tax-exclusive)
  receivableAccount: "1200",     // AR
  revenueAccount:    "4010",     // Service Revenue
  tax: { code: "HST", account: "2300" },
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
| `engine.models.{Account,JournalEntry,FiscalPeriod,Budget,Reconciliation}` | Mongoose models |
| `engine.repositories.accounts` | `seedAccounts()`, `bulkCreate()` + plugins |
| `engine.repositories.journalEntries` | `post()`, `unpost()`, `reverse()`, `duplicate()` + double-entry, fiscal-lock, idempotency |
| `engine.repositories.{fiscalPeriods,budgets}` | Plain CRUD |
| `engine.repositories.reconciliations` | `reconcile()`, `unreconcile()`, `getUnreconciled()` |
| `engine.record.*` | Domain verbs (`sale`, `expense`, `transfer`, `payment`, `adjustment`) |
| `engine.introspect.*` | Runtime catalog of accounts, tax codes, reports |
| `engine.reports.*` | All 10 reports, bound to owned models |

## Semantic Record API

Record business operations as domain verbs. The engine resolves account codes, splits tax, and produces a balanced journal entry — you never touch debits/credits.

```ts
// Cash sale with 13% HST
await engine.record.sale(orgId, {
  date, amount: 10000,
  receivableAccount: "1001", revenueAccount: "4010",
  tax: { code: "HST", account: "2300" },
});

// Expense with recoverable input tax credit
await engine.record.expense(orgId, {
  date, amount: 3000,
  expenseAccount: "6010", paidFromAccount: "2001",
  tax: { code: "HST_ITC", account: "2400" },
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

All verbs accept `options.user`, `options.session`, `options.idempotencyKey`, plus any custom field — they all flow into mongokit's `RepositoryContext` so audit/observability plugins (and your hooks) pick them up automatically.

## Introspection

```ts
const catalog = await engine.introspect.catalog(orgId);
// { accounts, journalTypes, reports, taxCodes, fiscalPeriods }

engine.introspect.accounts(orgId);
engine.introspect.taxCodes("ON");
engine.introspect.reports();   // sync — static catalog
```

## Structured Validation Errors

```ts
try {
  await engine.record.sale(orgId, { ... });
} catch (err) {
  if (err instanceof AccountingError) {
    err.status   // 400 | 403 | 404 | 409
    err.code     // 'VALIDATION_ERROR' | 'NOT_FOUND' | ...
    err.fields   // [{ path, issue, value }, ...]
    err.toJSON();
  }
}
```

Field errors come straight from plugins (double-entry, fiscal-lock) and the semantic layer.

## Audit, Observability & Framework Integration

The ledger is **framework-agnostic** and operates at the model layer — Express, Fastify, Nest, Hono, and Arc all work the same way. Three places you can hook in, composable:

1. **Any mongokit plugin** via `config.plugins` — see the `@classytic/mongokit` docs for `auditTrailPlugin`, `observabilityPlugin`, and others.
   ```ts
   const engine = createAccountingEngine({
     mongoose: mongoose.connection, country: canadaPack, currency: "CAD",
     plugins: {
       journalEntry: [/* your mongokit plugins */],
       account:      [/* your mongokit plugins */],
     },
   });
   ```
2. **Runtime listeners** — no plugin needed:
   ```ts
   engine.repositories.journalEntries.on("after:create", ({ context, result }) => {
     auditLog.write({ userId: context.user?._id, orgId: context.organizationId, entryId: result._id });
   });
   ```
3. **Your framework's own audit (HTTP-level)** — e.g. `@classytic/arc`'s `auditPlugin` records resource CRUD with request context. Use it alone, or combine with a model-layer plugin.

| Layer | What it sees | What it misses |
| --- | --- | --- |
| HTTP middleware (Arc / Express / Nest) | Request → user, IP, route, payload | Background jobs, CLI scripts, anything bypassing HTTP |
| Model-layer mongokit plugin | Every collection write, regardless of caller | HTTP context unless the caller forwards it |

For accounting compliance most teams want **both** — HTTP audit for traffic, model audit on `journalEntry` for an immutable trail. Forward request context on the call so both layers see it:

```ts
// Express
app.post("/sales", async (req, res) => {
  await engine.record.sale(req.body.orgId, req.body, {
    user: req.user, ip: req.ip, userAgent: req.headers["user-agent"],
  });
});
```

## Reports

```ts
await engine.reports.trialBalance({ organizationId, dateOption: "year",  dateValue: 2025 });
await engine.reports.balanceSheet({ organizationId, dateOption: "year",  dateValue: 2025 });
await engine.reports.incomeStatement({ organizationId, dateOption: "quarter", dateValue: { year: 2025, quarter: 2 } });
await engine.reports.generalLedger({ organizationId, dateOption: "month", dateValue: { year: 2025, month: 4 } });
await engine.reports.cashFlow({ organizationId, dateOption: "year", dateValue: 2025 });
await engine.reports.agedBalance({ organizationId, type: "receivable", asOfDate: new Date() });
await engine.reports.budgetVsActual({ organizationId, dateOption: "year", dateValue: 2025 });
await engine.reports.dimensionBreakdown({ organizationId, dimension: "departmentId", dateOption: "year", dateValue: 2025 });
await engine.reports.revaluation({ organizationId, asOfDate: new Date(), rates: [{ currency: "USD", rate: 1.40 }], unrealizedGainLossAccountId });
```

All values are integer cents. Use `Money.toDecimal()` at your API boundary.

The 10 reports:

- **Trial Balance** (3-column: opening + period + ending)
- **Balance Sheet** (with computed retained earnings, multi-year aware)
- **Income Statement** (revenue, COGS, gross profit, operating expenses, net income)
- **General Ledger** (per-account with running balances)
- **Cash Flow** (operating / investing / financing)
- **Aged Receivable / Payable** (configurable buckets)
- **Budget vs Actual** (variance analysis)
- **Dimension Breakdown** (by department, project, cost center)
- **FX Revaluation** (unrealized gain/loss)
- **Fiscal Year Close / Reopen** (automatic closing entries)

## Engine Configuration

```ts
createAccountingEngine({
  mongoose: mongoose.connection,             // required
  country:  canadaPack,                      // required
  currency: "CAD",                           // required — base/functional currency
  multiTenant: { orgField, orgRef },         // optional
  multiCurrency: { enabled: true, currencies: ["USD", "EUR"] },
  fiscalYearStartMonth: 1,                   // 1=Jan (default), 4=Apr, 7=Jul
  retainedEarningsAccountCode: "3600",       // overrides country pack
  modelNames: { account: "GLAccount", ... }, // custom collection names
  schemaOptions: {                           // extra fields/indexes per model
    journalEntry: {
      extraFields: { aiJob: { status: String, generatedAt: Date } },
      extraIndexes: [{ fields: { "aiJob.status": 1 }, options: { sparse: true } }],
    },
  },
  strictness: {
    immutable:        true,   // disable unpost — corrections only via reverse
    requireActor:     true,   // actorId required on post/reverse
    requireApproval:  true,   // entries must be approved before posting
  },
  plugins:    { journalEntry: [...], account: [...] },  // any mongokit plugins
  pagination: { account: { maxLimit: 5000 } },          // optional caps; no default cap
});
```

`pagination` has **no default cap** — large enterprise charts of accounts can be tens of thousands of rows. Pass `{ maxLimit: N }` per repository if you want to bound list queries.

## Built-in Plugins

| Plugin | Purpose |
| --- | --- |
| `doubleEntryPlugin` | Validates debits = credits, account existence, tenant integrity |
| `fiscalLockPlugin` | Prevents posting to closed fiscal periods |
| `dateLockPlugin` | Blocks entries before a configurable lock date |
| `taxHookPlugin` | Auto-generates tax lines via a `TaxLineGenerator` |
| `idempotencyPlugin` | Prevents duplicate entries by key |

`doubleEntryPlugin`, `fiscalLockPlugin` and `idempotencyPlugin` are wired automatically by the engine. The others are opt-in via the second `createAccountingEngine` argument.

## Custom Journal Types

The 15 built-in journal types (SALES, PURCHASES, GENERAL, PAYROLL, …) cover standard accounting. Register custom types **before** the first engine call:

```ts
import { registerJournalType } from "@classytic/ledger";

registerJournalType("POS_SALES",  { code: "POS_SALES",  name: "POS Sales Journal" });
registerJournalType("ECOM_SALES", { code: "ECOM_SALES", name: "E-Commerce Sales" });
```

Reference numbers use the type prefix (`POS_SALES/2025/03/0001`). The registry freezes after the first schema is created.

## Country Packs

```ts
import { defineCountryPack } from "@classytic/ledger";

export const myPack = defineCountryPack({
  code: "US", name: "United States", defaultCurrency: "USD",
  retainedEarningsAccountCode: "3200",
  accountTypes: [/* chart of accounts */],
  taxCodes:     {/* tax codes */},
  taxCodesByRegion: {}, regions: [],
});
```

Available: `@classytic/ledger-ca` (Canada), `@classytic/ledger-bd` (Bangladesh).

## Subpath Exports

| Path | Contents |
| --- | --- |
| `@classytic/ledger`           | Engine, Money, plugins, reports, types |
| `@classytic/ledger/money`     | `Money` class |
| `@classytic/ledger/reports`   | Standalone report generators |
| `@classytic/ledger/plugins`   | All plugins |
| `@classytic/ledger/exports`   | CSV export + QuickBooks field maps |
| `@classytic/ledger/country`   | `defineCountryPack`, `CountryPack` |
| `@classytic/ledger/constants` | Categories, journal types, currencies |

## Testing

```bash
npm test                            # 1273 tests, 67 files
npx vitest run tests/e2e/           # full-year scenarios
npx vitest run tests/scenarios/     # integration scenarios
npx vitest run tests/hardening/     # edge cases & invariants
```

Coverage includes:

- Canadian small-business full-year lifecycle (open → post → close → reopen)
- Multi-year fiscal cycles with retained-earnings rollover
- Multi-currency trading with FX revaluation
- Multi-tenant report isolation (org A cannot see org B)
- All 10 reports with month / quarter / year / custom date ranges
- Reversal and correction workflows
- Custom journal type registry → schema → posting pipeline
- Double-entry conservation across all entries
- Money arithmetic hardening (overflow, penny-leak, float traps)
- O-Level / A-Level / university textbook accounting problems

## Requirements

- Node.js >= 22
- MongoDB (replica set recommended for transactions)
- Mongoose >= 9.4.1
- @classytic/mongokit >= 3.5.3

## License

MIT
