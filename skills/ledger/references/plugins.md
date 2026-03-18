# Plugins — Reference

Plugins hook into mongokit's `before:create` and `before:update` events to enforce accounting rules.

## Double-Entry Plugin

Validates that every posted journal entry satisfies `sum(debits) === sum(credits)`.

```typescript
import { doubleEntryPlugin } from '@classytic/ledger';

const plugin = doubleEntryPlugin({
  JournalEntryModel: JournalEntry,
  AccountModel: Account,
  orgField: 'business',
});
```

### What it validates

On `before:create` and `before:update` (when state is `posted`):

1. Each line has debit OR credit > 0 (not both, not zero)
2. At least 2 journal items
3. `sum(debits) === sum(credits)` (exact integer match)
4. Syncs `totalDebit` and `totalCredit` onto the data
5. All journal item accounts exist (when `AccountModel` provided)
6. All referenced accounts belong to the same org as the entry (when `orgField` set)

### Account Validation

Account validation runs on **both** `before:create` and `before:update` when `AccountModel` is provided. This closes the `repository.update(id, { state: 'posted' })` bypass — a draft with invalid accounts cannot be posted through the generic update path.

On `before:create` for posted entries, `AccountModel` is **required** and the plugin throws if it's missing (fail-closed). On `before:update`, account validation runs when `AccountModel` is available but does not throw if it's absent (allows unit tests that only check balancing).

### Posted-Entry Protection

When `JournalEntryModel` is provided, the plugin protects posted entries from direct modification via updates:

- Blocks any state transition away from `posted` (e.g. `{ state: 'draft' }`)
- Blocks any field change on posted entries except idempotent `state: 'posted'`
- `reversed`/`reversedBy` are NOT allowed through `repository.update()` — `reverse()` uses `entry.save()` directly
- Partial updates that set `state: 'posted'` without `journalItems` fetch the persisted doc for validation

### Options

| Option | Type | Required | Description |
|---|---|---|---|
| `JournalEntryModel` | Model | No | Required for immutability guard and partial update validation |
| `AccountModel` | Model | Yes* | Validates account existence and tenant integrity. *Required on `before:create` (throws if missing). On `before:update`, runs when available. |
| `orgField` | string | No | Multi-tenant org field name (enables tenant-account integrity check) |

## Fiscal Lock Plugin

Prevents journal entries from being created or posted in a closed fiscal period.

```typescript
import { fiscalLockPlugin } from '@classytic/ledger';

const plugin = fiscalLockPlugin({
  FiscalPeriodModel: FiscalPeriod,
  JournalEntryModel: JournalEntry,
  orgField: 'business',
});
```

### What it validates

On `before:create` and `before:update`:

1. Gets the entry date from the payload, or falls back to the persisted document
2. Checks if any closed fiscal period covers that date (org-scoped)
3. Throws if the entry date falls in a closed period

### Options

| Option | Type | Required | Description |
|---|---|---|---|
| `FiscalPeriodModel` | Model | Yes | Mongoose model for fiscal periods |
| `JournalEntryModel` | Model | No | Needed to resolve date from persisted doc on partial updates |
| `orgField` | string | No | Multi-tenant org field name |

## Idempotency Plugin

Prevents duplicate journal entries by checking for existing entries with the same `idempotencyKey`.

```typescript
import { idempotencyPlugin } from '@classytic/ledger';

const plugin = idempotencyPlugin({
  JournalEntryModel: JournalEntry,
});
```

On `before:create`: if the entry has an `idempotencyKey` and a document with the same key already exists, the plugin throws a 409 Conflict error.

Enable the `idempotencyKey` schema field by setting `idempotency: true` in the engine config. The field has a unique sparse index — entries without a key are not affected.

### When to use

Idempotency keys are essential for subledger integrations where a retry (network failure, queue redelivery) could otherwise create duplicate postings. The subledger generates a deterministic key (e.g. `billing:invoice:INV-001`) and the ledger guarantees at-most-once posting.

## Plugin Composition

**Recommended:** Use `accounting.createJournalEntryRepository()` which handles all plugin wiring.

For manual composition, plugins are passed as an array to `createRepository()`:

```typescript
const repo = createRepository(JournalEntry, [
  doubleEntryPlugin({ JournalEntryModel: JournalEntry, AccountModel: Account, orgField: 'business' }),
  fiscalLockPlugin({ FiscalPeriodModel: FiscalPeriod, JournalEntryModel: JournalEntry, orgField: 'business' }),
  idempotencyPlugin({ JournalEntryModel: JournalEntry }),
]);
```

Plugins fire in registration order: double-entry → fiscal-lock → idempotency.
