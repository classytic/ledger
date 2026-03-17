# Engine & Configuration

The `AccountingEngine` is the main entry point. It holds your configuration and provides factory methods for schemas, repositories, and reports.

## Creating an Engine

```typescript
import { createAccountingEngine } from '@classytic/ledger';
import { canadaPack } from '@classytic/ledger-ca';

const accounting = createAccountingEngine({
  country: canadaPack,
  currency: 'CAD',
  multiTenant: { orgField: 'business', orgRef: 'Business' },
  fiscalYearStartMonth: 4, // April (default: 1 = January)
  logger: winstonLogger,   // optional, defaults to console
});
```

## Configuration Options

| Option | Type | Required | Description |
|---|---|---|---|
| `country` | `CountryPack` | Yes | Country pack (account types, tax codes) |
| `currency` | `string` | Yes | ISO 4217 currency code |
| `multiTenant` | `{ orgField, orgRef }` | No | Multi-tenant configuration |
| `fiscalYearStartMonth` | `number` | No | 1-12, default 1 (January) |
| `logger` | `Logger` | No | `{ warn, error, info }` interface; defaults to console |

### Multi-Tenant Config

When `multiTenant` is set, all schemas add an org reference field and compound indexes are scoped per-org. All repository methods and report generators enforce org isolation.

```typescript
multiTenant: {
  orgField: 'business',  // field name on documents
  orgRef: 'Business',    // Mongoose model name for ObjectId ref
}
```

Omit `multiTenant` for single-tenant applications.

## Engine Methods

### Schema Factories

```typescript
accounting.createAccountSchema(options?)       // → Mongoose Schema
accounting.createJournalEntrySchema('Account', options?)  // → Mongoose Schema
accounting.createFiscalPeriodSchema(options?)   // → Mongoose Schema
```

See [Schemas](schemas.md) for details.

### Repository Factory (recommended)

```typescript
import { createRepository } from '@classytic/mongokit';

const journalRepo = accounting.createJournalEntryRepository(
  createRepository,
  { JournalEntryModel: JournalEntry, AccountModel: Account, FiscalPeriodModel: FiscalPeriod },
);
// Includes: double-entry + fiscal lock plugins, post(), reverse() — all securely configured
```

### Manual Repository Wiring (advanced)

```typescript
accounting.wireJournalEntryRepository(repo, JournalEntryModel)
// Adds: repo.post(id, orgId), repo.reverse(id, orgId)

accounting.wireAccountRepository(repo, AccountModel)
// Adds: repo.seedAccounts(orgId), repo.bulkCreate(accounts, orgId)
```

See [Repositories](repositories.md) for details.

### Report Engine

```typescript
const reports = accounting.createReports({ Account, JournalEntry });

await reports.trialBalance({ organizationId, dateOption, dateValue });
await reports.balanceSheet({ organizationId, dateOption, dateValue });
await reports.incomeStatement({ organizationId, dateOption, dateValue });
await reports.generalLedger({ organizationId, dateOption, dateValue, accountId? });
await reports.cashFlow({ organizationId, dateOption, dateValue });
```

See [Reports](reports.md) for details.

### Account Type Helpers

```typescript
accounting.getPostingAccountTypes()   // → AccountType[]
accounting.isValidAccountType('1000') // → boolean
accounting.getAccountType('1000')     // → AccountType | undefined
accounting.getTaxCodesForRegion('ON') // → TaxCode[]
```

## Logger Interface

The engine accepts a logger that implements:

```typescript
interface Logger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
}
```

Used for transaction fallback warnings (standalone MongoDB) and operational messages. Defaults to `console.warn/error/info` with `[accounting]` prefix.
