# Plugins

Plugins hook into mongokit's `before:create` and `before:update` events to enforce accounting rules.

## Double-Entry Plugin

Validates that every posted journal entry satisfies `sum(debits) === sum(credits)`.

```typescript
import { doubleEntryPlugin } from '@classytic/ledger';

const plugin = doubleEntryPlugin({
  JournalEntryModel: JournalEntry, // required for immutability guard + partial updates
  AccountModel: Account,           // validates account existence on posted creates
  orgField: 'business',            // validates tenant-account integrity
});
```

### What it validates

On `before:create` and `before:update` (when state is `posted`):

1. Each line has debit OR credit > 0 (not both, not zero)
2. At least 2 journal items
3. `sum(debits) === sum(credits)` (exact integer match)
4. Syncs `totalDebit` and `totalCredit` onto the data

### Immutability Guard

When `JournalEntryModel` is provided, the plugin also enforces immutable posted ledger on updates:

- Blocks any state transition away from `posted` (e.g. `{ state: 'draft' }`)
- Blocks any field change on posted entries except `reversed`, `reversedBy`, and idempotent `state: 'posted'`
- Partial updates that set `state: 'posted'` without `journalItems` fetch the persisted doc for validation

### Account Validation (posted creates — fail-closed)

`AccountModel` is **required**. The plugin throws on any posted create if `AccountModel` is not provided. This ensures account existence and tenant integrity are always enforced.

On `before:create` for posted entries:

1. All journal items reference existing accounts
2. If `orgField` is set, all referenced accounts belong to the same organization as the entry

> **Tip:** Use `accounting.createJournalEntryRepository()` (see [Repositories](repositories.md)) to avoid manual plugin configuration.

### Options

| Option | Type | Required | Description |
|---|---|---|---|
| `JournalEntryModel` | Model | No | Required for immutability guard and partial update validation |
| `AccountModel` | Model | Yes* | Validates account existence and tenant integrity on posted creates. *Throws at runtime if missing on a posted create. |
| `orgField` | string | No | Multi-tenant org field name (enables tenant-account integrity check) |

## Fiscal Lock Plugin

Prevents journal entries from being created or posted in a closed fiscal period.

```typescript
import { fiscalLockPlugin } from '@classytic/ledger';

const plugin = fiscalLockPlugin({
  FiscalPeriodModel: FiscalPeriod,
  JournalEntryModel: JournalEntry,  // needed for partial update date resolution
  orgField: 'business',             // optional, for multi-tenant
});
```

### What it validates

On `before:create` and `before:update`:

1. Gets the entry date from the payload, or falls back to the persisted document
2. Checks if any closed fiscal period covers that date (org-scoped)
3. Throws if the entry date falls in a closed period

### Multi-Tenant Scoping

When `orgField` is configured:
- Resolves org from payload, or fetches from persisted doc
- Only checks fiscal periods for the same org
- Fail-closed: throws if org cannot be resolved

### Options

| Option | Type | Required | Description |
|---|---|---|---|
| `FiscalPeriodModel` | Model | Yes | Mongoose model for fiscal periods |
| `JournalEntryModel` | Model | No | Needed to resolve date from persisted doc on partial updates |
| `orgField` | string | No | Multi-tenant org field name |

## Plugin Composition

**Recommended:** Use `accounting.createJournalEntryRepository()` which handles all plugin wiring securely:

```typescript
const repo = accounting.createJournalEntryRepository(
  createRepository,
  { JournalEntryModel: JournalEntry, AccountModel: Account, FiscalPeriodModel: FiscalPeriod },
);
```

For manual composition, plugins are passed as an array to `createRepository()`:

```typescript
const repo = createRepository(JournalEntry, [
  doubleEntryPlugin({
    JournalEntryModel: JournalEntry,
    AccountModel: Account,
    orgField: 'business',
  }),
  fiscalLockPlugin({ FiscalPeriodModel: FiscalPeriod, JournalEntryModel: JournalEntry, orgField: 'business' }),
]);
```

Both plugins fire on the same hooks. Order matters: double-entry runs first (validates balance), then fiscal-lock (checks period).
