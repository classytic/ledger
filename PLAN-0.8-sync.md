# `@classytic/ledger@0.8.0` — Import/Export interfaces + `/sync` subpath

> **Status:** spec, not implemented. No code, no version bump, no publish until explicit user approval. This document pairs with [`packages/fin-io/PLAN.md`](../fin-io/PLAN.md) — read both together.

## TL;DR

`@classytic/ledger@0.8.0` is a **purely additive minor release** that:

1. Adds **type-only** `ImportSource` / `ImportMapper` / `ExportSink` interfaces to the core (`@classytic/ledger`). Zero runtime cost, zero new deps.
2. Adds a new **subpath export** `@classytic/ledger/sync` containing the thin runtime glue (`wireImport`, `wireExport`, and reference mappers like `ofxBankMapper`, `camtBankMapper`, `csvBankMapper`). Total: ~250 LOC.
3. Declares `@classytic/fin-io` as an **optional peer dependency** — only consumers who actually `import from '@classytic/ledger/sync'` install it.
4. **No breaking changes.** Existing 0.7.x consumers see nothing different unless they opt in. Bump from 0.7.x → 0.8.0 is safe by default.

## Why a subpath, not a separate package

We went over this with the user across the conversation that produced [`packages/fin-io/PLAN.md`](../fin-io/PLAN.md). Short version of the conclusion:

- The 0.7.0 strip principle (engine owns mechanics, sibling packages own domain logic) **does not** rule out `/sync` because `/sync` contains *zero* domain logic — it's pure structural mapping (`CanonicalTransaction → JournalEntry`) and a small wireUp helper.
- All the heavy work (XML parsing, SGML, CSV dialects, format quirks) lives in `@classytic/fin-io`, not here. The ledger package's dep footprint stays unchanged.
- Mapping a canonical bank txn to a debit/credit pair *is* a ledger concern — same category as the existing `reconciliations.match` helper which already lives in the core.
- One less package to publish, version, and document. The peer dep on `fin-io` keeps it cleanly opt-in.

## What lands in the ledger core (root export)

These are **type-only** additions to `@classytic/ledger`'s public API. They have no runtime cost and add no dependencies. They give external code (including consumers writing their own custom importers without using `fin-io` at all) a stable contract to implement.

```ts
// src/types/sync.ts — new file, re-exported from src/index.ts

/**
 * A source of data to be imported. May be sync or async, may be a buffer
 * or a stream. Decoupled from any specific file format.
 *
 * Implementations: parsers from @classytic/fin-io, custom user parsers,
 * API responses from QBO/Xero/Plaid SDKs, anything iterable.
 */
export interface ImportSource<TRaw> {
  /** Pull records from the source. May be a one-shot array or a stream. */
  read(): Iterable<TRaw> | AsyncIterable<TRaw>;
  /** Optional checkpoint marker for resumable imports. */
  checkpoint?(cursor: string): Promise<void>;
}

/**
 * Maps a raw record (from any ImportSource) to a JournalEntry payload.
 * Implementations are typically pure functions over the canonical shapes
 * from @classytic/fin-io, but nothing forces fin-io use.
 */
export interface ImportMapper<TRaw, TJournalInput> {
  /**
   * Transform one raw record into zero, one, or many JournalEntry inputs.
   * Return null to skip a record (e.g. opening-balance entries that the
   * ledger already knows about).
   */
  toJournalEntry(raw: TRaw, ctx: ImportContext): TJournalInput | TJournalInput[] | null;

  /**
   * Stable, source-assigned unique ID for the raw record. Used for
   * idempotent re-imports. The wireImport helper writes this into
   * JournalEntry.metadata.externalId and skips re-posting if it sees a
   * duplicate.
   */
  externalId(raw: TRaw): string;
}

export interface ImportContext {
  organizationId: string;
  /** When the import job started, for audit. */
  importedAt: Date;
  /** Optional run-scoped tag, e.g. 'monthly-bank-import-2026-04'. */
  importRunId?: string;
}

/**
 * Sink for emitting ledger data to an external format. Symmetric to
 * ImportSource. Used by wireExport().
 */
export interface ExportSink<TJournal, TOut> {
  /** Transform one JournalEntry into the export format's record shape. */
  fromJournalEntry(entry: TJournal): TOut;
  /** Write a batch of records to the destination (file, stream, API). */
  emit(records: TOut[]): Promise<void>;
  /** Optional flush for buffered sinks. */
  flush?(): Promise<void>;
}

/**
 * Result of an import run. Always returned by wireImport().run() — never
 * thrown. Errors on individual records do not abort the whole run unless
 * the strict option is set.
 */
export interface ImportReport {
  ok: boolean;
  inserted: number;
  skipped: number;             // already-known externalIds
  failed: number;
  errors: ImportError[];
  durationMs: number;
}

export interface ImportError {
  externalId?: string;
  message: string;
  cause?: unknown;
}

export interface ExportReport {
  ok: boolean;
  emitted: number;
  errors: Array<{ entryId: string; message: string }>;
  durationMs: number;
}
```

