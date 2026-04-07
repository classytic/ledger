# Changelog

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
