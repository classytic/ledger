# Repositories

Repository wiring adds domain methods onto mongokit `Repository` instances.

## Journal Entry Repository

### Recommended: Engine Factory (secure by default)

```typescript
import { createRepository } from '@classytic/mongokit';

const journalRepo = accounting.createJournalEntryRepository(
  createRepository,
  { JournalEntryModel: JournalEntry, AccountModel: Account, FiscalPeriodModel: FiscalPeriod },
);
```

This creates a repository with double-entry validation, account existence + tenant integrity checks, fiscal lock enforcement, and wired `post()`/`reverse()` methods — all configured securely from the engine's multi-tenant settings.

### Manual Wiring (advanced)

If you need custom plugin ordering or additional plugins:

```typescript
import { createRepository } from '@classytic/mongokit';
import { doubleEntryPlugin, fiscalLockPlugin } from '@classytic/ledger';

const journalRepo = createRepository(JournalEntry, [
  doubleEntryPlugin({
    JournalEntryModel: JournalEntry,
    AccountModel: Account,       // required — fail-closed on posted creates
    orgField: 'business',        // validates tenant-account integrity
  }),
  fiscalLockPlugin({ FiscalPeriodModel: FiscalPeriod, JournalEntryModel: JournalEntry, orgField: 'business' }),
]);

accounting.wireJournalEntryRepository(journalRepo, JournalEntry);
```

> **Important:** `AccountModel` is required. The double-entry plugin will throw on posted creates if `AccountModel` is not provided.

### `repo.post(id, orgId?, options?)`

Transitions a draft entry to posted state.

```typescript
const posted = await journalRepo.post(entryId, orgId);
```

**Validates:**
- Entry exists and belongs to org (multi-tenant)
- Entry is in `draft` state
- At least 2 journal items
- Every item has a valid account
- Every item has debit or credit > 0 (not both)
- Total debits === total credits (exact integer match)

**Options:** `{ session?: ClientSession }`

### `repo.reverse(id, orgId?, options?)`

Creates a mirror entry with flipped debits/credits. Marks the original as reversed.

```typescript
const { original, reversal } = await journalRepo.reverse(entryId, orgId);
```

**Behavior:**
- Creates a new `posted` entry with swapped debit/credit on each line
- Sets `reversed: true` and `reversedBy` on the original
- Sets `reversalOf` on the reversal entry
- Routes through `repository.create()` so all plugins (fiscal-lock, double-entry) run
- Atomic by default (internal transaction). Falls back to non-atomic on standalone MongoDB

**Options:** `{ session?: ClientSession, reversalDate?: Date }`

### Immutable Posted Ledger

Posted entries cannot be modified. The double-entry plugin blocks:
- Any state transition away from `posted` (e.g. `{ state: 'draft' }`)
- Any field change on a posted entry except reversal marking (`reversed`, `reversedBy`)

To correct a posted entry, use `reverse()` to create a correcting entry.

## Account Repository

```typescript
const accountRepo = createRepository(Account, []);
accounting.wireAccountRepository(accountRepo, Account);
```

### `repo.seedAccounts(orgId, options?)`

Seeds standard posting accounts from the country pack for an organization.

```typescript
const { created, skipped } = await accountRepo.seedAccounts(orgId);
```

- Deduplicates by `accountNumber` (not `accountTypeCode`)
- Only creates posting accounts (not groups or totals)
- Sets `accountNumber = code` and `name = typeName` from country pack

**Options:** `{ session?: ClientSession }`

### `repo.bulkCreate(accounts, orgId)`

Bulk creates accounts with validation and skip-if-exists logic.

```typescript
const result = await accountRepo.bulkCreate([
  { accountTypeCode: '1000', accountNumber: 'CASH-001', name: 'Main Cash' },
  { accountTypeCode: '1000', accountNumber: 'CASH-002', name: 'Petty Cash' },
], orgId);
```

**Returns:**
```typescript
{
  summary: { total, created, skipped, errors },
  created: [...],
  skipped: [...],
  errors: [...]
}
```

- Validates `accountTypeCode` against country pack (must be a posting account)
- Single batch query for dedup (no N+1)
- `ordered: false` on insertMany for concurrent safety
- `accountNumber` defaults to `accountTypeCode` if omitted
- `name` defaults to country pack type name if omitted

## Multi-Tenant Enforcement

When `orgField` is configured, `post()` and `reverse()` require `orgId`. Calling without it throws:

```
organizationId is required when multi-tenant mode is configured
```

This is fail-closed: unscoped queries are blocked, not silently allowed.

## Session Management

`reverse()` and fiscal operations use shared session helpers:

```typescript
import { acquireSession, finalizeSession } from '@classytic/ledger';
```

- **With replica set:** Creates internal transaction, commits on success, aborts on error
- **Standalone MongoDB:** Detects topology proactively, falls back to non-atomic with a warning
- **External session:** Pass `{ session }` in options to join a caller-managed transaction
