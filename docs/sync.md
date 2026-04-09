# Sync — Invoice Bridge, Import & Export

`@classytic/ledger/sync` is the integration subpath for connecting external systems to the ledger.

```typescript
import {
  // Invoice engine bridge (recommended)
  createLedgerBridge,

  // Import/export pipeline
  wireImport,
  wireExport,

  // Mapper factories (fin-io canonical shapes → JournalEntry)
  bankStatementMapper,
  invoiceMapper,
  journalEntryMapper,
  openingBalanceMapper,
} from '@classytic/ledger/sync';
```

---

## Invoice Engine Integration

### Recommended: `createLedgerBridge()`

Wire `@classytic/invoice` to `@classytic/ledger` with one call. The bridge handles account mapping, tax lines, credit notes, payments, and reversals — no manual journal wiring needed.

```typescript
import { createAccountingEngine } from '@classytic/ledger';
import { createLedgerBridge } from '@classytic/ledger/sync';
import { createInvoiceEngine } from '@classytic/invoice';
import { canadaPack } from '@classytic/ledger-ca';

// 1. Create the accounting engine
const accounting = createAccountingEngine({
  mongoose: connection,
  country: canadaPack,
  currency: 'CAD',
  multiTenant: { orgField: 'organizationId', orgRef: 'Organization' },
  idempotency: true,
});

// 2. Create the bridge — map your chart of accounts once
const bridge = createLedgerBridge(accounting, {
  accounts: {
    receivable: '1200',     // Accounts Receivable
    payable: '2000',        // Accounts Payable
    revenue: '4000',        // Revenue
    expense: '5000',        // Cost of Goods Sold / Expenses
    taxPayable: '2100',     // HST/GST/VAT Payable
    taxReceivable: '1150',  // HST/GST/VAT Receivable (Input Tax Credit)
    cash: '1000',           // Cash / Bank
  },
});

// 3. Pass the bridge to the invoice engine — done
const invoicing = createInvoiceEngine({
  mongoose: connection,
  ledger: bridge,
  // ... other invoice config
});
```

From this point, every invoice lifecycle operation automatically posts to the ledger:

- **`invoicing.services.posting.post(id)`** → creates a balanced journal entry
- **`invoicing.services.payment.recordPayment(input)`** → posts a payment entry (DR Cash, CR AR)
- **`invoicing.services.posting.cancel(id, reason)`** → reverses the journal entry
- **`invoicing.services.posting.void(id, reason)`** → reverses the journal entry (even if partially paid)

### How the bridge maps each move type

| Invoice Move Type | Journal Lines | Journal Type |
|---|---|---|
| `out_invoice` (Customer Invoice) | DR Receivable (total), CR Revenue (per line), CR Tax Payable | `SALES` |
| `in_invoice` (Vendor Bill) | DR Expense (per line), DR Tax Receivable, CR Payable (total) | `PURCHASES` |
| `out_refund` (Customer Credit Note) | CR Receivable, DR Revenue (per line), DR Tax Payable | `SALES` |
| `in_refund` (Vendor Credit Note) | DR Payable, CR Expense (per line), CR Tax Receivable | `PURCHASES` |
| `receipt` (POS Receipt) | DR Receivable/Cash, CR Revenue (per line), CR Tax Payable | `CASH_RECEIPTS` |

All amounts are integer cents. Tax lines are only added when `taxAmount > 0`.

### Payment recording

When the invoice engine records a payment, the bridge calls `engine.record.payment()`:

```
DR Cash (1000)        $500.00
CR Receivable (1200)  $500.00
```

An idempotency key is automatically derived from the payment ID (`payment:{paymentId}`), preventing duplicate journal entries on retry.

### Reversal

When an invoice is cancelled or voided, the bridge calls `engine.repositories.journalEntries.reverse()`, which creates a mirror entry with debits and credits swapped and links both entries bidirectionally.

### Bridge configuration options

#### `receiptAccount`

Override the debit account for POS receipts. By default, receipts debit the `receivable` account. If your receipts are immediately paid (no A/R), point this at cash:

```typescript
createLedgerBridge(accounting, {
  accounts: { ... },
  receiptAccount: '1000',  // Receipts debit Cash directly
});
```

#### `resolvePaymentAccounts`

Custom resolver for payment accounts. Use when you need to determine AR vs AP based on context (e.g., vendor bill payments should clear AP, not AR):

```typescript
createLedgerBridge(accounting, {
  accounts: { ... },
  resolvePaymentAccounts: (input) => {
    const isVendor = vendorInvoiceIds.has(input.invoiceId);
    return {
      receivableOrPayable: isVendor ? '2000' : '1200',
      cash: '1000',
    };
  },
});
```

### Double-entry guarantee

The bridge uses `engine.record.adjustment()` internally. This routes through the ledger's double-entry plugin, which validates `sum(debits) === sum(credits)` before persisting. If the invoice engine sends unbalanced data, the ledger rejects it with a structured validation error.

---

### Alternative: Manual wiring (without `createLedgerBridge`)

If you need full control over the journal entry shape — for example, to add dimension fields, use different accounts per line, or handle complex tax scenarios — you can implement the `LedgerBridge` interface yourself:

