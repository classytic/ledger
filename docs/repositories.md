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

This creates a repository with double-entry validation, account existence + tenant integrity checks, fiscal lock enforcement, idempotency (when enabled), and wired domain methods — all configured securely from the engine's settings.

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

// With strictness options
const posted = await journalRepo.post(entryId, orgId, { actorId: userId });
```

**Validates:**
- Entry exists and belongs to org (multi-tenant)
- Entry is in `draft` state
- At least 2 journal items
- Every item has a valid account
- Every item has debit or credit > 0 (not both)
- Total debits === total credits (exact integer match)
- `actorId` is present (when `strictness.requireActor` enabled)
- `approvedBy` AND `approvedAt` are set (when `strictness.requireApproval` enabled)

**Options:** `{ session?: ClientSession, actorId?: unknown }`

### `repo.unpost(id, orgId?, options?)`

Transitions a posted entry back to draft state, allowing re-editing.

```typescript
const draft = await journalRepo.unpost(entryId, orgId);
```

**Behavior:**
- Sets state to `draft`, clears `reversed`/`reversedBy` flags
- Disabled when `strictness.immutable` is enabled (throws error)

**Options:** `{ session?: ClientSession, actorId?: unknown }`

### `repo.archive(id, orgId?, options?)`

Archives a draft entry (draft → archived). Used to discard unneeded drafts without deleting them, preserving the audit trail.

```typescript
const archived = await journalRepo.archive(entryId, orgId);
```

**Behavior:**
- Only `draft` entries can be archived (posted and already-archived entries are rejected)
- Sets state to `archived` and updates `stateChangedAt`
- Archived entries do not appear in reports (reports filter `state: 'posted'`)

**Options:** `{ session?: ClientSession, actorId?: unknown }`

### `repo.reverse(id, orgId?, options?)`

Creates a mirror entry with flipped debits/credits. Marks the original as reversed.

```typescript
const { original, reversal } = await journalRepo.reverse(entryId, orgId);

// With actor tracking
const { original, reversal } = await journalRepo.reverse(entryId, orgId, { actorId: userId });
```

**Behavior:**
- Creates a new `posted` entry with swapped debit/credit on each line
- **Preserves all dimension fields** (departmentId, projectId, locationId, etc.) on reversal items
- Sets `reversed: true` and `reversedBy` on the original
- Sets `reversalOf` on the reversal entry
- Stamps `postedBy` on reversal and `reversedByUser` on original (when `actorId` provided)
- Routes through `repository.create()` so all plugins (fiscal-lock, double-entry) run
- Atomic by default (internal transaction). Falls back to non-atomic on standalone MongoDB

**Options:** `{ session?: ClientSession, reversalDate?: Date, actorId?: unknown }`

### `repo.duplicate(id, orgId?, options?)`

Creates a copy of an entry as a new draft.

```typescript
const copy = await journalRepo.duplicate(entryId, orgId);
```

**Behavior:**
- Copies journal type, label, and all journal items as a new `draft`
- **Preserves all dimension fields** (departmentId, projectId, locationId, etc.) on duplicated items
- Does NOT copy `_id`, `id`, `referenceNumber`, `state`, or reversal flags
- Sets date to today, prefixes label with "Copy of"
- Routes through `repository.create()` so all plugins run

**Options:** `{ session?: ClientSession }`

### Posted-Entry Protection

The double-entry plugin blocks direct modifications to posted entries through `repository.update()`:
- Blocks any field change on a posted entry except idempotent `state: 'posted'`
- Blocks any state transition away from `posted` (e.g. `{ state: 'draft' }`) via the update path

To correct a posted entry, use `reverse()` to create a correcting entry. When `strictness.immutable` is **not** enabled, `unpost()` is also available to transition back to draft for re-editing. When `strictness.immutable` is enabled, `unpost()` is disabled and `reverse()` is the only correction path.

### Strictness Configuration

When the engine is configured with `strictness`, all domain methods enforce additional rules:

```typescript
const accounting = createAccountingEngine({
  // ...
  strictness: {
    immutable: true,      // unpost() disabled — correction only via reverse()
    requireActor: true,   // actorId required on post/reverse/unpost
    requireApproval: true, // approvedBy + approvedAt required before posting
  },
});
```

| Rule | Effect |
|---|---|
| `immutable` | `unpost()` throws. Only `reverse()` can correct posted entries. |
| `requireActor` | `post()`, `reverse()`, `unpost()` require `options.actorId`. |
| `requireApproval` | `post()` requires both `approvedBy` and `approvedAt` to be set on the entry before it can be posted. |

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

When `orgField` is configured, `post()`, `reverse()`, `duplicate()`, and `unpost()` require `orgId`. Calling without it throws:

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

## What the ledger does NOT do

The ledger provides the core accounting engine — double-entry posting, validation, and reporting. It does **not** implement:

- **Subledger business logic** — invoice workflows, inventory costing, payroll calculations. These belong in your app layer or dedicated subledger packages. See [Subledger Integration](subledger-integration.md) for the contract pattern.
- **Account resolution** — mapping subledger codes to account ObjectIds. The app layer resolves account references before calling `repository.create()`.
- **Approval workflows** — the ledger enforces that `approvedBy`/`approvedAt` are set (when `requireApproval` is enabled), but the approval UI and routing logic belong to the app.
- **Tax calculation** — the ledger stores `taxDetails` on journal items as an audit trail, but tax computation (rates, jurisdiction rules) belongs to the country pack or tax engine.
