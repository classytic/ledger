# Country Packs

A country pack provides the **chart of accounts** + accounting conventions for a jurisdiction (retained-earnings code, COGS group, journal templates, fiscal year start month, report labels). Country packs are intentionally **tax-agnostic** in 0.7+ — tax computation, return templates, and tax code tables live in dedicated tax packages (`@classytic/bd-tax`, the planned `@classytic/ca-tax`, or your own).

## Using a Country Pack

```typescript
import { createAccountingEngine } from '@classytic/ledger';
import { canadaPack } from '@classytic/ledger-ca';

const accounting = createAccountingEngine({
  mongoose: mongoose.connection,
  country: canadaPack,
  currency: 'CAD',
});
```

## Available Packs

| Package | Country | Account Types | Notes |
|---|---|---|---|
| `@classytic/ledger-ca` | Canada | GIFI (CRA-aligned) | Re-exports `TAX_CODES`, `TAX_CODES_BY_REGION`, `craReturnTemplate` as raw constants for tax engines to lift |
| `@classytic/ledger-bd` | Bangladesh | BFRS (~600 accounts) | Re-exports `TAX_CODES`, `TAX_CODES_BY_DIVISION`, `mushakReturnTemplate` as raw constants for tax engines to lift |

## Creating a Custom Country Pack

```typescript
import { defineCountryPack } from '@classytic/ledger';
import type { AccountType } from '@classytic/ledger';

const myPack = defineCountryPack({
  code: 'US',
  name: 'United States',
  defaultCurrency: 'USD',
  retainedEarningsAccountCode: '3200',
  cogsGroupCode: 'Cost of Sales',
  accountTypes: [
    {
      code: '1000',
      name: 'Cash',
      category: 'Balance Sheet-Asset',
      description: 'Cash and equivalents',
      parentCode: null,
      isGroup: false,
      isTotal: false,
      cashFlowCategory: 'Operating',
    },
    // ... more account types
  ],
  // Optional: declarative journal templates seeded per organization
  journalTemplates: [
    { code: 'SALES', name: 'Sales', journalType: 'SALES', kind: 'sale', sequencePrefix: 'INV' },
    { code: 'PURCHASE', name: 'Purchases', journalType: 'PURCHASES', kind: 'purchase', sequencePrefix: 'BILL' },
    { code: 'BANK', name: 'Bank', journalType: 'CASH_RECEIPTS', kind: 'bank', sequencePrefix: 'BNK' },
    { code: 'CASH', name: 'Cash', journalType: 'CASH_PAYMENTS', kind: 'cash', sequencePrefix: 'CSH' },
    { code: 'MISC', name: 'Miscellaneous', journalType: 'MISC', kind: 'general', sequencePrefix: 'JE' },
  ],
});
```

## CountryPack Interface

```typescript
interface CountryPack {
  code: string;              // ISO 3166-1 alpha-2
  name: string;
  defaultCurrency: string;
  accountTypes: readonly AccountType[];

  // Optional declarative journal templates for engine.repositories.journals.seedDefaults()
  journalTemplates?: readonly JournalTemplate[];

  // Country-specific report defaults
  retainedEarningsAccountCode?: string;
  retainedEarningsDisplayCode?: string;
  currentYearEarningsCode?: string;
  cogsGroupCode?: string;
  reportLabels?: {
    assets?: string;
    liabilities?: string;
    equity?: string;
    revenue?: string;
    expenses?: string;
  };

  // Auto-generated helpers:
  getPostingAccountTypes(): readonly AccountType[];
  getAccountType(code: string): AccountType | undefined;
  isValidAccountType(code: string): boolean;
  isPostingAccount(code: string): boolean;
  flattenAccountTypes(): readonly AccountType[];
}
```

## AccountType Structure

```typescript
interface AccountType {
  code: string;
  name: string;
  category: CategoryKey;        // e.g. 'Balance Sheet-Asset', 'Income Statement-Income'
  description: string;
  parentCode: string | null;    // grouping hierarchy
  isGroup?: boolean;            // structural grouping header (not postable)
  isTotal?: boolean;            // calculated total row (not postable)
  cashFlowCategory?: 'Operating' | 'Investing' | 'Financing' | null;
  taxMetadata?: TaxMetadata;    // opaque metadata pass-through (no logic)
  deprecated?: boolean;
  replacedBy?: string;
  notes?: string;
}
```

Only accounts where `isGroup !== true && isTotal !== true` are posting accounts.

## JournalTemplate Structure

```typescript
interface JournalTemplate {
  code: string;                 // 'SALES', 'PURCHASE', 'BANK', ...
  name: string;
  journalType: string;          // one of the registered JOURNAL_TYPES codes
  sequencePrefix?: string;      // defaults to `code`
  sequenceStartNum?: number;    // defaults to 1
  kind?: 'general' | 'sale' | 'purchase' | 'bank' | 'cash' | string;
  defaultDebitAccountRole?: string;
  defaultCreditAccountRole?: string;
}
```

When the consumer calls `engine.repositories.journals.seedDefaults(orgId)`, the engine creates one Journal document per template with an isolated sequence counter.

## Tax — out of scope

Country packs in 0.7+ do **not** carry tax code tables, tax return templates, or tax repartition mappings. That work belongs in tax engine packages:

- `@classytic/bd-tax` — Bangladesh income tax slabs, IT-11GA forms, VAT/TDS/VDS computation, Mushak 9.1 return generator, deduction optimizer
- `@classytic/ca-tax` (planned) — Canadian GST/HST/PST/QST computation, CRA GST34 form, ITC tracking
- Or roll your own — a tax engine just calls `engine.repositories.journalEntries.create()` with the tax line items it wants posted

Country packs that previously bundled tax data (`ledger-bd`, `ledger-ca`) still re-export it as named constants — `TAX_CODES`, `TAX_CODES_BY_REGION` / `TAX_CODES_BY_DIVISION`, `mushakReturnTemplate`, `craReturnTemplate` — so tax engines can lift it directly without re-typing.