These types live in `src/types/sync.ts` and are re-exported from `src/index.ts` alongside the existing `JournalEntry`, `Account`, `LedgerEngine` types. They become part of the ledger's public type surface in 0.8.0.

**That's the entire core change.** No new runtime code, no new deps, no changes to any existing file's behavior. Pure additive.

## What lands in the new `/sync` subpath

A small runtime module under `src/sync/` exposed as `@classytic/ledger/sync`:

```
packages/ledger/src/sync/
├── index.ts                  ← public exports
├── wire-import.ts            ← wireImport({ source, mapper, journalEntries }) → { run() }
├── wire-export.ts            ← wireExport({ query, sink }) → { run() }
├── mappers/
│   ├── ofx.ts                ← ofxBankMapper(config)
│   ├── camt053.ts            ← camt053BankMapper(config)
│   ├── mt940.ts              ← mt940BankMapper(config)
│   ├── csv.ts                ← csvBankMapper(config)
│   ├── iif.ts                ← iifMapper(config) — full QB migration: accounts + customers + transactions
│   └── plaid.ts              ← plaidTransactionMapper(config)
└── util/
    ├── idempotency.ts        ← externalId → JournalEntry.metadata write/check
    └── batch.ts              ← chunked posting with backpressure
```

### `wireImport` — the core helper

```ts
// Conceptual signature; full version uses real ledger types.
export function wireImport<TRaw, TJournalInput>(args: {
  source: ImportSource<TRaw> | Iterable<TRaw> | AsyncIterable<TRaw>;
  mapper: ImportMapper<TRaw, TJournalInput>;
  journalEntries: JournalEntryRepository;
  context: Pick<ImportContext, 'organizationId' | 'importRunId'>;
  options?: {
    strict?: boolean;          // first error aborts run
    batchSize?: number;        // posts per bulk operation, default 100
    onProgress?: (p: { processed: number; total?: number }) => void;
  };
}): { run(): Promise<ImportReport> };
```

What `run()` does:

1. Iterates `source.read()` (handles both sync and async iterables)
2. For each raw record, calls `mapper.externalId(raw)` and checks if a `JournalEntry` already exists with `metadata.externalId === <id>` and matching `organizationId`. If yes → skip, increment `skipped`.
3. Otherwise calls `mapper.toJournalEntry(raw, ctx)`, which returns 0/1/N journal entry inputs
4. Stamps `metadata.externalId` and `metadata.importRunId` onto each entry
5. Batches into chunks of `batchSize` and posts via `journalEntries.createMany` (or whatever bulk API the repository exposes)
6. Captures per-record errors into the report instead of throwing — unless `strict: true`, in which case the first failure rejects the promise
7. Returns the `ImportReport`

The whole helper is ~80 LOC. Idempotency is the most important piece — re-running an import on the same OFX file produces zero duplicates because the externalId check fires before posting.

### Reference mappers

The `mappers/` directory ships pre-built mappers for the canonical shapes from `@classytic/fin-io`. Each is ~30-50 LOC. Example sketch:

```ts
// src/sync/mappers/ofx.ts
import type { CanonicalTransaction } from '@classytic/fin-io';
import type { ImportMapper } from '../../types/sync';

export interface OfxBankMapperConfig {
  /** CoA code for the bank account (debit side of incoming, credit side of outgoing). */
  bankAccountCode: string;
  /** CoA code for the suspense / to-be-categorized account. */
  defaultCounterAccountCode: string;
  /** Optional rule callback to assign smarter counter-accounts based on description. */
  categorize?: (txn: CanonicalTransaction) => string | undefined;
}

export function ofxBankMapper(
  config: OfxBankMapperConfig,
): ImportMapper<CanonicalTransaction, JournalEntryInput> {
  return {
    externalId: (txn) => txn.externalId,
    toJournalEntry: (txn, ctx) => {
      const counterAccount = config.categorize?.(txn) ?? config.defaultCounterAccountCode;
      const isCredit = txn.amount.amount > 0n;
      return {
        organizationId: ctx.organizationId,
        date: txn.postedDate,
        narration: txn.description,
        lines: isCredit
          ? [
              { accountCode: config.bankAccountCode, debit: txn.amount },
              { accountCode: counterAccount, credit: txn.amount },
            ]
          : [
              { accountCode: counterAccount, debit: { ...txn.amount, amount: -txn.amount.amount } },
              { accountCode: config.bankAccountCode, credit: { ...txn.amount, amount: -txn.amount.amount } },
            ],
        metadata: {
          source: 'fin-io/ofx',
          counterparty: txn.counterparty?.name,
          reference: txn.reference,
        },
      };
    },
  };
}
```

