/**
 * SourceBridge — host-implemented resolver for polymorphic external references.
 *
 * Ledger journal entries commonly carry a `reference`/`externalRef` pointing
 * at a source document that lives outside the ledger package — an Invoice,
 * Payment, Payroll Run, Stripe Charge, ERP voucher, etc. Storing these as
 * opaque `String + sourceModel` (per PACKAGE_RULES §7) keeps the ledger
 * transport-agnostic: the same schema works whether the source lives in the
 * same Mongo, a different Mongo, Postgres, or an external REST API.
 *
 * Hosts implement `SourceBridge` to hydrate those refs when building
 * enriched views (partner ledger with invoice details, audit trail with
 * payment metadata, reconciliation UI with source documents, etc.).
 *
 * All methods are optional. Features that need resolution degrade gracefully
 * when a bridge is not provided.
 */

/**
 * Polymorphic back-reference to a host source document — the universal
 * "what produced this entry" pointer used by both the entry-level
 * `JournalEntry.sourceRef` slot and the line-level
 * `JournalEntry.journalItems[].sourceRef` slot.
 *
 * Required:
 *   - `sourceModel` — host model namespace (`"SourceDocument"`,
 *     `"BankStatement"`, `"Invoice"`, `"PayrollRun"`, …).
 *   - `sourceId` — opaque string identifier (ObjectId hex, ULID, or a
 *     human-readable number like `INV-2026-04-001`). String — not ObjectId —
 *     because the ledger has no knowledge of consumer model namespaces.
 *
 * Optional denormalization (0.13.0+):
 *   - `label` — human-readable name of the source (statement label,
 *     invoice number with party). Renders "From: <label>" in audit / drill-down
 *     UIs without a follow-up `SourceBridge.resolve()` call.
 *   - `kind` — sub-classifier of `sourceModel` (e.g. `"xero-invoice"`,
 *     `"qbo-bill"`, `"bank-statement"`). Lets the UI route to the correct
 *     detail page without re-querying the source.
 *
 * Both optional fields are denormalized — labels rarely change, and if they
 * do, a one-shot `updateMany({ 'sourceRef.sourceId': id }, { $set: ... })`
 * refreshes stale copies. The tradeoff buys the bookkeeping UI a fast path
 * for "show me every JE produced by this document" without N+1 source-doc
 * fetches.
 */
export interface SourceRef {
  sourceId: string;
  sourceModel: string;
  label?: string | null;
  kind?: string | null;
}

export interface SourceBridgeContext {
  organizationId?: unknown;
  actorId?: unknown;
  [key: string]: unknown;
}

export interface SourceBridge {
  /**
   * Resolve a single external reference.
   *
   * Return `null` when the source cannot be found (deleted, permission
   * denied, wrong model). Do not throw for missing sources — callers
   * expect `null` for graceful degradation.
   */
  resolve?(
    sourceId: string,
    sourceModel: string,
    ctx: SourceBridgeContext,
  ): Promise<unknown | null>;

  /**
   * Batch resolver — avoids N+1 round-trips when enriching a list.
   * Key the returned map by `sourceId`. Missing sources may be omitted or
   * mapped to `null` at the implementer's discretion.
   */
  resolveMany?(
    refs: ReadonlyArray<SourceRef>,
    ctx: SourceBridgeContext,
  ): Promise<Map<string, unknown>>;
}
