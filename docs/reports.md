# Reports

All reports are generated from live aggregation pipelines — no cached balances. Multi-tenant isolation is enforced automatically.

## Using via Engine

```typescript
const reports = accounting.createReports({ Account, JournalEntry });
```

All report methods accept:

```typescript
{
  organizationId?: unknown;  // required in multi-tenant mode
  dateOption: 'month' | 'quarter' | 'year' | 'custom';
  dateValue: unknown;        // month: '2025-03', quarter: '2025-Q1', year: 2025, custom: { start, end }
  filters?: Record<string, unknown>;  // dimension filters (see below)
}
```

### Dimension Filters

All reports accept an optional `filters` parameter for filtering by custom dimension fields on journal items:

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

Filters are injected into aggregation `$match` stages after `$unwind`. Dangerous MongoDB operators (`$where`, `$expr`, `$function`, `$accumulator`, `$merge`, `$out`, `$unionWith`) are blocked by `buildItemFilters()`. Top-level `$`-prefixed keys are also blocked to prevent query injection.

### Account Identity in Reports

Reports use the **actual account row** for display names and codes, not the account type template. When `acc.name` or `acc.accountNumber` is set on the account document, that value is used. Falls back to `accountType.name` / `accountType.code` from the country pack when the account row doesn't have these fields.

This means tenants with multiple accounts under one type (e.g. three bank accounts all typed as "1000-Cash") will see their distinct names in report output.

## Trial Balance

```typescript
const tb = await reports.trialBalance({
  organizationId: orgId,
  dateOption: 'year',
  dateValue: 2025,
});
```

Three-column report: initial balance + current period activity + ending balance. Returns `TrialBalanceReport` with `rows: TrialBalanceRow[]` and `period`.

## Balance Sheet

```typescript
const bs = await reports.balanceSheet({
  organizationId: orgId,
  dateOption: 'year',
  dateValue: 2025,
  businessName: 'Acme Corp',
});
```

Returns `BalanceSheetReport` with `assets`, `liabilities`, `equity` categories, each containing groups of accounts. Net income is computed from income statement accounts for the fiscal year and injected into equity as retained earnings.

## Income Statement

```typescript
const is = await reports.incomeStatement({
  organizationId: orgId,
  dateOption: 'quarter',
  dateValue: '2025-Q1',
});
```

Returns `IncomeStatementReport` with revenue, cost of sales, operating expenses, and net income.

## General Ledger

```typescript
const gl = await reports.generalLedger({
  organizationId: orgId,
  dateOption: 'month',
  dateValue: '2025-01',
  accountId: optionalAccountId, // filter to single account
});
```

Returns `GeneralLedgerReport` with per-account transaction listings and running balances.

## Cash Flow

```typescript
const cf = await reports.cashFlow({
  organizationId: orgId,
  dateOption: 'year',
  dateValue: 2025,
});
```

Groups posted transactions by `cashFlowCategory` from the country pack's account type definitions. Returns `CashFlowReport` with three sections — Operating, Investing, Financing — and `netCashFlow`.

**Scope and limitations:** The cash flow statement is derived from the `cashFlowCategory` assigned to account types in the country pack. It works by summing journal items posted to accounts that have a cash flow category defined. This is an **indirect method** classification — it does not perform direct method cash flow analysis. For the report to be meaningful, the country pack must assign `cashFlowCategory` values to the relevant account types.

## Fiscal Period Close

```typescript
import { closeFiscalPeriod } from '@classytic/ledger';

const result = await closeFiscalPeriod(
  { AccountModel, JournalEntryModel, FiscalPeriodModel, country, orgField },
  { periodId, organizationId, closedBy: 'admin' },
);
// result: { periodId, netIncome, closingEntryId, accountsClosed, closedAt }
```

- Zeroes all income/expense account balances via a `YEAR_END` closing journal entry
- Transfers net income to retained earnings (configurable via `retainedEarningsAccountCode`)
- Marks period as `closed: true`
- Atomic by default (internal transaction)

## Fiscal Period Reopen

```typescript
import { reopenFiscalPeriod } from '@classytic/ledger';

const result = await reopenFiscalPeriod(
  { JournalEntryModel, FiscalPeriodModel, orgField },
  { periodId, organizationId, reopenedBy: 'admin' },
);
// result: { periodId, deletedEntryId, reopenedAt }
```

- Validates no later period is already closed (cascade protection)
- Deletes the closing journal entry
- Records audit trail (`reopenedAt`, `reopenedBy`)

## Using Standalone Functions

Reports can also be used without the engine:

```typescript
import { generateTrialBalance } from '@classytic/ledger/reports';

const tb = await generateTrialBalance(
  { AccountModel, JournalEntryModel, country, orgField, fiscalYearStartMonth },
  { organizationId, dateOption: 'year', dateValue: 2025, filters: { 'journalItems.departmentId': deptId } },
);
```
