# @classytic/ledger

Production-grade double-entry accounting engine for MongoDB. Built on [@classytic/mongokit](../mongokit). Designed for multi-tenant SaaS, AI-powered finance, and global tax compliance.

## Features

- **Double-entry bookkeeping** with balance validation and immutable posted ledger
- **Multi-tenant** isolation via configurable org field
- **Country packs** for localized chart of accounts and tax codes
- **Financial reports** — trial balance, balance sheet, income statement, general ledger, cash flow
- **Fiscal period management** — close and reopen with automatic year-end entries
- **CSV export** — QuickBooks-compatible and universal field maps
- **Cents-based Money** arithmetic for precision
- **Plugin system** — fiscal lock, double-entry validation (via mongokit hooks)

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
});

// 2. Create schemas & models
const Account = mongoose.model('Account', accounting.createAccountSchema());
const JournalEntry = mongoose.model('JournalEntry', accounting.createJournalEntrySchema('Account'));
const FiscalPeriod = mongoose.model('FiscalPeriod', accounting.createFiscalPeriodSchema());

// 3. Wire repositories (adds post, reverse, seedAccounts, bulkCreate)
import { createRepository } from '@classytic/mongokit';

const journalRepo = accounting.createJournalEntryRepository(
  createRepository,
  { JournalEntryModel: JournalEntry, AccountModel: Account, FiscalPeriodModel: FiscalPeriod },
);

const accountRepo = createRepository(Account, []);
accounting.wireAccountRepository(accountRepo, Account);

// 4. Generate reports
const reports = accounting.createReports({ Account, JournalEntry });
const bs = await reports.balanceSheet({
  organizationId: orgId,
  dateOption: 'year',
  dateValue: 2025,
});
```

## Subpath Exports

| Import path | Contents |
|---|---|
| `@classytic/ledger` | Engine, Money, schemas, plugins, reports, repositories, constants, types |
| `@classytic/ledger/money` | `Money` class (cents-based arithmetic) |
| `@classytic/ledger/schemas` | `createAccountSchema`, `createJournalEntrySchema`, `createFiscalPeriodSchema` |
| `@classytic/ledger/reports` | Report generators (trial balance, balance sheet, etc.) |
| `@classytic/ledger/plugins` | `doubleEntryPlugin`, `fiscalLockPlugin` |
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

## Requirements

- Node.js >= 18
- MongoDB (replica set recommended for transactions)
- Mongoose ^8 or ^9
- @classytic/mongokit >= 3.0.0

## License

MIT
