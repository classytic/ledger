# CLAUDE.md — @classytic/ledger

Production-grade double-entry accounting engine for MongoDB. Schemas, reports, tax, multi-tenant. Used by fajr-be (host).

**Releases:** see [RELEASING.md](RELEASING.md).

## Mongokit feature floor (>= 3.16)

Features the engine actively uses — do not lower the peer range without
replacing these:

- `repo.claim()` — CAS state machine for post/unpost/archive/reverseMark.
- `repo.claimVersion()` (0.14.0) — version-guarded `updateDraft()`; the
  double-entry, immutable-guard, and lock plugins all register
  `before:claimVersion` so it is a first-class guarded operation.
- `multiTenantPlugin` with `fieldType` casting (3.16.2) and fail-closed
  `onMismatch: 'throw'` defaults.
- `getNextSequence()` — session-aware atomic reference-number counters.
- `repo.capabilities` (`RepoCapabilities`, repo-core 0.6) — asserted at
  boot by `assertLedgerCapabilities` (0.14.0): `upsert` +
  `duplicateKeyError` always, `transactions` when an outbox is configured.

`exactOptionalPropertyTypes` is ON (0.14.0) — optional props are typed
`T | undefined` per PACKAGE_RULES P10; keep new interfaces consistent.
