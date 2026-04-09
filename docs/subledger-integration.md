# Subledger Integration

This guide explains how to integrate external subledgers (billing, inventory, payroll, etc.) with `@classytic/ledger`.

## Which pattern should I use?

| Subledger | Recommended approach |
|---|---|
| `@classytic/invoice` | Use `createLedgerBridge()` from `@classytic/ledger/sync` — see [sync.md](sync.md) |
| Custom invoicing, billing, or any system with the `LedgerBridge` interface | Use `createLedgerBridge()` — same bridge, no `@classytic/invoice` dependency needed |
| Inventory, payroll, or other custom subledgers | Use the `PostingContract` pattern described below |

If you're integrating with `@classytic/invoice`, **start with [sync.md](sync.md)** — the bridge handles all the wiring for you. This document covers the manual `PostingContract` pattern for custom subledgers that don't use the invoice engine.

---

The ledger provides **type-only posting contracts** — your application code is responsible for wiring subledgers to the journal entry repository.

## Responsibility Boundaries

| Concern | Ledger (`@classytic/ledger`) | App / Subledger Package |
|---|---|---|
| Double-entry validation | Yes — plugin enforces `debits === credits` | — |
| Account existence check | Yes — plugin validates account ObjectIds | — |
| Cross-tenant integrity | Yes — plugin ensures accounts belong to same org | — |
| Fiscal period lock | Yes — plugin blocks posting into closed periods | — |
| Idempotency (duplicate guard) | Yes — plugin checks `idempotencyKey` uniqueness | Must generate deterministic keys |
| Posted-entry protection | Yes — plugin blocks field changes on posted entries; fully immutable when `strictness.immutable` enabled | Use `reverse()` for corrections; `unpost()` available when immutable mode is off |
| Account code → ObjectId resolution | No | Yes — look up account by `accountType` code |
| Tax calculation | No — tax engines are separate packages (`@classytic/bd-tax`, `@classytic/ca-tax`, etc.) | Yes — compute tax amounts before posting via your tax engine of choice |
| Source document validation | No | Yes — implement `validate()` on the contract |
| Creating the journal entry | No — provides `repo.post()` | Yes — call `repo.create()` then `repo.post()` |
| Transaction coordination | No | Yes — wrap subledger + ledger writes in a session |
| Approval workflow | Enforces `approvedBy`/`approvedAt` if `requireApproval` is on | Yes — set these fields before calling `post()` |
| Reversal coordination | Provides `repo.reverse()` for the ledger side | Yes — update subledger state (void invoice, etc.) |

**In short:** the ledger validates and stores journal entries. Everything upstream — deciding _what_ to post, _when_ to post, and _how_ to resolve account codes — is the application's job.

## Posting Contracts

The ledger exports four TypeScript interfaces for structuring subledger integrations. These are **type-only** — they carry no runtime behavior or dependencies.

### `PostingContract<TSource>`

The top-level interface that a subledger adapter implements:

```typescript
import type { PostingContract } from '@classytic/ledger';

interface PostingContract<TSource = unknown> {
  readonly name: string;                          // e.g. 'billing', 'inventory'
  toJournalEntries(source: TSource): SubledgerPostingInput[];
  validate(source: TSource): void;                // throws on failure
}
```

### `SubledgerPostingInput`

The shape of a journal entry that the subledger produces:

```typescript
interface SubledgerPostingInput {
  journalType: string;                   // e.g. 'SALE', 'PURCHASE', 'PAYROLL'
  label: string;                         // human-readable description
  date: Date;                            // posting date
  journalItems: SubledgerJournalItem[];  // debit/credit lines
  idempotencyKey?: string;               // prevents duplicate postings on retry
  metadata?: Record<string, unknown>;    // arbitrary extra data
}
```

### `SubledgerJournalItem`

A single debit or credit line:

```typescript
interface SubledgerJournalItem {
  accountCode: string;                   // account type code (e.g. '1000', '4000')
  debit: number;                         // integer cents
  credit: number;                        // integer cents
  label?: string;                        // line description
  extraFields?: Record<string, unknown>; // dimension fields (departmentId, etc.)
}
```

### `PostingResult`

Returned by your posting function after entries are created:

```typescript
interface PostingResult {
  journalEntryIds: (string | ObjectId)[];
  idempotencyKeys?: string[];
}
```

## Integration Pattern

A typical subledger integration has three layers:

1. **Contract** — maps source documents to journal entry inputs (pure logic, no DB calls)
2. **Resolver** — converts account type codes to ObjectIds for the current tenant
3. **Poster** — creates and posts journal entries via the ledger repository

### Step 1: Implement the Contract

