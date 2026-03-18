# Subledger Integration — Reference

How to integrate external subledgers (billing, inventory, payroll, etc.) with `@classytic/ledger`. The ledger provides **type-only posting contracts** — your application code is responsible for wiring subledgers to the journal entry repository.

## Responsibility Boundaries

| Concern | Ledger | App / Subledger |
|---|---|---|
| Double-entry validation | Yes | — |
| Account existence check | Yes | — |
| Cross-tenant integrity | Yes | — |
| Fiscal period lock | Yes | — |
| Idempotency guard | Yes | Must generate deterministic keys |
| Posted-entry protection | Yes — blocks field changes on posted entries; fully immutable when `strictness.immutable` enabled | Use `reverse()` for corrections; `unpost()` available when immutable mode is off |
| Account code → ObjectId resolution | No | Yes |
| Tax calculation | No | Yes |
| Source document validation | No | Yes |
| Creating the journal entry | No | Yes — call `repo.create()` then `repo.post()` |
| Transaction coordination | No | Yes — wrap in a MongoDB session |
| Approval workflow | Enforces `approvedBy`/`approvedAt` | Yes — set fields before `post()` |
| Reversal coordination | Provides `repo.reverse()` | Yes — update subledger state |

## Posting Contracts

### `PostingContract<TSource>`

```typescript
import type { PostingContract } from '@classytic/ledger';

interface PostingContract<TSource = unknown> {
  readonly name: string;
  toJournalEntries(source: TSource): SubledgerPostingInput[];
  validate(source: TSource): void;
}
```

### `SubledgerPostingInput`

```typescript
interface SubledgerPostingInput {
  journalType: string;
  label: string;
  date: Date;
  journalItems: SubledgerJournalItem[];
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}
```

### `SubledgerJournalItem`

```typescript
interface SubledgerJournalItem {
  accountCode: string;                   // account type code (e.g. '1000', '4000')
  debit: number;                         // integer cents
  credit: number;                        // integer cents
  label?: string;
  extraFields?: Record<string, unknown>; // dimension fields
}
```

### `PostingResult`

```typescript
interface PostingResult {
  journalEntryIds: (string | ObjectId)[];
  idempotencyKeys?: string[];
}
```

## Full Integration Example

### Step 1: Implement the Contract

```typescript
import type { PostingContract, SubledgerPostingInput } from '@classytic/ledger';

const billingContract: PostingContract<Invoice> = {
  name: 'billing',

  validate(invoice) {
    if (!invoice.lineItems.length) throw new Error('Invoice has no line items');
    if (invoice.totalAmount <= 0) throw new Error('Invoice total must be positive');
  },

  toJournalEntries(invoice): SubledgerPostingInput[] {
    const items = invoice.lineItems.flatMap((line) => [
      {
        accountCode: '4000',
        debit: 0,
        credit: line.amount,
        label: line.description,
        extraFields: line.departmentId ? { departmentId: line.departmentId } : undefined,
      },
      ...(line.taxAmount > 0
        ? [{ accountCode: '2100', debit: 0, credit: line.taxAmount, label: `Tax – ${line.description}` }]
        : []),
    ]);

    items.push({
      accountCode: '1200',
      debit: invoice.totalAmount + invoice.totalTax,
      credit: 0,
      label: `Invoice ${invoice.number}`,
    });

    return [{
      journalType: 'SALE',
      label: `Invoice ${invoice.number}`,
      date: invoice.date,
      journalItems: items,
      idempotencyKey: `billing:invoice:${invoice._id}`,
    }];
  },
};
```

### Step 2: Resolve Account Codes

```typescript
async function resolveAccounts(
  input: SubledgerPostingInput,
  organizationId: string,
  AccountModel: Model<any>,
) {
  const codes = [...new Set(input.journalItems.map((i) => i.accountCode))];
  const accounts = await AccountModel.find({
    business: organizationId,
    accountTypeCode: { $in: codes },
  }).lean();

  const codeToId = new Map(accounts.map((a) => [a.accountTypeCode, a._id]));

  return input.journalItems.map((item) => {
    const accountId = codeToId.get(item.accountCode);
    if (!accountId) throw new Error(`No account for type ${item.accountCode} in org ${organizationId}`);
    return { account: accountId, debit: item.debit, credit: item.credit, label: item.label, ...item.extraFields };
  });
}
```

### Step 3: Create and Post

```typescript
async function postInvoice(invoice, organizationId, journalRepo, AccountModel, session?) {
  billingContract.validate(invoice);
  const [input] = billingContract.toJournalEntries(invoice);
  const journalItems = await resolveAccounts(input, organizationId, AccountModel);

  const entry = await journalRepo.create({
    business: organizationId,
    journalType: input.journalType,
    label: input.label,
    date: input.date,
    journalItems,
    idempotencyKey: input.idempotencyKey,
  }, { session });

  await journalRepo.post(entry._id, organizationId, { session });
  return { journalEntryIds: [entry._id], idempotencyKeys: [input.idempotencyKey!] };
}
```

## Idempotency

Key format convention: `{subledger}:{document-type}:{document-id}`

Examples: `billing:invoice:INV-001`, `inventory:receipt:RCV-1234`, `payroll:run:PR-2025-03`

The idempotency plugin returns a 409 Conflict if a journal entry with the same key already exists. Treat this as a no-op in your posting code.

**Prerequisite:** Enable `idempotency: true` in the engine config.

## Dimension Fields

Dimension fields on subledger items must be:

1. Declared in `extraItemFields` when creating the journal entry schema
2. Passed via `extraFields` on `SubledgerJournalItem`
3. Spread onto journal items during account resolution

Once posted, they are preserved through `duplicate()`/`reverse()` and available as report filters.

## Reversal Coordination

```typescript
// Reverse the ledger entry
await journalRepo.reverse(journalEntryId, organizationId, { actorId: userId, session });

// Update subledger state (your responsibility)
await Invoice.updateOne({ _id: invoiceId }, { status: 'voided' }, { session });
```

## Tax Handling

Country packs define tax code **metadata** (names, rates, regions) but do **not** compute tax amounts. Tax calculation is the application's responsibility. Include tax lines as separate journal items with the appropriate tax liability account code.

## What the Ledger Does Not Do

- Compute taxes
- Manage invoices, bills, or payments
- Orchestrate workflows
- Resolve account codes to ObjectIds
- Coordinate distributed transactions
- Generate direct-method cash flow