Each mapper imports types from `@classytic/fin-io` (peer dep, type-only — no runtime cost). Consumers who don't use these mappers and write their own custom one against the `ImportMapper` interface don't need `fin-io` at all.

### `wireExport` — symmetric helper

```ts
export function wireExport<TJournal, TOut>(args: {
  query: { organizationId: string; period: { from: Date; to: Date }; filter?: object };
  sink: ExportSink<TJournal, TOut>;
  journalEntries: JournalEntryRepository;
  options?: { batchSize?: number; onProgress?: (p: { emitted: number }) => void };
}): { run(): Promise<ExportReport> };
```

Streams `JournalEntry`s matching the query through `sink.fromJournalEntry`, batches via `sink.emit`, calls `sink.flush` at the end. Used by export-side packages (`@classytic/fin-io/iif` emit, future `@classytic/fin-io/camt053` emit, accountant CSV exports, etc.) when those land in fin-io Phase 7.

## `package.json` changes

Additive only:

```jsonc
{
  "version": "0.8.0",
  "exports": {
    ".":      { "...": "..." },              // unchanged
    "./sync": {
      "types":   "./dist/sync/index.d.mts",
      "import":  "./dist/sync/index.mjs",
      "default": "./dist/sync/index.mjs"
    }
  },
  "peerDependencies": {
    "@classytic/mongokit": "^3.5.0",         // existing
    "@classytic/fin-io":   "^0.1.0"          // NEW
  },
  "peerDependenciesMeta": {
    "@classytic/fin-io":   { "optional": true }
  }
}
```

The fin-io peer dep is **optional**. Consumers who never import from `/sync` see no warning, install nothing extra, and get the same ledger they had in 0.7.x.

## Idempotency: how it actually works end-to-end

This is the load-bearing feature. Re-running the same OFX import twice must produce zero duplicate journal entries.

1. **`fin-io` parser** assigns a stable `externalId` to every `CanonicalTransaction`. For OFX this is `<FITID>`. For CAMT it's `<NtryRef>` or `<AcctSvcrRef>`. For CSV with no native ID, fin-io synthesizes `sha256(date|amount|description).slice(0,16)` and emits a warning.
2. **`ImportMapper.externalId(raw)`** surfaces that ID up to the wire helper.
3. **`wireImport.run()`** queries the journal entries collection for `{ organizationId, "metadata.externalId": id }` before posting. The reference mappers compose this lookup into a single `$in`-against-batch query so checking 100 records is one Mongo round-trip, not 100.
4. **JournalEntry creation** stamps `metadata.externalId` so the next run can find it.
5. **Recommended index** (documented, not auto-created): `{ organizationId: 1, 'metadata.externalId': 1 }` partial index `where metadata.externalId exists`. The `/sync` README will tell consumers to add it; we won't reach into their Mongo on import.

This piggybacks on the existing `JournalEntry.metadata` field that ledger 0.7 already exposes. Zero schema changes.

## Migration from 0.7.x → 0.8.0

