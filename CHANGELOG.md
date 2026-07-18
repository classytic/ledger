# Changelog

## 0.17.0 — 2026-07-17

### Added — posting-rules engine (`@classytic/ledger/posting-rules`)

- **Typed posting-recipe kernel** (design: `docs/posting-rules-design.md`) — the
  research-backed replacement path for hand-written host posting contracts.
  Recipes are typed data objects with pure-function leaves: declarative,
  introspectable STRUCTURE (legs, sides, account refs, conditions, idempotency,
  journal type) + typed amount functions. Package-distributed, code-reviewed,
  contract-tested — deliberately NOT runtime configuration (Oracle SLA sprawl),
  NOT code plug-ins (NetSuite SuiteGL), NOT a string DSL (Numscript).
- **`evaluatePostingRecipe(recipe, input, { slots })`** — single-pass, pure,
  no-IO evaluation to an explainable `PostingDraft`. Engine invariants:
  Σdebit = Σcredit (typed `UnbalancedRecipeError` naming legs), fail-loud
  `UnknownSlotError` (never a silent default account), always-on per-leg
  explain provenance (slot → code, condition results, fold traces), skipped
  drafts (`skipped: true`, zero legs) for intentional no-ops.
- **`AccountRef` modes** — `slot` (chart alias) · `route` (item-derived slot:
  payment-method / regex tables) · `resolve` + `foldInto` (regime/rate-gated
  accounts: null resolution FOLDS the amount into a named target leg — the
  input-VAT-absorption pattern as a first-class mechanic) · `code` escape hatch.
- **`reversalOf(recipe, { keySuffix })`** — reversal by derivation: sides
  mirror, keys suffix, conditions/folds/groups carry over — reversals can no
  longer drift from their originals.
- **`PostingRuleRegistry`** — pack contribution (`registerPack` +
  `requiredSlots`), deliberate host `override`, boot-time `validate()` sweep
  collecting ALL unresolvable slots into one loud error.
- **Test kit** — `expectRecipe(...).withSlots(...).given(input).toPost([...])`
  with order-insensitive matching and precise diffs, `toSkip`, `toHaveKey`,
  `toBalance`, and `assertDeterministic` (double-evaluation purity enforcement).
- 19 kernel tests incl. corpus-fidelity recipes (sales transaction, vendor bill
  with VDS + VAT fold, landed-cost regex grouping + reversal) proving the model
  expresses the real be-prod contracts ahead of the `ledger-bd` recipe pack.

## 0.16.0 — unpublished (2026-07-15)

### Fixed (security/integrity) — immutable guard promoted to mongokit `immutableStatesPlugin`