```typescript
import type { LedgerBridge } from '@classytic/ledger/sync';

const ledgerBridge: LedgerBridge = {
  async createJournalEntry(input) {
    // Use record.adjustment() for multi-line entries with tax
    const entry = await accounting.record.adjustment(input.organizationId, {
      date: input.date,
      label: `Invoice ${input.invoiceId}`,
      journalType: 'SALES',
      lines: [
        { account: '1200', debit: input.totalAmount },
        ...input.lines.map(line => ({
          account: '4000',
          credit: line.amount,
          label: line.description,
        })),
        ...(input.taxAmount > 0
          ? [{ account: '2100', credit: input.taxAmount, label: 'Tax' }]
          : []),
      ],
    }, {
      idempotencyKey: input.idempotencyKey,
    });
    return String((entry as any)._id);
  },

  async reverseJournalEntry(journalEntryId, reason) {
    const { reversal } = await accounting.repositories.journalEntries
      .reverse(journalEntryId);
    return String((reversal as any)._id);
  },

  async recordPayment(input) {
    const entry = await accounting.record.payment(input.organizationId, {
      date: input.date,
      amount: input.amount,
      fromReceivableAccount: '1200',
      toCashAccount: '1000',
      label: `Payment ${input.paymentId} for ${input.invoiceId}`,
    }, {
      idempotencyKey: `payment:${input.paymentId}`,
    });
    return String((entry as any)._id);
  },
};

// Then pass to the invoice engine
const invoicing = createInvoiceEngine({
  mongoose: connection,
  ledger: ledgerBridge,
});
```

This gives you the same integration but with full control over account resolution, dimension fields, and tax line construction.

### Using `LedgerBridge` without `@classytic/invoice`

The bridge types are generic — any invoicing system that calls these 3 methods works:

```typescript
import type { LedgerBridge, LedgerPostInput, LedgerPaymentInput } from '@classytic/ledger/sync';

// Use createLedgerBridge() for standard mapping
const bridge: LedgerBridge = createLedgerBridge(accounting, { accounts: { ... } });

// Post an invoice
const jeId = await bridge.createJournalEntry({
  organizationId: 'org_1',
  invoiceId: 'INV-001',
  moveType: 'out_invoice',
  partnerId: 'customer-123',
  date: new Date(),
  currency: 'USD',
  lines: [
    { description: 'Consulting', amount: 100000, taxAmount: 13000, taxCode: 'HST' },
  ],
  totalAmount: 113000,
  taxAmount: 13000,
});

// Record a payment
await bridge.recordPayment({
  organizationId: 'org_1',
  invoiceId: 'INV-001',
  paymentId: 'PAY-001',
  amount: 113000,
  currency: 'USD',
  date: new Date(),
  method: 'bank_transfer',
});

// Reverse (cancel/void)
await bridge.reverseJournalEntry(jeId, 'Invoice cancelled');
```

---

## Bank Statement Import

Import bank transactions from any format supported by `@classytic/fin-io`:

```typescript
import { parseOfx } from '@classytic/fin-io/ofx';
import { wireImport, bankStatementMapper } from '@classytic/ledger/sync';

const parsed = parseOfx(buffer);
if (!parsed.ok) throw new Error(parsed.error);

const report = await wireImport({
  source: parsed.data.flatMap(s => s.transactions),
  mapper: bankStatementMapper({
    bankAccountId: bankAccount._id,
    suspenseAccountId: suspenseAccount._id,
    categorize: (txn) => knownVendors[txn.counterparty?.name]?.accountId,
  }),
  journalEntries: engine.repositories.journalEntries,
  context: { organizationId },
}).run();

console.log(`Imported ${report.inserted}, skipped ${report.skipped} duplicates`);
```

### Available mappers

| Mapper | Source | Output |
|---|---|---|
| `bankStatementMapper` | `CanonicalTransaction` (OFX, CAMT, MT940, CSV, Plaid) | 2-line JE: Cash ↔ Suspense |
| `invoiceMapper` | `CanonicalInvoice` (QBO, Xero JSON) | Multi-line JE: AR/AP ↔ Revenue/Expense ↔ Tax |
| `journalEntryMapper` | `CanonicalJournalEntry` (QBO, Xero manual journals) | 1:1 mapping |
| `openingBalanceMapper` | `TrialBalanceInput` | Multi-line opening balance entry |

### Idempotency

Re-running an import on the same file produces zero duplicates. Each mapper extracts a stable `externalId` from the source record (e.g., OFX `FITID`, CAMT `NtryRef`). The `wireImport` pipeline checks for existing entries before creating.

For best performance, provide a `findExisting` callback and add a partial index on `{ organizationId: 1, _externalId: 1 }`.

---

## Export

Stream ledger data to external formats:

```typescript
import { wireExport } from '@classytic/ledger/sync';

const report = await wireExport({
  query: { organizationId: 'org_1', state: 'posted' },
  sink: {
    fromJournalEntry: (entry) => transformToCSVRow(entry),
    emit: async (rows) => csvStream.write(rows),
    flush: async () => csvStream.end(),
  },
  journalEntries: engine.repositories.journalEntries,
  options: { batchSize: 500 },
}).run();
```

---

## Writing Custom Mappers

Implement `ImportMapper<TRaw>` for any data source:

```typescript
import type { ImportMapper } from '@classytic/ledger/sync';

interface MyPayrollRecord {
  id: string;
  employeeName: string;
  grossPay: number;
  taxWithheld: number;
  netPay: number;
  date: Date;
}

const payrollMapper: ImportMapper<MyPayrollRecord> = {
  externalId: (record) => `payroll:${record.id}`,

  toJournalEntry: (record, ctx) => ({
    date: record.date,
    label: `Payroll — ${record.employeeName}`,
    journalItems: [
      { account: salaryExpenseId, debit: record.grossPay, credit: 0 },
      { account: taxPayableId, debit: 0, credit: record.taxWithheld },
      { account: cashId, debit: 0, credit: record.netPay },
    ],
  }),
};
```
