# Country Packs

A country pack provides everything country-specific: chart of accounts template, tax codes, tax report templates, and region definitions.

## Using a Country Pack

```typescript
import { createAccountingEngine } from '@classytic/ledger';
import { canadaPack } from '@classytic/ledger-ca';

const accounting = createAccountingEngine({
  country: canadaPack,
  currency: 'CAD',
});
```

## Available Packs

| Package | Country | Account Types | Tax Codes |
|---|---|---|---|
| `@classytic/ledger-ca` | Canada | GIFI (CRA) | GST/HST/PST/QST |

## Creating a Custom Country Pack

```typescript
import { defineCountryPack } from '@classytic/ledger';
import type { AccountType, TaxCode } from '@classytic/ledger';

const myPack = defineCountryPack({
  code: 'US',
  name: 'United States',
  defaultCurrency: 'USD',
  accountTypes: [
    {
      code: '1000',
      name: 'Cash',
      category: 'Balance Sheet-Assets',
      mainType: 'Assets',
      normalBalance: 'debit',
      isGroup: false,
      isTotal: false,
    },
    // ... more account types
  ],
  taxCodes: {
    STATE_TAX: {
      code: 'STATE_TAX',
      name: 'State Sales Tax',
      taxType: 'sales',
      rate: 0.06,
      direction: 'collected',
      description: 'State sales tax',
      active: true,
    },
  },
  taxCodesByRegion: { CA: ['STATE_TAX'] },
  regions: ['CA', 'NY', 'TX'],
  taxReport: undefined, // optional tax return template
});
```

## CountryPack Interface

```typescript
interface CountryPack {
  code: string;              // ISO 3166-1 alpha-2
  name: string;
  defaultCurrency: string;
  accountTypes: AccountType[];
  taxCodes: Record<string, TaxCode>;
  taxCodesByRegion: Record<string, string[]>;
  regions: string[];
  taxReport?: TaxReportTemplate;

  // Auto-generated helpers:
  getPostingAccountTypes(): AccountType[];
  getAccountType(code: string): AccountType | undefined;
  isValidAccountType(code: string): boolean;
  isPostingAccount(code: string): boolean;
  getTaxCodesForRegion(region: string): TaxCode[];
  flattenAccountTypes(): AccountType[];
}
```

## AccountType Structure

```typescript
interface AccountType {
  code: string;
  name: string;
  category: CategoryKey;        // e.g. 'Balance Sheet-Assets', 'Income Statement-Income'
  mainType: MainType;           // 'Assets', 'Liabilities', 'Equity', etc.
  normalBalance: 'debit' | 'credit';
  isGroup: boolean;             // structural grouping header (not postable)
  isTotal: boolean;             // calculated total row (not postable)
  cashFlowCategory?: string;    // 'Operating', 'Investing', 'Financing'
  taxMetadata?: TaxMetadata;    // for virtual tax sub-accounts
}
```

Only accounts where `isGroup === false && isTotal === false` are posting accounts.

## TaxCode Structure

```typescript
interface TaxCode {
  code: string;
  name: string;
  taxType: string;                    // e.g. 'GST', 'HST', 'PST'
  rate: number;                       // e.g. 0.05 for 5%
  direction: 'collected' | 'recoverable' | 'paid';
  province?: string;
  reportLines?: number[];             // lines on the tax return
  description: string;
  active: boolean;
}
```
