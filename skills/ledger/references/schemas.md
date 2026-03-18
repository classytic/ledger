# Schemas — Reference

Schema factories create Mongoose schemas configured for your engine. They handle multi-tenant fields, indexes, and validation automatically.

## Account Schema

```typescript
const AccountSchema = accounting.createAccountSchema({
  indexes: true,        // default
  extraFields: {},      // merge additional fields
  extraIndexes: [],     // add custom indexes
});
const Account = mongoose.model('Account', AccountSchema);
```

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `accountTypeCode` | String | Yes | Classification code from country pack (e.g. GIFI code) |
| `accountNumber` | String | Yes | Unique business-facing identifier per org |
| `name` | String | Yes | User-facing display name |
| `active` | Boolean | No | Default `true` |
| `isCashAccount` | Boolean | No | Default `false`. Used by cash flow report |
| `{orgField}` | ObjectId | Multi-tenant only | Organization reference |

### Indexes

- `(orgField, accountNumber)` — unique per org
- `(orgField, accountTypeCode)` — non-unique, for classification queries

### Validation

- `accountTypeCode` is validated against the country pack on save
- Pre-validate hook auto-populates `accountNumber` (from `accountTypeCode`) and `name` (from country pack type name) if not explicitly set

## Journal Entry Schema

```typescript
const JournalEntrySchema = accounting.createJournalEntrySchema('Account', {
  autoReference: true,  // auto-generate reference numbers
  textSearch: true,     // text index on reference + label
  extraItemFields: {    // custom dimension fields on journal items
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
  },
});
```

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `journalType` | String | Yes | `GENERAL`, `SALES`, `PURCHASE`, `CASH_RECEIPT`, `CASH_DISBURSEMENT`, `PAYROLL`, `ADJUSTMENT`, `YEAR_END`, `MISC` |
| `referenceNumber` | String | Auto | Auto-generated (e.g. `GJ-0001`). Unique per org |
| `label` | String | No | Description/memo |
| `date` | Date | No | Defaults to `new Date()` |
| `state` | String | No | `draft` (default), `posted`, or `archived` |
| `stateChangedAt` | Date | No | Set when state changes |
| `journalItems` | Array | Yes | Embedded items (see below) |
| `totalDebit` | Number | No | Synced by double-entry plugin |
| `totalCredit` | Number | No | Synced by double-entry plugin |
| `reversed` | Boolean | No | Set by `reverse()` |
| `reversedBy` | ObjectId | No | Points to reversal entry |
| `reversalOf` | ObjectId | No | Points to original entry (on the reversal) |
| `{orgField}` | ObjectId | Multi-tenant only | Organization reference |

### Conditional Fields

| Field | Condition | Description |
|---|---|---|
| `createdBy` | `audit.trackActor` | Actor who created the entry |
| `postedBy` | `audit.trackActor` | Actor who posted the entry |
| `reversedByUser` | `audit.trackActor` | Actor who reversed the entry |
| `approvedBy` | `audit.trackActor` or `strictness.requireApproval` | Approval actor |
| `approvedAt` | `audit.trackActor` or `strictness.requireApproval` | Approval timestamp |
| `idempotencyKey` | `idempotency: true` | Unique key for at-most-once posting (sparse index) |

### Journal Item Sub-document

| Field | Type | Required | Description |
|---|---|---|---|
| `account` | ObjectId ref | Yes | Reference to Account model |
| `label` | String | No | Line-level description |
| `date` | Date | No | Line-level date override |
| `debit` | Number | No | Default 0, non-negative integer (cents) |
| `credit` | Number | No | Default 0, non-negative integer (cents) |
| `taxDetails` | Array | No | `[{ taxCode, taxName }]` audit trail |

Custom dimension fields (via `extraItemFields`) are added alongside these core fields. They are preserved through `duplicate()` and `reverse()` and can be filtered on in reports.

### Validation Rules

- Each line must have debit OR credit > 0, not both (mutual exclusion)
- Amounts must be non-negative integers (cents)
- Posted entries must have >= 2 items and `sum(debits) === sum(credits)`

## Fiscal Period Schema

```typescript
const FiscalPeriodSchema = accounting.createFiscalPeriodSchema();
```

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | String | Yes | e.g. "FY 2025" |
| `startDate` | Date | Yes | Period start |
| `endDate` | Date | Yes | Period end |
| `closed` | Boolean | No | Default `false` |
| `closedAt` | Date | No | Timestamp of closing |
| `closedBy` | String | No | User who closed |
| `closingEntryId` | ObjectId | No | Reference to YEAR_END journal entry |
| `reopenedAt` | Date | No | Timestamp of last reopen |
| `reopenedBy` | String | No | User who reopened |

### Overlap Protection

A `pre('validate')` hook prevents overlapping date ranges within a tenant. If a new period's date range overlaps with an existing period (same org in multi-tenant mode), validation fails with a descriptive error.

## Schema Options

All schema factories accept:

```typescript
interface SchemaOptions {
  indexes?: boolean;              // default true
  extraFields?: Record<string, unknown>;
  extraIndexes?: Array<{ fields: Record<string, 1 | -1>; options?: Record<string, unknown> }>;
}
```

Journal entry schema also accepts:

```typescript
interface JournalSchemaOptions extends SchemaOptions {
  autoReference?: boolean;        // default true
  textSearch?: boolean;           // default true
  extraItemFields?: Record<string, unknown>;  // custom fields on journal items
}
```
