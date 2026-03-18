# @classytic/ledger

Production-grade double-entry accounting engine for MongoDB. Built on [@classytic/mongokit](../mongokit). Designed for multi-tenant SaaS, AI-powered finance, and global tax compliance.

## Features

- **Double-entry bookkeeping** with balance validation and posted-entry protection (optionally immutable via strictness config)
- **Multi-tenant** isolation via configurable org field
- **Country packs** for localized chart of accounts and tax codes
- **Financial reports** — trial balance, balance sheet, income statement, general ledger, cash flow
- **Fiscal period management** — close and reopen with automatic year-end entries, overlap protection
- **CSV export** — QuickBooks-compatible and universal field maps
- **Cents-based Money** arithmetic for precision
- **Plugin system** — fiscal lock, double-entry validation, idempotency (via mongokit hooks)
- **Dimension fields** — custom fields on journal items (departmentId, projectId, etc.) preserved through all workflows
- **Dimension filters** — filter all reports by custom journal item fields
- **Strictness controls** — configurable immutability, actor tracking, and approval requirements
- **Subledger contracts** — typed interfaces for integrating billing, inventory, payroll, and other subledgers

## Install

```bash
npm install @classytic/ledger @classytic/mongokit mongoose
```

## Quick Start

```typescript
import { createAccountingEngine } from '@classytic/ledger';
import { canadaPack } from '@classytic/ledger-ca';
import mongoose from 'mongoose';

// 1. Create engine
const accounting = createAccountingEngine({
  country: canadaPack,
  currency: 'CAD',
  multiTenant: { orgField: 'business', orgRef: 'Business' },
  audit: { trackActor: true },
  idempotency: true,
  strictness: { immutable: true, requireActor: true },
});

// 2. Create schemas & models
const Account = mongoose.model('Account', accounting.createAccountSchema());
const JournalEntry = mongoose.model('JournalEntry', accounting.createJournalEntrySchema('Account', {
  extraItemFields: {
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  },
}));
const FiscalPeriod = mongoose.model('FiscalPeriod', accounting.createFiscalPeriodSchema());

// 3. Wire repositories (adds post, reverse, duplicate, unpost, seedAccounts, bulkCreate)
import { createRepository } from '@classytic/mongokit';

const journalRepo = accounting.createJournalEntryRepository(
  createRepository,
  { JournalEntryModel: JournalEntry, AccountModel: Account, FiscalPeriodModel: FiscalPeriod },
);

const accountRepo = createRepository(Account, []);
accounting.wireAccountRepository(accountRepo, Account);

// 4. Generate reports (with optional dimension filters)
const reports = accounting.createReports({ Account, JournalEntry });
const bs = await reports.balanceSheet({
  organizationId: orgId,
  dateOption: 'year',
  dateValue: 2025,
  filters: { 'journalItems.departmentId': deptId },
});
```

## Subpath Exports

| Import path | Contents |
|---|---|
| `@classytic/ledger` | Engine, Money, schemas, plugins, reports, repositories, constants, types |
| `@classytic/ledger/money` | `Money` class (cents-based arithmetic) |
| `@classytic/ledger/schemas` | `createAccountSchema`, `createJournalEntrySchema`, `createFiscalPeriodSchema` |
| `@classytic/ledger/reports` | Report generators (trial balance, balance sheet, etc.) |
| `@classytic/ledger/plugins` | `doubleEntryPlugin`, `fiscalLockPlugin`, `idempotencyPlugin` |
| `@classytic/ledger/repositories` | `wireJournalEntryMethods`, `wireAccountMethods` |
| `@classytic/ledger/exports` | CSV export: `exportToCsv`, `flattenJournalEntries`, field maps |
| `@classytic/ledger/constants` | Categories, journal types, currencies |
| `@classytic/ledger/country` | `defineCountryPack`, `CountryPack` interface |

## Documentation

- [Engine & Configuration](docs/engine.md)
- [Schemas](docs/schemas.md)
- [Repositories](docs/repositories.md)
- [Reports](docs/reports.md)
- [Plugins](docs/plugins.md)
- [Exports](docs/exports.md)
- [Country Packs](docs/country-packs.md)
- [Money](docs/money.md)
- [Subledger Integration](docs/subledger-integration.md)

## Requirements

- Node.js >= 22
- MongoDB (replica set recommended for transactions)
- Mongoose >= 9
- @classytic/mongokit >= 3.3.2

## License

MIT