```typescript
import type { PostingContract, SubledgerPostingInput } from '@classytic/ledger';

interface Invoice {
  _id: string;
  number: string;
  date: Date;
  lineItems: Array<{
    description: string;
    amount: number;       // integer cents
    taxAmount: number;    // integer cents
    departmentId?: string;
  }>;
  totalAmount: number;
  totalTax: number;
}

const billingContract: PostingContract<Invoice> = {
  name: 'billing',

  validate(invoice) {
    if (!invoice.lineItems.length) throw new Error('Invoice has no line items');
    if (invoice.totalAmount <= 0) throw new Error('Invoice total must be positive');
    // Add your business-specific validations here
  },

  toJournalEntries(invoice): SubledgerPostingInput[] {
    const items = invoice.lineItems.flatMap((line) => [
      {
        accountCode: '4000',  // Revenue
        debit: 0,
        credit: line.amount,
        label: line.description,
        extraFields: line.departmentId ? { departmentId: line.departmentId } : undefined,
      },
      ...(line.taxAmount > 0
        ? [{
            accountCode: '2100',  // Tax Payable
            debit: 0,
            credit: line.taxAmount,
            label: `Tax – ${line.description}`,
          }]
        : []),
    ]);

    items.push({
      accountCode: '1200',  // Accounts Receivable
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

The contract produces account type codes (strings like `'4000'`). Your app must resolve these to real account ObjectIds for the tenant:

```typescript
async function resolveAccounts(
  input: SubledgerPostingInput,
  organizationId: string,
  AccountModel: Model<any>,
): Promise<Array<{ account: ObjectId; debit: number; credit: number; label?: string; [key: string]: unknown }>> {
  // Build a map of accountCode → ObjectId for this tenant
  const codes = [...new Set(input.journalItems.map((i) => i.accountCode))];
  const accounts = await AccountModel.find({
    business: organizationId,
    accountTypeCode: { $in: codes },
  }).lean();

  const codeToId = new Map(accounts.map((a) => [a.accountTypeCode, a._id]));

  return input.journalItems.map((item) => {
    const accountId = codeToId.get(item.accountCode);
    if (!accountId) throw new Error(`No account found for type ${item.accountCode} in org ${organizationId}`);
    return {
      account: accountId,
      debit: item.debit,
      credit: item.credit,
      label: item.label,
      ...item.extraFields,
    };
  });
}
```

### Step 3: Create and Post

```typescript
async function postInvoice(
  invoice: Invoice,
  organizationId: string,
  journalRepo: any,
  AccountModel: Model<any>,
  session?: ClientSession,
) {
  // 1. Validate
  billingContract.validate(invoice);

  // 2. Map to journal inputs
  const [input] = billingContract.toJournalEntries(invoice);

  // 3. Resolve account codes → ObjectIds
  const journalItems = await resolveAccounts(input, organizationId, AccountModel);

  // 4. Create draft entry
  const entry = await journalRepo.create({
    business: organizationId,
    journalType: input.journalType,
    label: input.label,
    date: input.date,
    journalItems,
    idempotencyKey: input.idempotencyKey,
  }, { session });

  // 5. Post (triggers double-entry validation, fiscal lock, idempotency)
  await journalRepo.post(entry._id, organizationId, { session });

  return { journalEntryIds: [entry._id], idempotencyKeys: [input.idempotencyKey!] };
}
```

## Idempotency

Subledger integrations should always set `idempotencyKey` to prevent duplicate postings from retries, queue redelivery, or webhook replays.

Key format convention: `{subledger}:{document-type}:{document-id}`

Examples:
- `billing:invoice:INV-001`
- `inventory:receipt:RCV-1234`
- `payroll:run:PR-2025-03`

The ledger's idempotency plugin returns a 409 Conflict if a journal entry with the same key already exists. Your posting code should catch this and treat it as a no-op (the entry was already posted).

**Prerequisite:** Enable `idempotency: true` in the engine config so the schema includes the `idempotencyKey` field with its unique sparse index.

## Dimension Fields

If your subledger items carry dimension fields (`departmentId`, `projectId`, etc.), these must be:

1. Declared in `extraItemFields` when creating the journal entry schema
2. Passed via `extraFields` on `SubledgerJournalItem` (contract level)
3. Spread onto journal items during account resolution (see Step 2 above)

Once posted, dimension fields are:
- Preserved through `duplicate()` and `reverse()` operations
- Available as filters on all report types (trial balance, balance sheet, income statement, general ledger, cash flow)

## Reversal Coordination

To void or reverse a subledger transaction:

```typescript
// 1. Reverse the ledger entry
await journalRepo.reverse(journalEntryId, organizationId, {
  actorId: userId,
  session,
});

// 2. Update subledger state (your responsibility)
await Invoice.updateOne({ _id: invoiceId }, { status: 'voided' }, { session });
```

The ledger's `reverse()` creates a new journal entry with debits and credits swapped, links it to the original via `reversedBy`, and marks the original as `reversed: true`. All dimension fields from the original entry are preserved on the reversal.

## Tax Handling

`@classytic/ledger@0.7+` is intentionally tax-agnostic. Country packs ship the chart of accounts and journal templates only — tax computation, return generation, and tax-period filing locks all live in dedicated tax engine packages:

- **`@classytic/bd-tax`** — Bangladesh income tax (IT-11GA), VAT/TDS/VDS computation, Mushak 9.1 returns
- **`@classytic/ca-tax`** *(planned)* — Canadian GST/HST/PST/QST computation, CRA GST34 form
- **Or roll your own** — a tax engine just computes amounts and posts the resulting tax line items via `engine.repositories.journalEntries.create()`

The country packs `@classytic/ledger-bd` and `@classytic/ledger-ca` still re-export the raw tax data tables (`TAX_CODES`, `TAX_CODES_BY_DIVISION` / `TAX_CODES_BY_REGION`, `mushakReturnTemplate`, `craReturnTemplate`) as named constants so tax engines can lift them.

The integration pattern:

1. Compute tax amounts in your tax engine (input: invoice line items + jurisdiction; output: tax line items with account codes)
2. Include those tax line items in the same `journalEntries.create()` call as the rest of the entry
3. The ledger stores and reports on whatever you post — it does not validate tax arithmetic

## What the Ledger Does Not Do

To set clear expectations, the ledger intentionally does **not**:

- **Compute taxes** — that lives in dedicated tax engine packages (see above)
- **Manage invoices, bills, or payments** — these are subledger concerns
- **Orchestrate multi-step workflows** — approval routing, email notifications, etc. are app-level
- **Resolve account codes to ObjectIds** — the app must map country-pack codes to tenant accounts
- **Coordinate distributed transactions** — the app must wrap cross-collection writes in a MongoDB session
- **Generate direct-method cash flow** — the cash flow report classifies by `cashFlowCategory` on account types (indirect method only)
