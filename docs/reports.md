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
}
```

## Trial Balance

```typescript
const tb = await reports.trialBalance({
  organizationId: orgId,
  dateOption: 'year',
  dateValue: 2025,
});
```

Three-column report: initial balance + current period activity + ending balance. Returns `TrialBalanceReport` with `rows: TrialBalanceRow[]` and `totals`.

## Balance Sheet

```typescript
const bs = await reports.balanceSheet({
  organizationId: orgId,
  dateOption: 'year',
  dateValue: 2025,
  businessName: 'Acme Corp',
});
```

Returns `BalanceSheetReport` with `categories` grouped by Balance Sheet classifications (assets, liabilities, equity). Net income is computed from income statement accounts.

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

Groups posted transactions by `cashFlowCategory` from country pack account type definitions. Returns `CashFlowReport` with sections (Operating, Investing, Financing) and `netCashFlow`.

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
- Transfers net income to retained earnings (default code: `3660`, configurable via `retainedEarningsCode`)
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
  { organizationId, dateOption: 'year', dateValue: 2025 },
);
```
