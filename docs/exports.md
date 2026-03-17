# Exports

Pure data transformation pipeline for exporting journal entries to CSV. No database dependencies, no side effects.

## Import

```typescript
import { exportToCsv, flattenJournalEntries, quickbooksFieldMap, universalFieldMap } from '@classytic/ledger/exports';
```

## Pipeline

```
PopulatedJournalEntry[] → flattenJournalEntries() → FlatJournalRow[] → exportToCsv() → CSV string
```

### Step 1: Flatten

```typescript
const rows = flattenJournalEntries(populatedEntries);
```

Converts nested journal entries (with embedded items) into flat rows — one row per journal item. Populated account references are resolved to `accountNumber` and `accountName`.

### Step 2: Export to CSV

```typescript
const csv = exportToCsv(quickbooksFieldMap, rows);
```

Maps flat rows through a field map and serializes to CSV string.

## Field Maps

### QuickBooks (`quickbooksFieldMap`)

Produces a CSV compatible with QuickBooks Desktop "General Journal" import.

### Universal (`universalFieldMap`)

Exports all available fields for maximum data preservation.

### Custom Field Map

```typescript
import type { ExportFieldMap, FlatJournalRow } from '@classytic/ledger/exports';

const myFieldMap: ExportFieldMap<FlatJournalRow> = {
  Date: { header: 'Date', value: row => row.date?.toISOString().split('T')[0] ?? '' },
  Account: { header: 'Account', value: row => row.accountNumber ?? '' },
  Debit: { header: 'Debit', value: row => row.debit ? Money.formatPlain(row.debit) : '0' },
  Credit: { header: 'Credit', value: row => row.credit ? Money.formatPlain(row.credit) : '0' },
};

const csv = exportToCsv(myFieldMap, rows);
```

## Types

```typescript
interface FlatJournalRow {
  referenceNumber?: string;
  journalType?: string;
  date?: Date;
  label?: string;
  state?: string;
  accountNumber?: string;
  accountName?: string;
  accountTypeCode?: string;
  itemLabel?: string;
  debit?: number;
  credit?: number;
  taxCode?: string;
  taxName?: string;
}
```

## Notes

- DB stores debit/credit as integer cents (e.g. `10050` = $100.50). Built-in field maps convert cents to dollars at the CSV boundary via `Money.formatPlain()`.
- CSV cells are escaped per RFC 4180 (quotes, commas, newlines).