- **Required action: none.** 0.8.0 is purely additive. Consumers can bump and ship.
- **Optional action: install `@classytic/fin-io`** if you want bank-statement import. Then `import { wireImport, ofxBankMapper } from '@classytic/ledger/sync'` and `import { parseOfx } from '@classytic/fin-io/ofx'`.
- **README + docs/** updates: add a new `docs/sync.md` describing the import/export story, update `docs/engine.md` to mention the new types in the public API table, add a section to the root README.
- **Skill (`skills/SKILL.md`):** add a "Import bank data" section with the ofx + ledger/sync snippet.
- **Tests:** new `tests/sync/` directory with vitest specs for `wireImport` (idempotency, batching, error handling, strict mode), `wireExport`, and each reference mapper. Use mongodb-memory-server like the rest of the test suite. Use small in-memory `CanonicalTransaction` arrays as fixtures — full bank-file fixtures live in `fin-io`, not here.

## Phased delivery (gated on `fin-io` phases)

| Phase | Lands in | What | Trigger |
|---|---|---|---|
| **0** | this doc | Spec | done |
| **1** | `@classytic/ledger@0.8.0` | Core types only (`ImportSource`, `ImportMapper`, `ExportSink`, `wireImport`, `wireExport`, reports). No mappers yet. Tests for the helpers using a synthetic in-memory mapper. | when fin-io Phase 1 (canonical types + OFX) is ready to land |
| **2** | `@classytic/ledger@0.8.x` patch | `ofxBankMapper` reference impl + tests + docs/sync.md update | with fin-io OFX |
| **3** | `0.8.x` patch | `camt053BankMapper` | with fin-io CAMT |
| **4** | `0.8.x` patch | `csvBankMapper` + bank-preset wiring | with fin-io CSV |
| **5** | `0.8.x` patch | `mt940BankMapper` | with fin-io MT940 |
| **6** | `0.9.0` | `iifMapper` (multi-resource: accounts + customers + journals; might need a small extension to JournalEntryRepository for bulk customer/account upsert helpers, hence minor bump) | with fin-io IIF |
| **7** | `0.9.x` patch | `plaidTransactionMapper` | with fin-io Plaid |
| **8** | `1.0.0` | `wireExport` reference sinks (CSV, IIF emit, CAMT emit) | with fin-io Phase 7 (export side) |

Phases 1-5 are all `0.8.x` patch releases (additive mapper additions don't break anything). Phase 6 might need a minor bump if `iifMapper` requires touching the `JournalEntryRepository` interface for bulk customer/account upsert support. 1.0 lines up with the export side landing.

## What this PLAN does NOT do

- ❌ Does not change any existing 0.7 behavior
- ❌ Does not add file-format parsing to ledger core (that's `fin-io`)
- ❌ Does not add OAuth, webhooks, or vendor SDKs (those are future `@classytic/fin-io-{qbo,xero,plaid}` packages)
- ❌ Does not auto-create Mongo indexes (consumer responsibility, documented)
- ❌ Does not bump the major version — 0.7 → 0.8 is safe
- ❌ Does not publish anything until explicit user approval

## Open questions

These need user input before Phase 1 code lands:

1. **Should `wireImport` support a `dryRun: true` mode** that runs the full pipeline (parse, dedup-check, map) but doesn't persist? Useful for migration previews. I'd say yes, ~10 extra LOC.
2. **Should the idempotency lookup field be `metadata.externalId` or a dedicated top-level field on `JournalEntry`?** Top-level is faster to index but needs a schema bump (minor breaking, would push to 1.0). Metadata-based works in 0.8 with no schema change. **Recommendation: metadata in 0.8, promote to top-level in 1.0** if performance data justifies it.
3. **Should the `/sync` subpath also include a `wireReconcile` helper** for matching imported bank transactions against existing AR/AP open items via the existing `reconciliations.match` engine? It's a natural pairing — once you've imported bank data, the next thing you do is reconcile it. ~50 LOC. I'd defer to Phase 4 unless there's pull.
4. **Telemetry hooks:** should `wireImport` accept an `events: EventEmitter` so consumers can subscribe to `record-skipped`, `record-imported`, `batch-flushed`? Or just stick with the `onProgress` callback? Lean: callback in 0.8, EventEmitter in 1.0 if needed.

## Comparison: the user's full surface, before vs after

**Before (0.7.x):**
```ts
import { LedgerEngine, journalEntries } from '@classytic/ledger';
// no built-in import story; users write their own integration glue
```

**After (0.8.0, no /sync usage):**
```ts
import { LedgerEngine, journalEntries } from '@classytic/ledger';
// IDENTICAL to 0.7.x. Plus the ImportSource/ImportMapper types are now
// in the public type surface for users who want to write their own glue
// against a stable contract.
```

**After (0.8.0, with /sync + fin-io):**
```ts
import { journalEntries } from '@classytic/ledger';
import { wireImport, ofxBankMapper } from '@classytic/ledger/sync';
import { parseOfx } from '@classytic/fin-io/ofx';

const parsed = parseOfx(buffer);
if (parsed.ok) {
  const importer = wireImport({
    source: parsed.data.flatMap(s => s.transactions),
    mapper: ofxBankMapper({
      bankAccountCode: '1010',
      defaultCounterAccountCode: '5900',
    }),
    journalEntries,
    context: { organizationId },
  });
  const report = await importer.run();
  console.log(`imported ${report.inserted}, skipped ${report.skipped} duplicates`);
}
```

Three imports, eight lines, full bank-statement-to-double-entry pipeline with idempotent re-runs. That's the experience this plan is targeting.