- **CLOSED GAPS: `findOneAndUpdate`, `updateMany`, `deleteMany`, `bulkWrite`,
  and `restore` on the JournalEntry repository were UNFENCED** — with
  `strictness.immutable` on, a host could still mutate a POSTED entry through
  any of those repo paths without tripping the guard (only `update`, `delete`,
  `claim`, `claimVersion` were hooked). Also closed: a `claim` on a non-state
  field (which doesn't CAS-pin `state`) could patch a posted entry.
- `immutableGuardPlugin` is now a thin configuration of mongokit ≥3.22's
  `immutableStatesPlugin` (promoted FROM this package's 0.9.0 implementation,
  as a strict superset). Same semantics preserved: `_ledgerInternal` engine
  handshake, org-scoped state lookups, reverse-mark claim exemption
  (`isReverseMarkClaim` fingerprint unchanged), `ImmutableViolationError`
  (403 `IMMUTABLE_ENTRY`) via `errorFactory`. `updateMany`/`deleteMany` now
  refuse when ANY posted row is in the blast radius (never a silent partial
  application); `bulkWrite` on the repo is refused unless engine-flagged
  (reconciliation's raw `Model.bulkWrite` paths are hook-exempt by design
  and unaffected).
- `ImmutableGuardOptions.JournalEntryModel` removed — the plugin reads the
  repository's own model. Requires `@classytic/mongokit >= 3.22.0`.

## 0.15.2 — 2026-07-11

### Added

- **`ReverseOptions.reason?: string`** — optional human-readable reason for
  the reversal, appended to the reversal entry's label (e.g. `"duplicate
  posting"` → label becomes `"Reversal of MISC/2025/01/0001 — duplicate
  posting"`). Mirrors Odoo's `reverse_moves` reason and ERPNext's amendment
  remark; lets the GL self-document WHY an entry was reversed without
  requiring a separate memo. Pure additive — callers that omit it get the
  existing `"Reversal of …"` label unchanged.

### Tests

- `architectural-improvements.test.ts` — `reverse()` reason-appending
  (trim + format) verified.

## 0.15.1 — 2026-07-08

### Added

- **`AccountResolver` / `createAccountResolver`** — declarative GL-account resolution engine: keyword-matched rules, account purpose taxonomy (`ACCOUNT_PURPOSE`), and merge helper (`mergeAccountConfig`). Exported from the root barrel.

## 0.15.0 — 2026-07-04

### Changed (behavioral)

- **ISO 4217 currency gate via primitives (P1)** — the reconciliation
  event-catalog `currency` field (`z.string().nullable()` — accepted
  anything) now validates with `CURRENCY_PATTERN` from
  `@classytic/primitives/currency` (still nullable). Stricter
  publish-time validation when hosts run `validateMode: 'reject'` — a
  MINOR bump per 0.x convention. Primitives peer floor raised to
  `>=0.9.1` (first version exporting the pattern).

## 0.14.0 — 2026-07-03

Concurrency + boot-safety release: mongokit 3.16's `claimVersion()` adopted
end-to-end, a fail-fast capability gate, `exactOptionalPropertyTypes`, and
the primitives-0.9 timezone migration (zone-aware report boundaries)
finished and stabilized.

### Added — `updateDraft()` (version-guarded draft edits)

`repositories.journalEntries.updateDraft(id, patch, orgId?, { expectedVersion?, actorId?, session? })`
— rides mongokit 3.16's `claimVersion()` CAS on `__v`. Plain
`repository.update()` on drafts is last-write-wins (mongoose's
`optimisticConcurrency` only guards `save()`, not `findOneAndUpdate`);
this verb closes that gap:

- CAS `where: { state: 'draft' }` — a mid-edit post/archive is a clean
  miss, never a mixed write. Losses surface as typed errors:
  `ConcurrencyError` (version moved), `ImmutableViolationError` (left
  draft), `NOT_FOUND` (vanished).
- `expectedVersion` pins the `__v` the caller last read (send it from the
  loaded form) for true read-to-write optimistic locking.
- Engine-managed fields (state, totals, referenceNumber, audit stamps…)
  are rejected; `journalItems` patches revalidate line shape and resync
  `totalDebit`/`totalCredit` (findOneAndUpdate bypasses the schema
  pre-validate hook, so the verb owns that sync).

`claimVersion` is now a FIRST-CLASS GUARDED OPERATION: the double-entry,
immutable-guard, and lock plugins all register `before:claimVersion`
(operator-shaped `$set` unwrapped to the update-path validators), so a
host calling `repo.claimVersion()` directly cannot bypass posted-entry
immutability, item validation, or period locks.

### Added — boot capability gate

`createAccountingEngine` now asserts the repository backend's
`RepoCapabilities` (flow/order/catalog pattern) via the exported
`assertLedgerCapabilities()`: `upsert` + `duplicateKeyError` always
(atomic counters + race-safe idempotent create depend on them);
**`transactions` when an `outboxStore` is configured** — the durable-event
contract is unenforceable without multi-document transactions, so the
engine refuses to pretend. Standalone-Mongo hosts WITHOUT an outbox keep
working (the posting paths retain their non-transactional fallback).

### Changed — primitives 0.9 / zone-aware boundaries (migration completed)

- Peers: `@classytic/primitives >=0.9.0` (was >=0.6.0).
- `getDateRange` / `getFiscalYearStart` / `period-columns` resolve civil
  boundaries in the engine's reporting `zone` (default `'UTC'`) via
  `primitives/timezone` + the new `utils/zoned-boundaries.ts` — never the
  server-local `new Date(y, m, d)` constructor, which shifted report
  windows with the deploy machine's TZ (PACKAGE_RULES P12). UTC-deployed
  hosts see identical behavior; non-UTC hosts stop drifting.
- QuickBooks CSV export formats dates in UTC (deterministic across deploy
  machines).
- Test suite rewritten to assert UTC-civil boundaries (`Date.UTC`
  fixtures, `getUTC*` getters) plus a non-UTC-zone case (Asia/Dhaka), so
  it passes identically on any machine TZ.

### Changed — `exactOptionalPropertyTypes: true`

Enabled in tsconfig (PACKAGE_RULES P10); ~30 interfaces across reports,
plugins, repositories, and types widened to `T | undefined`, plus
conditional spreads where object literals fed exact-optional targets.
`MultiTenantConfig` now extends repo-core 0.6.1's fully-widened
`TenantConfig` with no exceptions (peer bumped to
`@classytic/repo-core >= 0.6.1`).

### Docs

- README **Production Wiring Checklist**: `fxRealizationPlugin` must be
  wired explicitly for multi-currency (silent-miss risk), the outbox relay
  is host responsibility, and fiscal-period REOPENING has no cascade guard
  — treat it as audit-gated.
- CLAUDE.md: mongokit >= 3.16 feature-floor inventory.

### Tests

1363 passing (+29: updateDraft suite, capability-gate suite, rewritten
zone-aware date-range suite).

## 0.13.0 — 2026-06-13

### Stack — mongokit 3.16 / repo-core 0.6 / primitives 0.7

- Peer ranges bumped to `@classytic/mongokit >=3.16.0`, `@classytic/repo-core >=0.6.0` (`@classytic/primitives >=0.6.0` unchanged). Dev stack pins mongokit `^3.16.0`, repo-core `^0.6.0`, primitives `^0.7.2`, clean-installed from the npm registry. No source-level changes were required by the bump — the full suite passes unmodified on the new stack.
- `multiTenantPlugin` now inherits mongokit 3.16's fail-closed defaults: `onMismatch: 'throw'` (a caller-supplied tenant that differs from the resolved scope is rejected, never silently rewritten — equivalent hex/ObjectId forms still normalize) and `allowDataInjection: false` (tenant scope must come from the call context, not payload stamping). Verified no ledger flow relied on the prior silent-overwrite behavior; ledger continues to stamp the matching org on the context, so equal values pass the guard.

### Fixed — outbox.save failures now propagate (PACKAGE_RULES §P8)

`safePublish()` previously swallowed `outboxStore.save()` failures, so a ledger write could commit while its durable event row silently vanished — the host relay would never know to re-deliver. This violated the transactional-outbox correctness contract (business write + event row commit atomically) and is severe for a financial package. Save failures now **propagate**: when the verb runs inside a host `withTransaction`, the throw rolls the transaction back; standalone callers fail loudly instead of dropping the event. Transport `publish()` failures are still swallowed (logged) — the relay re-delivers from the durable row.

**Behavioral change for hosts:** if your injected `OutboxStore.save` throws, the originating ledger verb (`post`/`unpost`/`archive`/`reverse`/`duplicate`/`seedAccounts`/reconciliation match) now rejects instead of succeeding. This is intentional fail-closed behavior — a durable accounting event must never be silently lost. Ensure your outbox store is healthy or wrap calls accordingly.

### Build hygiene

- `tsconfig.json`: `declarationMap` and `sourceMap` set to `false` (were `true`) — they leak source into published artifacts. `dist` now ships zero `.map` files (tsdown already had `sourcemap: false`).

## 0.12.5 — 2026-06-08

- Fix trial balance opening column: roll prior fiscal years' net P&L into the retained earnings account's opening balance so the TB ties out. New `TrialBalanceOptions.retainedEarningsAccountCode` override (defaults to country pack value). No-op when a real year-end closing entry was already posted.

## 0.12.4 — 2026-06-03

- Fix `seed()`: inherit `isCashAccount` from the country pack's `AccountType` — was silently defaulting to `false`, breaking Bank Reconciliation, Cash Flow Statement, and the import bank-account selector for seeded cash accounts

## 0.12.3 — 2026-05-26

### Added — entry-level `JournalEntry.sourceRef`

First-class schema slot for "what produced this whole JE", parallel to the
existing per-line `journalItems[].sourceRef`. Replaces the
per-consumer `extraFields.sourceRef` workaround.

- `SourceRef` gains optional `label` + `kind` (denormalized — drill-down UI
  renders without a `SourceBridge.resolve()` call).
- `JournalEntryInput.sourceRef?: SourceRef` — typed inline creation slot.
- `ENTRY_SOURCE_INDEX` — opt-in compound index. Spread into
  `schemaOptions.journalEntry.extraIndexes`.

**Compatibility:** purely additive — zero migration. Unstamped JEs
round-trip with null defaults. Hosts that already declared
`extraFields.sourceRef` (same 4-field shape) keep working —
`...extraFields` post-spread means host slot wins. Delete the host block
at your leisure. Versioned as a patch because the change is fully
back-compat (verified by the 0.12 → 0.12.3 collision test) and the existing
`^0.12.0` peer ranges in sibling packages (`ledger-au`, `ledger-ca`) accept
this version without republish.

### Fixed — `sparse + partialFilterExpression` index spec rejected by MongoDB

`LINE_SOURCE_INDEXES[0]` shipped with both `sparse: true` AND
`partialFilterExpression`. MongoDB rejects this combo at index creation
(`cannot mix "partialFilterExpression" and "sparse" options`), so every
host that opted into the line-level index silently got no index. Dropped
the redundant `sparse`; `partialFilterExpression` alone gives the same
storage savings.

### Changed — `extraIndexes` now tenant-scoped in multi-tenant mode

`schemaOptions.journalEntry.extraIndexes` are now registered BEFORE
`injectTenantField()` — the tenant field auto-prepends onto compound
indexes (matches built-in ledger indexes). Without this, a multi-tenant
drill-down like `find({ organizationId, 'sourceRef.sourceId': X })`
would scan stamped JEs across every tenant in the cluster.

Hosts that already manually prefix the tenant field on their extraIndexes
(the `{ organizationId: 1, _externalId: 1 }` pattern) are unaffected —
`injectTenantField`'s idempotent prefix check skips already-prefixed
indexes. No host code change required; this only adds correct behavior
for hosts that DIDN'T manually prefix.

### Peer-dep floors

`@classytic/mongokit` `>=3.14.0`, `@classytic/primitives` `>=0.6.0`,
`@classytic/repo-core` `>=0.5.0`. Additive on the APIs ledger uses.
Verified against Mongoose 9.6.2 + MongoDB 8.2.6.

## 0.12.2 — 2026-05-12

### Added — `journalEntryId` on `LedgerEntry` (general-ledger report rows)

Each row returned by `generateGeneralLedger(...)` now carries the source
`JournalEntry._id` as `journalEntryId: string`. The GL report selects
`_id` alongside the existing `date / referenceNumber / label /
journalItems` projection and threads the entry id through to every
`LedgerEntry` row.

**Why:** UIs rendering the GL had no programmatic handle to deep-link
from a ledger row back to the journal entry that produced it. The
`referenceNumber` is human-readable but not stable as a key (manual
adjustments can share refs across multiple JEs); `_id` is the only
stable join key. Hosts that hand-rolled a second `JournalEntry.find()`
to resolve the id-by-reference can drop that lookup.

**Compatibility:** purely additive at runtime. TypeScript consumers
that destructure `LedgerEntry` need no change; consumers that construct
`LedgerEntry` literals (rare — this is an output shape) must now
populate `journalEntryId`.

## 0.11.0

### ⚠️ BREAKING — `/sync` subpath removed; `@classytic/fin-io` peer dropped

The `@classytic/ledger/sync` subpath (introduced in 0.6 to bridge `@classytic/fin-io` canonical shapes into `JournalEntry` documents) has been removed. Sync orchestration is host responsibility — only one host (fajr-be-arc) ever consumed the subpath, and it already imported `@classytic/fin-io` directly elsewhere (parsers, providers, token stores). Keeping the glue in ledger violated PACKAGE_RULES P1 (no cross-`@classytic/*` imports outside `mongokit` + `primitives`) and forced fin-io to ride along as an optional peer for every consumer.

What moved out:
- `wireImport`, `wireExport` — generic batch importer/exporter
- `bankStatementMapper`, `invoiceMapper`, `journalEntryMapper`, `openingBalanceMapper` — fin-io-shape → `JournalEntryInput` mappers
- `createLedgerBridge` — `@classytic/invoice` LedgerBridge adapter
- All sync-only types (`ImportMapper`, `ImportContext`, `WireImportArgs`, `ExportSink`, `ImportReport`, etc.)

What stayed (now on the main entry):
- `buildOpeningBalanceEntry` (pure, no fin-io) — re-exported from `@classytic/ledger`
- `OpeningBalanceInput`, `OpeningBalanceResult` — re-exported from `@classytic/ledger`
- `JournalEntryInput`, `JournalItemInput` — re-exported from `@classytic/ledger` (these describe the `journalEntries.create()` input; they're inherent to the engine, not a sync concern)

**Migration for fajr-be-arc** (the only known consumer): the canonical replacement lives at `D:/projects/algoclan/fajr/fajr-be-arc/src/shared/ledger-sync/`. Imports change `from '@classytic/ledger/sync'` → `from '#shared/ledger-sync/index.js'`. fin-io stays as a fajr direct dependency; ledger no longer cares about it.

**Reference implementation for other hosts:** fajr's local copy is a stable, production-grade `LedgerBridge` adapter — multi-tenant, multi-currency, withholding tax, AR/AP-aware via an opt-in `resolvePaymentAccounts({ debit, credit })` callback (returns `{ debit: cash, credit: receivable }` for `out_invoice` payments and `{ debit: payable, credit: cash }` for `in_invoice` payments). Pairs with `@classytic/invoice@>=0.3.0`'s new `LedgerPaymentInput.moveType` field so the resolver dispatches AR/AP direction without an extra invoice fetch. Any future host needing the same glue can copy these files and adjust imports — see [`docs/sync.md`](docs/sync.md) for the full migration breakdown.

**Migration for any other consumer**: copy `src/shared/ledger-sync/` from fajr-be-arc into your own host repo. Drop `@classytic/fin-io` from ledger's peer footprint (it was already optional). The exports surface inside the moved folder is byte-identical to what `@classytic/ledger/sync` shipped.

### Fixed — reconciliation matching number generator (was: 0.10.4 smoke-blocker)

`reconciliations.match()` could collide on the unique index `{ matchingNumber: 1 }` when called twice on the same engine. Root cause: the 0.10.x refactor routed the in-collection `__counter__` sentinel doc's `$inc: { seq: 1 }` through `repository.findOneAndUpdate(...)` (to flow through the plugin pipeline — multi-tenant, audit, cache), but `seq` was never declared in the reconciliation schema and mongoose strict mode silently dropped the operator. Every call returned `undefined` → fell back to `1` → every match resolved to `RECN-000001`. First match per engine succeeded; second collided.

Replaced with `getNextSequence(counterKey, 1, connection, session)` from mongokit (the same primitive ledger already uses for `journalEntries.referenceNumber` allocation in `journal-entry.schema.ts`). Counter lives in the shared `_mongokit_counters` collection, no schema pollution, session-aware (counter rolls back if the calling transaction aborts), multi-tenant via key prefix `ledger:{orgScope}:matchingNumber`.

## [Unreleased]

### Removed

- **`config.idempotencyTtlSeconds` and the `idempotency_ttl_idx` partial TTL index on JournalEntry.** A 0.9.0-era partial TTL index (default 24 h) auto-deleted any JournalEntry that carried an `idempotencyKey` — every sale, COD placement / cancellation, customer invoice, vendor bill, shift close, manual adjustment posted through any idempotent path. JEs are permanent audit records; the cache and the record are not the same thing. Stripe / Saleor keep the replay cache in a SEPARATE store with TTL — they do not delete the resulting Charge / Order. Conflating the two here corrupted the audit trail (orphaned `journalEntryId` references on Invoice / Order docs, broken trial-balance and period-close calculations after 24 h). The unique partial index on `idempotencyKey` (untouched) is the only de-duplication primitive needed; the `before:create` hook in `idempotency.plugin.ts` reads it for fast-path replay detection. If a Stripe-style 24-h replay window ever becomes a forcing function (where the SAME key creates a NEW JE after expiry), implement that via a separate `IdempotencyCache` collection, never on the JE itself. Hosts that relied on the field can drop it from their `EngineConfig` — it no longer compiles. Migration: drop `idempotency_ttl_idx` from `journalentries` once after upgrading (`db.journalentries.dropIndex('idempotency_ttl_idx')`); idempotent on a clean install. Regression test in `tests/e2e/hardening-0.9.test.ts` asserts no TTL index exists on the collection and that a JE back-dated 25 h survives a TTL sweep window.

### Added

- **`config.journalEntryOrgField` — non-scoping branch tag on JE docs.** Single-company-multi-branch hosts (Account / FiscalPeriod stay company-wide, but every JE carries the originating branch ID for partition-style reports) had no way to surface the branch attribution through `record.*` helpers; the orgId arg was silently dropped because `multiTenant?.tenantField` was the only gate. The new field — paired with a host-declared `extraFields.<field>` schema path — lets `postEntry` stamp the JE doc on every record verb (`sale / adjustment / payment / expense / transfer`) without scoping the chart of accounts. `multiTenant` (when set) takes precedence — full multi-tenant scoping path is unchanged. Five scenario tests under [tests/scenarios/journal-entry-org-field.test.ts](tests/scenarios/journal-entry-org-field.test.ts) cover the matrix; 193/193 regression suite green.

## 0.10.1

### Fixed

- **`accounts.bulkCreate` — concurrency race against mongokit's wrapped 409.**
  When two callers each pass the pre-flight `existingNumbers` check and race
  to insert the same `accountNumber`, the loser's `createMany` call comes
  back with mongokit's `parseDuplicateKeyError` shape (`{ status: 409,
  duplicate: { fields } }`) rather than the raw `MongoBulkWriteError`. The
  catch only checked `code === 11000` / `writeErrors`, so the wrapped form
  bubbled out of a function whose JSDoc promises "duplicate key errors on
  individual docs don't abort the batch". Multi-tenant migration flows that
  fan out concurrent imports (QBO/Xero → fajr ledger) saw 409s leaking to
  end users instead of the partial-success result envelope.

  The dup-key recognizer now matches all three shapes (raw `code === 11000`,
  legacy `writeErrors[]`, and mongokit-wrapped `status === 409 + duplicate`).
  Because the wrapped error strips `insertedDocs`, the recovery branch falls
  back to a re-query by `accountNumber` to resolve the persisted `_id`s for
  callers that need to chain follow-up writes (mapping tables, journal-entry
  imports, etc.). Concurrent-insert rows now also carry `_id` in the
  `skipped` envelope when resolvable.

  Pure additive — no behavior change for callers that don't hit the race.

### Added

- **`accounts.bulkCreate` concurrency tests.** Three regression cases pinning
  the contract: 5 concurrent calls for the same `accountNumber` produce
  exactly one DB row and zero exceptions; mongokit-wrapped 409 with no
  `insertedDocs` recovers via re-query; non-duplicate-key errors (validation,
  connection) still propagate unchanged.

## 0.10.0

Builds on the 0.9.x events + bridges slate with cross-currency revaluation,
index-sync ergonomics, and a published event catalog. Peer deps migrated from
local `file:` links onto npm-published `@classytic/primitives@^0.1.0`.

### Added

- **`ExchangeRateBridge`** — new optional bridge (`@classytic/ledger/bridges`)
  that resolves fx rates at posting time. Hosts inject their own rate source
  (oanda, internal rate table, fixed floor) and the engine applies it during
  `postEntry` / revaluation flows. No runtime coupling to any fx provider.
- **`engine.syncIndexes()`** — call once at boot to drop any drifted/stale
  index specs on the three core collections (journal-entries, accounts,
  reconciliations). Replaces the manual `engine.models.*.syncIndexes()` loop.
- **`@classytic/ledger/events` — `ledger-event-catalog`** — typed catalog of
  every `LEDGER_EVENTS.*` constant paired with its zod payload schema and a
  human-readable description. Host event routers / MCP tool exposers consume
  this instead of hand-rolling per-event schemas.
- **`injectTenant` model helper** — internal plugin composition used by all
  three core repositories to thread the resolved tenant config into query
  predicates. Fixes an edge case where custom `tenantFieldType: 'custom'`
  configs lost the `resolve(ctx)` result on `findOneAndUpdate`.
- **Vitest projects split** — `npm test` now runs only unit + integration.
  `npm run test:all` runs the full tree (unit + integration + e2e). CI path
  stays fast; e2e suites stay opt-in.

### Changed

- **`events/transport.ts` removed.** `EventTransport` is re-exported from
  `@classytic/primitives/events` — removes the transport type duplication
  flagged in the 0.9 post-mortem.
- **`@classytic/primitives` devDep moved from `file:` to npm** (`^0.1.0`).
  Peer range `>=0.1.0` unchanged — consumers on 0.1.x are unaffected.
- **README trimmed** — pre-0.9 tax surface removed from the reference table;
  host integration guide kept.

### Fixed

- Account / Journal-Entry / Journal / Reconciliation repository + schema
  internals: deduplicate imports, normalize zod v4 shape, and tighten
  multi-tenant isolation checks (covered by the expanded scenario suite).
- 1377 tests pass; 1 skipped (an e2e opening-balance scenario gated on a
  flaky memory-server setup — non-blocking, logged in the test file).

### Peer deps

- `@classytic/primitives >= 0.1.0` (first npm-published version).
- Others unchanged from 0.9.1.

## 0.9.0 — "Events, Bridges, Tenant Plugin, Hardening"

Classytic package-rules alignment **plus** the full hardening slate flagged
by the 0.8.x peer review. Verified against `@classytic/mongokit@3.6.2`
from the npm registry. Zero regressions across 1420 tests.

### Bundled from the 0.8.x peer review (previously planned as 0.8.1)

**Fix** — `idempotencyKey` unique partial index was broken in 0.8.x. Its
`partialFilterExpression` used `{ $exists: true, $ne: null }`, which
MongoDB rejects with `Expression not supported in partial index: $not`.
The index was never actually built in consumers, so `idempotency: true`
was silently un-enforced at the DB layer — concurrent posts with the
same `idempotencyKey` could create duplicate journal entries.

Switched to `{ $type: 'string' }` — an allowed operator with the same
effective semantics given the schema already types `idempotencyKey` as
`string`. Mongoose's `syncIndexes()` detects drift and drops the broken
index spec automatically on next boot — no manual migration needed.
`engine.models.JournalEntry.syncIndexes()` is the recommended post-
upgrade step (or pass `syncIndexes: true` to `createAccountingEngine`,
see below).

Original scope of this fix was 0.8.1. It ships bundled into 0.9.0
alongside the full race-safety / typed-error / atomic-counter slate
the peer reviewer requested.

### Peer deps

- `@classytic/mongokit` peer now `>=3.6.2` (up from `>=3.6.1`).

  3.6.2 adds two primitives this release depends on:
  - `getNextSequence(counterKey, increment?, connection?, session?)` —
    session parameter enables atomic counter bumps inside caller
    transactions.
  - `multiTenantPlugin({ fieldType: 'string' | 'objectId' })` — native
    `ObjectId` cast for tenant IDs so `$lookup` / `.populate()` work
    against Better Auth's `organization` collection.

  Both shipped exactly as I flagged in the 0.9.0 mongokit-PR list —
  ledger now consumes them directly instead of reinventing the wheel.

### Added

**Events (§11-14 of PACKAGE_RULES):**
- `@classytic/ledger/events` subpath export
- `EventTransport` interface — structurally identical to `@classytic/arc`'s
  `EventTransport`. Drop in `MemoryEventTransport`, `RedisEventTransport`,
  `BullMQEventTransport`, or any custom implementation with zero adapter code.
- `InProcessLedgerBus` — default in-process transport when no `eventTransport`
  is injected. Supports exact-name, `*`, `ns.*`, and `ns:*` glob subscribe.
  Implements `publishMany` for outbox batching.
- `LEDGER_EVENTS` constants + typed payloads for every state transition:
  `ledger:entry.{created,posted,unposted,archived,duplicated,reversed}`,
  `ledger:account.{seeded,bulk-created}`, `ledger:journal.seeded`,
  `ledger:reconciliation.{matched,unmatched}`.
- `createEvent(type, payload, ctx, meta)` — auto-fills `meta.id`
  (`node:crypto.randomUUID`), `meta.timestamp`, `meta.userId`,
  `meta.organizationId`, `meta.correlationId`, `meta.resource`, `meta.resourceId`.
- Every state transition in the repository layer publishes via the injected
  transport. Failures in subscribers are caught — broken listeners cannot
  break the write path.
- `engine.events: EventTransport` — glob-subscribe from hosts:
  `await engine.events.subscribe('ledger:entry.*', handler)`.

**Bridges (§7, §23 of PACKAGE_RULES):**
- `@classytic/ledger/bridges` subpath export
- `SourceBridge` — host-implemented resolver for polymorphic external refs
  (Invoice, Payment, Stripe Charge, Postgres Order, anything). `resolve` for
  single, `resolveMany` for batch N+1 avoidance.
- `NotificationBridge` — direct-callback channel for operational alerts:
  `onPeriodLocked`, `onPeriodUnlocked`, `onEntryReversed`,
  `onReconciliationMismatch` (auto-fires from `reconciliations.match()` when
  `debitTotal !== creditTotal`).
- `engine.bridges: LedgerBridges` — `{ source?, notification? }`.

**Multi-tenant plugin (§9):**
- New `config.multiTenant.plugin: true` opts into mongokit's
  `multiTenantPlugin`, which injects the tenant filter at POLICY priority
  (before cache/audit/observability). Defaults to `false` for back-compat.
- `config.multiTenant.required: true` makes plugin fail-closed on missing
  `ctx.organizationId`. Defaults to `false`.
- `config.tenantFieldType: 'objectId' | 'string'` — forward-looking config
  surface for §9.1. Lets hosts declare whether the tenant field is stored as
  `ObjectId` (Better Auth compatibility for `$lookup` and `.populate()`) or
  `string` (external-auth-system compatibility).

### Preserved

- Every existing public signature. No breaking changes.
- `wireXxxMethods()` factories remain the stable internal API (an additive
  `integrations` parameter was appended). All 1398 tests pass unchanged.
- `orgId` positional parameter preserved — manual tenant scoping inside
  domain verbs stays as defense-in-depth alongside the optional plugin.

### Host wiring

```ts
import { MemoryEventTransport } from '@classytic/arc/events';
import { createAccountingEngine } from '@classytic/ledger';
import { LEDGER_EVENTS } from '@classytic/ledger/events';

const engine = createAccountingEngine({
  mongoose: mongoose.connection,
  country: canadaPack,
  currency: 'CAD',
  multiTenant: { orgField: 'business', orgRef: 'Business', plugin: true },
  tenantFieldType: 'objectId',
  eventTransport: new MemoryEventTransport(),  // or Redis, Kafka, BullMQ
  bridges: {
    source: { async resolve(id, model) { /* ... */ } },
    notification: { async onReconciliationMismatch(p) { alert(p); } },
  },
});

await engine.events.subscribe('ledger:entry.*', (e) => audit.record(e));
```

### Tests

- New scenario-oriented e2e: `tests/e2e/events-bridges-0.9.test.ts` (7 tests
  covering the full arc contract, bridge invocation, tenant plugin isolation,
  and structural-typing compatibility with arc transports).
- New smoke: `tests/smoke/v0.9-exports.smoke.test.ts` (4 tests verifying
  `/events` and `/bridges` subpaths build and import correctly from `dist/`).

### Hardening (peer-review follow-ups)

**Atomic `referenceNumber` counter (PR #2).** Replaces the pre-0.9
aggregate-then-insert allocator that caused duplicate reference numbers
under concurrent `post()` calls. Delegates to mongokit's
`getNextSequence(counterKey, 1, connection, session)` — backed by the
shared `_mongokit_counters` collection used across every
`@classytic/*` package. Key format: `ledger:{orgScope}:{journalType}:{YYYY}-{MM}`.

Counter bumps participate in caller transactions via the `session`
parameter (requires mongokit 3.6.2+), so `withTransaction` wrappers
commit the counter atomically with the document write.

Migration note: the counter collection moved from `_ledger_counters`
(my 0.9.0-preview name) to the shared `_mongokit_counters` store. If
you ran a pre-release of 0.9.0, migrate counter docs with:

```js
db._ledger_counters.find().forEach(doc => {
  db._mongokit_counters.insertOne({ _id: doc._id, seq: doc.seq });
});
db._ledger_counters.drop();
```

E2e proof: 5 concurrent `post()` calls in the same partition now all
succeed and receive unique monotonic sequences (`SALES/2026/01/0001`
through `0005`). Verified in
[`tests/e2e/hardening-0.9.test.ts`](tests/e2e/hardening-0.9.test.ts)
scenario 1.

**Race-safe `create` with typed errors (PR #2).** The repository's
`create()` wraps mongokit's base create with:

1. **Fast-path idempotency pre-check** (revenue pattern) — same
   `idempotencyKey` returns the existing entry without a second write.
2. **Race-safe insert with dup-key recovery** (cart pattern) — concurrent
   losers get the winner instead of a raw `MongoServerError(11000)`.
3. **Typed errors** — `IdempotencyConflictError`, `DuplicateReferenceError`,
   `ConcurrencyError`, `ImmutableViolationError`, all extending
   `AccountingError`. Callers can `instanceof`-check without parsing
   driver internals. Also exports `classifyDuplicateKey(err)` helper.

E2e proof: 10 concurrent creates with the same `idempotencyKey` collapse
to exactly 1 document, all 10 resolve to the same `_id`.

**FSM atomic transitions + `strictness.immutable` enforcement (PR #3).**
New `immutableGuardPlugin` wired automatically when
`config.strictness.immutable === true`. Blocks direct
`repository.update()`/`repository.delete()` calls targeting posted entries
at the `before:update`/`before:delete` hook layer. The engine's own
state-transition verbs (`post`, `unpost`, `archive`, `reverse`) still
work via the `_ledgerInternal` escape flag. Also adds
`optimisticConcurrency: true` on the journal entry schema for
`__v`-guarded saves.

The pre-existing `Errors.immutable(...)` factory now returns
`ImmutableViolationError`, so every throw site across the package
(including the double-entry plugin) is instance-checkable.

**Transactional wrapper (PR #4).** `outboxStore.save(event, { session })`
participates in the caller-provided mongoose session, letting hosts write
outbox rows atomically with the ledger document write. Existing
`context.session` threading in post/unpost/archive/reverse/duplicate/match/
unmatch is unchanged.

**Idempotency TTL index (PR #5).** Adds a sparse TTL index on
`createdAt` filtered by `{ idempotencyKey: { $type: 'string' } }` when
`config.idempotency: true`. Default TTL: 86400 seconds (24h, matches
Stripe/Saleor convention). Override via `config.idempotencyTtlSeconds`.
Stale replay keys no longer collide forever.

**Period lock plugin (PR #6).** No change — `fiscalLockPlugin`,
`dailyLockPlugin`, and the `createLockPlugin` factory already ship in
[`src/plugins/lock/`](src/plugins/lock/). Documented as satisfying
PACKAGE_RULES §9/§10 period-lock requirements.

**`OutboxStore` interface + `onAfterCommit`-equivalent (PR #7).**
New `@classytic/ledger/events` export `OutboxStore` — structurally
identical to `@classytic/arc`'s `OutboxStore` (copied shape, no runtime
import, same pattern as `EventTransport`). Hosts with arc pass their
`MongoOutboxStore` directly; non-arc hosts implement the 4 required
methods against any DB. Package does NOT ship a concrete store
(PACKAGE_RULES §5.5). The `safePublish` path in every repository now
calls `outboxStore.save(event, { session })` BEFORE the transport
publish, so outbox persistence happens in the same session as the
ledger write.

**Test helpers, `syncIndexes`, public errors (PR #8).**
- `config.syncIndexes: true` — engine fires `syncIndexes()` on every
  managed model at boot so new partial/TTL indexes are present before
  the first write. Default `false` for hosts running their own
  migration pipeline.
- New typed error classes exported at the root:
  `IdempotencyConflictError`, `DuplicateReferenceError`,
  `ConcurrencyError`, `ImmutableViolationError`, plus the
  `classifyDuplicateKey(err)` helper.
- `allocateReferenceNumber`, `buildReferenceCounterKey`,
  `formatReferenceNumber`, `getNextSequence` exported for consumers
  that want the counter without the full schema.

### Verified against mongokit 3.6.2 (npm)

Installed the published `@classytic/mongokit@3.6.2` from the npm
registry (not `file:` link, not local source). Peer and dev deps both
pinned to `>=3.6.2`. Entire suite re-run: **1420 passed, 1 skipped** —
no regressions from the upgrade, from the hardening slate, or from the
wheel-reinvention cleanup.

### Wheel-reinvention cleanup

Removed my own sequence-counter infrastructure in favor of mongokit
3.6.2's native primitives:

- **Deleted `src/utils/sequence.ts`** (~110 lines). Schema pre-save
  hook now calls `mongokit.getNextSequence` directly.
- **Dropped `allocateReferenceNumber`, `buildReferenceCounterKey`,
  `formatReferenceNumber`, `getNextSequence` exports** from the root.
  Consumers that want the counter primitive can import from
  `@classytic/mongokit` directly.
- **Counter collection aligned** on `_mongokit_counters` — shared with
  invoice, order, cart, revenue. One counter store per app.

No behavior change for consumers — the race-safety guarantee is
identical. The peer-review 5-concurrent-post test still passes.

### Wired `tenantFieldType` through `multiTenantPlugin`

`config.tenantFieldType: 'string' | 'objectId'` now propagates all the
way into `multiTenantPlugin({ fieldType })`. When set to `'objectId'`,
the plugin casts string tenant IDs from request context into
`mongoose.Types.ObjectId` before injection, so:

- `$lookup` / `$match` work against the `organization` collection
- `.populate('organization')` resolves the tenant document
- Better Auth's `organization._id` (native ObjectId) becomes
  interoperable with ledger documents that store `organizationId`
  as `Schema.Types.ObjectId`

Defaults to `'string'` for back-compat with UUID/slug-based auth
systems. New Better-Auth-backed hosts should set `'objectId'`.

### Deferred to 1.0.0

- Full class extension of repositories (§1). Current `wireXxxMethods`
  pattern stays stable; classes will replace them in a future major.
- Hard break on `orgId` positional argument. Reserved for 1.0.0 once
  hosts have migrated to context-based scoping via the opt-in plugin.
- Schema-level `tenantFieldType` switching in the models factory. The
  engine config field is live; the model factory will consume it once
  mongokit publishes a version with `fieldType` in `multiTenantPlugin`.

---

## 0.7.0 — "Tax Out, Accounting Stays" (BREAKING)

`@classytic/ledger` is a **double-entry accounting engine** — not a tax
engine. 0.6.x leaked tax concepts into the core (`TaxCode` interface,
`TaxReportTemplate`, `taxHookPlugin`, `taxLockPlugin` preset,
`createRepartitionTaxGenerator`, `resolveTaxRepartitionAccountCode` on
`CountryPack`, `cashBasisRealize` internal op, `engine.introspect.taxCodes`,
the `tax` parameter on `record.sale()` / `record.expense()`). 0.7.0 strips
all of it. This mirrors how Odoo (`account/` vs `l10n_*`), QuickBooks
(Ledger vs TaxService), and Xero (accounting vs Xero Tax) actually
separate the two concerns — and aligns with our existing dedicated tax
package `@classytic/bd-tax`.

### Removed (no shims, intentional clean break)

**Country pack contract** (`@classytic/ledger/country`):
- `TaxCode`, `TaxCodesByRegion`, `TaxRepartitionLine`, `TaxExigibility`,
  `TaxReportLine`, `TaxReportTemplate` interfaces
- `taxCodes`, `taxCodesByRegion`, `regions`, `taxReport`,
  `resolveTaxRepartitionAccountCode` fields on `CountryPack` /
  `CountryPackInput`
- `getTaxCodesForRegion()` helper method on `CountryPack`

**Plugins** (`@classytic/ledger/plugins`):
- `taxHookPlugin` + `TaxHookPluginOptions`
- `taxLockPlugin` preset + `TaxLockPluginOptions` (the underlying
  `createLockPlugin` factory + `periodResolver` are kept — tax engines
  can compose them themselves)

**Utilities** (`@classytic/ledger`):
- `createRepartitionTaxGenerator`, `defaultResolveTaxRepartitionAccountCode`
- `RepartitionAccountResolver`, `RepartitionGeneratorOptions` types
- `TaxLineGenerator`, `TaxLineInput`, `GeneratedTaxLine`, `applyTaxHook`

**Reports** (`@classytic/ledger/types/report`):
- `TaxReport`, `TaxAccountBalance`, `TaxReturnSummary`, `TaxReportParams`
  (these were never wired to a generator — orphaned types from earlier work)

**Engine + semantic API**:
- `engine.getTaxCodesForRegion(region)` method
- `engine.introspect.taxCodes(region?)` method
- `tax: TaxInput` parameter on `RecordSaleInput` / `RecordExpenseInput`
- `TaxInput` interface

**Internal op tags**:
- `cashBasisRealize` removed from `LedgerInternalOp`. The remaining tags
  are `'post' | 'unpost' | 'archive' | 'reverseMark' | 'fxRealize'` —
  all accounting concerns.

### Kept (unchanged, deliberate)

- `TaxDetail` and `TaxMetadata` interfaces in `core.ts` — these are pure
  metadata shapes (no logic), used as opaque pass-through tags on
  journal items and account types. Country packs and tax engines can
  populate them as they see fit.
- `taxDetails: Array<{taxCode?, taxName?}>` field on the journal-item
  schema — same reason: opaque audit metadata, not tax compute.

### Migration

Consumers using the removed tax APIs should:

1. Pin to `@classytic/ledger@^0.6.0` until they're ready to refactor, OR
2. Move tax concerns into a dedicated tax package
   (`@classytic/bd-tax` already exists; `@classytic/ca-tax` and others
   will follow the same pattern). Tax engines:
   - Own their own tax code tables
   - Compute returns / repartition / exigibility internally
   - Optionally expose a thin "post-to-ledger" adapter that calls
     `engine.repositories.journalEntries.create({...})`
3. For lock-period filing windows that used to need `taxLockPlugin`,
   compose `createLockPlugin({scope: 'tax', resolve: periodResolver({...})})`
   inside your tax package — the building blocks are unchanged.

Country packs `@classytic/ledger-bd` and `@classytic/ledger-ca` are
slimmed in their own 0.3.0 releases — same shape (chart of accounts +
journal templates) without the tax wiring. The raw BD/CA tax data
tables still ship as named exports (`TAX_CODES`, `TAX_CODES_BY_DIVISION`,
`mushakReturnTemplate`, etc.) so the future tax packages can lift them.

### Test + smoke updates

- Deleted `tests/utils/repartition-tax.test.ts`,
  `tests/utils/tax-hooks.test.ts`, `tests/plugins/tax-hook.plugin.test.ts`
- Deleted `tests/scenarios/semantic-quarterly-cycle.test.ts` (was tightly
  coupled to tax helpers; can be reborn in `@classytic/ca-tax` later)
- Stripped tax assertions from `tests/api/public-api.test.ts`,
  `tests/api/subpath-exports.test.ts`, `tests/country/country.test.ts`,
  `tests/engine.test.ts`, `tests/semantic/introspect.test.ts`,
  `tests/semantic/record.test.ts`, `tests/e2e/lock-scopes.test.ts`,
  `tests/e2e/plugins-fiscal-dimensions.test.ts`,
  `tests/architectural-improvements.test.ts`
- Smoke CLI dropped tax sections (5 — taxLockPlugin, 11 — repartition
  generator) and country pack assertions now confirm tax fields are
  **absent** from the country pack contract
- Final state: **1246 / 1247 tests** passing (1 unrelated skip),
  smoke green against the published shape

---

## 0.6.0 — "Open Items & Enterprise Primitives"

### Update notes (post-initial)

Added during the 0.6.0 development window after a real-world ERP review
identified gaps consumers were hitting when building A/P + A/R workflows:

- **`getOpenItems` gains `filter` + `asOfDate`** — partner-scoped subsidiary
  ledger queries now collapse to a single repository call:
  `getOpenItems({ accountId: apId, filter: { partnerId: 'sup-1' }, asOfDate })`.
  The projection now also surfaces the full item via `item: {...}` so
  consumers see every dimension they declared in `extraItemFields`.

- **`generatePartnerLedger` report** — supplier/customer statement with
  opening balance, running balance via `$setWindowFields`, per-line
  `daysPastDue`, `matchingNumber`, `isMatched`, and aged buckets at
  end-of-period. One aggregation pipeline, no consumer-side joins, no
  extra collections. Companion to `generateAgedBalance` (which gives the
  cross-partner summary). Located at `src/reports/partner-ledger.ts`.

- **`creditLimitPlugin`** — `before:create` enforcement of per-partner
  outstanding A/R caps. Walks `journalItems`, finds debits to the A/R
  control account, sums existing open exposure for each partner via the
  same aggregation `getOpenItems` uses, and throws
  `AccountingError(402, 'CREDIT_LIMIT_EXCEEDED')` with structured fields
  (`partnerId`, `limit`, `currentOutstanding`, `newExposure`) when the
  cap is breached. Exempt under `_ledgerInternal` (`reverseMark`,
  `fxRealize`, `cashBasisRealize`) so reversals + system entries always
  post. Demands a `partnerId` on every credit-sale line — fail-fast
  validation prevents untagged A/R items from polluting the subsidiary
  ledger.

- **mongokit peer bumped to `>=3.5.5`** — picks up schema-aware QueryParser
  coercion, geo query support, search-resolver plugin contract, and the
  full set of new query primitives shipped in mongokit 3.5.5. Fully
  backward compatible — no consumer changes required.

- **A/P + A/R integration recipe in SKILL.md** — a dedicated section
  walking through the canonical ERP workflow consumers can now build on
  top of these primitives. 8 numbered steps from "wire `partnerId` once"
  through to "credit notes & debit notes", with side-by-side comparison
  to Odoo showing how every concept they encode as a separate
  model/table maps to a single primitive in our package.

- **Scenario-based smoke section** added to `example/smoke.mjs` — a 10-
  step end-to-end ERP cycle (Acme Trading) covering bill receipt,
  partner ledger, credit-limit enforcement, partial settlement, full
  multi-cheque settlement, aged-balance reporting, and audit chain. Runs
  against the published `dist/` shape via `file:..` link, so any
  packaging regression that breaks A/P + A/R surfaces immediately during
  `npm run smoke` (which is gated into `prepublishOnly`). 28 / 28
  smoke assertions across all 12 sections.

### What it means for consumers

A consumer building an ERP A/P + A/R subsystem on `@classytic/ledger`
0.6.0 needs **one schema field** (`partnerId` extraItemField) plus
calls to **5 primitives** (`journalEntries.create`, `reconciliations.match`,
`reconciliations.getOpenItems`, `generatePartnerLedger`,
`generateAgedBalance`) — and an optional **one-line plugin install**
(`creditLimitPlugin`). No `Bill` model, no `Invoice` model, no
`AccountPayment` model, no partial/full reconciliation discriminator,
no separate credit-memo workflow. Every Odoo concept folds into a
journal entry + matching number.



A major release bringing item-level open-item matching, first-class
journal resources, tax repartition, realized FX, and a unified lock
primitive. No backcompat shims — this is an aggressive refactor toward
an enterprise-grade shape. Consumers on 0.5.x should migrate deliberately.

### Headline features

- **Item-level open-item matching** — `reconciliationRepository.match()`
  stamps a shared `matchingNumber` onto individual journal items so you
  can represent "one cheque settles two invoices" and "one invoice paid
  by three cheques" — the AR/AP canonical case. `getOpenItems()` surfaces
  unmatched items cheaply via a dedicated sparse index. `unmatch()`
  reverses the stamp atomically. Replaces the old 0.5.x entry-level
  `reconcile()` which could not represent these flows.

- **First-class `Journal` resource** — `engine.repositories.journals`
  exposes a catalogue of organization-owned posting channels with
  per-journal sequence prefixes, atomic `nextSequenceNumber()`, kinds
  (`sale` / `purchase` / `bank` / `cash` / `general`), default accounts,
  and source strings. Optional — existing consumers that never call
  `seedDefaults()` keep working with the `journalType` enum. Country
  packs can declare `journalTemplates` to seed organization-specific
  defaults (BD: Mushak Sales/Purchase/VDS/TDS, CA: standard 6-journal set).

- **Tax repartition** — `TaxCode.repartition` is a declarative array of
  `{factor, accountRole, gridCode?, documentTypes?}` lines. A single tax
  code can now emit multiple journal items (Odoo-style): reverse-charge
  VAT booking +100% collected / +100% recoverable, self-assessed sales
  tax, multi-destination splits. The new
  `createRepartitionTaxGenerator({country, resolveAccount})` expands the
  declarative config at posting time through the existing `taxHookPlugin`.

- **Cash-basis exigibility** — `TaxCode.exigibility: 'cash'` marks a tax
  whose recognition waits for payment. Combined with a `transition`
  repartition role and the open-item matching pipeline, consumers can
  park tax in a holding account at invoice time and move it to the real
  liability account on payment. Wiring is declarative in the country
  pack, zero application code.

- **Realized FX on reconciliation** — `fxRealizationPlugin` listens on
  `after:match`. When the matched items share a single foreign currency
  but were posted at different exchange rates, the plugin computes the
  base-currency delta and books a balancing journal entry tagged
  `_ledgerInternal: 'fxRealize'` to a configured realized-gain or
  realized-loss account. The reconciliation gets a `fxRealizationEntry`
  audit ref. Reverses cleanly via `unmatch()` → `reverse()`.

- **Unified lock primitive** — `createLockPlugin({scope, resolve, ...})`
  is the factory behind every lock scope. Scope-specific logic lives in
  a `LockResolver`; the factory owns all the shared pipeline plumbing
  (date resolution, multi-tenant org lookup, persisted-doc fallback on
  partial updates, `_ledgerInternal` exemption). Three built-in presets:
  - `fiscalLockPlugin`  — fiscal close (unchanged semantics vs 0.5.x)
  - `taxLockPlugin`     — tax filings, narrowed by per-item account selector
  - `dailyLockPlugin`   — per-branch watermark ("lastClosedDate")
  Two builtin resolvers (`periodResolver`, `watermarkResolver`) for
  composing bespoke scopes (bank-reconciliation, payroll, etc.).

- **Typed error channel** — all lock violations throw `AccountingError`
  with **HTTP 409** and the code `PERIOD_LOCKED_{SCOPE}`. The old
  `Errors.fiscal()` factory is removed in favor of
  `Errors.locked(scope, msg, fields?)`.

- **`_ledgerInternal` policy clarified** — only `reverseMark` and
  `fxRealize` are exempt from locks. `post` and `unpost` remain fully
  subject — you cannot post into or unpost out of a closed period.

- **Generic result types** — `ReverseResult<TEntry>` and
  `BulkCreateResult<TAccount>` are now generic over the document type.
  Callers no longer need casts.

- **Smoke test infrastructure** — `example/` is a standalone CLI that
  imports `@classytic/ledger` via a `file:..` link and exercises every
  major primitive against real MongoDB. Wired into `prepublishOnly` so
  `npm publish` cannot ship a broken dist/. See `scripts/smoke.mjs`.

### Data-model changes

| Change | Breaking? |
|---|---|
| New `journal` ref on `JournalItem` and `JournalEntry` (optional) | No |
| New `matchingNumber`, `maturityDate` on `JournalItem` | No |
| New `matchingNumber`, `items[{entry,itemIndex,...}]`, `isFullReconcile`, `currency`, `fxRealizationEntry` on `Reconciliation` | **Yes** — the entry-level schema is gone |
| New optional `repartition`, `exigibility` on `TaxCode` | No |
| New optional `journalTemplates`, `resolveTaxRepartitionAccountCode` on `CountryPack` | No |
| New `Journal` model/collection (opt-in via `seedDefaults`) | No |
| Removed `Errors.fiscal()` factory and `FISCAL_ERROR` code | **Yes** |
| `LedgerInternalOp` gains `'fxRealize'` and `'cashBasisRealize'` | No |

### Country packs

- **`@classytic/ledger-bd` 0.2.0** — peer bumped to `>=0.6.0`. Adds
  `journalTemplates` (Mushak Sales/Purchase/VDS/TDS/Bank/Cash/Misc),
  `resolveTaxRepartitionAccountCode` mapping (collected→2131,
  recoverable→1150, transition→1155, tds→2135, vds→2136). BD-VAT-15 now
  carries a single-line `repartition` with NBR grid box 1.

- **`@classytic/ledger-ca` 0.2.0** — peer bumped to `>=0.6.0`. Adds
  `journalTemplates` (Sales/Purchase/Bank/Cash/Payroll/Misc),
  `resolveTaxRepartitionAccountCode` mapping to GIFI codes
  (collected→2680, recoverable→1900, transition→2685). HST13 carries
  a single-line repartition with CRA box 103.

- **`@classytic/ledger-assets` 0.2.0** — peer bumped to `>=0.6.0` (no
  other changes; the asset engine is orthogonal to these primitives).

### Removed (no shims)

- `src/plugins/fiscal-lock.plugin.ts`
- `src/plugins/date-lock.plugin.ts`
- Old entry-level `reconciliationRepository.reconcile()` /
  `unreconcile()` / `getUnreconciled()` methods — replaced by
  `match()` / `unmatch()` / `getOpenItems()`
- `Errors.fiscal()` factory
- `FISCAL_ERROR` code
- `ReconcileParams` type

### Migration

See the old entry below for the lock-plugin renames. Additionally:

```ts
// 0.5.x — entry-level reconciliation
await engine.repositories.reconciliations.reconcile({
  account: arId,
  journalEntryIds: [invEntry._id, payEntry._id],
});

// 0.6.0 — item-level matching
await engine.repositories.reconciliations.match({
  account: arId,
  items: [
    { entry: invEntry._id, itemIndex: 0 }, // AR debit on the invoice
    { entry: payEntry._id, itemIndex: 1 }, // AR credit on the payment
  ],
});
```

```ts
// 0.5.x — no journal resource
await engine.repositories.journalEntries.create({
  journalType: 'SALES', // enum only
  ...
});

// 0.6.0 — opt-in journal resource
await engine.repositories.journals.seedDefaults(orgId);
const journals = await engine.repositories.journals.getAll();
const sales = journals.docs.find(j => j.code === 'SALES');
const refNo = await engine.repositories.journals.nextSequenceNumber(sales._id);
await engine.repositories.journalEntries.create({
  journalType: 'SALES',
  journal: sales._id,     // optional ref
  referenceNumber: refNo, // optional — overrides auto-gen
  ...
});
```

```ts
// 0.6.0 — FX realization
import { fxRealizationPlugin } from '@classytic/ledger/plugins';

fxRealizationPlugin({
  journalEntries: engine.repositories.journalEntries,
  realizedGainAccount: gainAcctId,
  realizedLossAccount: lossAcctId,
  baseCurrency: 'USD',
}).apply(engine.repositories.reconciliations);

// Now every match on multi-currency items auto-books realized FX.
```

---

## 0.6.0-pre (lock primitive refactor notes, rolled into 0.6.0 final)

Breaking — no compatibility shims. Every consumer using the old
`fiscalLockPlugin` / `dateLockPlugin` symbols must update imports, but the
new surface is a strict superset and the fiscal-lock preset is wire-level
drop-in.

### Highlights

- **Unified lock primitive.** `fiscalLockPlugin`, `dateLockPlugin`, and the
  informally-hand-rolled daily-close / tax-period guards that consumers were
  writing in route handlers have collapsed into a single composable
  factory: `createLockPlugin({ scope, resolve, accountSelector?, ... })`.
  Scope-specific logic lives in a `LockResolver`; the factory owns all the
  shared pipeline plumbing (date resolution, multi-tenant org lookup,
  persisted-doc fallback on partial updates, `_ledgerInternal` exemption).

- **Three builtin presets** cover the common cases:
    - `fiscalLockPlugin`  — fiscal close (unchanged semantics vs 0.5.x)
    - `taxLockPlugin`     — tax filings, narrowed by per-item account selector
    - `dailyLockPlugin`   — per-branch watermark ("lastClosedDate") semantics

- **Two builtin resolvers** for composing your own scopes (bank-reconciliation
  lock, payroll-run lock, per-journal-type lock, …) without reimplementing
  any plumbing:
    - `periodResolver`    — range-based `FindOne` against a period-table
    - `watermarkResolver` — single-date cutoff from a sync or async callback

- **Typed error channel.** All lock violations now throw
  `AccountingError` with **HTTP 409** and the code
  `PERIOD_LOCKED_{SCOPE}` (e.g. `PERIOD_LOCKED_FISCAL`,
  `PERIOD_LOCKED_TAX`, `PERIOD_LOCKED_DAILY`). Previously only fiscal
  lock produced a dedicated code (`FISCAL_ERROR`, 400) and that factory
  has been removed.

- **`_ledgerInternal` exemption narrowed to `reverseMark` only.** In 0.5.1
  this flag let every internal state transition bypass the double-entry
  immutability guard. In 0.6.0 the lock factory is more precise:
    - `post` / `unpost` are **still subject** to locks — you cannot post
      into, or unpost out of, a closed period.
    - `reverseMark` is exempt so that `reverse()` can mark an original
      entry (sitting inside a closed period) as reversed while the
      counter-entry posts into the currently-open period via the normal
      pipeline.

- **Generic result types.** `ReverseResult<TEntry>` and
  `BulkCreateResult<TAccount>` are now generic over the document type
  (default `Record<string, unknown>` for source compat). Callers that
  previously cast `(result.reversal as { _id: Types.ObjectId })._id` can
  drop the casts entirely.

- **`Errors.fiscal()` factory removed.** Replaced by
  `Errors.locked(scope, message, fields?)`. The scope argument is
  uppercased and embedded into the error code.

### Migration

Both offending import sites:

```ts
// 0.5.x
import { fiscalLockPlugin, dateLockPlugin } from '@classytic/ledger/plugins';

fiscalLockPlugin({ FiscalPeriodModel, JournalEntryModel, orgField });
dateLockPlugin({ getLockDate, JournalEntryModel, orgField });
```

become:

```ts
// 0.6.0
import { fiscalLockPlugin, dailyLockPlugin } from '@classytic/ledger/plugins';

fiscalLockPlugin({ FiscalPeriodModel, JournalEntryModel, orgField });
// date-lock → daily-lock (watermark semantics — entries ON or BEFORE the
// returned date are blocked; strictly after passes)
dailyLockPlugin({ getLastClosedDate, JournalEntryModel, orgField });
```

For tax filings and custom scopes:

```ts
import { taxLockPlugin, createLockPlugin, periodResolver } from '@classytic/ledger/plugins';

// Preset — narrowed by accountSelector (default: acc.taxMetadata != null)
taxLockPlugin({
  TaxPeriodModel,
  AccountModel,
  JournalEntryModel,
  isTaxAffecting: (acc) => acc.isTaxAccount === true, // optional override
});

// Bespoke scope — compose the factory with a resolver
createLockPlugin({
  scope: 'bank-recon',
  JournalEntryModel,
  resolve: periodResolver({
    scope: 'bank-recon',
    PeriodModel: BankReconModel,
    startField: 'statementStart',
    endField: 'statementEnd',
    closedField: 'reconciled',
  }),
});
```

Error-handler updates:

```ts
// 0.5.x
if (err.code === 'FISCAL_ERROR') return reply.status(400).send(err);

// 0.6.0
if (err.code?.startsWith('PERIOD_LOCKED_')) return reply.status(409).send(err);
```

### Removed

- `src/plugins/fiscal-lock.plugin.ts`
- `src/plugins/date-lock.plugin.ts`
- `Errors.fiscal()` factory
- `FISCAL_ERROR` code

### Added

- `src/plugins/lock/` — types, factory, resolvers, presets, barrel
- `Errors.locked(scope, msg, fields?)` factory
- `ReverseResult<TEntry>`, `BulkCreateResult<TAccount>` generics
- Integration suite at `tests/e2e/lock-scopes.test.ts` exercising all
  three presets through a real `mongodb-memory-server` pipeline, plus
  unit suites under `tests/plugins/lock/` for the factory and resolvers
  in isolation.

---

## 0.5.1

### Bug fixes

- **Plugin pipeline bypassed by `post()` / `unpost()` / `archive()`** — these
  methods previously called `entry.save()` directly on the Mongoose document,
  silently skipping every `before:update` hook. `fiscalLockPlugin`,
  `dateLockPlugin`, `auditTrailPlugin`, `observabilityPlugin`, and any
  consumer listener attached via `repo.on('before:update', ...)` never fired
  on draft → posted (or unpost / archive) transitions. Period locks were
  effectively unenforced for the normal posting flow.

  All three methods now route their state mutations through
  `repository.update()`. The double-entry immutability guard reads a typed
  `_ledgerInternal` flag on the repository context to permit these legitimate
  transitions while still blocking arbitrary edits to posted entries.
  External `repository.update()` callers cannot spoof the flag.

- **`reverse()` mark-as-reversed step bypassed the pipeline** — the original
  entry's `reversed = true; reversedBy = ...` mutation also went through
  `entry.save()`, so audit/observability/analytics plugins never observed the
  reversal event. Now routes through `repository.update()` with
  `_ledgerInternal: 'reverseMark'`.

- **`reverse()` and `duplicate()` dropped consumer extraFields** — these
  methods only carried the configured `orgField` from the source entry. Any
  field declared in `schemaOptions.journalEntry.extraFields` (`departmentId`,
  `projectId`, `sourceRef`, branch tags, multi-tenant `organizationId`, etc.)
  was silently dropped from reversals and duplicates. Branch-scoped reports
  under-counted reversals, plugin hooks couldn't see the branch on the
  create path, and audit trails lost the originating-document link.

  Both methods now copy every non-reserved top-level field from the source
  entry. A frozen reserved-keys set excludes only the fields these methods
  own (`_id`, `state`, `journalItems`, `referenceNumber`, `reversalOf`,
  `idempotencyKey`, audit timestamps, …).

### Type safety / DX

- **Mongokit module augmentation** — new
  [`src/types/mongokit-augmentation.ts`](src/types/mongokit-augmentation.ts)
  extends `RepositoryContext` and `SessionOptions` with a typed
  `_ledgerInternal?: LedgerInternalOp` field
  (`'post' | 'unpost' | 'archive' | 'reverseMark'`). Plugin authors observing
  the journal-entry repo get full IntelliSense on the flag — no `unknown`
  narrowing or `as` casts required. `LedgerInternalOp` is re-exported from
  `@classytic/ledger`.

- **`InternalUpdateOptions extends UpdateOptions`** — the journal-entry
  repository's internal flag is now passed via a typed options interface
  instead of `as never` casts.

- `JournalEntryDoc._id` is typed as `string | mongoose.Types.ObjectId`
  instead of `unknown`, removing every `as never` cast at `update()`
  call sites.

### Tests

- New e2e suite
  [`tests/scenarios/plugin-pipeline-and-extra-fields.test.ts`](tests/scenarios/plugin-pipeline-and-extra-fields.test.ts)
  (8 tests against `mongodb-memory-server`):
  1. `fiscalLockPlugin` **blocks** `post()` into a closed fiscal period —
     headline regression guard, was silently passing pre-fix.
  2. `post()` fires `before:update` with `state: 'posted'`.
  3. `unpost()` fires `before:update` with `state: 'draft'`.
  4. `archive()` fires `before:update` with `state: 'archived'`.
  5. `reverse()` fires `before:update` on the original with
     `reversed: true` (`_ledgerInternal: 'reverseMark'`).
  6. `reverse()` copies `departmentId`, `projectId`, `sourceRef`,
     `branchTag`.
  7. `duplicate()` copies the same extraFields.
  8. Multi-tenant `reverse()` still preserves `organizationId` (regression
     guard for the old orgField-only branch).

- Existing tests that asserted on the old `entry.save()` bypass behaviour
  were rewritten to assert the new `repository.update()` path. The previously
  green test that read **"reverse() bypasses immutability guard because it
  uses entry.save() directly"** is now a regression guard against the bypass
  coming back.

- `tests/helpers/mock-repository.ts` — the default `update` mock now echoes
  `{ _id, ...patch }` so domain methods that route through `update()` return
  assertable docs.

### Gates

- `tsc --noEmit`: clean
- `biome ci .`: clean
- `vitest run`: **1281 / 1281 passing** (was 1273 in 0.5.0; +8 new e2e tests)
- `tsdown` build: 252 KB across 26 files

### Compatibility

No breaking changes. The `_ledgerInternal` flag is additive and only set by
internal repo methods. Consumers calling `repository.update()` directly remain
subject to the immutability guard exactly as before.

## 0.5.0

Initial public release of the engine-owned models pattern. Engine eagerly
creates models and exposes `repositories`, `reports`, `record`, and
`introspect` as properties. Removed the legacy `wireXxxRepository` and
`createXxxSchema` API. See [README.md](README.md) for the full surface.
