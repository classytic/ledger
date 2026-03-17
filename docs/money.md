# Money

Integer-cents arithmetic helpers for safe financial computation. Avoids floating-point rounding errors by operating on integer minor-unit values.

## Import

```typescript
import { Money } from '@classytic/ledger';
// or
import { fromDecimal, toDecimal, percentage } from '@classytic/ledger/money';
```

## DB Storage Contract

All monetary fields (`debit`, `credit`, `totalDebit`, `totalCredit`, report balances/totals) are stored as **integer minor units (cents)**. For example, `10050` represents $100.50.

Use `fromDecimal()` at the HTTP/API boundary to convert user-facing dollar inputs to cents. Use `toDecimal()` or `formatPlain()` to convert back for display or CSV export.

```typescript
// Input boundary (HTTP request):
const cents = Money.fromDecimal(req.body.debit);  // 100.50 → 10050

// Arithmetic (already in cents):
const taxCents = Money.percentage(cents, 5);       // 5% of 10050 → 502

// Output boundary (display/CSV):
const display = Money.formatPlain(taxCents);       // 502 → "5.02"
```

## API

### Conversion

| Function | Signature | Description |
|---|---|---|
| `fromDecimal` | `(dollars, minorUnit?) → cents` | `10.50 → 1050` |
| `toDecimal` | `(cents, minorUnit?) → dollars` | `1050 → 10.50` |
| `parseCents` | `(input) → cents` | Parse string/number to cents |
| `round` | `(amount) → integer` | Round to nearest integer |

### Arithmetic (all operate on cents)

| Function | Signature | Description |
|---|---|---|
| `add` | `(a, b) → cents` | Add two amounts |
| `subtract` | `(a, b) → cents` | Subtract b from a |
| `multiply` | `(cents, factor) → cents` | Multiply by factor, rounded |
| `percentage` | `(cents, rate) → cents` | `percentage(10000, 5) → 500` |

### Tax Helpers

| Function | Signature | Description |
|---|---|---|
| `splitTaxInclusive` | `(inclusive, rate) → { base, tax }` | Extract tax from inclusive amount |
| `splitTaxExclusive` | `(exclusive, rate) → { base, tax, total }` | Calculate tax on exclusive amount |

### Allocation

| Function | Signature | Description |
|---|---|---|
| `allocate` | `(cents, weights) → cents[]` | Split amount by weights, remainder to largest |

### Formatting

| Function | Signature | Description |
|---|---|---|
| `format` | `(cents, currency?) → string` | `1050 → "$10.50"` |
| `formatPlain` | `(cents, minorUnit?) → string` | `1050 → "10.50"` |

## Money Class

All functions are also available as static methods on the `Money` class:

```typescript
Money.fromDecimal(10.50)   // 1050
Money.toDecimal(1050)      // 10.50
Money.percentage(1050, 5)  // 52
Money.round(10.7)          // 11  ← rounds to nearest INTEGER (cents)
```

> **Warning:** `Money.round()` rounds to the nearest **integer** (cents-based). If you need dollar-level rounding to 2 decimal places, use your own helper.
